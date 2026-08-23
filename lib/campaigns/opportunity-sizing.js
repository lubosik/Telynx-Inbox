'use strict';
/**
 * lib/campaigns/opportunity-sizing.js — how big is it, and how much of that
 * do we actually know.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 *   Every system of this kind eventually shows its owner one number. "£5,300
 *   of opportunity." That number is a population multiplied by a conversion
 *   rate somebody read on a vendor's blog, multiplied by an average order
 *   value, and by the time it reaches a screen the two guesses inside it have
 *   been laundered into a currency figure that looks like money. The owner
 *   then plans against it.
 *
 *   So this file makes the dishonest shape UNBUILDABLE rather than
 *   discouraged. There are exactly three things a caller can produce:
 *
 *     observed()    a figure read off rows that already exist. A count, a
 *                   quantile of order values, money already taken. It carries
 *                   what it was counted from.
 *     project()     a figure that depends on an assumed rate. It CANNOT be
 *                   built without the rate, the sample the rate came from, the
 *                   named source of that sample, and the claim being made. It
 *                   never returns a point value: it returns a range, because
 *                   the sample the rate came from is finite and the interval
 *                   around it is arithmetic, not modesty.
 *     refuse()      the honest answer when there is no defensible rate. It
 *                   carries the population and the observed values instead, so
 *                   the reader gets the facts without the guess.
 *
 * NO HEADLINE NUMBER
 *   A projection object has no `value`, `total`, `amount` or `revenue` key.
 *   There is nothing on it a template can print on its own and have it read
 *   like a fact. `assertNoHeadlineFigure()` enforces that and the test suite
 *   asserts it, because the first person to add `figure.total` for
 *   convenience would undo the whole file.
 *
 * INCREMENTAL REVENUE IS REFUSED BY CONSTRUCTION
 *   "How much extra will we make by messaging them" is the question the owner
 *   actually wants answered, and it is the one question this repository has no
 *   evidence for. Vici has never delivered a promotional campaign; the
 *   commercial contact ledger is empty. Every return this business has ever
 *   observed happened with no contact at all, so the observed rate measures
 *   what happens ANYWAY. Multiplying it by a population and calling the result
 *   campaign revenue would claim credit for the baseline.
 *
 *   project() therefore refuses `incremental_from_contact` unless it is handed
 *   a measured uplift with a real sample behind it. There is no flag, no
 *   override and no default rate. When somebody has run a holdout and measured
 *   one, they pass it in and the refusal becomes a projection with their
 *   sample stamped on it.
 *
 * NO CURRENCY SYMBOL IS EMITTED ANYWHERE
 *   Amounts are numbers with a `currency` code beside them, resolved by the
 *   caller from the store. A hard-coded symbol in a shared module is how a
 *   dollar figure ends up rendered as pounds.
 */

/** Bumped when the meaning of a sizing figure changes. Stored on every result. */
const SIZING_METHOD_VERSION = 'opportunity-sizing-2026-08-23';

/**
 * What a projection is claiming. Closed, because the difference between these
 * two is the difference between an honest forecast and a sales pitch.
 *
 *   no_action_baseline        what the population does on its own, with no
 *                             message sent. A yardstick, never a benefit.
 *   incremental_from_contact  what contacting them ADDS on top of that. Only
 *                             available with a measured uplift.
 */
const CLAIM_KINDS = Object.freeze(['no_action_baseline', 'incremental_from_contact']);

/**
 * Where a rate came from. `internal_observed_cohort` is this shop's own
 * history. `external_published` is somebody else's number, and it is allowed
 * only so that a projection built on one is FORCED to say so in its own
 * assumption sentence.
 */
const RATE_SOURCES = Object.freeze(['internal_observed_cohort', 'external_published']);

/** Keys a figure may never carry. See "NO HEADLINE NUMBER" above. */
const BANNED_HEADLINE_KEYS = Object.freeze([
  'value', 'total', 'amount', 'revenue', 'opportunity', 'estimate', 'headline'
]);

