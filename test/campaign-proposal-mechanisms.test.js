'use strict';
/**
 * The closed catalogue of campaign mechanisms, and the rules that keep a set
 * of proposals from being one proposal wearing four hats.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING
 *   The owner's complaint is specific: "Here are a few variations" must not
 *   mean three rewordings of the same offer. Distinctness is therefore a
 *   property of the CATALOGUE and of the SELECTION, not of the copy, and both
 *   are asserted here without a model anywhere in sight.
 *
 * AND THE RISK THAT MUST NOT VANISH
 *   A discount that works teaches the cohort to wait for the next one. That is
 *   a real cost and the brief says it must appear in the proposal rather than
 *   being hidden. It is enforced at require time, so the test below deletes it
 *   from a copy of the catalogue and proves the process refuses to load.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EVIDENCE_STATES,
  MAX_PER_CLASS,
  MECHANISMS,
  MECHANISM_IDS,
  OFFER_APPLIED_BY,
  assertCatalogueIntegrity,
  mechanismById,
  selectMechanisms,
  MIN_MECHANISM_LIMIT,
  DEFAULT_MECHANISM_LIMIT
} = require('../lib/campaigns/proposal-mechanisms');

/** A deep, mutable copy, so a test can break one field and re-run integrity. */
function mutableCatalogue() {
  return JSON.parse(JSON.stringify(MECHANISMS));
}

test('the catalogue loads, and every mechanism sits in its own distinctness class', () => {
  assert.equal(assertCatalogueIntegrity(), true);
  const classes = Object.values(MECHANISMS).map(mechanism => mechanism.distinctnessClass);
  assert.equal(new Set(classes).size, classes.length);
  assert.equal(MAX_PER_CLASS, 1);
});

test('there is exactly one no-offer control and it is always selected', () => {
  const control = Object.values(MECHANISMS).filter(mechanism => mechanism.alwaysInclude === true);
  assert.equal(control.length, 1);
  assert.equal(control[0].offer, null);

  for (const limit of [2, 3, 4, 6]) {
    const chosen = selectMechanisms({ limit });
    assert.equal(chosen[0].id, control[0].id, `the control must lead the set at limit ${limit}`);
  }
});

test('a selection never repeats a mechanism or a distinctness class', () => {
  const chosen = selectMechanisms({ limit: 6 });
  const ids = chosen.map(mechanism => mechanism.id);
  const classes = chosen.map(mechanism => mechanism.distinctnessClass);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(classes).size, classes.length);
});

test('a selection carries at most one monetary incentive, and always an alternative to one', () => {
  const chosen = selectMechanisms({ limit: 6 });
  const monetary = chosen.filter(mechanism => mechanism.offer?.kind === 'monetary_discount');
  assert.ok(monetary.length <= 1, 'more than one discount arm is not a set of variations');
  const withoutOffer = chosen.filter(mechanism => mechanism.offer === null);
  assert.ok(withoutOffer.length >= 1, 'a set with no unpriced arm can only answer "which offer"');
});

test('selection is deterministic and honours exclusions', () => {
  assert.deepEqual(
    selectMechanisms({ limit: 4 }).map(item => item.id),
    selectMechanisms({ limit: 4 }).map(item => item.id)
  );
  const chosen = selectMechanisms({ limit: 6, exclude: ['first_reorder_incentive'] });
  assert.ok(!chosen.some(mechanism => mechanism.id === 'first_reorder_incentive'));
});

test('the limit is clamped rather than trusted', () => {
  assert.equal(selectMechanisms({ limit: 0 }).length, MIN_MECHANISM_LIMIT,
    'zero clamps up to the minimum');
  // A non-numeric limit falls back to the default rather than throwing.
  assert.equal(selectMechanisms({ limit: 'four' }).length, DEFAULT_MECHANISM_LIMIT);

  // A huge limit no longer returns the whole catalogue, and should not: only
  // one arm may cost margin, so the three monetary mechanisms cannot all be
  // offered at once. What the clamp guarantees is that asking for 99 is not an
  // error and never exceeds what exists.
  const everything = selectMechanisms({ limit: 99 });
  assert.ok(everything.length <= MECHANISM_IDS.length);
  assert.ok(everything.length >= 2);
  assert.equal(everything.filter(m => m.offer?.kind === 'monetary_discount').length, 1);
});

// ── The risk that pays for itself later ─────────────────────────────────────

