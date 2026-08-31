'use strict';
/**
 * lib/campaigns/reasoning-trail.js — showing the working.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 *
 *   The owner asked to see "the journey and the thought process step by step
 *   ... I identified this and put these people in it because I think we can
 *   potentially get this amount".
 *
 *   Every fact he wants was already being computed and stored. The detector
 *   writes `countedFrom` sentences beside every number; buyer-cohorts.js
 *   writes a per-person `inclusion_evidence` blob with the order count, the
 *   date and value of their only order, whether what they bought is still on
 *   sale, and the tenure basis the rate came from. None of it was ever shown.
 *
 *   So this file adds no new analysis. It turns what is already known into
 *   sentences, in one place, so the phone renders strings instead of trying to
 *   pretty-print nested JSON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THE SERVER WRITES THE SENTENCES
 *
 *   Because the wording is the part that has to be careful, and the wording
 *   should be reviewable in one file with tests around it rather than spread
 *   through a SwiftUI view. Two specific traps this avoids:
 *
 *   1. Saying more than is known. "They are due to reorder" is a claim about
 *      the future dressed as a fact. Everything here is past tense and
 *      observed.
 *   2. Implying surveillance. The same rule copy-rules.js enforces for
 *      customer-facing copy applies to what the OWNER reads, because if the
 *      screen says "we have been tracking them since July" that is the tone
 *      that ends up in a message.
 */

/** Money, as a person writes it. */
function money(value, currency = 'USD') {
  // Number(null) is 0 and Number('') is 0, so a missing value would have
  // rendered as "$0.00" — a figure that looks measured and is not. Caught by
  // its own test. Reject the empties before coercing.
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const symbol = { USD: '$', GBP: '£', EUR: '€' }[currency] || '';
  return `${symbol}${amount.toFixed(2)}`;
}

