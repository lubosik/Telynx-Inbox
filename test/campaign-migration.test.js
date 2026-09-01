'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'scripts/campaigns-migration.sql'), 'utf8');
const analyticsSql = fs.readFileSync(path.join(ROOT, 'scripts/analytics-migration.sql'), 'utf8');

test('campaign migration is additive, repeatable and defaults live delivery off', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sms_campaign_settings/);
  assert.match(sql, /provider_approved\s+boolean NOT NULL DEFAULT false/);
  assert.match(sql, /live_send_enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(sql, /CHECK \(NOT live_send_enabled OR provider_approved\)/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql, /sendSMS|api\.telnyx|fetch\s*\(/i);
});

test('authoritative opportunity support state and atomic draft bundles fail closed', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sms_customer_commercial_eligibility/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, contact_phone\)/);
  assert.match(sql, /sms_customer_commercial_eligibility_source_present/);
  assert.match(sql, /sms_customer_commercial_eligibility_evidence_present/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.persist_sms_opportunity_draft_bundle/);
  assert.match(sql, /campaign_generation_actor_forbidden/);
  assert.match(sql, /permission_key = 'campaigns\.manage'/);
  assert.match(sql, /v_settings\.max_recipients_per_campaign/);
  assert.match(sql, /campaign_opportunity_bundle_set_invalid/);
  assert.match(sql, /opportunity\.value->>'dedupeKey' = draft_key\.value/);
  assert.match(sql, /structuredContext,ruleVersion/);
  assert.match(sql, /inclusionReason,ruleVersion/);
  // chr(31), not chr(0). This assertion pinned chr(0) in place for as long as
  // the bug existed: PostgreSQL text cannot hold a NUL, so that line raised
  // 54000 every time it ran and the whole send path was dead. The separator
  // still has to be here — without one, 'vici' + '+1555…' and 'vic' +
  // 'i+1555…' would take the same lock — it just has to be a character
  // PostgreSQL permits. See test/campaign-sql-null-character.test.js.
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_workspace_id \|\| chr\(31\) \|\| v_preparation_key/);
  assert.match(sql, /campaign_generated_audience_set_invalid/);
  assert.match(sql, /inclusionReason,productID/);
  assert.match(sql, /inclusionReason,variationID/);
  assert.match(sql, /inclusionReason,wooCustomerID/);
  assert.match(sql, /campaign_generated_recipient_evidence_invalid/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.persist_sms_opportunity_draft_bundle[\s\S]*TO service_role/);
});

test('recipient queue claims atomically and repeats send-time suppression', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_sms_campaign_recipients/);
  assert.match(sql, /FOR UPDATE OF r SKIP LOCKED/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(sql, /reserved_at/);
  assert.match(sql, /reservation_expires_at/);
  assert.match(sql, /consent_not_recorded/);
  assert.match(sql, /flow_type = 'opted-out'/);
  assert.match(sql, /v_settings\.provider_approved <> true OR v_settings\.live_send_enabled <> true/);
  assert.match(sql, /sms_commercial_contact_ledger/);
  assert.match(sql, /minimum_promotional_spacing_hours/);
  assert.match(sql, /max_promotional_per_7_days/);
  assert.match(sql, /max_promotional_per_30_days/);
  assert.match(sql, /ghl_dnd = false AND c\.ghl_sms_dnd_status = 'inactive'/);
  assert.match(sql, /dnd_unknown/);
  assert.match(sql, /ghl_dnd_synced_at <= now\(\)/);
  assert.match(sql, /sms_campaign_suppressions/);
  assert.doesNotMatch(sql, /sms_campaign_suppressions[\s\S]{0,500}(?:\+1|\b\d{10}\b)/,
    'the migration must not embed real internal/test phones');
});

test('campaign functions are service-role only and approval is two-phase', () => {
  assert.match(sql, /status = 'approval_pending'/);
  assert.match(sql, /approval_audit_recorded_at = now\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.prepare_sms_campaign_approval[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.claim_sms_campaign_recipients[\s\S]*TO service_role/);
  assert.match(sql, /status = 'approved'[^;]*approval_audit_recorded_at = now\(\)/s);
  assert.match(sql, /status <> 'approved' OR v_campaign\.approval_audit_recorded_at IS NULL/);
  assert.match(sql, /FROM public\.sms_audit_log a/);
  assert.match(sql, /campaign_approval_audit_proof_not_found/);
});

test('commercial contacts and existing ledgers carry durable campaign linkage', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sms_commercial_contact_ledger/);
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key\)/);
  assert.match(sql, /contact_phone, accepted_at DESC/);
  assert.match(sql, /ALTER TABLE sms_messages[\s\S]*campaign_recipient_id uuid/);
  assert.match(sql, /ALTER TABLE sms_sent_log[\s\S]*campaign_recipient_id uuid/);
  assert.match(sql, /to_regclass\('public\.revenue_attributions'\)/);
});

test('workspace integrity and provider lifecycle transitions are database-enforced', () => {
  assert.match(sql, /FOREIGN KEY \(workspace_id, campaign_id\) REFERENCES (?:public\.)?sms_campaigns\(workspace_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, recipient_id, campaign_id\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.record_sms_campaign_provider_acceptance/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.begin_sms_campaign_provider_attempt/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.heartbeat_sms_campaign_provider_attempt/);
  assert.match(sql, /state = 'reconciliation_required'/);
  assert.match(sql, /provider_idempotency_key/);
  assert.match(sql, /campaign_claim_fence_failed/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.record_sms_campaign_provider_result/);
  assert.match(sql, /p_trust_source IS DISTINCT FROM 'telnyx_ed25519_v2'/);
  assert.match(sql, /'provider\.' \|\| p_result/);
  assert.match(sql, /ON CONFLICT \(workspace_id, provider, provider_event_id\)[\s\S]*WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL DO NOTHING/);
  assert.match(sql, /ORDER BY e\.occurred_at DESC,[\s\S]*provider\.delivered/);
  assert.match(sql, /p_occurred_at < v_recipient\.sent_at/);
  assert.match(sql, /campaign_provider_result_time_invalid/);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});

test('analytics and campaign migrations converge campaign attribution links in either order', () => {
  assert.match(analyticsSql, /ADD COLUMN IF NOT EXISTS campaign_id uuid/);
  assert.match(analyticsSql, /to_regclass\('public\.sms_campaigns'\)/);
  assert.match(analyticsSql, /revenue_attributions_campaign_recipient_fk/);
  assert.match(sql, /to_regclass\('public\.revenue_attributions'\)/);
  assert.match(sql, /revenue_attributions_campaign_recipient_fk/);
});

test('older non-workspace lifecycle overloads are removed before replacement', () => {
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.prepare_sms_campaign_approval\(uuid,bigint,integer,text,text\)/);
  assert.match(sql, /prepare_sms_campaign_approval\(uuid,text,bigint,integer,text,text\)/);
  assert.match(sql, /finalize_sms_campaign_approval\(uuid,text,integer,bigint,text\)/);
  assert.match(sql, /schedule_sms_campaign\(uuid,text,bigint,timestamptz\)/);
  assert.match(sql, /cancel_sms_campaign\(uuid,text,bigint,text\)/);
});
