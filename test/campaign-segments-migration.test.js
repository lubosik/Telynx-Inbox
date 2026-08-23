'use strict';
/**
 * scripts/campaign-segments-migration.sql, read as text.
 *
 * These are shape assertions, not behaviour: there is no Postgres in the
 * offline test run. They exist because the properties they check are the ones
 * that cannot be recovered after the fact. A missing trigger is invisible until
 * an excluded customer receives a promotional SMS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'scripts/campaign-segments-migration.sql'), 'utf8');
const campaignsSql = fs.readFileSync(path.join(ROOT, 'scripts/campaigns-migration.sql'), 'utf8');

test('the migration is additive, repeatable, and touches no already-applied file', () => {
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
  for (const table of [
    'sms_campaign_segments', 'sms_campaign_segment_members',
    'sms_campaign_segment_overrides', 'sms_campaign_segment_runs'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(sql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDROP COLUMN\b/i);
  // Adding a permission key would make the deploy order a crash loop. Segments
  // reuse the two keys campaigns-migration.sql already seeds.
  assert.doesNotMatch(sql, /INSERT INTO sms_permissions/);
  assert.match(campaignsSql, /'campaigns\.read'/);
  assert.match(campaignsSql, /'campaigns\.manage'/);
  // And it sends nothing.
  assert.doesNotMatch(sql, /sendSMS|api\.telnyx|fetch\s*\(/i);
});

test('automatic versus manual is stored, constrained, and immutable', () => {
  assert.match(sql, /segment_kind\s+text NOT NULL CHECK \(segment_kind IN \('automatic', 'manual'\)\)/);
  // An automatic segment must name its detector; a manual one must not have
  // one, or a recompute could overwrite a person's list.
  assert.match(sql, /sms_campaign_segment_definition_matches_kind/);
  assert.match(sql, /segment_kind = 'automatic' AND char_length\(coalesce\(definition->>'detector', ''\)\) > 0/);
  assert.match(sql, /segment_kind = 'manual' AND definition->>'detector' IS NULL/);
  // Immutability is a trigger, not a convention.
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sms_campaign_segment_kind_is_immutable/);
  assert.match(sql, /segment_kind_is_immutable/);
  assert.match(sql, /CREATE TRIGGER sms_campaign_segment_kind_immutable\s*\n\s*BEFORE UPDATE ON public\.sms_campaign_segments/);
  // A manual segment can never claim to have been computed.
  assert.match(sql, /sms_campaign_segment_manual_never_computed/);
});

test('membership_source distinguishes computed, manual and forced_include', () => {
  assert.match(
    sql,
    /membership_source\s+text NOT NULL CHECK \(membership_source IN \('computed', 'manual', 'forced_include'\)\)/
  );
  assert.match(sql, /manual_segment_members_must_be_manual/);
  assert.match(sql, /automatic_segment_members_must_be_computed_or_forced/);
});

test('every member row can carry its inclusion evidence and rule version', () => {
  assert.match(sql, /inclusion_evidence\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(sql, /evidence_rule_version text/);
  // Whether the engine also matched a force-included person, recorded
  // separately so the human reason is never overwritten.
  assert.match(sql, /engine_matched\s+boolean NOT NULL DEFAULT false/);
  assert.match(sql, /engine_evidence\s+jsonb/);
  assert.match(sql, /first_seen_at/);
  assert.match(sql, /last_seen_at/);
});

test('an exclusion lives in its own table and the database refuses to break it', () => {
  // Its own table, because recompute rewrites member rows.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sms_campaign_segment_overrides/);
  assert.match(sql, /override_type\s+text NOT NULL CHECK \(override_type IN \('include', 'exclude'\)\)/);
  // At most one ACTIVE override per person per segment; revoked rows survive.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_segment_override_active_idx[\s\S]{0,200}WHERE revoked_at IS NULL/
  );
  assert.match(sql, /revoked_at\s+timestamptz/);
  assert.match(sql, /revoked_by/);
  assert.match(sql, /revoke_reason/);
  // The trigger is the independent enforcement: no member row may exist for a
  // phone holding an active exclude override, whatever the caller sends.
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sms_campaign_segment_member_is_permitted/);
  assert.match(sql, /segment_member_is_excluded_by_override/);
  assert.match(
    sql,
    /BEFORE INSERT OR UPDATE ON public\.sms_campaign_segment_members/
  );
  // And recording an exclusion evicts an existing member in the same
  // transaction, so there is no window where somebody is both.
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sms_campaign_segment_override_applies/);
  assert.match(sql, /DELETE FROM public\.sms_campaign_segment_members\s*\n\s*WHERE segment_id = NEW\.segment_id AND contact_phone = NEW\.contact_phone/);
});

test('recompute is idempotent, filters exclusions again, and preserves force includes', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_sms_campaign_segment_recompute/);
  // Idempotency key.
  assert.match(sql, /UNIQUE \(segment_id, run_key\)/);
  assert.match(
    sql,
    /SELECT \* INTO v_run FROM public\.sms_campaign_segment_runs[\s\S]{0,200}IF FOUND THEN RETURN v_run; END IF;/
  );
  // Exclusions are dropped from the incoming set here as well as in the
  // application, and counted so the run row is honest about it.
  assert.match(sql, /o\.override_type = 'exclude'[\s\S]{0,60}o\.revoked_at IS NULL/);
  assert.match(sql, /v_excluded := v_candidate_count - jsonb_array_length\(v_incoming\)/);
  // Only computed rows leave. A force include is never deleted by a recompute.
  assert.match(
    sql,
    /DELETE FROM public\.sms_campaign_segment_members m[\s\S]{0,200}m\.membership_source = 'computed'/
  );
  // And a force-included row keeps its human reason and its source on upsert.
  assert.match(sql, /WHEN public\.sms_campaign_segment_members\.membership_source = 'forced_include'/);
  assert.match(sql, /membership_source = public\.sms_campaign_segment_members\.membership_source/);
  // Rows the engine stopped matching are flagged rather than removed.
  assert.match(sql, /SET engine_matched = false, engine_evidence = NULL/);
  // Concurrency: the segment row is locked for the duration.
  assert.match(sql, /FROM public\.sms_campaign_segments\s*\n\s*WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE/);
  // A manual segment is refused outright.
  assert.match(sql, /segment_is_manual_and_is_not_recomputable/);
});

test('every segment RPC is service-role only', () => {
  const functions = [
    'create_sms_campaign_segment', 'add_sms_campaign_segment_member',
    'remove_sms_campaign_segment_member', 'set_sms_campaign_segment_override',
    'revoke_sms_campaign_segment_override', 'apply_sms_campaign_segment_recompute',
    'delete_sms_campaign'
  ];
  for (const name of functions) {
    assert.match(
      sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
      `${name} must be revoked from PUBLIC, anon and authenticated`
    );
    assert.match(
      sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`),
      `${name} must be granted only to service_role`
    );
    assert.match(
      sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]{0,900}?SET search_path = ''`),
      `${name} must pin an empty search_path`
    );
  }
});

test('RLS is on and fail-closed, with no anon or authenticated policy', () => {
  for (const table of [
    'sms_campaign_segments', 'sms_campaign_segment_members',
    'sms_campaign_segment_overrides', 'sms_campaign_segment_runs'
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
  }
  assert.match(sql, /REVOKE ALL ON TABLE public\.sms_campaign_segments[\s\S]{0,300}FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.sms_campaign_segments[\s\S]{0,300}TO service_role;/);
  // Writes go through the SECURITY DEFINER RPCs only.
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE)[^;]*sms_campaign_segment/);
  assert.doesNotMatch(sql, /CREATE POLICY/);
});

test('phones are constrained to E.164 and nothing real is embedded', () => {
  assert.match(sql, /sms_campaign_segment_member_phone_e164 CHECK \(contact_phone ~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'\)/);
  assert.match(sql, /sms_campaign_segment_override_phone_e164/);
  // No real customer or staff number may be committed in a migration.
  assert.doesNotMatch(sql, /\+\d{10,}/);
});

test('the indexes match the filters the service actually uses', () => {
  // list() filters on workspace, kind and archived_at.
  assert.match(sql, /sms_campaign_segments_live_idx[\s\S]{0,160}WHERE archived_at IS NULL/);
  // detail() and recompute page members by (segment_id, contact_phone).
  assert.match(sql, /sms_campaign_segment_members_segment_idx\s*\n\s*ON sms_campaign_segment_members \(segment_id, contact_phone\)/);
  // The override lookups filter by segment and type.
  assert.match(sql, /sms_campaign_segment_override_segment_idx/);
  // The campaign list now excludes archived rows by default.
  assert.match(sql, /sms_campaigns_live_list_idx[\s\S]{0,160}WHERE archived_at IS NULL/);
});
