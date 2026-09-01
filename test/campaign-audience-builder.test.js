'use strict';
/**
 * test/campaign-audience-builder.test.js — building a campaign from a recipe,
 * and above all NOT building one for somebody who already had it.
 *
 * The dedupe is the reason this module exists. Cohorts do not know who has
 * been messaged: `one_time_lapsed` hands back the same 278 people next month
 * minus whoever ordered, so a second run without this sends the same personal
 * discount to the same person. Most of these tests are about that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { RECIPE_KEYS, recipe, recipeCatalogue } = require('../lib/campaigns/recipes');
const { buildFromRecipe } = require('../lib/campaigns/audience-builder');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');
const { fieldsUsed } = require('../lib/campaigns/merge-fields');

const OFFLINE_SKUS = new Map([['RT20', 'RT']]);
const NOW = new Date('2026-09-01T12:00:00Z');

/**
 * Supabase-shaped stub.
 *
 * `segmentMembers`, `priorCampaigns` and `priorRecipients` are the three reads
 * the builder makes before it decides anything, so they are the only three
 * things worth controlling.
 */
/**
 * A stand-in for a Supabase result that is both awaitable and pageable.
 *
 * The real client offers `.range()`; a fake that only resolved could never
 * express a 1000-row page, which is exactly why these fakes never caught
 * readIn truncating a chunk.
 */
function pageable(rows) {
  return {
    range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
    then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); }
  };
}

function stubClient({
  segments = [{ id: 'seg-1', segment_key: 'one_time_lapsed', member_count: 3 }],
  segmentMembers = [],
  priorCampaigns = [],
  priorRecipients = [],
  contacts = [],
  orders = [],
  created = [],
  updates = []
} = {}) {
  return {
    created,
    updates,
    from(table) {
      if (table === 'sms_campaign_segments') {
        const b = { select: () => b, in: () => b, eq: () => b, is: () => Promise.resolve({ data: segments, error: null }) };
        return b;
      }
      if (table === 'sms_campaign_segment_members') {
        const b = { select: () => b, eq: () => b, range: (f) => Promise.resolve({ data: f === 0 ? segmentMembers : [], error: null }) };
        return b;
      }
      if (table === 'sms_campaigns') {
        const b = {
          select: () => b,
          eq: () => b,
          gte: () => Promise.resolve({ data: priorCampaigns, error: null }),
          // buildFromSegment stamps discount_percent on the new draft, because
          // approval mints at the application default otherwise.
          update: (row) => { updates.push(row); return b; }
        };
        return b;
      }
      if (table === 'sms_campaign_recipients') {
        const b = { select: () => b, eq: () => b, range: (f) => Promise.resolve({ data: f === 0 ? priorRecipients : [], error: null }) };
        return b;
      }
      if (table === 'sms_contacts') {
        const b = { select: () => b, in: () => pageable(contacts) };
        return b;
      }
      // sms_orders
      const b = { select: () => b, in: () => pageable(orders) };
      return b;
    },
    rpc(_name, params) {
      created.push(params);
      return Promise.resolve({ data: { id: `camp-${created.length}`, title: params.p_title }, error: null });
    }
  };
}

const person = (n) => `+1555${String(n).padStart(7, '0')}`;

/** Enough people to clear MINIMUM_MARKETING_AUDIENCE without listing 30 by hand. */
const manyPeople = (count) => Array.from({ length: count }, (_, i) => i + 1);
const contactRow = (n) => ({ phone: person(n), name: `Person ${n}` });
const orderRow = (n) => ({
  contact_phone: person(n), items: [{ sku: 'RT20', total: '130' }],
  created_at: '2026-07-04T00:00:00Z', status: 'delivered'
});

// ── The recipes themselves ─────────────────────────────────────────────────

test('every recipe carries both copy variants and a dedupe window', () => {
  for (const key of RECIPE_KEYS) {
    const found = recipe(key);
    assert.ok(found.copy.named && found.copy.plain, `${key} needs both variants`);
    // Mandatory: without it a rerun re-messages the same people.
    assert.ok(Number.isInteger(found.dedupeDays) && found.dedupeDays > 0,
      `${key} must declare a dedupe window`);
  }
});

