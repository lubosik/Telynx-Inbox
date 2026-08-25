'use strict';
/**
 * Turning one opportunity into several genuinely different campaign proposals.
 *
 * THE MODEL IS MOCKED ENTIRELY AND NOTHING HERE TOUCHES THE NETWORK. Every
 * test injects a `completion` function, so lib/openrouter-private.js is never
 * called and OPENROUTER_API_KEY is never read.
 *
 * FIVE PROPERTIES THIS FILE EXISTS TO PROVE
 *   1. Several proposals come back, and they differ by MECHANISM, not by
 *      wording. Three rewordings of one offer is the failure being guarded.
 *   2. A draft that fails the existing copy validator is never surfaced, is
 *      never repaired, and its text never leaves the process.
 *   3. The model produces no numbers. A rationale carrying a digit is refused
 *      rather than trimmed.
 *   4. No customer data reaches the prompt, and neither does any figure.
 *   5. Nothing here writes, schedules, approves or sends anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_COPY_SIMILARITY,
  ProposalDraftError,
  buildAudience,
  checkRationale,
  contentTokens,
  draftProposals,
  offerFor,
  parseDrafts,
  proposalsEnabled,
  similarity
} = require('../lib/campaigns/proposal-writer');
const { MECHANISMS, selectMechanisms, DEFAULT_MECHANISM_LIMIT } = require('../lib/campaigns/proposal-mechanisms');
const { normaliseOpportunity } = require('../lib/campaigns/opportunity-contract');

// The sender's name is a BUSINESS DECISION and it has already changed once,
// from "Vici" to "Vin from Vici". Fixtures that hardcode it turn every one of
// these tests into a test of the current name, so 30 of them failed on a
// two-word copy change that broke nothing. Read it from the rules instead: the
// name can change again and only the rule file needs editing.
const { RULES: COPY_RULES } = require('../lib/campaigns/copy-rules');
const BRAND = COPY_RULES.brand.defaultName;


const ON = { CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED: 'true' };

const PRODUCTS = [
  { productID: 41, variationID: 0, name: 'BPC-157' },
  { productID: 42, variationID: 0, name: 'TB-500' }
];

/** Compliant drafts, one per mechanism. Each passes the real validator. */
const DRAFTS = {
  plain_check_in: {
    message: `${BRAND}: we are here if you need anything from us. Reply STOP to opt out.`,
    rationale: 'This group may simply never have heard from the business again after their first order.'
  },
  product_education: {
    message: `${BRAND}: happy to answer any question about our range, just reply here. Reply STOP to opt out.`,
    rationale: 'A buyer who is unsure what pairs with what tends to stop rather than ask.'
  },
  ask_what_stopped_them: {
    message: `${BRAND}: how did things go with us, reply and let us know. Reply STOP to opt out.`,
    rationale: 'A written answer from one person tells the business more than a rate on a group this size.'
  },
  free_shipping: {
    message: `${BRAND}: there is something waiting on your next order, details on our site. Reply STOP to opt out.`,
    rationale: 'Shipping is a cost the customer meets at checkout without having chosen it.'
  },
  bundle: {
    message: `${BRAND}: there is a pairing in the range worth a look, ask us for details. Reply STOP to opt out.`,
    rationale: 'Changing what is on the table is different from changing what it costs.'
  },
  // THE TWO PERSONALISED ARMS. Both carry variables and both state their
  // offer, which is what the loosened copy rules exist to permit.
  loyalty_thank_you: {
    message: `${BRAND}: Hi {{first_name}}, {{order_count}} orders in and we appreciate you. Code {{code}} for 15% off. Reply STOP to opt out.`,
    rationale: 'Somebody who has ordered several times has already decided about this business, and noticing costs nothing until it is redeemed.'
  },
  winback_personal: {
    message: `${BRAND}: Hi {{first_name}}, it has been a while. Code {{code}} for 15% off your next one. Reply STOP to opt out.`,
    rationale: 'The largest cohort in the list bought once and stopped, and this is the cheapest test of whether that was indifference or forgetting.'
  },
  first_reorder_incentive: {
    message: `${BRAND}: something is set aside for you, ask us and we will explain. Reply STOP to opt out.`,
    rationale: 'The strongest short term lever, and the one that costs the most later.'
  }
};