class SizingError extends Error {
  constructor(message, code = 'SIZING_INPUT_INVALID') {
    super(message);
    this.name = 'SizingError';
    this.code = code;
  }
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new SizingError(`${label} must be a finite number.`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SizingError(`${label} must be a non-negative whole number.`);
  }
  return parsed;
}

function text(value, label, max = 400) {
  if (typeof value !== 'string' || !value.trim()) throw new SizingError(`${label} is required.`);
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The Wilson score interval for a proportion.
 *
 * Used rather than the normal approximation because these samples are small
 * and some of the rates are near the ends, where the textbook interval happily
 * produces a negative lower bound. A rate of "18 out of 140" is not 12.9%, it
 * is 12.9% with a real width around it, and the width is the honest part.
 *
 * z defaults to 1.96, the conventional 95% two-sided value.
 */
function wilsonInterval(successes, trials, z = 1.96) {
  const s = nonNegativeInteger(successes, 'successes');
  const n = nonNegativeInteger(trials, 'trials');
  if (n === 0) return { point: null, low: null, high: null, successes: s, trials: n, z };
  if (s > n) throw new SizingError('successes cannot exceed trials.');
  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    point: round4(p),
    low: round4(Math.max(0, (centre - spread) / denominator)),
    high: round4(Math.min(1, (centre + spread) / denominator)),
    successes: s,
    trials: n,
    z
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * A figure read off rows that exist. Counts, sums of money already taken,
 * quantiles of order values actually charged.
 *
 * `countedFrom` is not decoration. Six months from now "504" means nothing and
 * "504 distinct paying phone numbers with exactly one paid order, from 1,288
 * paid orders between 2026-01-17 and 2026-08-23" means everything.
 */
function observed({ label, countedFrom, currency = null, ...rest }) {
  const figure = {
    kind: 'observed',
    method: SIZING_METHOD_VERSION,
    label: text(label, 'label', 200),
    countedFrom: text(countedFrom, 'countedFrom', 400),
    currency: currency === null ? null : text(currency, 'currency', 8)
  };
  for (const [key, value] of Object.entries(rest)) {
    if (BANNED_HEADLINE_KEYS.includes(key)) {
      throw new SizingError(`An observed figure may not use the key "${key}"; name what was counted.`);
    }
    figure[key] = value;
  }
  return Object.freeze(figure);
}

/**
 * Money that has already been taken. Separated from observed() by name only,
 * so that a reader scanning for "is this real" gets an unambiguous answer, and
 * so that a caller cannot accidentally file a hypothetical under it.
 */
function observedMoney({ label, countedFrom, currency, amount, orders, people }) {
  return Object.freeze({
    kind: 'observed_money',
    method: SIZING_METHOD_VERSION,
    label: text(label, 'label', 200),
    countedFrom: text(countedFrom, 'countedFrom', 400),
    currency: text(currency || 'unknown', 'currency', 8),
    alreadyTaken: round2(finiteNumber(amount, 'amount')),
    orders: nonNegativeInteger(orders, 'orders'),
    people: nonNegativeInteger(people, 'people'),
    hypothetical: false
  });
}

/**
 * An explicit refusal to put a number on something.
 *
 * This is a first-class result, not an error path. "712 people whose median
 * first order was 74" is the answer; "5,300 of opportunity" is not, and a
 * refusal is how the first gets returned in the place the second would have
 * gone.
 */
function refuse({ label, reason, detail, population = null, observedInstead = null }) {
  return Object.freeze({
    kind: 'refusal',
    method: SIZING_METHOD_VERSION,
    label: text(label, 'label', 200),
    reason: text(reason, 'reason', 80),
    detail: text(detail, 'detail', 600),
    population: population === null ? null : nonNegativeInteger(population, 'population'),
    observedInstead
  });
}

/**
 * Project a population forward at an assumed rate.
 *
 * Everything below is mandatory and unvalidated input is a throw, not a
 * default:
 *
 *   claim            which of the two questions this answers.
 *   population       how many people it is applied to.
 *   rateSuccesses /  the sample the rate came from. The rate is DERIVED from
 *   rateTrials       these rather than passed in, so a rate can never arrive
 *                    without the sample that produced it.
 *   rateSource       internal_observed_cohort or external_published.
 *   rateSourceDetail a sentence naming the source precisely. For an external
 *                    rate this is where the vendor gets named.
 *   valueLow /       the observed order values the money range is built from,
 *   valueMid /       normally the lower quartile, middle and upper quartile of
 *   valueHigh        real orders. Not an average, because an average order
 *                    value hides the spread that makes the range honest.
 *
 * Returns a RANGE of people and a RANGE of money, and no point figure for
 * either. The people range is the population times the confidence interval on
 * the rate. The money range is the people range times the observed value
 * spread, so both sources of uncertainty are visible.
 *
 * `measuredUplift` is the only way to obtain an incremental claim. It must
 * carry its own sample. Without it, an incremental claim returns a refusal
 * rather than throwing, because "we cannot answer that yet" is a result the
 * caller should be able to display.
 */
function project({
  label,
  claim,
  population,
  rateSuccesses,
  rateTrials,
  rateSource,
  rateSourceDetail,
  valueLow,
  valueMid,
  valueHigh,
  currency,
  measuredUplift = null,
  z = 1.96
}) {
  const safeLabel = text(label, 'label', 200);
  if (!CLAIM_KINDS.includes(claim)) {
    throw new SizingError(`claim must be one of: ${CLAIM_KINDS.join(', ')}.`);
  }
  if (!RATE_SOURCES.includes(rateSource)) {
    throw new SizingError(`rateSource must be one of: ${RATE_SOURCES.join(', ')}.`);
  }
  const safeDetail = text(rateSourceDetail, 'rateSourceDetail', 600);
  const people = nonNegativeInteger(population, 'population');

  if (claim === 'incremental_from_contact') {
    const upliftTrials = Number(measuredUplift?.trials);
    if (!Number.isSafeInteger(upliftTrials) || upliftTrials <= 0) {
      return refuse({
        label: safeLabel,
        reason: 'no_measured_uplift',
        detail: 'There is no measured difference between contacting these customers and leaving '
          + 'them alone, because no promotional campaign has ever been delivered from this system. '
          + 'Every return in the history happened with no contact at all, so the observed rate is '
          + 'what happens anyway and cannot be presented as revenue a message would create. Run a '
          + 'campaign against a holdout, measure the gap, and this becomes answerable.',
        population: people
      });
    }
  }

  const rate = claim === 'incremental_from_contact'
    ? wilsonInterval(measuredUplift.successes, measuredUplift.trials, z)
    : wilsonInterval(rateSuccesses, rateTrials, z);

  if (rate.trials === 0) {
    return refuse({
      label: safeLabel,
      reason: 'no_sample_behind_rate',
      detail: 'The rate this projection would need has no sample behind it, so there is nothing to '
        + 'project from. The population is reported on its own.',
      population: people
    });
  }

  const low = round2(finiteNumber(valueLow, 'valueLow'));
  const mid = round2(finiteNumber(valueMid, 'valueMid'));
  const high = round2(finiteNumber(valueHigh, 'valueHigh'));
  if (low > mid || mid > high) throw new SizingError('valueLow, valueMid and valueHigh must be ordered.');

  const peopleLow = Math.floor(people * rate.low);
  const peopleHigh = Math.ceil(people * rate.high);

  return Object.freeze({
    kind: 'projection',
    method: SIZING_METHOD_VERSION,
    label: safeLabel,
    claim,
    // Repeated in plain words so nothing downstream has to know what the enum
    // means to render it safely.
    claimMeans: claim === 'no_action_baseline'
      ? 'What this group is expected to do with no message sent. It is a yardstick to judge a '
        + 'campaign against, not revenue a campaign would create.'
      : 'The measured difference between contacting this group and leaving it alone.',
    population: people,
    rate: {
      point: rate.point,
      low: rate.low,
      high: rate.high,
      successes: rate.successes,
      trials: rate.trials,
      confidence: `${Math.round((1 - 2 * (1 - normalCdf(z))) * 100)}%`,
      source: rateSource,
      sourceDetail: safeDetail,
      fromThisShopsOwnData: rateSource === 'internal_observed_cohort'
    },
    peopleRange: { low: peopleLow, high: peopleHigh },
    moneyRange: {
      currency: text(currency || 'unknown', 'currency', 8),
      low: round2(peopleLow * low),
      high: round2(peopleHigh * high),
      middleIfEveryOrderWereTypical: round2(Math.round(people * rate.point) * mid),
      orderValueBasis: { lowerQuartile: low, middle: mid, upperQuartile: high }
    },
    assumption: assumptionSentence({ claim, rate, rateSource, safeDetail }),
    hypothetical: true
  });
}

/** Standard normal CDF, used only to render z as a readable confidence level. */
function normalCdf(z) {
  // Abramowitz and Stegun 7.1.26 error function approximation.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * The sentence that has to travel with every projection. It names the rate, the
 * sample, and where the sample came from, in that order, because those are the
 * three things a reader needs to decide whether to believe it.
 */
function assumptionSentence({ claim, rate, rateSource, safeDetail }) {
  const percentage = `${round2(rate.point * 100)}%`;
  const band = `${round2(rate.low * 100)}% to ${round2(rate.high * 100)}%`;
  const origin = rateSource === 'internal_observed_cohort'
    ? `This rate is this shop's own history: ${rate.successes} of ${rate.trials}. ${safeDetail}`
    : `This rate is NOT from this shop's data. It is a published outside figure and it may not `
      + `describe these customers at all. ${safeDetail}`;
  const meaning = claim === 'no_action_baseline'
    ? 'It describes what happens with no message sent, so it is the number a campaign has to beat, '
      + 'not the number a campaign would earn.'
    : 'It describes the measured gap between contacting this group and leaving it alone.';
  return `Assumes ${percentage} (${band} allowing for the size of the sample). ${origin} ${meaning}`;
}

/**
 * Throws if a figure carries a key that could be printed on its own and read
 * as a fact. Called by the detector on everything it emits, and asserted
 * directly by the test suite.
 */
function assertNoHeadlineFigure(figure, path = 'figure') {
  if (!figure || typeof figure !== 'object') return figure;
  if (Array.isArray(figure)) {
    figure.forEach((entry, index) => assertNoHeadlineFigure(entry, `${path}[${index}]`));
    return figure;
  }
  if (figure.kind === 'projection') {
    for (const key of BANNED_HEADLINE_KEYS) {
      if (key in figure) {
        throw new SizingError(`${path}.${key} is a bare headline figure on a projection.`);
      }
    }
    if (!figure.assumption || !figure.rate?.trials) {
      throw new SizingError(`${path} is a projection with no stated assumption or sample.`);
    }
    if (!figure.peopleRange || figure.peopleRange.low === undefined) {
      throw new SizingError(`${path} is a projection with no range.`);
    }
  }
  for (const [key, value] of Object.entries(figure)) {
    if (value && typeof value === 'object') assertNoHeadlineFigure(value, `${path}.${key}`);
  }
  return figure;
}

/** Quantiles of a numeric sample, for building an honest value range. */
function quantiles(values) {
  const sorted = (values || [])
    .map(Number).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return { count: 0, min: null, lowerQuartile: null, middle: null, upperQuartile: null, max: null, sum: 0 };
  }
  const at = fraction => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const value = lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    return round2(value);
  };
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    lowerQuartile: at(0.25),
    middle: at(0.5),
    upperQuartile: at(0.75),
    max: round2(sorted[sorted.length - 1]),
    sum: round2(sorted.reduce((total, value) => total + value, 0))
  };
}

module.exports = {
  BANNED_HEADLINE_KEYS,
  CLAIM_KINDS,
  RATE_SOURCES,
  SIZING_METHOD_VERSION,
  SizingError,
  assertNoHeadlineFigure,
  observed,
  observedMoney,
  project,
  quantiles,
  refuse,
  wilsonInterval
};
