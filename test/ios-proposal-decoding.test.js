'use strict';
/**
 * test/ios-proposal-decoding.test.js
 *
 * WHY THE OFFERS SCREEN SAID "PROPOSAL DATA COULD NOT BE VERIFIED"
 *
 * `cohortSizeBasis` was decoded on the phone as a CODE, an identifier
 * restricted to [a-z0-9_-./]. The server has always sent a sentence:
 *
 *   "1305 paid orders across 792 buyers, counted per person and never per
 *    product pair."
 *
 * The first space failed the check, so every proposal threw during decoding,
 * the whole page became APIError.decoding, and the operator was shown an error
 * while four perfectly good drafts sat on the server.
 *
 * THE FIXTURE IS WHY NOBODY CAUGHT IT. The iOS smoke test supplied
 * `"detector_snapshot"`, a value the server cannot produce, because
 * opportunity-contract.js runs sizeBasis through `plainText()` and fills it
 * from the detector's `countedFrom` sentence. A fixture that cannot occur in
 * production is worse than no fixture: it is a test that passes for a shape
 * nobody will ever send.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MODELS = read('ios/ViciInbox/Core/CampaignProposalModels.swift');
const FIXTURE = read('ios/Tests/CampaignProposalModelsSmoke.swift');

test('cohortSizeBasis is decoded as PROSE, because that is what is sent', () => {
  const at = MODELS.indexOf('cohortSizeBasis = try CampaignProposalDecoding');
  assert.ok(at >= 0, 'the field must still be decoded');
  const decode = MODELS.slice(at, at + 200);
  assert.match(decode, /CampaignProposalDecoding\.text/,
    'a sentence cannot be decoded as a code');
  assert.doesNotMatch(decode, /CampaignProposalDecoding\.code/);
  // The server's own ceiling, so the two cannot drift apart silently.
  assert.match(decode, /maximum: 400/);
});

test('the server really does send a sentence there', () => {
  // Not an assumption about the server: the contract module says so. sizeBasis
  // goes through plainText, which permits prose, and is filled from a
  // countedFrom sentence.
  const contract = read('lib/campaigns/opportunity-contract.js');
  assert.match(contract, /sizeBasis: plainText\(/);
  assert.match(contract, /MAX_STATEMENT_LENGTH = 400/);
});

test('THE FIXTURE MUST BE A SHAPE THE SERVER CAN ACTUALLY PRODUCE', () => {
  // This is the assertion that would have caught the bug. A slug here means
  // the test is exercising a value nobody sends.
  const matches = [...FIXTURE.matchAll(/"cohortSizeBasis"\s*:\s*"([^"]*)"/g)].map(m => m[1]);
  assert.ok(matches.length > 0, 'the fixture must still set the field');
  for (const value of matches) {
    assert.ok(value.includes(' '),
      `"${value}" is a slug. The server sends a counted sentence, and a fixture that cannot occur in production is a test of nothing.`);
    assert.ok(value.length > 20, `"${value}" is too short to be the real sentence`);
  }
});

test('a code field and a prose field are not confused elsewhere in the same struct', () => {
  // The neighbouring fields, checked so a future edit does not repeat this in
  // the other direction. cohortLabel and plainEnglish are prose; kind is a code.
  const audience = MODELS.slice(
    MODELS.indexOf('cohortLabel = try CampaignProposalDecoding'),
    MODELS.indexOf('requiresSegment = try values.decode')
  );
  assert.match(audience, /cohortLabel = try CampaignProposalDecoding\.text/);
  assert.match(audience, /plainEnglish = try CampaignProposalDecoding\.text/);
  const kindAt = MODELS.indexOf('kind = try CampaignProposalDecoding');
  assert.match(MODELS.slice(kindAt, kindAt + 120), /\.code\(/,
    'kind really is a machine value and must stay strict');
});
