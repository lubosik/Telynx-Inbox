'use strict';
/**
 * lib/campaigns/buyer-cohorts.js — who these customers are, by what they have
 * bought and when, rather than by what the reorder engine can predict.
 *
 * WHY THIS FILE EXISTS
 *   The reorder engine is correct and it reaches almost nobody. It needs three
 *   spaced purchases of one product before it will say anything, and on the
 *   live database 1,318 of 1,689 customer-product groups have exactly one
 *   purchase. That is not a bug in the engine. It is the shape of the
 *   business: most Vici customers bought once and never came back.
 *
 *   So the money is not in reminding regulars. It is in the several hundred
 *   people who bought once, were never contacted again, and drifted. This file
 *   makes those people addressable.
 *
 * WHERE THE CUTS COME FROM, AND WHY THEY ARE NOT ROUND NUMBERS
 *   The obvious axis for a one-time buyer is how long ago that order was. A
 *   buyer from three weeks ago and a buyer from six months ago are different
 *   propositions and should not sit in one list.
 *
 *   The tempting boundaries are 30, 60 and 90 days. They are somebody else's
 *   numbers. The boundaries below are measured from THIS shop's own repeat
 *   buyers: the gap between a returning customer's first and second order.
 *   Half of everyone who ever came back had come back by day 34. Nine in ten
 *   had come back by day 95. Those two facts define what "still normal",
 *   "getting late" and "gone" mean here, and they mean something different in
 *   another shop.
 *
 *   The boundaries are FROZEN at the values measured on the date below, not
 *   recomputed live. A saved segment whose meaning silently shifted every
 *   night would make "why is this person in this list" unanswerable. Instead
 *   every build recomputes the live distribution and reports the DRIFT, so a
 *   person can re-freeze deliberately when the shape of the business changes.
 *   `calibration.drift` is that report.
 *
 * MEMBERSHIP IS BEHAVIOUR, NEVER PERMISSION
 *   Same rule as lib/campaigns/segment-definitions.js. Nothing here reads
 *   consent, STOP state, DND, quiet hours or support clearance. Whether a
 *   person may be messaged is decided at send time by the gates that already
 *   exist. A cohort answers "who is this", not "may we".
 *
 *   `everCommerciallyContacted` is on the record because "nobody in this group
 *   has ever been contacted" is the single most important fact about the
 *   one-time buyers, and it is read from the commercial contact ledger, which
 *   is a record of what was SENT. It is not consent and it is not used to
 *   filter anybody out.
 *
 * ONE READER
 *   Everything here is derived from the `sources` object that
 *   readAuthoritativeGenerationSources() already returns, and person-level
 *   facts come from buildCustomerFacts() so that "an order" means exactly the
 *   same thing here as it does in a described segment. This file adds the
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
 * the date below. Every figure here is an observation, and the comment beside
 * it is the observation it came from.
 *
 * Re-freezing is a deliberate act: change these numbers, bump
 * BUYER_COHORT_RULE_VERSION, and say in docs/campaigns/BUYER-COHORTS.md what
 * moved and why.
 */
