'use strict';
/**
 * lib/campaigns/opportunity-detector.js — where the revenue actually is,
 * across the whole customer base, at portfolio level.
 *
 * NOT PER PERSON
 *   lib/campaigns/opportunity-policy.js already answers "is there a reason to
 *   contact THIS customer today". This file answers a different question the
 *   owner has been asking and nothing could answer: "look at everybody, and
 *   tell me where the money is". The output is a small number of findings
 *   about groups, each with the evidence that produced it and an honest
 *   statement of how big it might be.
 *
 * EVERY FINDING IS THREE SEPARATE THINGS, AND THEY NEVER MERGE
 *   evidence   what is true, counted from rows. Population, order values,
 *              observed return rates, whether anybody has ever been contacted.
 *   observed   money that has already been taken. Real, banked, historical.
 *   sizing     what MIGHT happen, or an explicit refusal to say. Always built
 *              through lib/campaigns/opportunity-sizing.js, which cannot
 *              produce a bare number.
 *
 *   A reader who only looks at `evidence` gets facts. A reader who only looks
 *   at `sizing` gets ranges with their assumptions attached. There is nowhere
 *   to look that produces a confident figure with no provenance, and
 *   assertNoHeadlineFigure() runs over the whole payload before it is returned.
 *
 * THE BASELINE IS NOT A BENEFIT
 *   Every rate this detector has is an ORGANIC rate. No promotional campaign
 *   has ever been delivered from this system, the commercial contact ledger is
 *   empty, and so every second order in the history happened with no contact
 *   at all. That makes those rates a yardstick for judging a future campaign
 *   and useless as a forecast of one. Every projection here therefore carries
 *   `claim: 'no_action_baseline'`, and the incremental question returns a
 *   refusal until somebody runs a holdout and measures the difference.
 *
 * SMALL GROUPS ARE FLAGGED, NOT HIDDEN
 *   A cohort under the actionable floor still appears, with `actionability`
 *   saying that a rate measured on it is consistent with a wide range of true
 *   rates. Hiding it would be a different kind of lie.
 */

const {
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  COHORTS_NOT_BUILT,
  COHORT_CALIBRATION,
  actionability,
  computeBuyerCohortMembers
} = require('./buyer-cohorts');
const {
  assertNoHeadlineFigure,
  observed,
  observedMoney,
  project,
  quantiles,
  refuse
} = require('./opportunity-sizing');

/** Bumped when a finding's meaning changes. Stamped on the payload. */
const DETECTOR_VERSION = 'opportunity-detector-2026-08-23';

/**
 * The reporting currency.
 *
 * `sms_orders` carries no currency column, so there is nothing per-order to
 * read. This matches the default already used by
 * lib/campaigns/attribution-generator.js, and is overridable for a workspace
 * that is not selling in it. No symbol is ever emitted; the code travels
 * beside the number.
 */