/** "8 July 2026", or null if the date is unusable. */
function longDate(value) {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function plural(count, one, many) {
  return Number(count) === 1 ? one : many;
}

/**
 * Why THIS person is in the campaign.
 *
 * Reads the `inclusion_evidence` written by buyer-cohorts.js. Returns [] when
 * there is nothing recorded rather than inventing a reason, because "we do not
 * know why this person is here" is a real and important answer.
 */
function personTrail(evidence, { currency = 'USD' } = {}) {
  if (!evidence || typeof evidence !== 'object') return [];
  const steps = [];

  const orders = Number(evidence.orderCount);
  if (Number.isFinite(orders)) {
    steps.push(orders === 1
      ? 'They have ordered once.'
      : `They have ordered ${orders} times.`);
  }

  const when = longDate(evidence.onlyOrderAt);
  const days = Number(evidence.daysSinceOnlyOrder);
  if (when && Number.isFinite(days)) {
    steps.push(`That order was on ${when}, ${days} ${plural(days, 'day', 'days')} ago.`);
  } else if (when) {
    steps.push(`That order was on ${when}.`);
  }

  const value = money(evidence.onlyOrderValue, currency);
  if (value) steps.push(`It came to ${value}.`);

  const items = Number(evidence.productsInOnlyOrder);
  if (Number.isFinite(items) && items > 0) {
    steps.push(`It had ${items} ${plural(items, 'item', 'items')} in it.`);
  }

  // Whether they can actually buy it again is the single most decision-useful
  // fact here: a win-back aimed at a discontinued product is a wasted send.
  const stock = evidence.productsStillPurchasable;
  if (stock === 'all') steps.push('Everything they bought is still on sale.');
  else if (stock === 'some') steps.push('Some of what they bought is no longer on sale.');
  else if (stock === 'none') steps.push('Nothing they bought is still on sale.');

  if (evidence.everCommerciallyContacted === false) {
    steps.push('They have never been sent a marketing message.');
  } else if (evidence.everCommerciallyContacted === true) {
    steps.push('They have been sent a marketing message before.');
  }

  const basis = evidence.tenureBasis;
  if (basis && Number.isFinite(Number(basis.repeatBuyersMeasured))) {
    steps.push(
      `The windows used to sort them were measured on this shop's own ${basis.repeatBuyersMeasured} `
      + 'repeat buyers, not on an industry average.'
    );
  }

  return steps;
}

/**
 * How the GROUP was arrived at, and what the numbers do and do not say.
 *
 * Reads one entry from detectOpportunities().findings. The `countedFrom`
 * sentences are the detector's own, quoted rather than paraphrased, so this
 * file cannot drift away from what was actually measured.
 */
function cohortTrail(finding, { currency = 'USD' } = {}) {
  if (!finding || typeof finding !== 'object') return [];
  const steps = [];
  const evidence = finding.evidence || {};

  if (finding.title) steps.push(`What was noticed: ${finding.title}`);

  const people = evidence.people;
  if (people && Number.isFinite(Number(people.people))) {
    steps.push(`How many people: ${people.people}. ${people.countedFrom || ''}`.trim());
    if (Number.isFinite(Number(people.neverContacted))) {
      steps.push(`${people.neverContacted} of them have never been sent a marketing message.`);
    }
  }

  const value = evidence.orderValue;
  if (value && Number.isFinite(Number(value.middle))) {
    const mid = money(value.middle, value.currency || currency);
    const low = money(value.lowerQuartile, value.currency || currency);
    const high = money(value.upperQuartile, value.currency || currency);
    steps.push(
      `What their orders were worth: typically ${mid}`
      + (low && high ? `, with most between ${low} and ${high}.` : '.')
    );
  }

  const age = evidence.timeSinceOrder;
  if (age && Number.isFinite(Number(age.middleDays))) {
    // Rounded: the detector reports a median, which lands on a half day for an
    // even-sized cohort, and "typically 175.5 days ago" reads like a machine.
    //
    // The range is checked separately rather than assumed present. The live
    // detector always emits all three, but a file whose whole premise is
    // "never show a figure that was not measured" must not print
    // "ranging from NaN to NaN" the day one of them is missing.
    const middle = `How long ago: typically ${Math.round(age.middleDays)} days`;
    const hasRange = Number.isFinite(Number(age.earliestDays))
      && Number.isFinite(Number(age.latestDays));
    steps.push(hasRange
      ? `${middle}, ranging from ${Math.round(age.earliestDays)} to ${Math.round(age.latestDays)}.`
      : `${middle}.`);
  }

  const stock = evidence.canStillBuyIt;
  // All three, or none. Two counts and an "undefined" is worse than silence.
  if (stock && ['everyProductStillOnSale', 'someProductsGone', 'everyProductGone']
    .every(field => Number.isFinite(Number(stock[field])))) {
    steps.push(
      `Can they buy it again: ${stock.everyProductStillOnSale} yes, `
      + `${stock.someProductsGone} partly, ${stock.everyProductGone} no. ${stock.countedFrom || ''}`.trim()
    );
  }

  // ── What it is worth, and what that number is NOT ───────────────────────
  //
  // opportunity-sizing.js deliberately refuses an incremental figure until an
  // uplift has actually been measured, and assertNoHeadlineFigure() throws if
  // one ever grows a bare total. That refusal is the most important thing on
  // this screen, so it is stated rather than left as an absence: an owner who
  // sees a baseline and no caveat will read the baseline as a forecast.
  const sizing = finding.sizing || {};
  const baseline = sizing.baseline;
  if (baseline?.rate?.sourceDetail) {
    // The rate lives at sizing.baseline.rate.sourceDetail, not
    // baseline.rateSourceDetail — a first version guessed the flatter name and
    // the line silently never appeared, which is the quiet way a trail ends up
    // missing the one number it exists to explain.
    steps.push(`What normally happens: ${baseline.rate.sourceDetail}`);
  }
  if (baseline?.claimMeans) {
    steps.push(`Read that as: ${baseline.claimMeans}`);
  }
  const incremental = sizing.incremental;
  if (incremental && incremental.reason) {
    steps.push(
      'What this campaign would add: not estimated. '
      + (incremental.detail || incremental.reason)
      + ' A number here would be a guess wearing a decimal point.'
    );
  }

  const taken = finding.observed?.moneyAlreadyTaken;
  if (taken && Number.isFinite(Number(taken.amount))) {
    const amount = money(taken.amount, taken.currency || currency);
    if (amount) steps.push(`What these people have already spent: ${amount}. ${taken.countedFrom || ''}`.trim());
  }

  // Array-checked before iterating: `blockers: {}` threw "object is not
  // iterable", and `blockers: [null]` threw on .detail. A malformed field
  // should cost its own line, not the whole trail.
  if (Array.isArray(finding.blockers)) {
    for (const blocker of finding.blockers) {
      if (!blocker) continue;
      const said = typeof blocker === 'string'
        ? blocker
        : (blocker.detail || blocker.reason || null);
      if (said) steps.push(`In the way: ${said}`);
    }
  }

  return steps;
}

module.exports = { cohortTrail, longDate, money, personTrail, plural };