function reply(mechanismIDs, overrides = {}) {
  return JSON.stringify(mechanismIDs.map(id => ({
    mechanism: id,
    message: overrides[id]?.message ?? DRAFTS[id].message,
    rationale: overrides[id]?.rationale ?? DRAFTS[id].rationale
  })));
}

function stubCompletion(content) {
  const calls = [];
  const completion = async request => {
    calls.push(request);
    return { content, model: 'test/model' };
  };
  completion.calls = calls;
  return completion;
}

function neverCalled() {
  const completion = async () => { throw new Error('the model must not be called'); };
  completion.calls = [];
  return completion;
}

function opportunity(overrides = {}) {
  return {
    id: 'one_time_buyers_no_second_order',
    kind: 'repeat_purchase',
    title: 'Most buyers have ordered once and not come back',
    cohort: {
      key: 'one_time_buyers',
      label: 'One-time buyers',
      size: 700,
      sizeBasis: 'Customers with exactly one paid order.',
      segmentKey: 'one_time_buyers',
      definition: {
        match: 'all',
        conditions: [{ dimension: 'order_count', operator: 'equals', value: 1 }]
      }
    },
    facts: [],
    sizing: {
      reachable: 412,
      reachableBasis: 'Cohort members with a phone number and no STOP on record.',
      confidence: 'low',
      assumptions: [{
        id: 'second_purchase_rate',
        statement: 'One in twenty of the reachable cohort places a second order within ninety days',
        source: 'Assumed for illustration; no measured rate exists for this list.'
      }],
      scenarios: [{
        id: 'second_orders_at_assumed_rate',
        label: 'Second orders at the stated rate',
        assumptionId: 'second_purchase_rate',
        value: 20,
        unit: 'orders'
      }]
    },
    ...overrides
  };
}

async function draft({ mechanisms = ['plain_check_in', 'product_education', 'ask_what_stopped_them', 'free_shipping'],
  overrides = {}, input = {}, env = ON, content } = {}) {
  const completion = stubCompletion(content ?? reply(mechanisms, overrides));
  const result = await draftProposals(
    { opportunity: opportunity(), products: PRODUCTS, segments: [], ...input },
    { env, completion }
  );
  return { result, completion };
}

// ── The brake ───────────────────────────────────────────────────────────────

test('the flag is off unless it is exactly the lowercase string true', () => {
  for (const value of ['1', 'TRUE', 'True', 'yes', 'on', '', undefined]) {
    assert.equal(proposalsEnabled({ CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED: value }), false, `"${value}" must be off`);
  }
  assert.equal(proposalsEnabled(ON), true);
});

test('with the flag off nothing is drafted and no model is reached', async () => {
  await assert.rejects(
    draftProposals({ opportunity: opportunity() }, { env: {}, completion: neverCalled() }),
    error => error instanceof ProposalDraftError && error.code === 'CAMPAIGN_PROPOSALS_DISABLED'
  );
});

// ── Several proposals, and they actually differ ─────────────────────────────

test('one opportunity produces several proposals with different mechanisms', async () => {
  const { result } = await draft();
  assert.equal(result.returned, 4);
  const ids = result.proposals.map(item => item.mechanism);
  assert.equal(new Set(ids).size, 4);
  const classes = result.proposals.map(item => item.distinctnessClass);
  assert.equal(new Set(classes).size, 4);
});

test('the set always contains a no-offer arm and at most one monetary arm', async () => {
  const all = Object.keys(MECHANISMS);
  // Ask selection what it will actually offer, rather than assuming the whole
  // catalogue. It gates by cohort now, and this fixture is a one-time-buyer
  // opportunity, so the loyalty arm is correctly absent and a stub naming it
  // would be a reply to a question nobody asked.
  const offered = selectMechanisms({ limit: 6, opportunity: opportunity() }).map(m => m.id);
  const { result } = await draft({ mechanisms: offered, input: { mechanismLimit: 6 } });
  assert.ok(all.length > offered.length, 'not every mechanism suits every cohort');
  const withoutOffer = result.proposals.filter(item => item.offer.kind === 'none');
  const monetary = result.proposals.filter(item => item.offer.kind === 'monetary_discount');
  assert.ok(withoutOffer.length >= 1);
  assert.ok(monetary.length <= 1);
});

