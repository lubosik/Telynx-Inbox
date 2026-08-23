'use strict';
/**
 * lib/campaigns/buyer-cohorts.js — who these customers are, by what they have
 * bought and when, rather than by what the reorder engine can predict.
 *
 * WHY THIS FILE EXISTS
 *   The reorder engine is correct and it reaches about nine people. It needs
 *   three spaced purchases OF ONE PRODUCT before it will say anything, and
 *   almost nobody here does that.
 *
 *   The reason is not that customers never come back. 277 of 781 buyers came
 *   back at least once. The reason is that when they come back they buy
 *   SOMETHING ELSE. Repeat behaviour here is cross-product, and an engine
 *   measuring same-product spacing is blind to it.
 *
 *   That distinction governs this whole file: A COHORT IS DECIDED AT THE
 *   CUSTOMER LEVEL, NEVER THE CUSTOMER-PRODUCT LEVEL. Somebody who bought
 *   BPC-157 once and GHK-Cu once is a repeat customer with two one-time
 *   products, and must never appear in a one-time-buyer cohort. Counting
 *   customer-product pairs instead of customers is what turns 504 one-time
 *   buyers into an imaginary 1,300 and makes the problem look bigger than it
 *   is. `orderCount` below comes from buildCustomerFacts(), which counts
 *   distinct paid ORDERS per person, and every cohort predicate reads it.
 *
 * WHERE THE CUTS COME FROM
 *   The axis is how long ago the only order was, because a buyer from three
 *   weeks ago and a buyer from six months ago are different propositions.
 *
 *   The boundaries are 30, 90 and 365 days. They are round, and they are not
 *   borrowed: they were checked against this shop's own repeat buyers before
 *   being adopted. Measured on 2026-08-23 across 277 repeat buyers, half of
 *   everyone who ever placed a second order had placed it by day 33.9, and
 *   nine in ten had by day 94.3. So 30 and 90 sit within a few days of where
 *   this shop's own behaviour already puts them, and the chance of a return
 *   falls steadily from the first order onwards rather than spiking later.
 *   Effort is front-loaded.
 *
 *   There is deliberately NO cohort beyond 365 days. The oldest paid order in
 *   the database is 215 days old, so such a cohort would contain nobody, and
 *   the decay means it would not be worth a flow even once it could be filled.
 *
 *   The cuts are FROZEN, not recomputed live. A saved segment whose meaning
 *   shifted every night would make "why is this person in this list"
 *   unanswerable. Every build recomputes the live distribution and reports the
 *   DRIFT instead, so a person can re-freeze deliberately. `calibration.drift`
 *   is that report.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   No RFM grid. At 781 buyers a five by five by five grid averages six people
 *   per cell, and a six-person cell has no measurable rate. There is one
 *   binary spend split, above or below what a one-time buyer typically spends,
 *   and that is the whole of the value dimension.
 *
 *   No lifetime-value model and no propensity score. At this sample size, with
 *   a dominant never-repeated class, such a model fits noise and then reports
 *   the noise with a decimal point on it.
 *
 *   `actionableFloorPeople` records the size below which a cohort's own
 *   observed rate is consistent with almost any true rate. Cohorts under it
 *   are still computed and still shown; they are flagged, not hidden.
 *
 * MEMBERSHIP IS BEHAVIOUR, NEVER PERMISSION
 *   Same rule as lib/campaigns/segment-definitions.js. Nothing here reads
 *   consent, STOP state, DND, quiet hours or support clearance. Whether a
 *   person may be messaged is decided at send time by the gates that already
 *   exist. A cohort answers "who is this", not "may we".
 *
 *   `everCommerciallyContacted` is on the record because "nobody in this group
 *   has ever been contacted" is the single most important fact about these
 *   people, and it is read from the commercial contact ledger, a record of
 *   what was SENT. It is not consent and it filters nobody out.
 *
 * ONE READER
 *   Everything here derives from the `sources` object that
 *   readAuthoritativeGenerationSources() already returns, and person-level
 *   facts come from buildCustomerFacts() so that "an order" means exactly the
 *   same thing here as in a described segment. This file adds only the
 *   order-level and product-level detail those facts do not carry: what the
 *   single order was worth, how many different products were in it, and
 *   whether those products can still be bought.
 */

