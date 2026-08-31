'use strict';
/**
 * test/assistant-opportunity-conversion.test.js
 *
 * Why the assistant could never draft a campaign.
 *
 * The portfolio produces FINDINGS. Everything downstream of an opportunity id
 * consumes OPPORTUNITIES. They are different shapes, and the adapter in
 * routes/assistant.js handed findings straight through, which broke the same
 * feature in three places at once:
 *
 *   1. list_opportunities read `finding.id`. Findings have `key`. The model was
 *      shown a list of nulls and then asked to quote an id from it.
 *   2. read() compared `String(f.id) === String(id)`, so undefined was matched
 *      against every id there is, and it returned null for all of them.
 *   3. and had either worked, the contract would have refused the raw finding:
 *      "Unexpected opportunity field: key, segmentKey, population, ..."
 *
 * These tests use the real converter against finding-shaped fixtures, so a
 * change to either shape fails here rather than in a conversation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opportunityFromFinding, normaliseOpportunity } = require('../lib/campaigns/opportunity-contract');

/** Source without comments, so prose about a bug is not mistaken for the bug. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The real shape, read from the production portfolio on 2026-08-25. */
const FINDING = Object.freeze({
  key: 'one_time_buyers',
  segmentKey: 'one_time_buyers',
  title: 'Bought once and never came back',
  population: 511,
  actionability: { people: 511, floor: 100, belowFloor: false, note: 'At least 100 people.' },
  evidence: {
    countedAt: 'customer',
    people: {
      kind: 'observed', label: 'People in Bought once and never came back',
      countedFrom: '1305 paid orders across 792 buyers, counted per person and never per product pair.',
      people: 511, neverContacted: 511
    }
  },
  observed: {},
  sizing: null
});

test('a finding is NOT an opportunity, and the contract says so out loud', () => {
  // The failure that was happening in production, pinned. If this ever starts
  // passing, the contract has been loosened and the assistant will be able to
  // send customer evidence to a model provider.
  assert.throws(
    () => normaliseOpportunity(FINDING),
    (error) => /Unexpected opportunity field/.test(error.message)
      && /key/.test(error.message),
    'passing a raw finding to the contract must be refused'
  );
});

test('the converter produces the id draft_campaign needs', () => {
  const result = opportunityFromFinding(FINDING);
  assert.equal(result.ok, true);
  // Prefixed, so an opportunity id can never be confused with a segment key or
  // a campaign id somewhere that takes a bare string.
  assert.equal(result.opportunity.id, 'finding:one_time_buyers');
  assert.equal(result.opportunity.title, 'Bought once and never came back');
});

test('the size lives at cohort.size, which is what the tool must read', () => {
  const { opportunity } = opportunityFromFinding(FINDING);
  // `audienceSize` is what the tool used to read and exists on neither shape,
  // so every opportunity was announced with no size at all. That reads as an
  // engine that found nothing rather than one holding five hundred people.
  assert.equal(opportunity.audienceSize, undefined);
  assert.equal(opportunity.cohort.size, 511);
});

test('the converter output is accepted by the contract that produced it', () => {
  // ── THIS TEST USED TO ASSERT THE OPPOSITE ────────────────────────────────
  //
  // It was called "the converter output must be TRIMMED before the contract
  // will take it back", and it asserted that round-tripping THREW:
  //
  //     assert.throws(() => normaliseOpportunity(opportunity),
  //       /Unexpected opportunity field: contractVersion, kindLabel/);
  //
  // It was an accurate description of the behaviour and it pinned a bug in
  // place as though it were a decision. normaliseOpportunity derives both
  // fields, adds them to its output, and its input list forbade them — so its
  // own output was invalid input, and the one caller that did not know to trim
  // was the automatic daily path.
  //
  // Measured in production before the fix: six findings offered every day for
  // six consecutive days, drafted 0, saved 0, every one rejected, with the
  // enabling flag switched ON the entire time. A green test suite the whole
  // way, because this test asserted the failure was correct.
  //
  // A test that documents a sharp edge is worth having. A test that makes the
  // edge permanent is not. The contract now accepts what it produces.
  const { opportunity } = opportunityFromFinding(FINDING);
  assert.ok('contractVersion' in opportunity);
  assert.ok('kindLabel' in opportunity);
  assert.doesNotThrow(() => normaliseOpportunity(opportunity),
    'the contract must accept its own output, or the automatic proposal path '
    + 'throws on every finding, every day, in silence');

  // The trimmed shape still works, so routes/assistant.js trimming is now
  // belt-and-braces rather than load-bearing.
  const allowed = ['id', 'kind', 'title', 'cohort', 'facts', 'sizing', 'detectedAt', 'detectorVersion'];
  const trimmed = {};
  for (const field of allowed) trimmed[field] = opportunity[field];
  assert.doesNotThrow(() => normaliseOpportunity(trimmed));
});

test('the route adapter returns something drafting will actually accept', () => {
  // Behavioural, not a source scan. An earlier version of this test read the
  // file for the destructuring line, and passed while the conversion sat
  // bypassed behind an `if (false)`: the words were there and the code was not
  // running. Feeding a real finding through and handing the result to the
  // contract is the only version of this that cannot be fooled.
  const { convertFindings } = require('../routes/assistant');
  const converted = convertFindings([FINDING]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0].id, 'finding:one_time_buyers');
  assert.doesNotThrow(() => normaliseOpportunity(converted[0]),
    'whatever this returns must be draftable, or the assistant fails at the last step');
  assert.deepEqual(
    Object.keys(converted[0]).sort(),
    ['cohort', 'detectedAt', 'detectorVersion', 'facts', 'id', 'kind', 'sizing', 'title'],
    'exactly the fields the contract allows, no more'
  );
});

test('a finding the contract refuses is dropped, not offered and then failed', () => {
  const { convertFindings } = require('../routes/assistant');
  // Offering an opportunity that cannot be drafted from wastes the operator's
  // time at the last possible moment. The refusals list is where "the engine
  // would not size this" already gets said.
  assert.deepEqual(convertFindings([{ nonsense: true }]), []);
  assert.deepEqual(convertFindings([null, undefined]), []);
  assert.deepEqual(convertFindings(null), []);
  assert.equal(convertFindings([FINDING, { nonsense: true }]).length, 1);
});

test('the tool reads the fields that exist, not the ones that were wished for', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'assistant', 'tools.js'), 'utf8'));
  const list = tools.slice(tools.indexOf("name: 'list_opportunities'"), tools.indexOf("name: 'list_referrals'"));
  assert.match(list, /people: finding\.cohort\?\.size/);
  assert.doesNotMatch(list, /audienceSize/, 'that field is on neither shape');
  assert.doesNotMatch(list, /finding\.mechanism/,
    'a mechanism belongs to a proposal, and is not decided until one is drafted');
});
