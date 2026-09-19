'use strict';

/**
 * The one-handset campaign proving ground.
 *
 * A test is a real provider send but it is not campaign delivery. These tests
 * hold that boundary: strict destination, one renderer, one sender, one audit,
 * and no lifecycle or audience mutation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const createCampaignRouter = require('../routes/campaigns');
const { campaignTestPhone } = require('../routes/campaigns');
const { redactMetadata } = require('../lib/audit/redact');
const { campaignCopyField } = require('../lib/campaigns/service');

function handler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  // The first layer is the rate limiter. Unit tests exercise the endpoint
  // itself; express-rate-limit has its own package tests.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  return {
    statusCode: 200, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}

test('test destinations are strict E.164, not silently rewritten guesses', () => {
  for (const accepted of ['+13055551234', '+447506440284', '+919876543210']) {
    assert.equal(campaignTestPhone(accepted), accepted);
  }
  for (const refused of [
    '', null, '3055551234', '13055551234', '+1 (305) 555-1234',
    '+0123456789', '+1234567', '+1234567890123456', '+1abc3055551234'
  ]) {
    assert.equal(campaignTestPhone(refused), null, String(refused));
  }
});

test('campaign persistence normalises ordinary line breaks but not hidden control characters', () => {
  assert.equal(
    campaignCopyField('Vin from Vici:\nCards and Apple Pay are live.\t Reply STOP to opt out.'),
    'Vin from Vici: Cards and Apple Pay are live. Reply STOP to opt out.'
  );
  assert.equal(campaignCopyField('Vin   from Vici:  Hello.  Reply STOP to opt out.'),
    'Vin from Vici: Hello. Reply STOP to opt out.');
  assert.equal(campaignCopyField('Vin from Vici:\u0000Hello. Reply STOP to opt out.').includes('\u0000'), true,
    'non-whitespace controls remain visible to the deterministic validator');
});

test('campaign persistence fixes phone punctuation before review instead of blocking the draft', () => {
  assert.equal(
    campaignCopyField('Vin from Vici: We’re live — cards, Apple Pay, and more… Reply STOP to opt out.'),
    "Vin from Vici: We're live - cards, Apple Pay, and more... Reply STOP to opt out."
  );
  assert.equal(
    campaignCopyField('Vin from Vici: “Any card” works. Reply STOP to opt out.'),
    'Vin from Vici: "Any card" works. Reply STOP to opt out.'
  );
});

test('one test renders once, sends once, audits a masked target and changes no campaign state', async () => {
  const serviceCalls = [];
  const renderCalls = [];
  const sends = [];
  const audits = [];
  const campaign = {
    id: 'campaign-1', title: 'Card payments', proposed_message: 'Vin from Vici: Hello. Reply STOP to opt out.'
  };
  const service = new Proxy({
    detail: async id => {
      serviceCalls.push(['detail', id]);
      return { campaign };
    }
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return async () => { throw new Error(`unexpected campaign mutation: ${String(key)}`); };
    }
  });
  const router = createCampaignRouter({
    service,
    campaignClient: {},
    campaignTestRenderer: async input => {
      renderCalls.push(input);
      return { rendered: [{ message: 'Vin from Vici: Cards now accepted. Reply STOP to opt out.' }] };
    },
    campaignTestSender: async (to, text) => {
      sends.push({ to, text });
      return { messageId: 'provider-message-1', status: 'queued' };
    },
    campaignTestAuditWriter: async input => { audits.push(input); return { recorded: true }; }
  });

  const res = response();
  await handler(router, 'post', '/:id/test-send')({
    params: { id: campaign.id }, body: { to: '+13055551234' }, actor: { id: 9 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.payload.sent, true);
  assert.equal(res.payload.to, '+13055551234');
  assert.equal(res.payload.providerStatus, 'queued');
  assert.deepEqual(serviceCalls, [['detail', 'campaign-1']]);
  assert.equal(renderCalls.length, 1);
  assert.deepEqual(renderCalls[0], {
    template: 'Vin from Vici: Hello. Reply STOP to opt out.',
    to: '+13055551234',
    approvedMinimumSpend: null
  });
  assert.deepEqual(sends, [{
    to: '+13055551234',
    text: 'Vin from Vici: Cards now accepted. Reply STOP to opt out.'
  }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, 'campaign.test_sent');
  assert.equal(audits[0].details.metadata.target_last4, '1234');
  assert.equal(JSON.stringify(audits[0].details).includes('+13055551234'), false,
    'the immutable audit fields must not receive the full test number');
});

test('an invalid test number reaches neither campaign data nor the provider', async () => {
  let touched = false;
  const router = createCampaignRouter({
    service: new Proxy({}, { get: () => async () => { touched = true; } }),
    campaignTestSender: async () => { touched = true; },
    campaignTestRenderer: async () => { touched = true; }
  });
  const res = response();
  await handler(router, 'post', '/:id/test-send')({
    params: { id: 'campaign-1' }, body: { to: '(305) 555-1234' }, actor: { id: 9 }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'CAMPAIGN_TEST_SEND_NUMBER_INVALID');
  assert.equal(touched, false);
});

test('default test rendering uses synthetic facts and never reads a customer recipient', async () => {
  const sends = [];
  const service = new Proxy({
    detail: async () => ({ campaign: {
      id: 'campaign-safe-test',
      proposed_message: 'Vin from Vici: Hi {{first_name}}, RT is ready. Reply STOP to opt out.'
    } })
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return async () => { throw new Error(`customer data must not be read: ${String(key)}`); };
    }
  });
  const router = createCampaignRouter({
    service,
    campaignClient: {},
    campaignTestSender: async (to, message) => { sends.push({ to, message }); return { status: 'queued' }; },
    campaignTestAuditWriter: async () => ({ recorded: true })
  });
  const res = response();
  await handler(router, 'post', '/:id/test-send')({
    params: { id: 'campaign-safe-test' }, body: { to: '+13055551234' }, actor: { id: 9 }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sends, [{
    to: '+13055551234',
    message: 'Vin from Vici: Hi Test, RT is ready. Reply STOP to opt out.'
  }]);
});

test('a fixed campaign coupon is the exact code rendered into a real test', async () => {
  const sends = [];
  const router = createCampaignRouter({
    service: { detail: async () => ({ campaign: {
      id: 'campaign-cc20',
      proposed_message: 'Vin from Vici: Use code {{code}} for 20% off on orders $100 or more: https://vicipeptides.com/shop/ Reply STOP to opt out.',
      discount_percent: 20,
      audience_definition: { coupon_code: 'CC20', discount_percent: 20 }
    } }) },
    campaignClient: {},
    campaignCouponVerifier: async () => ({ code: 'CC20', minimum_amount: '100.00' }),
    campaignTestRenderer: async input => {
      assert.equal(input.couponCode, 'CC20');
      assert.equal(input.approvedMinimumSpend, 100);
      return { rendered: [{ message: input.template.replace('{{code}}', input.couponCode) }] };
    },
    campaignTestSender: async (to, message) => { sends.push({ to, message }); return { status: 'queued' }; },
    campaignTestAuditWriter: async () => ({ recorded: true })
  });
  const res = response();
  await handler(router, 'post', '/:id/test-send')({
    params: { id: 'campaign-cc20' }, body: { to: '+13055551234' }, actor: { id: 9 }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.match(sends[0].message, /Use code CC20 for 20% off on orders \$100 or more/);
  assert.doesNotMatch(sends[0].message, /TEST|000000/);
});

test('a real test refuses a fake placeholder when no coupon is attached', async () => {
  let sent = false;
  const router = createCampaignRouter({
    service: { detail: async () => ({ campaign: {
      id: 'campaign-unknown-code',
      proposed_message: 'Vin from Vici: {{code}} gets you 20% off. Reply STOP to opt out.',
      discount_percent: 20,
      audience_definition: { discount_percent: 20 }
    } }) },
    campaignClient: {},
    campaignTestSender: async () => { sent = true; }
  });
  const res = response();
  await handler(router, 'post', '/:id/test-send')({
    params: { id: 'campaign-unknown-code' }, body: { to: '+13055551234' }, actor: { id: 9 }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CAMPAIGN_TEST_SEND_COUPON_MISSING');
  assert.match(res.payload.error, /no real coupon is attached/i);
  assert.equal(sent, false);
});

test('campaign test audit metadata retains useful proof without a raw phone or copy', () => {
  const redacted = redactMetadata('campaign.test_sent', {
    target_last4: '1234', segments: 1, characters: 58, provider_status: 'queued',
    to: '+13055551234', message: 'secret campaign copy'
  }).metadata;
  assert.deepEqual(redacted, {
    target_last4: '1234', segments: 1, characters: 58, provider_status: 'queued'
  });
});

test('the iPhone flow cleans line breaks and phone punctuation before review and exposes an isolated test action', () => {
  const root = path.join(__dirname, '..');
  const model = fs.readFileSync(path.join(root, 'ios/ViciInbox/App/CampaignViewModels.swift'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/CampaignsView.swift'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8');

  assert.match(model, /if step == \.message \{ message = Self\.singleLineCampaignCopy\(message\) \}/);
  assert.match(model, /components\(separatedBy: \.whitespacesAndNewlines\)[\s\S]*joined\(separator: " "\)/);
  assert.match(model, /"\\u\{2019\}": "'"/,
    'a normal iPhone apostrophe must be converted before the copy check');
  assert.match(model, /verdict\.normalizedMessage[\s\S]*message = normalized/,
    'the editor must show the exact server-reviewed wording before saving');
  assert.match(view, /CampaignTestSendSection\(campaignID: campaign\.id, offerLabel: campaign\.offerLabel\)/,
    'the saved campaign review screen must offer the test before approval or scheduling');
  assert.match(view, /It does not approve, schedule or send the campaign to its audience/);
  assert.ok(view.includes('This test will use \\(offerLabel).'));
  assert.match(view, /coupon not attached/);
  assert.match(api, /func sendCampaignTest\(id: String, to phone: String\)/);
  assert.match(api, /\/test-send/);
});