const COHORT_CALIBRATION = Object.freeze({
  measuredOn: '2026-08-23',
  /** Paid orders, deduplicated, that the measurement was taken from. */
  paidOrdersObserved: 1288,
  /** Repeat buyers whose first-to-second gap produced the return window. */
  repeatBuyersObserved: 277,
  /**
   * Day by which half of all returning customers had placed their second
   * order. Observed value 33.9 days, taken as 34.
   */
  halfReturnedByDays: 34,
  /**
   * Day by which nine in ten of them had. Observed value 94.3 days, taken as
   * 95, the first whole day past it.
   */
  nineInTenReturnedByDays: 95,
  /** One-time buyers the spending cut was measured across. */
  oneTimeBuyersObserved: 504,
  /**
   * Upper quartile of what a one-time buyer spent on their single order.
   * Above this is "spent well", measured against this shop rather than a
   * category benchmark.
   */
  wellAboveAverageOrderValue: 218
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

function orderIdentity(order) {
  const id = String(order?.woo_order_id ?? order?.id ?? '');
  return id || null;
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
 * 2,346 line items carry no Woo identifier at all, so reading the field
 * directly resolves 0.5% of the history and makes every product-shaped cohort
 * look empty.
 */
function ordersByPerson(sources, { now }) {
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
    const id = orderIdentity(order);
    if (!id) continue;

    if (!byPhone.has(phone)) byPhone.set(phone, new Map());
    const orders = byPhone.get(phone);
    if (orders.has(id)) continue;
    ordersConsidered += 1;

    const total = Number(order.total);
    const productKeys = new Set();
    for (const [position, item] of itemsFor(order).entries()) {
      const resolution = resolveOrderItemIdentity(item, index, { catalogueAvailable });
      resolutions.push(resolution);
      if (resolution.resolved) {
        productKeys.add(`${resolution.productID}:${resolution.variationID}`);
      }
      void position;
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
 * `unknown` when no line item in the order resolved to a catalogue product, or
 * when the catalogue could not be read. It is never quietly folded into
 * `none`: "we could not tell" and "it is gone" lead to opposite decisions.
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
 * For a horizon of N days: only buyers whose FIRST order is at least N days
 * old are counted, because anybody newer has not had the chance to return yet.
 * Including them would divide by a denominator that cannot possibly convert
 * and would understate the rate. `cohortSize` is that denominator and travels
 * with the rate so nobody has to take it on trust.
 *
 * This measures what happens with NO CONTACT, because no promotional campaign
 * has ever been delivered from this system. That is what makes it usable as a
 * yardstick and useless as a revenue forecast.
 */
function returnBaseline(byPhone, now) {
  const firstAndSecond = [];
  for (const orders of byPhone.values()) {
    const times = [...orders.values()].map(entry => entry.placedAt).sort((a, b) => a - b);
    firstAndSecond.push({
      first: times[0],
      second: times.length > 1 ? times[1] : null,
      orderCount: times.length
    });
  }

  const withinHorizon = BASELINE_HORIZON_DAYS.map(horizonDays => {
    let cohortSize = 0;
    let returned = 0;
    for (const entry of firstAndSecond) {
      if ((now - entry.first) / DAY_MS < horizonDays) continue;
      cohortSize += 1;
      if (entry.second !== null && (entry.second - entry.first) / DAY_MS <= horizonDays) returned += 1;
    }
    return { horizonDays, cohortSize, returned };
  });

  // The number that actually matters for a lapsed cohort: of the people who
  // had NOT come back by day A, how many came back between A and B. A rate
  // measured from day zero is dominated by people who were never at risk.
  const afterPassing = [[34, 95], [34, 180], [95, 180]].map(([fromDays, toDays]) => {
    let cohortSize = 0;
    let returned = 0;
    for (const entry of firstAndSecond) {
      if ((now - entry.first) / DAY_MS < toDays) continue;
      const returnedEarly = entry.second !== null && (entry.second - entry.first) / DAY_MS <= fromDays;
      if (returnedEarly) continue;
      cohortSize += 1;
      if (entry.second !== null && (entry.second - entry.first) / DAY_MS <= toDays) returned += 1;
    }
    return { stillOneTimeAtDays: fromDays, byDays: toDays, cohortSize, returned };
  });

  const gaps = firstAndSecond
    .filter(entry => entry.second !== null)
    .map(entry => (entry.second - entry.first) / DAY_MS)
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
  const { byPhone, resolutions, ordersConsidered, inventory } = ordersByPerson(sources, { now: at });

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
    const onlyOrder = sorted.length === 1 ? sorted[0] : null;

    buyers.push({
      contactPhone: record.contactPhone,
      contactID: record.contactID,
      contactName: record.contactName,
      // Person-level facts come from buildCustomerFacts so that "an order"
      // means the same thing here as it does in a described segment.
      orderCount: record.orderCount,
      lifetimeSpend: record.lifetimeSpend,
      lastOrderAt: record.lastOrderAt,
      daysSinceLastOrder: record.daysSinceLastOrder,
      firstOrderAt: first ? new Date(first.placedAt).toISOString() : null,
      daysSinceFirstOrder: first ? Math.floor((atTime - first.placedAt) / DAY_MS) : null,
      firstOrderValue: first ? Math.round(first.total * 100) / 100 : null,
      // Only meaningful for a one-time buyer, and null for everybody else so
      // that a comparison against it can never quietly include a regular.
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

  const observedCalibration = {
    repeatBuyersObserved: baseline.returnGap.repeatBuyers,
    halfReturnedByDays: baseline.returnGap.halfReturnedByDays,
    nineInTenReturnedByDays: baseline.returnGap.nineInTenReturnedByDays,
    oneTimeBuyersObserved: oneTimeValues.length,
    wellAboveAverageOrderValue: quantileOf(oneTimeValues, 0.75),
    paidOrdersObserved: ordersConsidered
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
      neverContacted: contactedPhones.size === 0,
      commercialContactsRecorded: contactedPhones.size
    },
    coverage: {
      customers: facts.length,
      buyers: buyers.filter(buyer => buyer.orderCount > 0).length,
      contactsWithNoPaidOrder: buyers.filter(buyer => buyer.orderCount === 0).length,
      ordersConsidered,
      productIdentity: summariseResolutions(resolutions),
      catalogueAvailable,
      catalogueStale: sources.catalogueStale === true
    }
  };
}

/**
 * How far the live distribution has moved away from the frozen cuts.
 *
 * Reported, never applied. A cut that has drifted is a prompt to re-freeze
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
      drifted: Math.abs(difference) > tolerance,
      tolerance
    };
  };
  const entries = [
    compare('halfReturnedByDays', frozen.halfReturnedByDays, observed.halfReturnedByDays, 7),
    compare('nineInTenReturnedByDays', frozen.nineInTenReturnedByDays, observed.nineInTenReturnedByDays, 14),
    compare('wellAboveAverageOrderValue', frozen.wellAboveAverageOrderValue, observed.wellAboveAverageOrderValue, 25)
  ];
  return {
    measuredOn: frozen.measuredOn,
    entries,
    anyDrifted: entries.some(entry => entry.drifted),
    action: entries.some(entry => entry.drifted)
      ? 'The live data has moved away from the frozen cuts. Re-measure with '
        + 'scripts/dry-run-buyer-cohorts.js and re-freeze COHORT_CALIBRATION deliberately.'
      : 'The frozen cuts still match the live data.'
  };
}

function oneTimeBuyer(buyer) {
  return buyer.orderCount === 1 && Number.isInteger(buyer.daysSinceLastOrder);
}

function cohortEvidence(buyer, extra = {}) {
  return {
    detector: 'buyer_cohort',
    orderCount: buyer.orderCount,
    onlyOrderAt: buyer.lastOrderAt,
    daysSinceOnlyOrder: buyer.daysSinceLastOrder,
    onlyOrderValue: buyer.onlyOrderValue,
    productsInOnlyOrder: buyer.onlyOrderProductCount,
    productsStillPurchasable: buyer.onlyOrderAvailability,
    everCommerciallyContacted: buyer.everCommerciallyContacted,
    returnWindowBasis: {
      measuredOn: COHORT_CALIBRATION.measuredOn,
      repeatBuyersMeasured: COHORT_CALIBRATION.repeatBuyersObserved,
      halfReturnedByDays: COHORT_CALIBRATION.halfReturnedByDays,
      nineInTenReturnedByDays: COHORT_CALIBRATION.nineInTenReturnedByDays
    },
    ...extra
  };
}

/**
 * THE COHORT CATALOGUE.
 *
 * Copy rules are the same as segment-definitions.js and are enforced by
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
      'Everybody who has paid for exactly one order and has not ordered since. This is the '
      + 'largest group in the customer base by a wide margin, and not one of them has ever been '
      + 'sent anything by this system. Start here to see the size of the problem, then work from '
      + 'the smaller groups below, which split these same people by how long ago that one order '
      + 'was and by how much they spent.',
    matches: oneTimeBuyer,
    evidence: buyer => cohortEvidence(buyer)
  }),

  one_time_recent: Object.freeze({
    key: 'one_time_recent',
    name: 'Bought once, and it was recent',
    description:
      'Customers with a single order placed less than 34 days ago. Half of every customer who '
      + 'has ever placed a second order here had placed it by that point, so these people are '
      + 'still inside the ordinary run of things and most of them are not lost at all. Use this '
      + 'group for a friendly first order follow up. It is the wrong group for a win back offer, '
      + 'because you would be discounting to people who were going to come back anyway.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder < COHORT_CALIBRATION.halfReturnedByDays,
    evidence: buyer => cohortEvidence(buyer, { window: 'inside_the_usual_return_time' })
  }),

  one_time_slipping: Object.freeze({
    key: 'one_time_slipping',
    name: 'Bought once, and starting to slip away',
    description:
      'Customers with a single order placed between 34 and 94 days ago. They are past the point '
      + 'by which half of all returning customers had come back, but still inside the stretch '
      + 'that produced nine in ten of every second order this shop has ever taken. They have not '
      + 'gone yet and they are no longer on track. If one group is worth a well timed message '
      + 'before anything else, it is this one.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder >= COHORT_CALIBRATION.halfReturnedByDays
      && buyer.daysSinceLastOrder < COHORT_CALIBRATION.nineInTenReturnedByDays,
    evidence: buyer => cohortEvidence(buyer, { window: 'slipping' })
  }),

  one_time_lapsed: Object.freeze({
    key: 'one_time_lapsed',
    name: 'Bought once, and the usual return time has passed',
    description:
      'Customers with a single order placed 95 days ago or more. Nine in ten of the second orders '
      + 'this shop has taken arrived sooner than that, so going on what people here have actually '
      + 'done, these customers are unlikely to come back on their own. This is the biggest of the '
      + 'one order groups. Treat it as a win back audience and expect to give a reason to return, '
      + 'not merely a reminder.',
    matches: buyer => oneTimeBuyer(buyer)
      && buyer.daysSinceLastOrder >= COHORT_CALIBRATION.nineInTenReturnedByDays,
    evidence: buyer => cohortEvidence(buyer, { window: 'lapsed' })
  }),

  one_time_high_value: Object.freeze({
    key: 'one_time_high_value',
    name: 'Bought once, and spent well',
    description:
      'Customers with a single order that was in the top quarter of what one order customers '
      + 'spend here. They showed they will spend real money and then stopped, which makes each '
      + 'one worth more than a name in the bigger lists. There are few enough of them to work by '
      + 'hand or by phone, and that is how they should be worked. This group overlaps the '
      + 'recency groups above, because it cuts the same people a different way.',
    matches: buyer => oneTimeBuyer(buyer)
      && Number.isFinite(buyer.onlyOrderValue)
      && buyer.onlyOrderValue >= COHORT_CALIBRATION.wellAboveAverageOrderValue,
    evidence: buyer => cohortEvidence(buyer, {
      spendBasis: {
        measuredOn: COHORT_CALIBRATION.measuredOn,
        oneTimeBuyersMeasured: COHORT_CALIBRATION.oneTimeBuyersObserved,
        topQuarterStartsAt: COHORT_CALIBRATION.wellAboveAverageOrderValue
      }
    })
  }),

  one_time_multi_product: Object.freeze({
    key: 'one_time_multi_product',
    name: 'Bought once, and took more than one product',
    description:
      'Customers with a single order that contained more than one different product. Choosing '
      + 'several things on a first visit is the strongest sign of interest this shop records '
      + 'before somebody becomes a regular, and most of the one order group did exactly that. '
      + 'Use it when you want the warmest part of the one order audience, and pair it with one of '
      + 'the recency groups to decide what to say to them.',
    matches: buyer => oneTimeBuyer(buyer) && Number(buyer.onlyOrderProductCount) > 1,
    evidence: buyer => cohortEvidence(buyer, {
      productKeysInOnlyOrder: buyer.onlyOrderProductKeys
    })
  })
});

const BUYER_COHORT_KEYS = Object.freeze(Object.keys(BUYER_COHORTS).sort());

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
      inclusionEvidence: {
        ...cohort.evidence(buyer),
        ruleVersion: BUYER_COHORT_RULE_VERSION,
        segmentKey: cohort.key,
        cohortKey: cohort.key,
        additionalMatches: 0
      },
      commercialClearance: null
    });
  }
  members.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));
  return members;
}

module.exports = {
  BASELINE_HORIZON_DAYS,
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  BUYER_COHORT_RULE_VERSION,
  COHORT_CALIBRATION,
  availabilityOf,
  buildBuyerCohortFacts,
  buyerCohort,
  buyerCohortCatalogue,
  computeBuyerCohortMembers,
  driftReport,
  quantileOf,
  returnBaseline
};
