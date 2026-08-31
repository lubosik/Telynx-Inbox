'use strict';
/**
 * test/campaign-copy-craft.test.js — the copywriting guidance itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RISK THIS FILE GUARDS
 *
 *   OBSERVED_PATTERNS was written by reading real marketing SMS from two
 *   high-volume senders. Their messages are full of things copy-rules.js
 *   forbids: exclamation marks, invented deadlines, currency amounts, ALL CAPS
 *   mechanics, the word "free", shortened links.
 *
 *   Guidance is not output, so nothing here can reach a customer directly. But
 *   priming a model with a banned word costs candidates: the model reaches for
 *   it, the validator discards the draft, and the owner sees "every version
 *   broke a copy rule" with no idea why. A reviewer caught exactly that in the
 *   first version of this file, where technique 8 said "earn the discount" and
 *   "discount" is on the carrier-filter list.
 *
 *   So every line of guidance is held to the same lexicon as the copy.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUSINESS, OBSERVED_PATTERNS, SELF_CHECK, TECHNIQUES,
  renderBusinessContext, renderObservedPatterns, renderSelfCheck, renderTechniques
} = require('../lib/campaigns/copy-craft');
const { RULES, flattenedBannedTerms } = require('../lib/campaigns/copy-rules');

/** Every line of guidance the model is shown, as one corpus. */
const GUIDANCE = [
  renderBusinessContext(), renderTechniques(), renderObservedPatterns(), renderSelfCheck()
].join('\n');

test('the guidance never uses a term the validator would reject', () => {
  // Quoted examples are the trap: it is tempting to show the model
  // "UP TO 80% OFF" as an illustration of what not to do, and then it does it.
  const banned = flattenedBannedTerms()
    .map(entry => String(entry.term || entry).toLowerCase())
    .filter(term => term.length > 3);

  const corpus = GUIDANCE.toLowerCase();
  const found = banned.filter(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(corpus));
  assert.deepEqual(found, [],
    `the guidance primes the model with terms the validator discards: ${found.join(', ')}`);
});

test('the guidance contains no exclamation mark, despite quoting senders who love them', () => {
  // Rule 6 bans them in output. A model shown three of them in its guidance
  // writes them.
  assert.doesNotMatch(GUIDANCE, /!/);
});

test('the guidance shows no currency amount and no ALL CAPS mechanic', () => {
  // Rule 12 bans currency in output; rule 17 bans capitals except STOP.
  assert.doesNotMatch(GUIDANCE, /[$£€]\s?\d/, 'no worked currency example');
  // Allow acronyms and the deliberate single-word emphasis (FIRST, NOT, ONE),
  // but nothing that reads as a shouted offer.
  assert.doesNotMatch(GUIDANCE, /\b(?:UP TO|OFF|DOWN TO|FREE|SALE|NOW)\b/);
});

test('the guidance uses no character the message itself could not use', () => {
  // An em dash is not in the GSM 03.38 alphabet, so a message containing one is
  // sent as UCS-2 at 70 characters a segment — rule 5 forbids it outright. It is
  // also against this owner's standing rule for anything client-facing.
  //
  // Guidance is not output, but a model shown an em dash writes one, and the
  // draft is then discarded for a punctuation mark nobody chose.
  for (const character of ['\u2014', '\u2013', '\u2018', '\u2019', '\u201C', '\u201D', '\u2026']) {
    assert.ok(!GUIDANCE.includes(character),
      `guidance contains ${JSON.stringify(character)}, which the validator rejects in output`);
  }
  const { isGsm7 } = require('../lib/campaigns/copy-validator');
  for (const line of [...TECHNIQUES, ...OBSERVED_PATTERNS]) {
    assert.ok(isGsm7(line), `not writable in GSM-7, so not safe to show as an example: ${line.slice(0, 50)}`);
  }
});

test('the observed patterns describe technique, not wording to copy', () => {
  // The point is what travels, not a style to imitate. No sender is named and
  // no message is reproduced verbatim, which also keeps another company's copy
  // out of this codebase.
  for (const forbidden of ['SHEIN', 'JD Gyms', 'tinyurl', 's.pro', 'Nottingham', 'Chatham']) {
    assert.ok(!GUIDANCE.includes(forbidden), `guidance should not name or quote: ${forbidden}`);
  }
  assert.ok(OBSERVED_PATTERNS.length >= 5);
});

test('every pattern says what to DO', () => {
  // The whole reason this file exists beside copy-rules.js: the rules are
  // twenty-one prohibitions, and a model given only prohibitions writes
  // nothing worth sending.
  for (const line of [...TECHNIQUES, ...OBSERVED_PATTERNS]) {
    assert.ok(line.length > 40, `too terse to act on: ${line}`);
    assert.ok(!/^(?:Do not|Never|Avoid)\b/.test(line),
      `this belongs in copy-rules.js as a rule, not here as craft: ${line.slice(0, 60)}`);
  }
});

test('the business context matches the brand the rules enforce', () => {
  // A prompt that names a different sender than the validator requires would
  // fail brand_identifies_sender_first on every single draft.
  assert.equal(BUSINESS.sender, RULES.brand.defaultName);
  assert.match(renderBusinessContext(), /research peptides/);
  assert.match(renderBusinessContext(), /already bought at least once/);
});

test('the self-check asks about the brief first', () => {
  // The owner's complaint was that drafts ignored his instruction. The first
  // thing the model re-reads should be whether it did what was asked.
  assert.match(SELF_CHECK[0], /brief/i);
  assert.match(renderSelfCheck(), /160 characters or fewer/);
});

test('both drafting prompts carry the craft, not just the rules', () => {
  // Two separate modules write customer-facing SMS: the campaign copy drafter
  // and the proposal drafter behind automatic suggestions. Guidance added to
  // one and not the other is how they drift apart.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['copy-writer.js', 'proposal-writer.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', file), 'utf8');
    assert.match(source, /renderObservedPatterns\(\)/, `${file} must include the observed patterns`);
    assert.match(source, /renderBusinessContext\(\)/, `${file} must include the business context`);
    assert.match(source, /renderPromptRules\(\)/, `${file} must still include the rules verbatim`);
  }
});

test('line breaks stay forbidden, because one segment cannot afford them', () => {
  // The block layout in the observed messages is genuinely good and was NOT
  // adopted: those senders run past 250 characters across two paid segments,
  // and rule 2 holds this business to 160 septets in one. At that length a
  // four-block layout leaves about thirty words.
  //
  // Pinned so that "improve the formatting" never quietly becomes a change to
  // the character set a compliance validator enforces.
  const { validateCopy } = require('../lib/campaigns/copy-validator');
  const verdict = validateCopy(
    `${RULES.brand.defaultName}. Hello there.\n\nA second block. ${RULES.optOut.exactSuffix}`,
    { brandName: RULES.brand.defaultName, approvedProductCodes: [] }
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some(f => f.check === 'gsm7_character_set_only'));
});