test('the mechanisms differ in kind, not only in words: offers, costs and risks all differ', async () => {
  const offered = selectMechanisms({ limit: 6, opportunity: opportunity() }).map(m => m.id);
  const { result } = await draft({ mechanisms: offered, input: { mechanismLimit: 6 } });
  const offerKinds = new Set(result.proposals.map(item => item.offer.kind));
  assert.ok(offerKinds.size >= 3, 'at least three different offer kinds, including none');
  const riskIDs = new Set(result.proposals.flatMap(item => item.risks.map(risk => risk.id)));
  assert.ok(riskIDs.size >= 5, 'the arms must not share one risk profile');
});

test('MUTATION: three rewordings of one message yield ONE proposal, not three', async () => {
  // The exact failure the owner named. Same substance, different words, three
  // different mechanisms. Only the first survives; the rest are refused as
  // not distinct, naming what they duplicated.
  const { result } = await draft({
    overrides: {
      product_education: { message: `${BRAND}: we are here if you need anything at all from us. Reply STOP to opt out.` },
      ask_what_stopped_them: { message: `${BRAND}: if you need anything from us we are here. Reply STOP to opt out.` }
    }
  });
  assert.equal(result.returned, 2, 'only the first of the three near-duplicates, plus the genuinely different one');
  const notDistinct = result.refused.filter(item => item.stage === 'distinctness');
  assert.equal(notDistinct.length, 2);
  assert.equal(notDistinct[0].tooSimilarTo, 'plain_check_in');
});

test('the similarity measure separates a reworded message from a different one', () => {
  const brand = 'Vici';
  const a = contentTokens(DRAFTS.free_shipping.message, brand);
  const reworded = contentTokens(
    `${BRAND}: something is waiting on your next order, details are on our site. Reply STOP to opt out.`, brand
  );
  const different = contentTokens(DRAFTS.plain_check_in.message, brand);
  assert.ok(similarity(a, reworded) >= MAX_COPY_SIMILARITY, 'a reword must read as a duplicate');
  assert.ok(similarity(a, different) < MAX_COPY_SIMILARITY, 'a different mechanism must not');
});

// ── The validator gate ──────────────────────────────────────────────────────

test('MUTATION: a draft that fails the copy validator is never surfaced', async () => {
  const { result } = await draft({
    overrides: {
      free_shipping: { message: `${BRAND}: FREE shipping today only, save 20% now. Reply STOP to opt out.` }
    }
  });
  assert.equal(result.proposals.some(item => item.mechanism === 'free_shipping'), false);
  const refusal = result.refused.find(item => item.mechanism === 'free_shipping');
  assert.equal(refusal.stage, 'copy_validator');
  assert.ok(refusal.failedChecks.length > 0);
});

test('MUTATION: the text of a rejected draft never leaves the process', async () => {
  const poison = `${BRAND}: this cures everything, guaranteed. Reply STOP to opt out.`;
  const { result } = await draft({ overrides: { plain_check_in: { message: poison } } });
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('cures everything'), false, 'a rejected draft must not appear anywhere in the payload');
  assert.equal(serialised.includes(poison), false);
  const refusal = result.refused.find(item => item.mechanism === 'plain_check_in');
  assert.ok(refusal.reasons.length > 0, 'the reviewer is told which rules failed');
  assert.ok(refusal.bannedTerms.includes('cure') || refusal.bannedTerms.includes('guaranteed'));
});

test('MUTATION: a health claim is refused even when every other rule passes', async () => {
  const { result } = await draft({
    overrides: {
      product_education: { message: `${BRAND}: our range is clinically proven to help. Reply STOP to opt out.` }
    }
  });
  assert.equal(result.proposals.some(item => item.mechanism === 'product_education'), false);
});