test('every monetary mechanism names the discount-training risk, in the proposal', () => {
  for (const mechanism of Object.values(MECHANISMS)) {
    if (mechanism.offer?.kind !== 'monetary_discount') continue;
    const risk = mechanism.risks.find(item => item.id === 'discount_trains_waiting');
    assert.ok(risk, `${mechanism.id} must carry discount_trains_waiting`);
    assert.match(risk.statement, /wait/i);
    assert.equal(risk.severity, 'high');
  }
});

test('MUTATION: deleting the discount-training risk makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  broken.first_reorder_incentive.risks = broken.first_reorder_incentive.risks
    .filter(risk => risk.id !== 'discount_trains_waiting');
  assert.throws(
    () => assertCatalogueIntegrity(broken),
    /discount_trains_waiting/,
    'a monetary mechanism without its training risk must be a boot failure, not a quiet omission'
  );
});

test('MUTATION: a second mechanism in one class makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  broken.bundle.distinctnessClass = broken.free_shipping.distinctnessClass;
  assert.throws(() => assertCatalogueIntegrity(broken), /already used/);
});

test('MUTATION: a mechanism with no risk makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  broken.plain_check_in.risks = [];
  assert.throws(() => assertCatalogueIntegrity(broken), /carries no risk/);
});

test('MUTATION: a digit in a prompt directive makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  broken.plain_check_in.copyDirective = 'Offer 20 percent off and say nothing else.';
  assert.throws(() => assertCatalogueIntegrity(broken), /contains a digit/);
});

test('MUTATION: an offer a model could apply makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  broken.free_shipping.offer.appliedBy = 'model';
  assert.throws(() => assertCatalogueIntegrity(broken), /may only be applied by/);
});

test('MUTATION: an offer stated in copy with no code to give makes the catalogue refuse to load', () => {
  // THIS ASSERTION USED TO BE THE OPPOSITE. It required statedInCopy to be
  // false everywhere, because "the copy validator rejects a price, a
  // percentage, a code and the word free". A percentage and a code both pass
  // now, so the blanket version had become a statement about a world that no
  // longer exists.
  //
  // What replaces it is narrower and still real: a mechanism may state its
  // offer, but a message that announces a discount and hands over no code is
  // an advert for something the customer cannot use.
  const broken = mutableCatalogue();
  broken.bundle.offer.statedInCopy = true;
  assert.throws(() => assertCatalogueIntegrity(broken), /never asks for \{\{code\}\}/);

  // And the two that DO state their offer both ask for one, so they load.
  assert.doesNotThrow(() => assertCatalogueIntegrity());
});

test('a mechanism that names a cohort is only offered for that cohort', () => {
  // A thank-you for four orders sent to somebody who ordered once renders as
  // "1 order in and we appreciate you", which is faintly insulting. The
  // mirror case reads as a business that has lost track of a regular.
  const { selectMechanisms } = require('../lib/campaigns/proposal-mechanisms');
  const single = selectMechanisms({ limit: 6, opportunity: { cohort: { key: 'one_time_buyers' } } })
    .map(m => m.id);
  assert.ok(single.includes('winback_personal'));
  assert.ok(!single.includes('loyalty_thank_you'));

  const repeat = selectMechanisms({ limit: 6, opportunity: { cohort: { key: 'repeat_buyers_slowing' } } })
    .map(m => m.id);
  assert.ok(repeat.includes('loyalty_thank_you'));
  assert.ok(!repeat.includes('winback_personal'));
});

test('AT MOST ONE ARM COSTS MARGIN, however many monetary mechanisms exist', () => {
  // This used to be true for free: the catalogue held exactly one monetary
  // mechanism. It now holds three, and without the cap the reviewer is handed
  // three flavours of discount and one control, which answers "which discount"
  // and never "does this cohort need one at all".
  const { selectMechanisms, MECHANISMS } = require('../lib/campaigns/proposal-mechanisms');
  const monetaryInCatalogue = Object.values(MECHANISMS)
    .filter(m => m.offer?.kind === 'monetary_discount');
  assert.ok(monetaryInCatalogue.length >= 3, 'the cap is only meaningful with several to choose from');

  for (const key of ['one_time_buyers', 'repeat_buyers_slowing']) {
    for (const limit of [4, 6, 8]) {
      const picked = selectMechanisms({ limit, opportunity: { cohort: { key } } });
      const monetary = picked.filter(m => m.offer?.kind === 'monetary_discount');
      assert.ok(monetary.length <= 1,
        `${key} at limit ${limit} offered ${monetary.length} discounts`);
    }
  }
});

test('MUTATION: removing the control makes the catalogue refuse to load', () => {
  const broken = mutableCatalogue();
  delete broken.plain_check_in.alwaysInclude;
  assert.throws(() => assertCatalogueIntegrity(broken), /alwaysInclude/);
});

