'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const createReferralRouter = require('../routes/referrals');
const { buildRow } = require('../lib/audit/log');

function handler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}

const ACTOR = { id: 7, displayName: 'Gregory' };
const REFERRAL = {
  id: '11111111-1111-4111-8111-111111111111', contactPhone: '+13055550123',
  contactName: 'Nessa', targetKind: 'directed', originalTarget: { id: '8' },
  owner: null, state: 'pending', version: 1
};

test('the referral API exposes only the handoff lifecycle', () => {
  const noop = async () => ({ referral: REFERRAL, notifications: [] });
  const router = createReferralRouter({ service: new Proxy({}, { get: () => noop }) });
  const paths = router.stack.filter(entry => entry.route).map(entry => {
    const method = Object.keys(entry.route.methods).find(key => entry.route.methods[key]);
    return `${method.toUpperCase()} ${entry.route.path}`;
  }).sort();
  assert.deepEqual(paths, [
    'GET /', 'GET /:id', 'GET /recipients', 'POST /', 'POST /:id/claim',
    'POST /:id/hand-back', 'POST /:id/reassign', 'POST /:id/resolve'
  ]);
});

test('create records note presence but never copies the note into immutable audit', async () => {
  const audits = [];
  const notifications = [];
  const router = createReferralRouter({
    service: { create: async () => ({ referral: REFERRAL, notifications: [{ eventType: 'referrals.assigned' }] }) },
    auditWriter: async input => { audits.push(input); return { recorded: true }; },
    notificationSender: async input => { notifications.push(input); return { sent: 0, disabled: true }; }
  });
  const res = response();
  await handler(router, 'post', '/')({
    body: { contactPhone: '+13055550123', targetKind: 'directed', targetUserId: '8', note: 'Do not quote the lower price.' },
    actor: ACTOR
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(audits[0].metadata.note_present, true);
  const immutableRow = buildRow(audits[0]);
  assert.equal(JSON.stringify(immutableRow).includes('Do not quote'), false);
  assert.equal(notifications.length, 1);
});

test('unknown request fields are refused before the service can act', async () => {
  let acted = false;
  const router = createReferralRouter({ service: { create: async () => { acted = true; } } });
  const res = response();
  await handler(router, 'post', '/')({ body: { customerMessage: 'send me' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'REFERRAL_INPUT_REJECTED');
  assert.equal(acted, false);
});

test('notification failure cannot turn a completed referral into an API failure', async () => {
  const router = createReferralRouter({
    service: { claim: async () => ({ referral: { ...REFERRAL, state: 'owned', version: 2 }, notifications: [{ eventType: 'referrals.assigned' }] }) },
    auditWriter: async () => ({ recorded: true }),
    notificationSender: async () => { throw new Error('APNs unavailable'); }
  });
  const res = response();
  await handler(router, 'post', '/:id/claim')({ params: { id: REFERRAL.id }, body: {}, actor: ACTOR }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.referral.state, 'owned');
  assert.equal(res.payload.notification.error, 'referral_notification_failed');
});