test('nothing is auto-repaired: a failing draft produces a refusal, never a fixed message', async () => {
  const { result } = await draft({
    overrides: { plain_check_in: { message: `${BRAND}: hurry, last chance. Reply STOP to opt out.` } }
  });
  assert.equal(result.proposals.length, 3);
  assert.equal(result.proposals.some(item => /hurry/i.test(item.copy.text)), false);
  assert.equal(result.refused.some(item => item.mechanism === 'plain_check_in'), true);
});

test('every surfaced proposal carries validated copy with no failed checks', async () => {
  const { result } = await draft();
  for (const proposal of result.proposals) {
    assert.equal(proposal.copy.validated, true);
    assert.deepEqual(proposal.copy.failedChecks, []);
    assert.ok(proposal.copy.septets <= 160);
    assert.equal(proposal.copy.gsm7, true);
  }
});

// ── The model writes no numbers ─────────────────────────────────────────────

test('MUTATION: a rationale containing a digit refuses the whole proposal', async () => {
  const { result } = await draft({
    overrides: { free_shipping: { rationale: 'About 15 percent of this group should come back.' } }
  });
  assert.equal(result.proposals.some(item => item.mechanism === 'free_shipping'), false);
  const refusal = result.refused.find(item => item.mechanism === 'free_shipping');
  assert.equal(refusal.stage, 'rationale');
  assert.ok(refusal.reasons.includes('rationale_contains_a_number'));
});

test('a rationale that drifts into a health claim is refused', () => {
  const verdict = checkRationale('This group would recover faster with a treatment they can trust.');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes('rationale_uses_a_banned_term'));
});

test('a rationale carrying a link or a template glyph is refused', () => {
  assert.equal(checkRationale('Send them to https://example.com for details.').ok, false);
  assert.equal(checkRationale('Use the {{first_name}} field for warmth.').ok, false);
});

test('a plain rationale is accepted unchanged, never trimmed into shape', () => {
  const text = 'This group has no ordering rhythm, so nothing can be framed as a reminder.';
  const verdict = checkRationale(text);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.text, text);
});

test('no proposal exposes a figure the model wrote; every figure has a basis', async () => {
  const { result } = await draft();
  for (const proposal of result.proposals) {
    assert.equal(/\d/.test(proposal.reasoning.modelRationale), false);
    for (const projection of proposal.projections) {
      assert.ok(projection.basis, `${projection.id} carries no basis`);
      assert.equal(/revenue/i.test(projection.label), false);
    }
  }
});

// ── Nothing personal reaches the prompt ─────────────────────────────────────

test('the prompt carries no customer identity, no count and no money', async () => {
  const { completion } = await draft();
  // The USER message is the only part that carries anything about this
  // business. The SYSTEM message is the constant compliance rule block, and it
  // contains an at sign on purpose: rule 17 quotes "S@ve" as an example of the
  // substitution it forbids. Screening it here would mean screening the rules.
  const user = completion.calls[0].messages[1].content;
  assert.equal(/\+?\d[\d().\-\s]{7,}\d/.test(user), false, 'a phone-shaped run reached the prompt');
  assert.equal(/@/.test(user), false, 'an at sign reached the prompt');
  assert.equal(/\d/.test(user), false, 'a digit of any kind reached the prompt');
  assert.equal(/[$£€]/.test(user), false, 'a currency symbol reached the prompt');
  assert.deepEqual(completion.calls[0].sensitiveValues, []);
});

test('the compliance rules reach the prompt verbatim, never paraphrased', async () => {
  const { RULES, renderPromptRules } = require('../lib/campaigns/copy-rules');
  const { completion } = await draft();
  const system = completion.calls[0].messages[0].content;
  assert.ok(system.includes(renderPromptRules()));
  for (const rule of RULES.promptRules) assert.ok(system.includes(rule), `missing rule: ${rule.slice(0, 40)}`);
});

test('an opportunity that carries a customer is refused before any model call', async () => {
  const poisoned = opportunity({ title: 'Sarah on 555 123 4567 never came back' });
  await assert.rejects(
    draftProposals({ opportunity: poisoned }, { env: ON, completion: neverCalled() })
  );
});

