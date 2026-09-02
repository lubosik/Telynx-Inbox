'use strict';
/**
 * test/campaign-revenue-one-section.test.js — one revenue number, with the
 * orders behind it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO SECTIONS, SAME QUESTION, DIFFERENT ANSWERS
 *
 *   "Revenue from the codes" said $626.10. "Revenue Attribution", directly
 *   below it, said $0.00 — same campaign, bigger font, confidence tiers, and
 *   the link to the evidence.
 *
 *   The owner read them as the same thing. He was right, and about something
 *   worse: NOTHING has ever written to sms_campaign_attributions. Measured on
 *   production, the table is empty and no insert exists anywhere in the
 *   codebase, so the tiered section could only ever show zero, for every
 *   campaign, for ever.
 *
 *   A headline number structurally incapable of being right, sitting above a
 *   measured one, teaches somebody to distrust both.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the tiered section only shows when it actually has orders', () => {
  // Not deleted: if that pipeline is ever built this returns on its own rather
  // than being rediscovered. But an empty one must never be shown.
  const view = read('ios', 'ViciInbox', 'UI', 'CampaignsView.swift');
  assert.match(view,
    /financial\.orders\.attributed > 0 \|\| financial\.orders\.influenced > 0 \{/,
    'a section with no orders behind it has nothing to say');
  assert.doesNotMatch(view, /Section\("Revenue Attribution"\)/,
    'and the permanently-empty placeholder is gone');
});

test('the revenue section carries the orders that prove it', () => {
  // The owner's words: so the client knows the app is not making this up. A
  // number somebody has to navigate elsewhere to verify is a number they stop
  // verifying.
  const view = read('ios', 'ViciInbox', 'UI', 'CampaignsView.swift');
  assert.match(view, /Section\("Revenue from this campaign"\)/);
  assert.match(view, /DisclosureGroup\("See the \\\(redemptions\.count\) order/);
  for (const evidence of ['#\\(row.wooOrderID)', 'row.readableWho', 'row.code', 'row.formattedTotal']) {
    assert.ok(view.includes(evidence), `the evidence row must show ${evidence}`);
  }
});

test('an evidence row always names somebody', () => {
  // A row of evidence with no subject is not evidence. The recipient snapshot
  // is null on campaigns built from a phone list, so the contact record is the
  // fallback and the last four digits are the floor.
  const models = read('ios', 'ViciInbox', 'Core', 'CampaignModels.swift');
  const fn = models.slice(models.indexOf('var readableWho: String'));
  assert.match(fn.slice(0, 300), /phone\.suffix\(4\)/);

  const attribution = read('lib', 'campaigns', 'coupon-attribution.js');
  assert.match(attribution,
    /name: recipient\.contact_name_snapshot \|\| names\.get\(recipient\.contact_phone\) \|\| null/);
});

test('a missing name never costs the revenue figure', () => {
  // The name lookup is cosmetic. Failing it must not stop money being
  // reported, which is the only thing on that screen anybody acts on.
  const attribution = read('lib', 'campaigns', 'coupon-attribution.js');
  const block = attribution.slice(attribution.indexOf('const names = new Map();'));
  assert.match(block.slice(0, 900), /catch \{/);
  assert.match(block.slice(0, 900), /Revenue must still report/);
});

test('the orders come from redemptions, not from a table nothing writes', () => {
  // The whole point. Every pound traces to a code on a specific paid order.
  const service = read('lib', 'campaigns', 'service.js');
  assert.match(service, /campaignCouponRedemptions\(/);

  const attribution = read('lib', 'campaigns', 'coupon-attribution.js');
  assert.match(attribution, /redemptions/,
    'and the rows are returned so the app can show them');
});