test('every recipe template is compliant copy at the worst case', () => {
  for (const key of RECIPE_KEYS) {
    const found = recipe(key);
    for (const [variant, template] of Object.entries(found.copy)) {
      const verdict = validateCopy(template, {
        brandName: RULES.brand.defaultName,
        approvedProductCodes: RULES.defaultApprovedProductCodes
      });
      assert.equal(verdict.ok, true,
        `${key}.${variant}: ${JSON.stringify((verdict.failures || []).map(f => f.check))}`);
      assert.match(template, /Reply STOP to opt out/);
    }
  }
});

test('a recipe that offers nothing has no {{code}}, and one that offers has one', () => {
  for (const key of RECIPE_KEYS) {
    const found = recipe(key);
    for (const template of Object.values(found.copy)) {
      const usesCode = fieldsUsed(template).includes('code');
      assert.equal(usesCode, found.discountPercent !== null,
        `${key}: a discount and a {{code}} must agree`);
    }
  }
});

test('only the named variant may reference the product', () => {
  for (const key of RECIPE_KEYS) {
    const found = recipe(key);
    assert.ok(fieldsUsed(found.copy.named).includes('last_product'), `${key}.named should name it`);
    // The whole point of the plain variant: it exists for people whose product
    // has no approved code, so referencing it would defeat the split.
    assert.equal(fieldsUsed(found.copy.plain).includes('last_product'), false,
      `${key}.plain must not reference the product`);
  }
});

test('the catalogue is safe to return from an API', () => {
  const catalogue = recipeCatalogue();
  assert.equal(catalogue.length, RECIPE_KEYS.length);
  for (const entry of catalogue) {
    // No copy, no templates: the app shows descriptions, and the words that
    // reach customers stay server-side until a draft exists.
    assert.equal(entry.copy, undefined);
    assert.ok(entry.name && entry.description && entry.dedupeDays);
  }
});

// ── The dedupe, which is the point ─────────────────────────────────────────

test('somebody who already had this recipe is left out', async () => {
  const client = stubClient({
    segmentMembers: [1, 2, 3].map(n => ({ contact_phone: person(n) })),
    priorCampaigns: [{ id: 'old-1', status: 'completed', created_at: '2026-08-01T00:00:00Z' }],
    priorRecipients: [{ contact_phone: person(1) }, { contact_phone: person(2) }],
    contacts: [1, 2, 3].map(contactRow),
    orders: [1, 2, 3].map(orderRow)
  });
  const result = await buildFromRecipe({
    client, recipeKey: 'winback_one_time', now: NOW, dryRun: true
  });
  assert.equal(result.candidates, 3);
  assert.equal(result.suppressedAsDuplicate, 2);
  assert.equal(result.audience, 1);
});

test('everybody having had it produces no drafts and says why', async () => {
  const client = stubClient({
    segmentMembers: [1, 2].map(n => ({ contact_phone: person(n) })),
    priorCampaigns: [{ id: 'old-1', status: 'completed', created_at: '2026-08-01T00:00:00Z' }],
    priorRecipients: [1, 2].map(n => ({ contact_phone: person(n) }))
  });
  const result = await buildFromRecipe({ client, recipeKey: 'winback_one_time', now: NOW });
  assert.equal(result.audience, 0);
  assert.equal(result.created.length, 0);
  // Silence would read as a bug. The reason has to be on screen.
  assert.match(result.note, /already had this campaign in the last 180 days/);
  assert.equal(client.created.length, 0, 'nothing may be written when nobody qualifies');
});

test('a cancelled campaign does not block anybody, because nothing was sent', async () => {
  const client = stubClient({
    segmentMembers: [{ contact_phone: person(1) }],
    priorCampaigns: [{ id: 'old-1', status: 'cancelled', created_at: '2026-08-01T00:00:00Z' }],
    priorRecipients: [{ contact_phone: person(1) }],
    contacts: [contactRow(1)],
    orders: [orderRow(1)]
  });
  const result = await buildFromRecipe({ client, recipeKey: 'winback_one_time', now: NOW, dryRun: true });
  assert.equal(result.suppressedAsDuplicate, 0);
  assert.equal(result.audience, 1);
});