// ── Offers, costs and evidence ──────────────────────────────────────────────

test('every offer says what a human must still supply, whether or not the copy states it', () => {
  for (const mechanism of Object.values(MECHANISMS)) {
    if (!mechanism.offer) continue;
    assert.equal(mechanism.offer.appliedBy, OFFER_APPLIED_BY);
    // statedInCopy is a per-mechanism decision now rather than a constant
    // false. What is NOT negotiable is that a human still decides the terms:
    // a message may say "15% off with this code" and the percentage, the
    // expiry and the margin behind it are still somebody's call, made before
    // approval, in the store as well as in the message.
    assert.equal(typeof mechanism.offer.statedInCopy, 'boolean');
    assert.ok(mechanism.offer.termsRequiredFromHuman.length >= 3,
      `${mechanism.id} must list what the reviewer has to decide`);
    if (mechanism.offer.statedInCopy) {
      assert.match(mechanism.copyDirective, /\{\{code\}\}/,
        `${mechanism.id} states an offer, so it must hand over a code`);
    }
  }
});

test('no mechanism claims research it does not have', () => {
  for (const mechanism of Object.values(MECHANISMS)) {
    assert.ok(EVIDENCE_STATES.includes(mechanism.evidence.status));
    for (const risk of mechanism.risks) {
      assert.ok(['assumption', 'research'].includes(risk.evidence),
        `${mechanism.id} risk ${risk.id} must say whether it is evidence or judgement`);
    }
  }
});

test('an unknown mechanism id resolves to null rather than to something plausible', () => {
  assert.equal(mechanismById('aggressive_discount'), null);
  assert.equal(mechanismById(''), null);
  assert.equal(mechanismById(undefined), null);
  assert.equal(mechanismById('plain_check_in').id, 'plain_check_in');
});

// ── The research reconciliation hook ────────────────────────────────────────

test('when the repeat-purchase research lands, its DECISIONS reconcile with this catalogue', () => {
  // docs/campaigns/REPEAT-PURCHASE-RESEARCH.md is being written in parallel.
  // Until it exists this test asserts nothing about it, which is honest: there
  // is nothing to reconcile. The moment it lands, every mechanism id it names
  // in a DECISIONS block must exist here, so adopting the research is an edit
  // CI checks rather than a claim in a commit message.
  const doc = path.join(__dirname, '..', 'docs', 'campaigns', 'REPEAT-PURCHASE-RESEARCH.md');
  if (!fs.existsSync(doc)) {
    assert.ok(
      Object.values(MECHANISMS).every(mechanism => mechanism.evidence.status === 'awaiting_research'),
      'with no research document present, no mechanism may claim to be research backed'
    );
    return;
  }
  const text = fs.readFileSync(doc, 'utf8');
  const block = text.match(/##\s*DECISIONS([\s\S]*?)(?=\n##\s|$)/i);

  // A guard that cannot find anything to check must FAIL, not pass.
  //
  // The first version of this test looked for the literal string
  // `mechanism: <id>` and returned early if the DECISIONS heading did not
  // match. The research landed with its mechanisms in a markdown table
  // instead, so the pattern found nothing, `missing` was empty, and the test
  // reported success while checking precisely nothing. Inventing a mechanism
  // called `send_them_a_hug` in the document still passed 18 of 18.
  //
  // Both silent-pass paths are now failures, and the scan is format-agnostic:
  // any backtick-quoted snake_case identifier anywhere in the block counts.
  assert.ok(block, 'the research document must carry a "## DECISIONS" heading for this guard to read');

  const named = [...new Set(
    [...block[1].matchAll(/`([a-z][a-z0-9_]{3,})`/g)].map(match => match[1])
  )];
  assert.ok(
    named.length > 0,
    'found no backtick-quoted identifiers in the DECISIONS block, so this guard is checking nothing'
  );

  // Only identifiers shaped like a mechanism are held to the catalogue. The
  // block legitimately names columns, flags and files too, so an unknown
  // identifier is only a failure when it looks like one of ours.
  const mechanismShaped = named.filter(id => MECHANISM_IDS.includes(id)
    || /^(plain|product|ask|free|first|bundle|offer|send|give|show)_/.test(id));
  assert.ok(
    mechanismShaped.length > 0,
    'the DECISIONS block names no mechanism at all, which means the research and the catalogue are not connected'
  );

  const missing = mechanismShaped.filter(id => !MECHANISM_IDS.includes(id));
  assert.deepEqual(
    missing, [],
    `\n\nThe research names mechanisms this catalogue does not have:\n  ${missing.join('\n  ')}\n`
  );
});
