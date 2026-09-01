'use strict';
/**
 * test/campaign-cost.test.js — what a campaign costs, before anybody approves it.
 *
 * The owner found out a message had become two segments from a warning badge,
 * and his first question was whether people would get it twice. The cost was
 * never on the approval screen at all. It is now, and this file holds the
 * arithmetic honest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateCampaignCost, segmentsFor, costPerSegment } = require('../lib/campaigns/cost');
const { RULES } = require('../lib/campaigns/copy-rules');

test('a segment is not ceil(length / 160)', () => {
  // THE ARITHMETIC THAT IS EASY TO GET WRONG. A message that fits uses the
  // full 160. The moment it does not, EVERY part drops to 153, because each
  // carries the header telling the handset how to reassemble it. Dividing by
  // 160 under-counts long messages by one segment at exactly the lengths
  // campaigns land on.
  assert.equal(segmentsFor('a'.repeat(160)), 1);
  assert.equal(segmentsFor('a'.repeat(161)), 2);
  assert.equal(segmentsFor('a'.repeat(306)), 2);
  assert.equal(segmentsFor('a'.repeat(307)), 3);
  assert.equal(segmentsFor(''), 0);

  // 200 septets is two segments. Divided by 160 it would read as two as well,
  // but 310 would read as two and is actually three.
  assert.equal(Math.ceil(310 / 160), 2, 'the naive sum says two');
  assert.equal(segmentsFor('a'.repeat(310)), 3, 'and the real answer is three');
});

test('an extension character costs two septets, and the estimate knows', () => {
  // A euro sign is one character and two septets, so a message can cross a
  // segment boundary without getting any longer to look at.
  assert.equal(segmentsFor('€'.repeat(80)), 1);
  assert.equal(segmentsFor('€'.repeat(81)), 2);
});

test('every message is counted, not one length multiplied by the audience', () => {
  // A long name pushes one person into a second segment while everybody else
  // stays in one, and multiplying would hide that entirely.
  const messages = [...Array(9).fill('a'.repeat(100)), 'a'.repeat(200)];
  const estimate = estimateCampaignCost({ messages, env: { SMS_COST_PER_SEGMENT_USD: '0.01' } });
  assert.equal(estimate.recipients, 10);
  assert.equal(estimate.segments, 11, 'nine at one segment, one at two');
  assert.equal(estimate.oneSegment, 9);
  assert.equal(estimate.multiSegment, 1);
  assert.equal(estimate.estimatedCostUsd, 0.11);
});

test('the arithmetic is shown, because an estimate is not a fact', () => {
  const estimate = estimateCampaignCost({
    messages: Array(385).fill('a'.repeat(200)),
    env: { SMS_COST_PER_SEGMENT_USD: '0.0079' }
  });
  assert.equal(estimate.segments, 770);
  assert.equal(estimate.estimatedCostUsd, 6.08);
  assert.match(estimate.workedOut, /385 recipients, 770 segments at \$0\.0079 = \$6\.08/);
  assert.equal(estimate.estimateOnly, true);

  // And what the shorter wording would have cost, so the price of the longer
  // message is visible rather than implied.
  assert.equal(estimate.ifAllSingleSegmentUsd, 3.04);
});

test('the rate is a setting and a bad one falls back rather than poisoning the total', () => {
  assert.equal(costPerSegment({ SMS_COST_PER_SEGMENT_USD: '0.02' }), 0.02);
  assert.equal(costPerSegment({ SMS_COST_PER_SEGMENT_USD: '0' }), 0, 'free is a legitimate rate');
  for (const bad of ['abc', '', undefined, '-1', 'NaN']) {
    const rate = costPerSegment({ SMS_COST_PER_SEGMENT_USD: bad });
    assert.ok(rate > 0, `"${bad}" should fall back to the default, got ${rate}`);
  }
});

test('an empty campaign costs nothing and says so', () => {
  const estimate = estimateCampaignCost({ messages: [] });
  assert.equal(estimate.recipients, 0);
  assert.equal(estimate.segments, 0);
  assert.equal(estimate.estimatedCostUsd, 0);
});

test('the segment maths matches the rule the validator enforces', () => {
  // If the ceiling ever moves again, the estimate must move with it rather
  // than keeping its own private idea of how long a message may be.
  assert.equal(RULES.length.septetsPerSingleSegment, 160);
  assert.equal(RULES.length.septetsPerConcatenatedSegment, 153);
  assert.equal(
    segmentsFor('a'.repeat(RULES.length.maxSeptets)),
    Math.ceil(RULES.length.maxSeptets / RULES.length.septetsPerConcatenatedSegment),
    'the longest allowed message must cost what the rule implies'
  );
});

// ── The message is the promise ─────────────────────────────────────────────

test('a coupon may not be worth less than the message says', () => {
  // WHAT WENT WRONG. audience_definition.discount_percent held 20, the
  // sms_campaigns.discount_percent column was NULL because the RPC never
  // writes it, and approval read the column, fell back to 15, and minted a
  // 15% coupon for a message that said "20% off". Three places held the
  // answer and the emptiest one won.
  //
  // The guard reads the percentage back OUT of the copy that will be sent. A
  // coupon worth less than the message promises makes the business a liar at
  // the checkout, one customer at a time, with no error anywhere.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', 'service.js'), 'utf8');

  assert.match(source, /function assertDiscountMatchesMessage/);
  assert.match(source, /CAMPAIGN_DISCOUNT_MISMATCH/);

  // It must run BEFORE anything is minted, for the same reason the migration
  // check does: coupon creation is the irreversible step.
  const freeze = source.slice(source.indexOf('async function renderAndFreeze('));
  assert.ok(
    freeze.indexOf('assertDiscountMatchesMessage') < freeze.indexOf('renderForRecipients')
      || freeze.indexOf('assertDiscountMatchesMessage') < freeze.indexOf('issueSharedCode'),
    'the check must run before any coupon is created'
  );
});

test('the discount is read from where it is actually stored', () => {
  // The column is null for every campaign built from a recipe, because
  // create_sms_campaign_draft records the discount in audience_definition and
  // never writes the column.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', 'service.js'), 'utf8');
  const fn = source.slice(source.indexOf('function campaignDiscountPercent('),
    source.indexOf('function assertDiscountMatchesMessage('));

  assert.match(fn, /audience_definition\?\.discount_percent/,
    'it must fall back to the recipe value the builder actually recorded');
  assert.ok(fn.indexOf('discount_percent') < fn.indexOf('audience_definition'),
    'the column still wins when it is set');
  assert.match(fn, /DEFAULT_DISCOUNT_PERCENT/, 'and there is still a last resort');
});