test('a draft counts as already reached, so two drafts cannot target one person', async () => {
  const client = stubClient({
    segmentMembers: [{ contact_phone: person(1) }],
    // Not sent yet, but about to be approved. Building a second draft for the
    // same person is the exact failure this prevents.
    priorCampaigns: [{ id: 'draft-1', status: 'draft', created_at: '2026-08-30T00:00:00Z' }],
    priorRecipients: [{ contact_phone: person(1) }]
  });
  const result = await buildFromRecipe({ client, recipeKey: 'winback_one_time', now: NOW, dryRun: true });
  assert.equal(result.suppressedAsDuplicate, 1);
  assert.equal(result.audience, 0);
});

// ── Building ───────────────────────────────────────────────────────────────

test('a dry run writes nothing at all', async () => {
  const client = stubClient({
    segmentMembers: [1, 2].map(n => ({ contact_phone: person(n) })),
    contacts: [1, 2].map(contactRow),
    orders: [1, 2].map(orderRow)
  });
  const result = await buildFromRecipe({ client, recipeKey: 'winback_one_time', now: NOW, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(client.created.length, 0);
  assert.ok(result.created.length > 0, 'a dry run still reports what it would build');
});

test('a real build creates drafts and only drafts', async () => {
  const client = stubClient({
    segmentMembers: [1, 2].map(n => ({ contact_phone: person(n) })),
    contacts: [1, 2].map(contactRow),
    orders: [1, 2].map(orderRow)
  });
  const result = await buildFromRecipe({ client, recipeKey: 'winback_one_time', now: NOW });
  assert.ok(client.created.length >= 1);
  for (const call of client.created) {
    assert.equal(call.p_workflow_category, 'winback_one_time_buyer');
    assert.equal(call.p_campaign_type, 'manual');
    // The audience definition has to explain itself later.
    assert.equal(call.p_audience_definition.kind, 'recipe');
    assert.equal(call.p_audience_definition.dedupe_days, 180);
    assert.ok(Array.isArray(call.p_recipients) && call.p_recipients.length > 0);
  }
  assert.ok(result.created.every(row => row.id));
});

test('an unknown recipe is refused rather than guessed at', async () => {
  await assert.rejects(
    () => buildFromRecipe({ client: stubClient(), recipeKey: 'not_a_recipe' }),
    /Unknown campaign recipe/
  );
});

test('a segment that has never been computed says so instead of building nothing', async () => {
  // The difference that matters: "the daily cycle has not built this segment"
  // and "nobody qualifies" look identical from an empty audience, and only one
  // of them is a problem to fix.
  await assert.rejects(
    () => buildFromRecipe({ client: stubClient({ segments: [] }), recipeKey: 'winback_one_time' }),
    /None of these segments exist yet/
  );
});

// ── Any segment, not just the three recipes ────────────────────────────────

test('a campaign can be built from any saved segment with the owner\'s own copy', async () => {
  // The link that was missing. A segment can be described in words, turned
  // into rules by a model, previewed and saved; copy can be drafted by a
  // model; codes mint at approval. But a campaign's audience could only be
  // selected contacts, all contacts, or pasted numbers, so "clearance on RT
  // for people who bought it and went quiet" stopped at the last step.
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  // Thirty, because the floor refuses a promotional campaign below 25 and
  // this test is about the segment path rather than about the floor.
  const people = manyPeople(30);
  const client = stubClient({
    segments: [{ id: 'seg-1', segment_key: 'bought_rt_lapsed', member_count: people.length }],
    segmentMembers: people.map(n => ({ contact_phone: person(n) })),
    contacts: people.map(contactRow),
    orders: people.map(orderRow)
  });
  const result = await buildFromSegment({
    client,
    segmentKeys: ['bought_rt_lapsed'],
    title: 'Clearance on RT',
    workflowCategory: 'clearance',
    message: "It's Vin from Vici. Hi {{first_name}}, {{code}} is 25% off. Reply STOP to opt out.",
    discountPercent: 25,
    now: NOW
  });
  assert.equal(result.audience, 30);
  assert.equal(result.created.length, 1, 'one message means one draft, not a named and a plain');
  const call = client.created[0];
  assert.equal(call.p_workflow_category, 'clearance');
  assert.equal(call.p_audience_definition.discount_percent, 25);
  assert.equal(call.p_audience_definition.kind, 'segment');
  // On the row too, not only in the audience definition: renderAndFreeze reads
  // the column, so a discount recorded only as metadata mints at the default.
  assert.deepEqual(client.updates, [{ discount_percent: 25 }]);
});

test('a segment campaign dedupes against its own workflow category', async () => {
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  const people = manyPeople(30);
  const client = stubClient({
    segments: [{ id: 'seg-1', segment_key: 'bought_rt_lapsed', member_count: people.length }],
    segmentMembers: people.map(n => ({ contact_phone: person(n) })),
    priorCampaigns: [{ id: 'old', status: 'completed', created_at: '2026-08-20T00:00:00Z' }],
    priorRecipients: [{ contact_phone: person(1) }],
    contacts: people.map(contactRow),
    orders: people.map(orderRow)
  });
  const result = await buildFromSegment({
    client, segmentKeys: ['bought_rt_lapsed'], title: 'Clearance',
    workflowCategory: 'clearance', message: "It's Vin from Vici. Hi {{first_name}}. Reply STOP to opt out.",
    now: NOW, dryRun: true
  });
  // Two clearance campaigns a fortnight apart must not both reach one person.
  assert.equal(result.suppressedAsDuplicate, 1);
  assert.equal(result.audience, 29);
});

test('a segment build refuses without a segment or a message', async () => {
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  await assert.rejects(
    () => buildFromSegment({ client: stubClient(), segmentKeys: [], message: 'hi' }),
    /At least one segment is required/
  );
  await assert.rejects(
    () => buildFromSegment({ client: stubClient(), segmentKeys: ['x'], message: '   ' }),
    /A message is required/
  );
});

// ── The floor, and who is exempt from it ───────────────────────────────────

test('a promotional campaign to a handful of people is refused', async () => {
  // A send to four people is not a campaign, it is a mail merge with a coupon
  // budget: nothing about it can be measured and reviewing it costs more than
  // the outcome. Refused rather than warned, because a warning on a screen of
  // green ticks is a warning nobody reads.
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  const { MINIMUM_MARKETING_AUDIENCE } = require('../lib/campaigns/audience-health');
  const few = [1, 2, 3].map(n => ({ contact_phone: person(n) }));
  const client = stubClient({
    segments: [{ id: 'seg-1', segment_key: 'tiny', member_count: 3 }],
    segmentMembers: few,
    contacts: [1, 2, 3].map(contactRow),
    orders: [1, 2, 3].map(orderRow)
  });
  await assert.rejects(
    () => buildFromSegment({
      client, segmentKeys: ['tiny'], title: 'Tiny', workflowCategory: 'clearance',
      message: "It's Vin from Vici. Hi {{first_name}}. Reply STOP to opt out.", now: NOW
    }),
    (error) => {
      assert.equal(error.code, 'AUDIENCE_BELOW_MINIMUM');
      assert.match(error.message, new RegExp(`at least ${MINIMUM_MARKETING_AUDIENCE}`));
      return true;
    }
  );
  assert.equal(client.created.length, 0, 'nothing may be written when the floor is not met');
});

test('a check-in is exempt, because one person is a good reason to ask one person', async () => {
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  const client = stubClient({
    segments: [{ id: 'seg-1', segment_key: 'tiny', member_count: 1 }],
    segmentMembers: [{ contact_phone: person(1) }],
    contacts: [contactRow(1)],
    orders: [orderRow(1)]
  });
  const result = await buildFromSegment({
    client, segmentKeys: ['tiny'], title: 'Check in', workflowCategory: 'checkin_21d',
    message: "It's Vin from Vici. Hi {{first_name}}. Reply STOP to opt out.", now: NOW
  });
  assert.equal(result.audience, 1);
  assert.equal(result.created.length, 1);
});

test('an empty audience is reported, not refused as below the floor', async () => {
  // Zero and three are different problems and must not read the same. Zero
  // means the rules match nobody; three means they match too few.
  const { buildFromSegment } = require('../lib/campaigns/audience-builder');
  const client = stubClient({
    segments: [{ id: 'seg-1', segment_key: 'empty', member_count: 0 }],
    segmentMembers: []
  });
  const result = await buildFromSegment({
    client, segmentKeys: ['empty'], title: 'Empty', workflowCategory: 'clearance',
    message: "It's Vin from Vici. Reply STOP to opt out.", now: NOW
  });
  assert.equal(result.audience, 0);
  assert.equal(result.created.length, 0);
  assert.match(result.note, /Nobody/);
});