function reportingCurrency(env = process.env) {
  const configured = String(env?.CAMPAIGN_REPORTING_CURRENCY || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(configured) ? configured : 'USD';
}

/**
 * The organic return rate that applies to a cohort at its own tenure.
 *
 * A cohort 120 days in must not be quoted the day-zero rate. Most of what that
 * rate measures is people who returned in week one, who by definition are not
 * in a lapsed cohort at all. `afterPassing` holds the conditional rates and
 * this picks the one whose starting point matches the cohort.
 */
function baselineForTenure(baseline, { stillOneTimeAtDays, byDays }) {
  const rows = Array.isArray(baseline?.afterPassing) ? baseline.afterPassing : [];
  return rows.find(row => row.stillOneTimeAtDays === stillOneTimeAtDays && row.byDays === byDays) || null;
}

function withinHorizon(baseline, horizonDays) {
  const rows = Array.isArray(baseline?.withinHorizon) ? baseline.withinHorizon : [];
  return rows.find(row => row.horizonDays === horizonDays) || null;
}

/**
 * One cohort's membership and the facts that describe it.
 *
 * Membership comes from computeBuyerCohortMembers, the same function the saved
 * segment uses, so a finding can never disagree with the segment it names.
 */
function cohortSlice(cohortKey, cohortFacts) {
  const members = computeBuyerCohortMembers(cohortKey, cohortFacts, { now: new Date(cohortFacts.now) });
  const phones = new Set(members.map(member => member.contactPhone));
  const buyers = (cohortFacts.buyers || []).filter(buyer => phones.has(buyer.contactPhone));
  const orderValues = buyers
    .map(buyer => buyer.onlyOrderValue)
    .filter(value => Number.isFinite(value) && value > 0);
  const neverContacted = buyers.filter(buyer => !buyer.everCommerciallyContacted).length;
  const availability = { all: 0, some: 0, none: 0, unknown: 0 };
  let daysSum = 0;
  const daysList = [];
  for (const buyer of buyers) {
    availability[buyer.onlyOrderAvailability] = (availability[buyer.onlyOrderAvailability] || 0) + 1;
    if (Number.isInteger(buyer.daysSinceLastOrder)) {
      daysSum += buyer.daysSinceLastOrder;
      daysList.push(buyer.daysSinceLastOrder);
    }
  }
  return {
    key: cohortKey,
    name: BUYER_COHORTS[cohortKey].name,
    population: buyers.length,
    neverContacted,
    orderValues: quantiles(orderValues),
    tenureDays: quantiles(daysList),
    availability,
    averageTenureDays: daysList.length ? Math.round((daysSum / daysList.length) * 10) / 10 : null
  };
}

/**
 * Build one finding for a one-time-buyer cohort.
 *
 * `conditionalBaseline` is the organic return rate measured from this cohort's
 * own starting point. When there is none, the finding still exists and its
 * sizing is a refusal that reports the population and the observed order
 * values instead. That is the required behaviour, not a degraded one.
 */
function cohortFinding({
  slice, cohortFacts, currency, conditionalBaseline, horizonLabel,
  spansEveryTenure = false, anchorNote = ''
}) {
  const reach = actionability(slice.population);
  const values = slice.orderValues;

  const sizing = {};
  if (spansEveryTenure) {
    sizing.baseline = refuse({
      label: `What ${slice.name} would do with no message sent`,
      reason: 'mixed_tenure_population',
      detail: 'This group contains customers who bought last week and customers who bought six '
        + 'months ago, and those two have very different chances of coming back on their own. '
        + 'There is no single rate that describes both, and the one rate that could be quoted '
        + 'here would be dominated by people who came back within a week, none of whom is in this '
        + 'group any more. The three time based groups each sit at one point in a customer life '
        + 'and each carry their own rate. Read those.',
      population: slice.population,
      observedInstead: values
    });
  } else if (!conditionalBaseline || conditionalBaseline.cohortSize <= 0) {
    sizing.baseline = refuse({
      label: `What ${slice.name} would do with no message sent`,
      reason: 'no_comparable_history',
      detail: 'No earlier group of customers has been in this position long enough to show what '
        + 'they do next, so there is no rate from this shop to apply and no honest way to project '
        + 'one. The population and what these people actually spent are reported instead.',
      population: slice.population,
      observedInstead: values
    });
  } else {
    sizing.baseline = project({
      label: `What ${slice.name} would do with no message sent, ${horizonLabel}`,
      claim: 'no_action_baseline',
      population: slice.population,
      rateSuccesses: conditionalBaseline.returned,
      rateTrials: conditionalBaseline.cohortSize,
      rateSource: 'internal_observed_cohort',
      rateSourceDetail: `Measured on this shop's own buyers: of those still on one order at day `
        + `${conditionalBaseline.stillOneTimeAtDays} and old enough to observe to day `
        + `${conditionalBaseline.byDays}, ${conditionalBaseline.returned} of `
        + `${conditionalBaseline.cohortSize} placed a second order. Not one of them was contacted, `
        + `because no campaign has ever been sent from this system. ${anchorNote}`,
      valueLow: values.lowerQuartile ?? 0,
      valueMid: values.middle ?? 0,
      valueHigh: values.upperQuartile ?? 0,
      currency
    });
  }

  // The question the owner actually wants answered, and the one there is no
  // evidence for. Asked explicitly so the refusal is on the record rather than
  // being an absence somebody could read as an oversight.
  sizing.incremental = project({
    label: `Extra orders a message to ${slice.name} would create`,
    claim: 'incremental_from_contact',
    population: slice.population,
    rateSuccesses: 0,
    rateTrials: 0,
    rateSource: 'internal_observed_cohort',
    rateSourceDetail: 'There is no such measurement.',
    valueLow: values.lowerQuartile ?? 0,
    valueMid: values.middle ?? 0,
    valueHigh: values.upperQuartile ?? 0,
    currency,
    measuredUplift: null
  });

  return {
    key: slice.key,
    segmentKey: slice.key,
    title: slice.name,
    population: slice.population,
    actionability: reach,
    evidence: {
      countedAt: 'customer',
      people: observed({
        label: `People in ${slice.name}`,
        countedFrom: `${cohortFacts.coverage.ordersConsidered} paid orders across `
          + `${cohortFacts.coverage.buyers} buyers, counted per person and never per product pair.`,
        people: slice.population,
        neverContacted: slice.neverContacted
      }),
      orderValue: observed({
        label: 'What their single order was worth',
        countedFrom: `${values.count} single orders with a positive total.`,
        currency,
        lowerQuartile: values.lowerQuartile,
        middle: values.middle,
        upperQuartile: values.upperQuartile,
        lowest: values.min,
        highest: values.max
      }),
      timeSinceOrder: observed({
        label: 'How long ago that order was',
        countedFrom: `${slice.tenureDays.count} one order customers.`,
        earliestDays: slice.tenureDays.min,
        lowerQuartileDays: slice.tenureDays.lowerQuartile,
        middleDays: slice.tenureDays.middle,
        upperQuartileDays: slice.tenureDays.upperQuartile,
        latestDays: slice.tenureDays.max
      }),
      canStillBuyIt: observed({
        label: 'Whether what they bought can still be bought',
        countedFrom: 'The live WooCommerce catalogue, read through the shared catalogue cache.',
        everyProductStillOnSale: slice.availability.all || 0,
        someProductsGone: slice.availability.some || 0,
        everyProductGone: slice.availability.none || 0,
        couldNotTell: slice.availability.unknown || 0
      })
    },
    observed: {
      moneyAlreadyTaken: observedMoney({
        label: `Money these ${slice.population} people have already paid`,
        countedFrom: 'The sum of their single paid orders. Already banked, not an opportunity.',
        currency,
        amount: values.sum,
        orders: values.count,
        people: slice.population
      })
    },
    sizing
  };
}

/**
 * Findings that are not about a cohort: structural facts about the customer
 * base that change what anybody should build next.
 */
function structuralFindings(cohortFacts, currency) {
  const coverage = cohortFacts.coverage;
  const buyers = cohortFacts.buyers || [];
  const findings = [];

  // 1. Why the reorder engine reaches almost nobody, stated as data rather
  //    than as a complaint. Repeat behaviour exists; it is cross-product.
  const repeatBuyers = buyers.filter(buyer => buyer.orderCount >= 2);
  const crossProductRepeat = repeatBuyers.filter(buyer =>
    buyer.distinctProductsEverBought >= buyer.orderCount).length;
  findings.push({
    key: 'repeat_behaviour_is_cross_product',
    title: 'People do come back, they just buy something else',
    population: repeatBuyers.length,
    actionability: actionability(repeatBuyers.length),
    evidence: {
      countedAt: 'customer',
      buyers: observed({
        label: 'Orders per buyer',
        countedFrom: `${coverage.ordersConsidered} paid orders across ${coverage.buyers} buyers.`,
        ordersPerBuyer: coverage.ordersPerBuyer,
        repeatBuyers: repeatBuyers.length,
        repeatBuyersWhoseProductsAreAtLeastAsVariedAsTheirOrders: crossProductRepeat
      })
    },
    observed: {},
    sizing: {
      baseline: refuse({
        label: 'The value of fixing the reorder engine',
        reason: 'not_a_revenue_question',
        detail: 'This finding explains why a same-product reorder engine finds so few people here. '
          + 'It is a reason to build cross-product cohorts, which is what the one order groups are, '
          + 'and there is no population being contacted so there is nothing to size.',
        population: repeatBuyers.length
      })
    }
  });

  // 2. Contacts with no paid order. A real population, and one there is no
  //    honest way to value: they have never spent anything here.
  const noOrder = coverage.contactsWithNoPaidOrder;
  findings.push({
    key: 'contacts_with_no_paid_order',
    title: 'Known contacts who have never paid for anything',
    population: noOrder,
    actionability: actionability(noOrder),
    evidence: {
      countedAt: 'customer',
      people: observed({
        label: 'Contacts with no paid order on record',
        countedFrom: `${coverage.customers} known contacts, of whom ${coverage.buyers} have paid `
          + 'for at least one order.',
        people: noOrder
      })
    },
    observed: {},
    sizing: {
      baseline: refuse({
        label: 'What these contacts are worth',
        reason: 'no_observed_order_value',
        detail: 'These people have never placed a paid order, so this shop has no observation of '
          + 'what one of them spends and no observation of how often one of them converts. Both '
          + 'numbers a projection needs are missing, and borrowing either from the buyers would be '
          + 'assuming the answer. The population is the finding.',
        population: noOrder
      })
    }
  });

  // 3. Products the one-time buyers can no longer buy. Operational, not
  //    promotional: a message offering a gone product is worse than silence.
  const oneTime = buyers.filter(buyer => buyer.orderCount === 1);
  const goneEntirely = oneTime.filter(buyer => buyer.onlyOrderAvailability === 'none').length;
  const partlyGone = oneTime.filter(buyer => buyer.onlyOrderAvailability === 'some').length;
  findings.push({
    key: 'one_time_buyers_whose_product_is_gone',
    title: 'One order customers whose product is no longer on sale',
    population: goneEntirely + partlyGone,
    actionability: actionability(goneEntirely + partlyGone),
    evidence: {
      countedAt: 'customer',
      products: observed({
        label: 'Whether a one order customer could buy the same thing again today',
        countedFrom: 'The live WooCommerce catalogue against their resolved order lines.',
        everythingTheyBoughtIsGone: goneEntirely,
        someOfItIsGone: partlyGone,
        outOf: oneTime.length
      })
    },
    observed: {},
    sizing: {
      baseline: refuse({
        label: 'Revenue recoverable from these customers',
        reason: 'nothing_to_offer_them',
        detail: 'A win back message needs something to buy. For these customers the thing they '
          + 'chose is not currently on sale, so the finding is a restocking or substitution '
          + 'decision rather than a campaign, and sizing it as campaign revenue would be sizing a '
          + 'message nobody can send.',
        population: goneEntirely + partlyGone
      })
    }
  });

  return findings;
}

/**
 * Everything standing between a finding and any action on it.
 *
 * Reported at portfolio level because they are the same for every finding, and
 * because a screen full of opportunities with no statement that sending is
 * switched off would be an invitation to assume it is not.
 */
function portfolioBlockers(cohortFacts, env) {
  const blockers = [];
  if (cohortFacts.baseline?.neverContacted) {
    blockers.push({
      key: 'no_campaign_has_ever_been_sent',
      severity: 'informational',
      detail: 'The commercial contact ledger is empty. Nobody in any of these groups has ever '
        + 'received a campaign message from this system. That is why every rate here describes '
        + 'what customers do on their own, and why no figure here can be presented as revenue a '
        + 'campaign would create.'
    });
  }
  if (String(env?.CAMPAIGNS_LIVE_SEND_ENABLED || '') !== 'true') {
    blockers.push({
      key: 'live_sending_is_off',
      severity: 'blocking',
      detail: 'Promotional delivery is switched off in this environment. These findings are '
        + 'analysis. They are not permission to send, and they do not become one when the switch '
        + 'is turned on: consent, provider approval, quiet hours, frequency limits and Admin '
        + 'approval are all separate and all still apply.'
    });
  }
  if (cohortFacts.coverage?.catalogueAvailable === false) {
    blockers.push({
      key: 'product_catalogue_unavailable',
      severity: 'degraded',
      detail: 'The WooCommerce catalogue could not be read on this run, so nothing here knows '
        + 'which products can still be bought. Population counts are unaffected; the stock figures '
        + 'read as unknown rather than as gone.'
    });
  }
  if (cohortFacts.calibration?.drift?.anyDrifted) {
    blockers.push({
      key: 'cohort_cuts_have_drifted',
      severity: 'informational',
      detail: cohortFacts.calibration.drift.action
    });
  }
  return blockers;
}

/**
 * Read the whole customer base and report where the revenue is.
 *
 * @param {object} cohortFacts buildBuyerCohortFacts() output
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {object} the portfolio, safe to return from an API
 */
function detectOpportunities(cohortFacts, { env = process.env } = {}) {
  if (!cohortFacts || !Array.isArray(cohortFacts.buyers)) {
    throw new Error('detectOpportunities requires buildBuyerCohortFacts() output.');
  }
  const currency = reportingCurrency(env);
  const baseline = cohortFacts.baseline || {};

  // WHICH RATE A COHORT IS ENTITLED TO QUOTE, AND WHICH IS NOT ENTITLED TO ONE.
  //
  // A conditional rate is anchored at a point in a customer's life: "of the
  // people who were still on one order at day 30, this many came back". It
  // only applies to a population sitting at that same point.
  //
  // The three TENURE cohorts each sit at one point, so each takes the rate
  // anchored at its own lower boundary. That anchoring errs HIGH on purpose:
  // somebody 25 days into the first month has already gone 25 days without
  // returning, so their true remaining chance is at or below the rate measured
  // from day zero. Erring high on a do-nothing baseline is the conservative
  // direction, because the baseline is a hurdle a campaign has to clear, and
  // an understated hurdle would flatter a campaign. The assumption sentence
  // says so.
  //
  // The parent cohort and the two orthogonal cuts SPAN every tenure. There is
  // no single point they sit at, so there is no single conditional rate that
  // applies to them, and quoting one would be exactly the survivorship error
  // the conditional rates exist to avoid: a rate measured from day zero is
  // dominated by people who returned in week one, and every one of those
  // people has already left the one-time population by definition. Those three
  // refuse, and point at the tenure cohorts, which do have an answer.
  const ANCHORED_AT_ENTRY = 'The people in this group entered it at that point and some have '
    + 'already gone weeks past it without returning, so the true figure is at or below this '
    + 'range. That is the safe direction for a number a campaign has to beat.';
  const tenureRates = {
    one_time_first_month: withinHorizon(baseline, 90)
      ? { ...withinHorizon(baseline, 90), stillOneTimeAtDays: 0, byDays: 90 }
      : null,
    one_time_slipping: baselineForTenure(baseline, { stillOneTimeAtDays: 30, byDays: 180 }),
    one_time_lapsed: baselineForTenure(baseline, { stillOneTimeAtDays: 90, byDays: 180 })
  };
  const spansEveryTenure = new Set([
    'one_time_buyers', 'one_time_above_typical_spend', 'one_time_multi_product'
  ]);
  const horizonLabels = {
    one_time_first_month: 'over their first three months',
    one_time_slipping: 'over the following few months',
    one_time_lapsed: 'over the following three months'
  };

  const findings = [];
  for (const cohortKey of BUYER_COHORT_KEYS) {
    const slice = cohortSlice(cohortKey, cohortFacts);
    findings.push(cohortFinding({
      slice,
      cohortFacts,
      currency,
      conditionalBaseline: tenureRates[cohortKey] || null,
      spansEveryTenure: spansEveryTenure.has(cohortKey),
      anchorNote: ANCHORED_AT_ENTRY,
      horizonLabel: horizonLabels[cohortKey] || 'over the following few months'
    }));
  }
  findings.push(...structuralFindings(cohortFacts, currency));

  // Biggest population first, because the question this answers is "where is
  // the revenue", and a group of four hundred is where you look before a group
  // of nine. Ties break on key so the order is reproducible.
  findings.sort((left, right) =>
    right.population - left.population || String(left.key).localeCompare(String(right.key)));

  // Every refusal, gathered where nobody can miss it. A refusal buried inside
  // a finding is a refusal somebody scrolls past.
  const refusals = [];
  for (const finding of findings) {
    for (const [name, figure] of Object.entries(finding.sizing || {})) {
      if (figure?.kind !== 'refusal') continue;
      refusals.push({
        finding: finding.key,
        question: name,
        label: figure.label,
        reason: figure.reason,
        detail: figure.detail,
        population: figure.population
      });
    }
  }

  const allOrderValues = (cohortFacts.buyers || [])
    .filter(buyer => buyer.orderCount > 0)
    .map(buyer => buyer.lifetimeSpend)
    .filter(value => Number.isFinite(value) && value > 0);

  const payload = {
    detectorVersion: DETECTOR_VERSION,
    computedAt: cohortFacts.now,
    currency,
    portfolio: {
      moneyAlreadyTaken: observedMoney({
        label: 'Everything paid customers have spent, across the whole history read',
        countedFrom: `${cohortFacts.coverage.ordersConsidered} paid orders across `
          + `${cohortFacts.coverage.buyers} buyers.`,
        currency,
        amount: allOrderValues.reduce((total, value) => total + value, 0),
        orders: cohortFacts.coverage.ordersConsidered,
        people: cohortFacts.coverage.buyers
      }),
      customers: observed({
        label: 'The shape of the customer base',
        countedFrom: 'Contacts and paid orders, counted per person.',
        knownContacts: cohortFacts.coverage.customers,
        buyers: cohortFacts.coverage.buyers,
        contactsWithNoPaidOrder: cohortFacts.coverage.contactsWithNoPaidOrder,
        ordersPerBuyer: cohortFacts.coverage.ordersPerBuyer
      })
    },
    findings,
    refusals,
    notBuilt: COHORTS_NOT_BUILT,
    blockers: portfolioBlockers(cohortFacts, env),
    calibration: cohortFacts.calibration,
    baseline: {
      neverContacted: baseline.neverContacted === true,
      commercialContactsRecorded: baseline.commercialContactsRecorded || 0,
      returnWithin: baseline.withinHorizon || [],
      returnAfterPassing: baseline.afterPassing || [],
      secondOrderValue: quantiles(baseline.secondOrderValues || []),
      whatThisMeasures: 'What customers did with no message sent. Every rate here is the number a '
        + 'campaign has to beat, not a number a campaign would earn.'
    },
    coverage: cohortFacts.coverage,
    floor: {
      people: COHORT_CALIBRATION.actionableFloorPeople,
      note: 'Findings below this population are reported with a warning rather than hidden. A rate '
        + 'measured on a small group is consistent with a wide range of true rates.'
    }
  };

  // The last line of defence. If anything above ever grows a bare headline
  // figure, this throws here rather than shipping it to a screen.
  assertNoHeadlineFigure(payload, 'opportunities');
  return payload;
}

module.exports = {
  DETECTOR_VERSION,
  baselineForTenure,
  cohortSlice,
  detectOpportunities,
  portfolioBlockers,
  reportingCurrency,
  structuralFindings
};
