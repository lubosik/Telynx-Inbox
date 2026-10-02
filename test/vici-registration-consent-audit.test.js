'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { csvRows, cohortRows, evidenceStatus, classify } =
  require('../scripts/audit-vici-registration-consent');

const source = { id: 42, phone: '+12125550100' };
const verified = { wordpress_user_id: 42, phone: '+12125550100', verified: true,
  reason: 'verified', evidence: { source: 'vici_registration',
    occurred_at: '2026-09-30T18:00:00Z', version: 'vici_marketing_sms_voice_v1',
    disclosure: 'Vici SMS consent', privacy_url: 'https://vicipeptides.com/privacy',
    terms_url: 'https://vicipeptides.com/terms' } };

test('cohort CSV parser preserves quoted fields and excludes non-phone/paid accounts', () => {
  const input = 'wp_user_id,phone,woo_paid_order_count,first_name\n'
    + '42,+12125550100,0,"Jane, Jr"\n'
    + '43,,0,No Phone\n'
    + '44,+12125550101,1,Paid\n';
  const rows = csvRows(input);
  assert.equal(rows[0].first_name, 'Jane, Jr');
  assert.deepEqual(cohortRows(rows), [{ ...source, email: '' }]);
});

test('WordPress evidence must match the specific user and current phone', () => {
  assert.equal(evidenceStatus(source, verified), 'wordpress_checkbox_verified');
  assert.equal(evidenceStatus(source, { ...verified, wordpress_user_id: 99 }), 'identity_conflict');
  assert.equal(evidenceStatus(source, { ...verified, phone: '+12125550102' }), 'phone_conflict');
  assert.equal(evidenceStatus(source, { ...verified, verified: false, reason: 'checkbox_not_granted' }),
    'checkbox_not_granted');
  assert.equal(evidenceStatus(source, { ...verified, evidence: { ...verified.evidence, disclosure: '' } }),
    'evidence_incomplete');
});

test('consent, ledger sync and send eligibility are separate states', () => {
  const blocked = classify(source, verified, { eligibility: { eligible: false, reason: 'dnd_unknown' },
    consentEvent: { event_type: 'opt_in', source: 'vici_registration', occurred_at: '2026-09-30T18:00:00Z' } });
  assert.equal(blocked.lukoConsent, 'recorded_opt_in');
  assert.equal(blocked.consentSynced, true);
  assert.equal(blocked.sendEligible, false);
  const optedOut = classify(source, verified, { eligibility: { eligible: false, reason: 'opted_out' },
    consentEvent: { event_type: 'opt_out', occurred_at: '2026-10-01T18:00:00Z' } });
  assert.equal(optedOut.lukoConsent, 'recorded_opt_out');
  assert.equal(optedOut.sendEligible, false);
  assert.equal(classify(source, null, { eligibility: { eligible: true, reason: 'eligible' } }).sendEligible, false);
});

test('connector consent audit is signed, read only and bounded', () => {
  const plugin = fs.readFileSync(path.join(__dirname, '../wordpress/luko-vici-connector/luko-vici-connector.php'), 'utf8');
  assert.match(plugin, /Version: 0\.4\.1/);
  assert.match(plugin, /'\/consent-audit'[\s\S]*?'permission_callback' => \[ __CLASS__, 'verify_rest_hmac' \]/);
  assert.match(plugin, /count\( \$ids \) > 200/);
  const method = plugin.split('public static function consent_audit( $request ) {')[1]
    .split('public static function cart_status( $request ) {')[0];
  assert.doesNotMatch(method, /\b(update_user_meta|insert_user_meta|self::emit|wp_insert_user|sendSMS)\s*\(/);
});
