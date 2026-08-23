'use strict';
/**
 * The rules in docs/campaigns/SMS-COPY-RESEARCH.md and the rules in
 * lib/campaigns/copy-rules.js must be the same rules.
 *
 * This is the test that makes "no paraphrase" a mechanical property rather
 * than an intention. A compliance rule that exists in two places drifts: the
 * doc says "do not state a dose", somebody softens the code to "avoid overly
 * specific dosing", and six months later nobody can say which one is the
 * policy. Here the doc's fenced RULES block is parsed and compared to the
 * constant, deeply, in both directions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RULES, renderPromptRules, flattenedBannedTerms } = require('../lib/campaigns/copy-rules');

const DOC = path.join(__dirname, '..', 'docs', 'campaigns', 'SMS-COPY-RESEARCH.md');

function rulesBlockFromDoc() {
  const markdown = fs.readFileSync(DOC, 'utf8');
  const section = markdown.split(/^## 1\. RULES$/m)[1];
  assert.ok(section, 'SMS-COPY-RESEARCH.md must have a "## 1. RULES" section');
  const fenced = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fenced, 'section 1 must contain one fenced json block');
  return JSON.parse(fenced[1]);
}

test('the doc RULES block and lib/campaigns/copy-rules.js are the same rule set', () => {
  const fromDoc = rulesBlockFromDoc();
  // Both directions. deepEqual on a plain object is symmetric, but asserting
  // the key sets separately produces a readable failure naming what moved.
  assert.deepEqual(Object.keys(fromDoc).sort(), Object.keys(RULES).sort());
  assert.deepEqual(fromDoc, JSON.parse(JSON.stringify(RULES)));
});

test('every prompt rule reaches the model verbatim, numbered and nothing else', () => {
  const rendered = renderPromptRules();
  const lines = rendered.split('\n');
  assert.equal(lines.length, RULES.promptRules.length);
  RULES.promptRules.forEach((rule, index) => {
    assert.equal(lines[index], `${index + 1}. ${rule}`);
    // The rule text itself is untouched: strip the numbering and it is
    // character-for-character what the doc says.
    assert.equal(lines[index].replace(/^\d+\.\s/, ''), rule);
  });
});

test('the prompt states the rules the validator actually enforces', () => {
  // Not a paraphrase check — a coverage check. Each of these is a rule the
  // validator will reject on, so the model must have been told about it.
  const prompt = renderPromptRules().toLowerCase();
  for (const phrase of [
    '160 characters or fewer',
    'reply stop to opt out.',
    'exclamation mark',
    'em dash',
    'dose',
    'guarantee',
    'free',
    'capital letters',
    'fr33',
    's@ve',
    'merge field'
  ]) {
    assert.ok(prompt.includes(phrase), `the prompt rules never mention "${phrase}"`);
  }
});

test('every banned term carries the source it was transcribed from', () => {
  for (const [category, group] of Object.entries(RULES.bannedTerms)) {
    assert.ok(group.source && group.source.length > 20, `${category} has no usable source citation`);
    assert.ok(group.terms.length > 0, `${category} is empty`);
    for (const term of group.terms) {
      assert.equal(typeof term, 'string');
      assert.equal(term, term.toLowerCase(), `banned term "${term}" must be stored lower case`);
      assert.ok(term.trim() === term && term.length > 0, `banned term "${term}" has stray whitespace`);
    }
  }
  for (const pattern of RULES.bannedPatterns) {
    assert.ok(pattern.source && pattern.source.length > 20, `${pattern.id} has no usable source citation`);
    assert.doesNotThrow(() => new RegExp(pattern.pattern, pattern.flags || undefined), pattern.id);
  }
});

test('the twelve-point checklist is twelve points with unique ids', () => {
  assert.equal(RULES.checks.length, 12);
  assert.equal(new Set(RULES.checks.map(check => check.id)).size, 12);
});

test('flattened banned terms are longest-first so a phrase reports before a word inside it', () => {
  const flattened = flattenedBannedTerms();
  for (let index = 1; index < flattened.length; index += 1) {
    assert.ok(
      flattened[index - 1].term.length >= flattened[index].term.length,
      'banned terms are not sorted longest-first'
    );
  }
  assert.ok(flattened.every(entry => entry.category && entry.source));
});

test('the rule set is deeply frozen, so no caller can widen a compliance list', () => {
  assert.throws(() => { RULES.length.maxSeptets = 1600; }, TypeError);
  assert.throws(() => { RULES.bannedTerms.carrier_filter_high_risk.terms.push('anything'); }, TypeError);
  assert.throws(() => { RULES.optOut.exactSuffix = 'nope'; }, TypeError);
  assert.equal(RULES.length.maxSeptets, 160);
});

test('the approved codes are real catalogue entries, and name no GLP-1', () => {
  // This list was empty, on the reasoning that an invented SKU list would
  // exempt unverified codes. It is now read from the live WooCommerce
  // catalogue, so emptiness is no longer the property worth asserting. Two
  // things are.
  const codes = RULES.defaultApprovedProductCodes;
  assert.ok(codes.length > 0, 'populated from the catalogue, not invented');

  // First: exemption is narrow. A code buys an ALL-CAPS pass and nothing more,
  // so nothing in the list may collide with a banned term.
  // bannedTerms is grouped by source, each group { source, terms }.
  const banned = new Set(
    Object.values(RULES.bannedTerms)
      .flatMap(group => group.terms)
      .map(term => String(term).toUpperCase())
  );
  for (const code of codes) {
    assert.equal(banned.has(code.toUpperCase()), false, `${code} is also a banned term`);
  }

  // Second, and the one that matters: the catalogue calls the GLP-1 products
  // RT, TZ and SM, never by name. Those three substances are what place a
  // peptide seller inside Telnyx's prohibited categories. Approving the full
  // name here would exempt it from the ALL-CAPS check and, worse, put it in
  // front of the drafting model as a sanctioned token.
  for (const forbidden of ['RETATRUTIDE', 'TIRZEPATIDE', 'SEMAGLUTIDE', 'OZEMPIC', 'MOUNJARO', 'WEGOVY', 'ZEPBOUND']) {
    assert.equal(
      codes.some(code => code.toUpperCase() === forbidden), false,
      `${forbidden} must never be an approved product code`
    );
  }
});
