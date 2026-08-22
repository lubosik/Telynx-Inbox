'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapGHLDndState } = require('../sync-ghl');

test('GHL DND mapping preserves explicit global and SMS-channel state', () => {
  assert.deepEqual(mapGHLDndState({
    dnd: false,
    dndSettings: { sms: { status: 'inactive' } }
  }, '2026-08-22T12:00:00Z'), {
    ghl_dnd: false,
    ghl_sms_dnd_status: 'inactive',
    ghl_dnd_synced_at: '2026-08-22T12:00:00.000Z'
  });
  assert.equal(mapGHLDndState({
    dnd: true,
    dndSettings: { sms: { status: 'PERMANENT' } }
  }, '2026-08-22T12:00:00Z').ghl_sms_dnd_status, 'permanent');
});

test('missing or malformed HighLevel DND fields remain unknown rather than false', () => {
  for (const contact of [
    {},
    { dnd: false },
    { dndSettings: { sms: { status: 'inactive' } } },
    { dnd: false, dndSettings: { sms: { status: 'mystery' } } }
  ]) {
    const mapped = mapGHLDndState(contact, '2026-08-22T12:00:00Z');
    assert.equal(mapped.ghl_dnd_synced_at, null);
  }
});
