'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'scripts', 'referrals-migration.sql'), 'utf8');
const route = fs.readFileSync(path.join(ROOT, 'routes', 'referrals.js'), 'utf8');
const referralSources = [
  route,
  fs.readFileSync(path.join(ROOT, 'lib', 'referrals', 'store.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'lib', 'referrals', 'service.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'lib', 'referrals', 'notifications.js'), 'utf8')
].join('\n');

test('the migration is additive, transaction wrapped and service-role only', () => {
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.sms_conversation_referrals/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.sms_conversation_referral_events/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /REVOKE ALL ON TABLE public\.sms_conversation_referrals FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.claim_sms_conversation_referral[\s\S]*TO service_role/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|ALL).*authenticated/i);
});

test('one unresolved referral per conversation is enforced in Postgres', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS sms_conversation_referrals_one_open_phone_idx/);
  assert.match(sql, /WHERE state IN \('pending', 'owned'\)/);
});

test('claim is one conditional update and losers are refused', () => {
  const claim = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_sms_conversation_referral'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.reassign_sms_conversation_referral')
  );
  assert.match(claim, /UPDATE public\.sms_conversation_referrals r[\s\S]*r\.state = 'pending'[\s\S]*r\.owner_user_id IS NULL/);
  assert.match(claim, /RETURNING r\.\* INTO v_row/);
  assert.match(claim, /REFERRAL_ALREADY_CLAIMED/);
  assert.doesNotMatch(claim, /SELECT \* INTO v_row[\s\S]*FOR UPDATE/,
    'initial claim must not become a Node-like read then write path');
});

test('legacy shared identity is never granted referral permissions and SQL refuses it', () => {
  const grants = sql.slice(sql.indexOf('INSERT INTO public.sms_role_permissions'), sql.indexOf('CREATE TABLE'));
  assert.doesNotMatch(grants, /\('legacy', 'referral\./);
  assert.match(sql, /u\.is_legacy_shared = false/);
});

test('hand-back is explicit, note-bearing, and cannot be bypassed by reassign', () => {
  assert.match(sql, /IF v_note IS NULL THEN RAISE EXCEPTION 'REFERRAL_NOTE_REQUIRED'/);
  assert.match(sql, /p_target_user_id = v_row\.referred_by_user_id[\s\S]*REFERRAL_USE_HAND_BACK/);
  assert.match(sql, /'handed_back'/);
});

test('referral events are append-only including truncate', () => {
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.sms_conversation_referral_events/);
  assert.match(sql, /BEFORE TRUNCATE ON public\.sms_conversation_referral_events/);
});

test('referral notes have no route to the outbound messaging stack', () => {
  for (const forbidden of [
    /require\([^)]*routes\/send/, /sendSMS\s*\(/, /sendMMS\s*\(/,
    /telnyx-api/, /webhook-ghl/, /\.from\(['"]sms_messages['"]\)/,
    /INSERT\s+INTO\s+(?:public\.)?sms_messages/i,
    /UPDATE\s+(?:public\.)?sms_messages/i
  ]) {
    assert.equal(forbidden.test(referralSources), false, `referral code reached forbidden outbound shape ${forbidden}`);
  }
});
