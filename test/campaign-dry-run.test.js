'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptedPromotionalTimes,
  currentConsentByPhone,
  currentDndReason,
  evaluateCadenceScenarios,
  productKey,
  rowsForWorkspace
} = require('../scripts/dry-run-campaign-cadence');

test('historical product grouping prefers exact ids, then SKU, then a legacy name', () => {
  assert.deepEqual(productKey({ product_id: 10, variation_id: 11, sku: 'x', name: 'A' }), {
    key: 'variation:11', quality: 'exact_id'
  });
  assert.deepEqual(productKey({ sku: ' AbC ' }), { key: 'sku:abc', quality: 'sku' });
  assert.deepEqual(productKey({ name: '  Product   Name ' }), {
    key: 'legacy-name:product name', quality: 'legacy_name'
  });
  assert.equal(productKey({}), null);
});

test('only the latest evidenced Vici promotional opt-in is active', () => {
  const rows = [
    { id: 1, contact_phone: '+13055550001', event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici', source: 'checkout', evidence_ref: 'order:1', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 2, contact_phone: '+13055550001', event_type: 'opt_out', purpose: 'promotional_sms', brand_id: 'vici', source: 'STOP', evidence_ref: null, occurred_at: '2026-02-01T00:00:00Z' },
    { id: 3, contact_phone: '+13055550002', event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici', source: 'checkout', evidence_ref: '', occurred_at: '2026-02-01T00:00:00Z' },
    { id: 4, contact_phone: '+13055550003', event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici', source: 'checkout', evidence_ref: 'form:9', occurred_at: '2026-02-01T00:00:00Z' }
  ];
  assert.deepEqual([...currentConsentByPhone(rows)], ['+13055550003']);
});

test('cadence scenarios use current DND, authoritative suppressions and deduped accepted contacts', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const selected = [1, 2, 3, 4].map(index => ({ phone: `+1305555000${index}` }));
  const consented = new Set(selected.map(row => row.phone));
  const contacts = selected.map(row => ({
    phone: row.phone, opted_out: false, ghl_dnd: false,
    ghl_sms_dnd_status: 'inactive', ghl_dnd_synced_at: '2026-08-22T11:00:00Z'
  }));
  contacts[1].ghl_sms_dnd_status = 'active';
  const suppressions = [{
    contact_phone: selected[2].phone, active: true, reason_code: 'test_identity',
    effective_at: '2026-08-01T00:00:00Z', expires_at: null
  }];
  const ledger = [
    { contact_phone: selected[3].phone, classification: 'promotional', idempotency_key: 'same', accepted_at: '2026-08-22T00:00:00Z' },
    { contact_phone: selected[3].phone, classification: 'promotional', idempotency_key: 'same', accepted_at: '2026-08-22T00:00:00Z' }
  ];
  assert.equal(acceptedPromotionalTimes(ledger, now).length, 1);
  const scenarios = evaluateCadenceScenarios({ selected, consented, contacts, suppressions, ledger, now });
  assert.deepEqual(scenarios.map(row => row.sendsAllowedNow), [1, 1, 1]);
  assert.deepEqual(scenarios[1].suppressionReasons, {
    dnd: 1, authoritative_suppression: 1, minimum_spacing: 1
  });
});

test('cadence dry run fails closed when a current safety source is unavailable', () => {
  const base = {
    selected: [{ phone: '+13055550001' }],
    consented: new Set(['+13055550001']),
    contacts: [{
      phone: '+13055550001', opted_out: false, ghl_dnd: false,
      ghl_sms_dnd_status: 'inactive', ghl_dnd_synced_at: '2026-08-22T11:00:00Z'
    }],
    now: new Date('2026-08-22T12:00:00Z')
  };
  assert.equal(evaluateCadenceScenarios({ ...base, suppressionsAvailable: false })[0]
    .suppressionReasons.authoritative_suppression_unknown, 1);
  assert.equal(evaluateCadenceScenarios({ ...base, ledgerAvailable: false })[0]
    .suppressionReasons.cadence_ledger_unavailable, 1);
  assert.equal(currentDndReason({
    phone: '+13055550001', opted_out: false, ghl_dnd: false,
    ghl_sms_dnd_status: 'inactive', ghl_dnd_synced_at: '2026-08-22T12:00:01Z'
  }, base.now), 'dnd_unknown');
});

test('workspace-owned cadence evidence cannot be contaminated by another tenant', () => {
  const rows = [
    { workspace_id: 'vici', contact_phone: '+13055550001' },
    { workspace_id: 'another', contact_phone: '+13055550001' },
    { workspace_id: null, contact_phone: '+13055550001' }
  ];
  assert.deepEqual(rowsForWorkspace(rows), [rows[0]]);
});
