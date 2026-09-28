'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichVIPContacts, readVIPContactSnapshot, readVIPManualMembership } = require('../lib/vip-inbox-snapshot');

const env = { TELNYX_PHONE_NUMBER: '+13054043184', VIP_INBOX_PHONE_NUMBER: '+19177254009' };
const now = new Date('2026-09-28T12:00:00Z');
const vipPhone = '+15555550101';
const mainPhone = '+15555550102';
const manualPhone = '+15555550103';
const contacts = [vipPhone, mainPhone, manualPhone].map((phone, i) => ({ id: i + 1, phone }));
const orders = [1, 2, 3].map(id => ({ id, woo_order_id: id, contact_phone: vipPhone,
  total: 200, status: 'completed', created_at: `2026-0${id}-01T12:00:00Z` }));
const membership = { segmentID: 'vip-segment', manuallyIncluded: new Set([manualPhone]) };

test('contacts and inbox use one canonical paid-order and manual VIP snapshot', () => {
  const result = enrichVIPContacts(contacts, orders, membership, { env, now });
  assert.equal(result.length, contacts.length);
  assert.deepEqual(result.map(c => c.id), [1, 2, 3]);
  assert.deepEqual(result.map(c => c.customer_tier), ['vip', 'standard', 'vip']);
  assert.deepEqual(result.map(c => c.reply_from_number), [env.VIP_INBOX_PHONE_NUMBER,
    env.TELNYX_PHONE_NUMBER, env.VIP_INBOX_PHONE_NUMBER]);
  assert.equal(result[0].paid_order_count, 3);
  assert.equal(result[0].lifetime_spend_cents, 60000);
  assert.equal(result[2].vip_source, 'manual');
  assert.equal(result[1].vip_source, null);
});

test('promotion preserves contact identity and does not invent SMS consent', () => {
  const original = [{ id: 1, phone: vipPhone, sms_consent: false, notes: 'Keep history' }];
  const before = enrichVIPContacts(original, orders.slice(0, 2), membership, { env, now })[0];
  const after = enrichVIPContacts(original, orders, membership, { env, now })[0];
  assert.equal(before.customer_tier, 'standard');
  assert.equal(after.customer_tier, 'vip');
  assert.equal(before.id, after.id);
  assert.equal(after.sms_consent, false);
  assert.equal(after.notes, 'Keep history');
  assert.equal(original[0].customer_tier, undefined);
});

test('failed/cancelled/refunded orders cannot qualify a VIP contact', () => {
  const result = enrichVIPContacts(contacts, orders.map((order, index) => ({ ...order,
    status: ['failed', 'cancelled', 'refunded'][index] })), membership, { env, now });
  assert.equal(result[0].customer_tier, 'standard');
  assert.equal(result[0].paid_order_count, 0);
});

test('legacy unconfigured VIP number falls back to established main reply line', () => {
  const result = enrichVIPContacts(contacts, orders, membership, {
    env: { TELNYX_PHONE_NUMBER: env.TELNYX_PHONE_NUMBER }, now
  });
  assert.equal(result[0].customer_tier, 'vip');
  assert.equal(result[0].reply_from_number, env.TELNYX_PHONE_NUMBER);
});

test('empty contacts require no orders or segment query', async () => {
  const result = await readVIPContactSnapshot({ from() { throw new Error('must not query'); } }, []);
  assert.deepEqual(result, []);
});

test('manual membership read failures do not silently move manual VIPs into Main', async () => {
  const client = { from() {
    const query = { select() { return query; }, eq() { return query; }, is() { return query; },
      maybeSingle: async () => ({ data: null, error: { code: '42501', message: 'Read denied' } }) };
    return query;
  } };
  await assert.rejects(readVIPManualMembership(client), error => error.code === '42501');
});

test('optional missing seed schema still allows automatic paid-order membership', async () => {
  const client = { from() {
    const query = { select() { return query; }, eq() { return query; }, is() { return query; },
      maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'Missing table' } }) };
    return query;
  } };
  const result = await readVIPManualMembership(client);
  assert.equal(result.segmentID, null);
  assert.equal(result.manuallyIncluded.size, 0);
});