test('an unexpected input key is refused, because recipients are server-owned', async () => {
  await assert.rejects(
    draftProposals(
      { opportunity: opportunity(), recipients: ['+15550001111'] },
      { env: ON, completion: neverCalled() }
    ),
    error => error.code === 'CAMPAIGN_PROPOSALS_INPUT_REJECTED'
  );
});

// ── Malformed model output ──────────────────────────────────────────────────

test('prose instead of JSON produces no proposals and a refusal for each mechanism', async () => {
  const { result } = await draft({ content: 'Here are some great ideas for you!' });
  assert.equal(result.returned, 0);
  // One refusal per mechanism the writer actually asked about, which is the
  // default limit rather than a hardcoded four. That default moved from four
  // to six so the personalised arms are always offered.
  assert.equal(result.refused.length, DEFAULT_MECHANISM_LIMIT);
  assert.ok(result.refused.every(item => item.reasons.includes('model_wrote_nothing_for_this_mechanism')));
});

test('a mechanism the model invented is ignored rather than proposed', async () => {
  const content = JSON.stringify([
    { mechanism: 'aggressive_discount', message: DRAFTS.plain_check_in.message, rationale: DRAFTS.plain_check_in.rationale },
    { mechanism: 'plain_check_in', message: DRAFTS.plain_check_in.message, rationale: DRAFTS.plain_check_in.rationale }
  ]);
  const { result } = await draft({ content });
  assert.deepEqual(result.proposals.map(item => item.mechanism), ['plain_check_in']);
});

test('a fenced JSON block is accepted; malformed JSON yields nothing', () => {
  assert.equal(parseDrafts('```json\n[{"mechanism":"a","message":"m"}]\n```').length, 1);
  assert.deepEqual(parseDrafts('{not json'), []);
  assert.deepEqual(parseDrafts('{"mechanism":"a"}'), []);
  assert.deepEqual(parseDrafts('[{"mechanism":"a"}]'), []);
});

test('an unreachable model produces no proposals and a stated refusal', async () => {
  const completion = async () => { throw new Error('socket hang up'); };
  await assert.rejects(
    draftProposals({ opportunity: opportunity() }, { env: ON, completion }),
    error => error.code === 'CAMPAIGN_PROPOSALS_UNAVAILABLE'
  );
});

// ── The audience ────────────────────────────────────────────────────────────

test('the cohort rules go through the same segment validator as everything else', () => {
  const built = buildAudience(
    normaliseOpportunity(opportunity()), MECHANISMS.plain_check_in, { products: PRODUCTS, segments: [] }
  );
  assert.equal(built.ok, true);
  assert.equal(built.audience.kind, 'rules');
  assert.ok(built.audience.plainEnglish.length > 0);
  assert.equal(built.audience.requiresSegment, false);
});

test('a cohort definition the segment validator refuses produces a refusal, not a wider audience', async () => {
  const broken = opportunity();
  broken.cohort.definition = {
    match: 'all',
    conditions: [{ dimension: 'likelihood_to_buy', operator: 'at_least', value: 3 }]
  };
  const { result } = await draft({ input: { opportunity: broken } });
  assert.equal(result.returned, 0);
  assert.ok(result.refused.every(item => item.stage === 'audience'));
  assert.ok(result.refused[0].errors.length > 0);
});

test('an audience is narrowed only when the detector supplied the fact, and says so when it did not', () => {
  const withoutAnchor = normaliseOpportunity(opportunity());
  const plain = buildAudience(withoutAnchor, MECHANISMS.bundle, { products: PRODUCTS, segments: [] });
  assert.equal(plain.audience.narrowedBy, null);
  assert.match(plain.audience.narrowingSkipped, /invents a threshold/);

  const raw = opportunity();
  raw.cohort.anchorProductKey = '41:0';
  const narrowed = buildAudience(normaliseOpportunity(raw), MECHANISMS.bundle, { products: PRODUCTS, segments: [] });
  assert.equal(narrowed.ok, true);
  assert.ok(narrowed.audience.narrowedBy);
  assert.equal(narrowed.audience.ruleSet.conditions.length, 2);
  assert.match(narrowed.audience.plainEnglish, /BPC-157/);
});

