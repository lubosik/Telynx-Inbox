'use strict';
/**
 * test/campaign-planner.test.js — one sentence in, a reviewable campaign out.
 *
 * The planner composes four things that each already worked, so these tests
 * are mostly about the joins: the offer not being the model's decision, the
 * brief surviving the shape the copy writer demands, and every failure leaving
 * the rest of the proposal usable rather than blanking the screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  briefForDrafter,
  explicitDiscount,
  normaliseWarning,
  planCampaign,
  shapeOf
} = require('../lib/campaigns/planner');

/** Segment service stub: draft some rules, and say how many they match. */
const stubSegments = ({ matched = 50, throws = null } = {}) => ({
  draftRules: async ({ description }) => {
    if (throws) throw Object.assign(new Error(throws), { code: 'SEGMENT_AI_INPUT_REJECTED' });
    return { ruleSet: { version: 1, conditions: [] }, description };
  },
  previewRules: async ({ rules }) => ({
    ruleSet: rules,
    plainEnglish: 'people who match',
    matchedCount: matched,
    consideredCount: 973,
    sample: [],
    warnings: []
  })
});

const stubDrafter = (candidates = [{ text: 'Vin from Vici: hello. Reply STOP to opt out.', septets: 44 }]) =>
  async () => ({ candidates, returned: candidates.length });

const stubClient = () => ({
  from() {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: null }), in: async () => ({ data: [], error: null }) };
    return b;
  }
});

// ── Reading the brief ──────────────────────────────────────────────────────

test('a percentage the owner names beats the shape default', () => {
  assert.equal(explicitDiscount('clearance, 30% off'), 30);
  assert.equal(explicitDiscount('clearance'), null);
  // Nonsense percentages are not offers.
  assert.equal(explicitDiscount('100% off'), null);
  assert.equal(explicitDiscount('0% off'), null);
});

test('the shape decides the default offer, and a thank-you offers nothing', () => {
  assert.equal(shapeOf('win back the people who stopped'), 'winback');
  assert.equal(shapeOf('clearance on the last of the stock'), 'clearance');
  assert.equal(shapeOf('thank our most loyal customers'), 'thanks');
  assert.equal(shapeOf('something else entirely'), 'custom');
});

test('the brief is reshaped into what the copy writer will accept', () => {
  // BRIEF_PATTERN in copy-writer.js does not allow `%`, so "20% off" had the
  // whole request refused and the plan came back with no copy at all, for one
  // character. Rewritten rather than stripped: the model may state a
  // percentage only when the brief asks, and deleting the symbol would remove
  // the ask with it.
  assert.equal(briefForDrafter('clearance, 20% off'), 'clearance, 20 percent off');
  assert.match(briefForDrafter('clearance on RT @ 20% — now!'), /^[A-Za-z0-9][A-Za-z0-9 .,:;'?()/-]*$/);
  assert.ok(briefForDrafter('x'.repeat(400)).length <= 200);
});

test('a warning always has a readable message', () => {
  // A structured warning with no message renders as [object Object] on screen,
  // which is worse than no warning because it looks like a bug.
  assert.equal(normaliseWarning('plain text').message, 'plain text');
  assert.equal(normaliseWarning({ code: 'x', message: 'said' }).message, 'said');
  assert.ok(normaliseWarning({ code: 'x', detail: 'detail only' }).message);
  assert.ok(normaliseWarning({ weird: true }).message);
});

// ── Planning ───────────────────────────────────────────────────────────────

test('a plan carries who, what it offers and what it says', async () => {
  const plan = await planCampaign({
    client: stubClient(),
    brief: 'win back the people who stopped ordering',
    segments: stubSegments({ matched: 120 }),
    drafter: stubDrafter()
  });
  assert.equal(plan.shape, 'winback');
  assert.equal(plan.discountPercent, 15, 'a win-back defaults to 15, not to whatever a model fancies');
  assert.equal(plan.audience.matchedCount, 120);
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.ready, true);
});

test('a thank-you plan offers nothing, however the model feels about it', async () => {
  const plan = await planCampaign({
    client: stubClient(),
    brief: 'thank our most loyal customers',
    segments: stubSegments({ matched: 200 }),
    drafter: stubDrafter()
  });
  // A model asked to design a discount designs a generous one, because nothing
  // in the prompt costs it anything. The offer is the business's decision.
  assert.equal(plan.discountPercent, null);
});

test('an audience below the floor is warned about and is not ready', async () => {
  const plan = await planCampaign({
    client: stubClient(),
    brief: 'clearance on the last few',
    segments: stubSegments({ matched: 4 }),
    drafter: stubDrafter()
  });
  const floor = plan.warnings.find(w => w.code === 'below_floor');
  assert.ok(floor, 'four people is not a campaign and the plan must say so');
  assert.match(floor.message, /below the 25/);
});

test('an empty audience is not ready even with good copy', async () => {
  const plan = await planCampaign({
    client: stubClient(),
    brief: 'clearance on something nobody bought',
    segments: stubSegments({ matched: 0 }),
    drafter: stubDrafter()
  });
  assert.equal(plan.ready, false);
});

test('a failed audience still returns the copy, and the reverse', async () => {
  // A proposal with three quarters of its parts is useful; a blank screen is
  // not, so each stage fails on its own.
  const noAudience = await planCampaign({
    client: stubClient(),
    brief: 'something the segment writer cannot parse',
    segments: stubSegments({ throws: 'too short' }),
    drafter: stubDrafter()
  });
  assert.equal(noAudience.audience, null);
  assert.ok(noAudience.audienceError.message);
  assert.equal(noAudience.copy.length, 1, 'the copy still came back');
  assert.equal(noAudience.ready, false);

  const noCopy = await planCampaign({
    client: stubClient(),
    brief: 'win back the people who stopped',
    segments: stubSegments({ matched: 90 }),
    drafter: async () => { throw new Error('model down'); }
  });
  assert.equal(noCopy.audience.matchedCount, 90, 'the audience still came back');
  assert.ok(noCopy.copyError.message);
  assert.equal(noCopy.ready, false);
});

test('every draft being rejected says so rather than looking empty', async () => {
  const plan = await planCampaign({
    client: stubClient(),
    brief: 'win back the people who stopped',
    segments: stubSegments({ matched: 90 }),
    drafter: stubDrafter([])
  });
  assert.equal(plan.copyError.code, 'ALL_DRAFTS_REJECTED');
  assert.equal(plan.ready, false);
});

test('an empty brief is refused before anything is called', async () => {
  await assert.rejects(
    () => planCampaign({ client: stubClient(), brief: '   ', segments: stubSegments() }),
    /Say what the campaign should do/
  );
});

test('the planner writes nothing', () => {
  // It proposes. A plan a model wrote from one sentence is exactly what a
  // person should read before a segment and a campaign exist.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'planner.js'), 'utf8'
  );
  for (const forbidden of ['createFromRules', 'create_sms_campaign', '.insert(', '.update(']) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not appear in the planner`);
  }
});