const { normalisePhone } = require('../phone');
const { buildCustomerFacts } = require('./segment-facts');
const { currentInventory, inventoryFor, mergedInventory } = require('./generation-service');
const { buildCatalogueIndex, resolveOrderItemIdentity, summariseResolutions } = require('./product-identity');

const DAY_MS = 86400000;
const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);

/**
 * Bumped when a cohort's meaning changes. Stored on every member row, so an
 * old row still reads as "this is what the rules said at the time".
 */
const BUYER_COHORT_RULE_VERSION = 'buyer-cohorts-2026-08-23';

/**
 * THE FROZEN CUTS.
 *
 * Measured by scripts/dry-run-buyer-cohorts.js against the live database on
 * the date below. Every figure is an observation and the comment beside it
 * says what was observed.
 *
 * Re-freezing is a deliberate act: change these, bump
 * BUYER_COHORT_RULE_VERSION, and record in docs/campaigns/BUYER-COHORTS.md
 * what moved and why.
 */
const COHORT_CALIBRATION = Object.freeze({
  measuredOn: '2026-08-23',
  /** Paid orders, deduplicated by order id, behind every figure here. */
  paidOrdersObserved: 1288,
  /** Distinct people with at least one paid order. */
  buyersObserved: 781,
  /** Of those, people with exactly one paid order. */
  oneTimeBuyersObserved: 504,
  /** Of those, people with two or more. Repeat behaviour does exist here. */
  repeatBuyersObserved: 277,

  // ---- tenure boundaries, in days since the only order --------------------
  /** End of the first cohort. Adopted round, validated below. */
  earlyEndsAtDays: 30,
  /** End of the second. */
  slippingEndsAtDays: 90,
  /** End of the third. Nothing is built beyond it; see the file header. */
  lapsedEndsAtDays: 365,

  // ---- the measurements that validate those boundaries --------------------
  /** Day by which half of all returning customers had placed order two. */
  observedHalfReturnedByDays: 33.9,
  /** Day by which nine in ten of them had. */
  observedNineInTenReturnedByDays: 94.3,
  /** Oldest paid order in the database, which bounds every tenure cohort. */
  longestObservedTenureDays: 215,

  // ---- the one value dimension -------------------------------------------
  /**
   * What a one-time buyer typically spent on their single order. A single
   * binary split, deliberately at the middle rather than anywhere finer: see
   * "WHAT IS DELIBERATELY NOT HERE".
   */
  typicalOneTimeOrderValue: 169.24,

  /**
   * Below this many people, a cohort's own observed rate is consistent with
   * almost any true rate, so a decision taken from it is a coin toss with
   * extra steps. Flagged, never hidden.
   */
  actionableFloorPeople: 100
});

/** Horizons the organic return baseline is measured at, in days. */
const BASELINE_HORIZON_DAYS = Object.freeze([30, 60, 90, 120, 180]);