test('a cohort with no saved segment is readable but marked as needing one', () => {
  const raw = opportunity();
  raw.cohort.segmentKey = null;
  const built = buildAudience(normaliseOpportunity(raw), MECHANISMS.plain_check_in, { products: PRODUCTS, segments: [] });
  assert.equal(built.audience.requiresSegment, true);
  assert.equal(built.audience.segmentKey, null);
});

// ── Offers stay out of the copy ─────────────────────────────────────────────

test('an offer is structured, and the copy states only what it is allowed to', async () => {
  // This asserted statedInCopy === false everywhere and that no copy contained
  // a percentage. Both were true and neither is now: two mechanisms exist
  // specifically to say "15% off with this code". What did NOT change is that a
  // human still decides the terms, and that a currency amount and the carrier
  // trigger words are still refused.
  const offered = selectMechanisms({ limit: 6, opportunity: opportunity() }).map(m => m.id);
  const { result } = await draft({ mechanisms: offered, input: { mechanismLimit: 6 } });
  for (const proposal of result.proposals) {
    if (proposal.offer.kind === 'none') {
      assert.equal(proposal.offer.statedInCopy, false);
      continue;
    }
    assert.equal(proposal.offer.appliedBy, 'human_at_review');
    assert.ok(proposal.offer.termsRequiredFromHuman.length >= 3);
    // Still refused, in every arm, stated offer or not.
    assert.equal(/\$|£|€|\bfree\b|\bdiscount\b/i.test(proposal.copy.text), false,
      `${proposal.mechanism} used a currency amount or a carrier trigger word`);
    // An arm that says it states its offer must actually hand over a code.
    if (proposal.offer.statedInCopy) {
      assert.match(proposal.copy.text, /\{\{code\}\}/,
        `${proposal.mechanism} announces an offer with no code to use`);
    }
  }
});

test('a no-offer proposal says out loud that it is the arm without one', () => {
  const offer = offerFor(MECHANISMS.plain_check_in);
  assert.equal(offer.kind, 'none');
  assert.match(offer.note, /whether this cohort needs one/);
});

test('a monetary proposal carries the discount-training risk where a reviewer will read it', async () => {
  // Which monetary arm is offered depends on the cohort now, so the test asks
  // rather than naming one. What must hold for whichever arrives is that the
  // cost it defers onto later orders is stated in the proposal a person reads.
  const offered = selectMechanisms({ limit: 6, opportunity: opportunity() }).map(m => m.id);
  const { result } = await draft({ mechanisms: offered, input: { mechanismLimit: 6 } });
  const monetary = result.proposals.filter(item => item.offer.kind === 'monetary_discount');
  assert.equal(monetary.length, 1, 'exactly one arm may cost margin');
  assert.ok(monetary[0].risks.some(risk => risk.id === 'discount_trains_waiting'),
    `${monetary[0].mechanism} hides the cost of training people to wait`);
});

// ── It is a proposal, and it says so ────────────────────────────────────────

test('every proposal is a draft: status proposed, and the review requirements are in the payload', async () => {
  const { result } = await draft();
  for (const proposal of result.proposals) {
    assert.equal(proposal.status, 'proposed');
    assert.ok(proposal.reviewRequirements.includes('a_proposal_is_not_a_campaign'));
    assert.ok(proposal.reviewRequirements.includes(
      'accepting_creates_a_draft_that_still_needs_the_normal_approval_path'
    ));
  }
});

test('the reasoning distinguishes the model sentence from the business premise', async () => {
  const { result } = await draft();
  for (const proposal of result.proposals) {
    assert.equal(proposal.reasoning.rationaleAuthor, 'model');
    assert.ok(proposal.reasoning.mechanismPremise.length > 0);
    assert.equal(proposal.reasoning.evidenceStatus, 'awaiting_research');
  }
});

test('drafting reaches no database and creates no campaign', async () => {
  // The module holds no client at all: if it required db.js this would throw
  // on a missing SUPABASE_URL long before a proposal came back.
  const { result } = await draft();
  assert.ok(result.proposals.length > 0);
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'proposal-writer.js'), 'utf8'
  );
  assert.equal(/require\(['"]\.\.\/\.\.\/db['"]\)/.test(source), false);
  assert.equal(/create_sms_campaign_draft/.test(source), false);
});