function itemsFor(order) {
  if (Array.isArray(order?.items)) return order.items;
  if (typeof order?.items !== 'string') return [];
  try {
    const parsed = JSON.parse(order.items);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function paid(order) {
  return PAID_STATUSES.has(String(order?.status || '').toLowerCase());
}

function quantileOf(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Math.round(value * 100) / 100;
}

/**
 * Every paid order, per person, with the detail a cohort needs: when, what it
 * was worth, and which catalogue products were in it.
 *
 * Product identity is resolved through lib/campaigns/product-identity.js, not
 * by reading `product_id` off the line item. On the live database 2,334 of
 * 2,346 paid line items carry no Woo identifier at all, so reading the field
 * directly resolves half a percent of the history and makes every
 * product-shaped cohort look empty.
 */
function ordersByPerson(sources) {
  const inventory = mergedInventory(sources);
  const catalogueAvailable = sources.catalogueAvailable !== false;
  const index = sources.catalogueIndex || buildCatalogueIndex(sources.catalogueEntries || []);

  const byPhone = new Map();
  const resolutions = [];
  let ordersConsidered = 0;

  for (const order of sources.orders || []) {
    const phone = normalisePhone(order?.contact_phone);
    if (!phone || !paid(order)) continue;
    const placedAt = Date.parse(order.created_at);
    if (!Number.isFinite(placedAt)) continue;
    const id = String(order?.woo_order_id ?? order?.id ?? '');
    if (!id) continue;

    if (!byPhone.has(phone)) byPhone.set(phone, new Map());
    const orders = byPhone.get(phone);
    if (orders.has(id)) continue;
    ordersConsidered += 1;

    const total = Number(order.total);
    const productKeys = new Set();
    for (const item of itemsFor(order)) {
      const resolution = resolveOrderItemIdentity(item, index, { catalogueAvailable });
      resolutions.push(resolution);
      if (resolution.resolved) productKeys.add(`${resolution.productID}:${resolution.variationID}`);
    }

    orders.set(id, {
      placedAt,
      total: Number.isFinite(total) && total > 0 ? total : 0,
      productKeys: [...productKeys].sort()
    });
  }

  return { byPhone, resolutions, ordersConsidered, inventory };
}

/**
 * How much of what somebody bought can still be bought.
 *
 * `unknown` when no line item resolved to a catalogue product, or when the
 * catalogue could not be read. Never quietly folded into `none`: "we could not
 * tell" and "it is gone" lead to opposite decisions.
 */
function availabilityOf(productKeys, inventory, now, catalogueAvailable) {
  if (!catalogueAvailable) return 'unknown';
  if (!productKeys.length) return 'unknown';
  let purchasable = 0;
  for (const key of productKeys) {
    const [productID, variationID] = key.split(':').map(Number);
    const row = inventoryFor(inventory, productID, variationID);
    if (row && currentInventory(row, now)) purchasable += 1;
  }
  if (purchasable === productKeys.length) return 'all';
  if (purchasable > 0) return 'some';
  return 'none';
}

/**
 * The organic return baseline, measured cohort-lagged so it is not the
 * survivorship lie.
 *
 * For a horizon of N days only buyers whose FIRST order is at least N days old
 * are counted, because anybody newer has not had the chance to return yet.
 * Including them divides by a denominator that could not possibly convert and
 * understates the rate. `cohortSize` is that denominator and travels with the
 * rate so nobody has to take it on trust.
 *
 * This measures what happens with NO CONTACT, because no promotional campaign
 * has ever been delivered from this system. That is what makes it usable as a
 * yardstick and useless as a revenue forecast.
 */
function returnBaseline(byPhone, now) {
  const journeys = [];
  for (const orders of byPhone.values()) {
    const times = [...orders.values()].map(entry => entry.placedAt).sort((a, b) => a - b);
    journeys.push({ first: times[0], second: times.length > 1 ? times[1] : null });
  }

  const withinHorizon = BASELINE_HORIZON_DAYS.map(horizonDays => {
    let cohortSize = 0;
    let returned = 0;
    for (const journey of journeys) {
      if ((now - journey.first) / DAY_MS < horizonDays) continue;
      cohortSize += 1;
      if (journey.second !== null && (journey.second - journey.first) / DAY_MS <= horizonDays) returned += 1;
    }
    return { horizonDays, cohortSize, returned };
  });

  // The number that actually matters for a lapsed cohort: of the people who
  // had NOT come back by day A, how many came back between A and B. A rate
  // measured from day zero is dominated by people who were never at risk, and
  // quoting it at somebody 120 days in overstates their chances.
  const afterPassing = [[30, 90], [30, 180], [90, 180]].map(([fromDays, toDays]) => {
    let cohortSize = 0;
    let returned = 0;
    for (const journey of journeys) {
      if ((now - journey.first) / DAY_MS < toDays) continue;
      const returnedEarly = journey.second !== null
        && (journey.second - journey.first) / DAY_MS <= fromDays;
      if (returnedEarly) continue;
      cohortSize += 1;
      if (journey.second !== null && (journey.second - journey.first) / DAY_MS <= toDays) returned += 1;
    }
    return { stillOneTimeAtDays: fromDays, byDays: toDays, cohortSize, returned };
  });

  const gaps = journeys
    .filter(journey => journey.second !== null)
    .map(journey => (journey.second - journey.first) / DAY_MS)
    .sort((a, b) => a - b);

  return {
    withinHorizon,
    afterPassing,
    returnGap: {
      repeatBuyers: gaps.length,
      halfReturnedByDays: quantileOf(gaps, 0.5),
      threeQuartersReturnedByDays: quantileOf(gaps, 0.75),
      nineInTenReturnedByDays: quantileOf(gaps, 0.9)
    }
  };
}

/** What a second order has actually been worth, for anybody sizing one. */
function secondOrderValues(byPhone) {
  const values = [];
  for (const orders of byPhone.values()) {
    if (orders.size < 2) continue;
    const sorted = [...orders.values()].sort((a, b) => a.placedAt - b.placedAt);
    if (sorted[1].total > 0) values.push(sorted[1].total);
  }
  return values;
}

/**
 * How far the live distribution has moved away from the frozen cuts.
 *
 * Reported, never applied. A drifted cut is a prompt to re-freeze
 * deliberately, not licence for the software to redefine a saved segment
 * behind somebody's back.
 */
function driftReport(frozen, observed) {
  const compare = (name, frozenValue, observedValue, tolerance) => {
    if (observedValue === null || observedValue === undefined) {
      return { name, frozen: frozenValue, observed: null, drifted: false, note: 'not measurable yet' };
    }
    const difference = Math.round((observedValue - frozenValue) * 100) / 100;
    return {
      name,
      frozen: frozenValue,
      observed: observedValue,
      difference,
      tolerance,
      drifted: Math.abs(difference) > tolerance
    };
  };
  const entries = [
    compare('observedHalfReturnedByDays', frozen.observedHalfReturnedByDays, observed.halfReturnedByDays, 7),
    compare('observedNineInTenReturnedByDays', frozen.observedNineInTenReturnedByDays, observed.nineInTenReturnedByDays, 14),
    compare('typicalOneTimeOrderValue', frozen.typicalOneTimeOrderValue, observed.typicalOneTimeOrderValue, 25),
    compare('oneTimeBuyersObserved', frozen.oneTimeBuyersObserved, observed.oneTimeBuyersObserved, 75),
    compare('repeatBuyersObserved', frozen.repeatBuyersObserved, observed.repeatBuyersObserved, 50)
  ];
  const drifted = entries.filter(entry => entry.drifted).map(entry => entry.name);
  return {
    measuredOn: frozen.measuredOn,
    entries,
    anyDrifted: drifted.length > 0,
    driftedNames: drifted,
    action: drifted.length
      ? 'The live data has moved away from the frozen cuts. Re-measure with '
        + 'scripts/dry-run-buyer-cohorts.js and re-freeze COHORT_CALIBRATION deliberately, '
        + 'bumping BUYER_COHORT_RULE_VERSION.'
      : 'The frozen cuts still match the live data.'
  };
}

/**
 * Build one buyer record per known customer, plus the calibration report and
 * the observed baseline.
 *
 * @param {object} sources readAuthoritativeGenerationSources() output
 * @param {object} [options]
 * @param {Date} [options.now]
 */
function buildBuyerCohortFacts(sources = {}, { now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');
  const atTime = at.getTime();
  const catalogueAvailable = sources.catalogueAvailable !== false;

  const { facts } = buildCustomerFacts(sources, { now: at });
  const { byPhone, resolutions, ordersConsidered, inventory } = ordersByPerson(sources);

  const contactedPhones = new Set();
  for (const row of sources.ledger || []) {
    const phone = normalisePhone(row?.contact_phone);
    if (phone) contactedPhones.add(phone);
  }

  const buyers = [];
  for (const record of facts) {
    const orders = byPhone.get(record.contactPhone);
    const sorted = orders ? [...orders.values()].sort((a, b) => a.placedAt - b.placedAt) : [];
    const first = sorted[0] || null;
    const last = sorted.length ? sorted[sorted.length - 1] : null;
    // Null for anybody who is not a one-time buyer, so a comparison against
    // one of these fields can never quietly include a repeat customer.
    const onlyOrder = record.orderCount === 1 && sorted.length === 1 ? sorted[0] : null;

    buyers.push({
      contactPhone: record.contactPhone,
      contactID: record.contactID,
      contactName: record.contactName,
      // CUSTOMER LEVEL. Distinct paid orders per person, from
      // buildCustomerFacts, never customer-product pairs.
      orderCount: record.orderCount,
      lifetimeSpend: record.lifetimeSpend,
      lastOrderAt: record.lastOrderAt,
      daysSinceLastOrder: record.daysSinceLastOrder,
      firstOrderAt: first ? new Date(first.placedAt).toISOString() : null,
      daysSinceFirstOrder: first ? Math.floor((atTime - first.placedAt) / DAY_MS) : null,
      firstOrderValue: first ? Math.round(first.total * 100) / 100 : null,
      distinctProductsEverBought: new Set(sorted.flatMap(entry => entry.productKeys)).size,
      onlyOrderValue: onlyOrder ? Math.round(onlyOrder.total * 100) / 100 : null,
      onlyOrderProductCount: onlyOrder ? onlyOrder.productKeys.length : null,
      onlyOrderProductKeys: onlyOrder ? onlyOrder.productKeys : [],
      onlyOrderAvailability: onlyOrder
        ? availabilityOf(onlyOrder.productKeys, inventory, at, catalogueAvailable)
        : 'unknown',
      lastOrderProductKeys: last ? last.productKeys : [],
      everCommerciallyContacted: contactedPhones.has(record.contactPhone)
    });
  }
  buyers.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));

  const baseline = returnBaseline(byPhone, atTime);
  const oneTimeValues = buyers
    .filter(buyer => buyer.orderCount === 1 && buyer.onlyOrderValue > 0)
    .map(buyer => buyer.onlyOrderValue)
    .sort((a, b) => a - b);
  const ordersPerBuyer = {};
  for (const buyer of buyers) {
    if (buyer.orderCount <= 0) continue;
    const bucket = String(buyer.orderCount);
    ordersPerBuyer[bucket] = (ordersPerBuyer[bucket] || 0) + 1;
  }

  const observedCalibration = {
    paidOrdersObserved: ordersConsidered,
    buyersObserved: buyers.filter(buyer => buyer.orderCount > 0).length,
    oneTimeBuyersObserved: buyers.filter(buyer => buyer.orderCount === 1).length,
    repeatBuyersObserved: buyers.filter(buyer => buyer.orderCount >= 2).length,
    halfReturnedByDays: baseline.returnGap.halfReturnedByDays,
    nineInTenReturnedByDays: baseline.returnGap.nineInTenReturnedByDays,
    typicalOneTimeOrderValue: quantileOf(oneTimeValues, 0.5),
    longestObservedTenureDays: buyers.reduce(
      (longest, buyer) => Math.max(longest, buyer.daysSinceFirstOrder ?? 0), 0)
  };

  return {
    now: at.toISOString(),
    buyers,
    calibration: {
      frozen: COHORT_CALIBRATION,
      observed: observedCalibration,
      drift: driftReport(COHORT_CALIBRATION, observedCalibration),
      ruleVersion: BUYER_COHORT_RULE_VERSION
    },
    baseline: {
      ...baseline,
      secondOrderValues: secondOrderValues(byPhone),
      /**
       * True when the commercial contact ledger is empty. It is the single
       * fact that makes every rate here an ORGANIC rate: nothing in this
       * history was influenced by a message from this system.
       */
      neverContacted: contactedPhones.size === 0,
      commercialContactsRecorded: contactedPhones.size
    },
    coverage: {
      customers: facts.length,
      buyers: buyers.filter(buyer => buyer.orderCount > 0).length,
      contactsWithNoPaidOrder: buyers.filter(buyer => buyer.orderCount === 0).length,
      ordersPerBuyer,
      ordersConsidered,
      productIdentity: summariseResolutions(resolutions),
      catalogueAvailable,
      catalogueStale: sources.catalogueStale === true
    }
  };
}

/**
 * A one-time buyer, at the CUSTOMER level.
 *
 * Exactly one paid order in total. Somebody with two orders of two different
 * products is a repeat customer and fails this, which is the entire point.
 */
function oneTimeBuyer(buyer) {
  return buyer.orderCount === 1 && Number.isInteger(buyer.daysSinceLastOrder);
}

function cohortEvidence(buyer, extra = {}) {
  return {
    detector: 'buyer_cohort',
    countedAt: 'customer',
    orderCount: buyer.orderCount,
    onlyOrderAt: buyer.lastOrderAt,
    daysSinceOnlyOrder: buyer.daysSinceLastOrder,
    onlyOrderValue: buyer.onlyOrderValue,
    productsInOnlyOrder: buyer.onlyOrderProductCount,
    productsStillPurchasable: buyer.onlyOrderAvailability,
    everCommerciallyContacted: buyer.everCommerciallyContacted,
    tenureBasis: {
      measuredOn: COHORT_CALIBRATION.measuredOn,
      repeatBuyersMeasured: COHORT_CALIBRATION.repeatBuyersObserved,
      earlyEndsAtDays: COHORT_CALIBRATION.earlyEndsAtDays,
      slippingEndsAtDays: COHORT_CALIBRATION.slippingEndsAtDays,
      lapsedEndsAtDays: COHORT_CALIBRATION.lapsedEndsAtDays
    },
    ...extra
  };
}

/**
 * THE COHORT CATALOGUE.
 *
 * Copy rules match segment-definitions.js and are enforced by
 * test/campaign-buyer-cohorts.test.js: no dash for a sentence break, no
 * statistical vocabulary, nothing that could read as advice about a person's
 * health, and a description substantial enough to say who is in the group and
 * when you would use it.
 */
const BUYER_COHORTS = Object.freeze({
  one_time_buyers: Object.freeze({
    key: 'one_time_buyers',
    name: 'Bought once and never came back',
    description:
      'Everybody who has paid for exactly one order in total and has not ordered since. Counted '
      + 'per person, so somebody who bought two different products on two occasions is a returning '
      + 'customer and is not in here. This is the largest group in the customer base by a wide '
      + 'margin and not one of them has ever been sent anything by this system. Start here to see '
      + 'the size of it, then work from the smaller groups below.',
    matches: oneTimeBuyer,
    evidence: buyer => cohortEvidence(buyer)
  }),

  one_time_first_month: Object.freeze({
    key: 'one_time_first_month',
    name: 'Bought once, within the last month',
    description:
      'Customers with a single order placed 30 days ago or less. Around half of every second '
      + 'order this shop has ever taken arrived inside that first month, so these people are still '
      + 'inside the ordinary run of things and most are not lost at all. Use this group for a '
      + 'friendly follow up on a first order. It is the wrong group for a win back offer, because '
      + 'you would be discounting to people who were going to come back anyway.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder <= COHORT_CALIBRATION.earlyEndsAtDays,
    evidence: buyer => cohortEvidence(buyer, { tenure: 'first_month' })
  }),

  one_time_slipping: Object.freeze({
    key: 'one_time_slipping',
    name: 'Bought once, and starting to slip away',
    description:
      'Customers with a single order placed between 31 and 90 days ago. They are past the point '
      + 'where most returning customers had already come back, and still inside the stretch that '
      + 'produced nine in ten of every second order this shop has taken. They have not gone yet '
      + 'and they are no longer on track. If one group is worth a well timed message before '
      + 'anything else, it is this one.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder > COHORT_CALIBRATION.earlyEndsAtDays
      && buyer.daysSinceLastOrder <= COHORT_CALIBRATION.slippingEndsAtDays,
    evidence: buyer => cohortEvidence(buyer, { tenure: 'slipping' })
  }),

  one_time_lapsed: Object.freeze({
    key: 'one_time_lapsed',
    name: 'Bought once, and the usual return time has passed',
    description:
      'Customers with a single order placed between 91 and 365 days ago. Nine in ten of the second '
      + 'orders this shop has taken arrived sooner than that, so going on what people here have '
      + 'actually done, these customers are unlikely to come back on their own. This is the '
      + 'biggest of the one order groups. Treat it as a win back audience and expect to give a '
      + 'reason to return, not merely a reminder.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder > COHORT_CALIBRATION.slippingEndsAtDays
      && buyer.daysSinceLastOrder <= COHORT_CALIBRATION.lapsedEndsAtDays,
    evidence: buyer => cohortEvidence(buyer, { tenure: 'lapsed' })
  }),

  one_time_above_typical_spend: Object.freeze({
    key: 'one_time_above_typical_spend',
    name: 'Bought once, and spent above the usual amount',
    description:
      'Customers with a single order worth more than a one order customer here usually spends. '
      + 'They showed they will part with real money and then stopped, which makes each of them '
      + 'worth more attention than a name in the bigger lists. This group deliberately cuts the '
      + 'same people as the three time based groups, from a different angle, so expect it to '
      + 'overlap them. Pair the two when you decide who to approach by hand.',
    matches: buyer => oneTimeBuyer(buyer)
      && Number.isFinite(buyer.onlyOrderValue)
      && buyer.onlyOrderValue > COHORT_CALIBRATION.typicalOneTimeOrderValue,
    evidence: buyer => cohortEvidence(buyer, {
      spendBasis: {
        measuredOn: COHORT_CALIBRATION.measuredOn,
        oneTimeBuyersMeasured: COHORT_CALIBRATION.oneTimeBuyersObserved,
        aboveThisAmount: COHORT_CALIBRATION.typicalOneTimeOrderValue
      }
    })
  }),

  one_time_multi_product: Object.freeze({
    key: 'one_time_multi_product',
    name: 'Bought once, and took more than one product',
    description:
      'Customers with a single order that contained more than one different product. Choosing '
      + 'several things on a first visit is the strongest sign of interest this shop records '
      + 'before somebody becomes a regular, and most of the one order group did exactly that. Use '
      + 'it when you want the warmest part of the one order audience, and pair it with one of the '
      + 'time based groups to decide what to say to them.',
    matches: buyer => oneTimeBuyer(buyer) && Number(buyer.onlyOrderProductCount) > 1,
    evidence: buyer => cohortEvidence(buyer, { productKeysInOnlyOrder: buyer.onlyOrderProductKeys })
  })
});

const BUYER_COHORT_KEYS = Object.freeze(Object.keys(BUYER_COHORTS).sort());

/**
 * Cohorts considered and deliberately NOT built, with the reason.
 *
 * Recorded in code rather than only in a document, because the next person to
 * ask "why is there no dormant-over-a-year list" will read this file, and
 * because the opportunity detector returns this list so the absence is visible
 * on the screen rather than only to a reader of source.
 */
const COHORTS_NOT_BUILT = Object.freeze([
  Object.freeze({
    key: 'one_time_dormant_over_a_year',
    reason: 'no_such_customer_exists',
    detail: 'The oldest paid order in the database is 215 days old, so a cohort of people whose '
      + 'only order was over a year ago would contain nobody. The chance of a return also falls '
      + 'steadily with time, so it would not be worth its own flow even once it could be filled.'
  }),
  Object.freeze({
    key: 'rfm_grid',
    reason: 'sample_too_small',
    detail: 'A recency, frequency and value grid over 781 buyers averages about six people per '
      + 'cell. A six-person cell has no measurable rate, so the grid would produce confident '
      + 'looking labels with nothing behind them.'
  }),
  Object.freeze({
    key: 'propensity_or_lifetime_value_model',
    reason: 'sample_too_small',
    detail: 'With 781 buyers and a dominant never-repeated class, a fitted score reproduces noise '
      + 'and then reports it to a decimal place. The tenure cohorts carry the same information '
      + 'without the false precision.'
  }),
  Object.freeze({
    key: 'product_back_in_stock_buyers',
    reason: 'no_stock_transition_history',
    detail: 'A back in stock cohort needs a recorded out of stock to in stock transition. '
      + 'sms_product_inventory and sms_commerce_product_events are both empty, so there is no '
      + 'previous state to compare against and no such transition can be evidenced yet. Seed the '
      + 'baseline with scripts/seed-product-inventory-baseline.js before expecting one.'
  })
]);

function buyerCohort(key) {
  return BUYER_COHORTS[String(key || '')] || null;
}

function buyerCohortCatalogue() {
  return BUYER_COHORT_KEYS.map(key => {
    const cohort = BUYER_COHORTS[key];
    return {
      key: cohort.key,
      detector: 'buyer_cohort',
      name: cohort.name,
      description: cohort.description,
      ruleVersion: BUYER_COHORT_RULE_VERSION
    };
  });
}

/**
 * Members of one cohort, in the same row shape every other automatic segment
 * produces, so segment-service can reconcile, digest, override and notify
 * without knowing a cohort from a reorder candidate.
 *
 * `commercialClearance` is null on purpose. A cohort is decided entirely from
 * purchase history, so there is no clearance observation to carry; the read
 * time contactability layer fills it in for display.
 */
function computeBuyerCohortMembers(cohortKey, cohortFacts, { now = new Date() } = {}) {
  const cohort = buyerCohort(cohortKey);
  if (!cohort) throw new Error(`Unknown buyer cohort: ${String(cohortKey)}`);
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const buyers = Array.isArray(cohortFacts?.buyers) ? cohortFacts.buyers : [];
  const members = [];
  for (const buyer of buyers) {
    if (typeof buyer?.contactPhone !== 'string' || !buyer.contactPhone) continue;
    if (!cohort.matches(buyer)) continue;
    members.push({
      contactPhone: buyer.contactPhone,
      contactID: buyer.contactID ?? null,
      contactName: buyer.contactName ?? null,
      // `cohortRuleVersion`, not `ruleVersion`. When these rows travel
      // through computeSegmentMembers() the shared wrapper stamps
      // `ruleVersion` with the segment catalogue's own version, and two
      // different meanings under one key is how an evidence row stops being
      // readable years later.
      inclusionEvidence: {
        ...cohort.evidence(buyer),
        cohortRuleVersion: BUYER_COHORT_RULE_VERSION,
        cohortKey: cohort.key
      },
      commercialClearance: null
    });
  }
  members.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));
  return members;
}

/**
 * Whether a cohort is large enough for its own observed rate to mean anything.
 * Advisory, attached to a finding rather than used to hide one.
 */
function actionability(population) {
  const people = Number(population) || 0;
  const floor = COHORT_CALIBRATION.actionableFloorPeople;
  return {
    people,
    floor,
    belowFloor: people < floor,
    note: people < floor
      ? `Fewer than ${floor} people. A rate measured on a group this size is consistent with a `
        + 'wide range of true rates, so treat any percentage from it as a hint rather than a '
        + 'finding.'
      : `At least ${floor} people, which is enough for a measured rate to be worth acting on.`
  };
}

module.exports = {
  BASELINE_HORIZON_DAYS,
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  BUYER_COHORT_RULE_VERSION,
  COHORTS_NOT_BUILT,
  COHORT_CALIBRATION,
  actionability,
  availabilityOf,
  buildBuyerCohortFacts,
  buyerCohort,
  buyerCohortCatalogue,
  computeBuyerCohortMembers,
  driftReport,
  oneTimeBuyer,
  quantileOf,
  returnBaseline
};
