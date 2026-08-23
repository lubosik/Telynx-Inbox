'use strict';
/**
 * lib/campaigns/segment-facts.js — one record per customer, from the same
 * authoritative rows the campaign generator reads.
 *
 * WHY THIS IS NOT DERIVED FROM buildGenerationInput()
 *   `buildGenerationInput()` answers "who could we prepare a draft for right
 *   now", so it drops a customer whose product has unknown stock and a
 *   customer whose commercial eligibility is not clear. Those are correct
 *   exclusions for a draft and wrong ones for a segment: "customers who bought
 *   BPC-157 more than twice" is a question about people, and answering it with
 *   a silently pruned subset would produce a count nobody can reconcile.
 *
 *   So this reads the SAME `sources` object returned by
 *   `readAuthoritativeGenerationSources()` — the same orders, the same
 *   contacts, the same eligibility rows — and applies its own, stated,
 *   filtering. Commercial eligibility becomes a dimension the operator can ask
 *   about rather than an invisible filter.
 *
 * WHAT COUNTS AS AN ORDER
 *   The same paid statuses the generator uses, deduplicated by order id. An
 *   order total is a whole-order figure, so summing per product group would
 *   double count a two-product order; spend is summed over unique orders only.
 *
 * WHAT A MISSING VALUE MEANS
 *   `null`, and null never matches a comparison. A customer with no orders has
 *   no last order date, no cadence and no average order value, so
 *   "days since last order at least 0" still means "has ordered at least
 *   once" rather than "everybody". `orderCount`, `lifetimeSpend` and
 *   `consentState` are defined for every customer; the validator's vacuity
 *   check depends on exactly that split.
 *
 * NO PII LEAVES THIS FILE TOWARDS A MODEL. These records are used by the
 * evaluator and the preview only. The translator never sees one.
 */

const { normalisePhone } = require('../phone');
const {
  authoritativeSupportState,
  currentInventory
} = require('./generation-service');
const { cadenceFromIntervals, intervalDays, qualifyingPurchaseTimes } = require('./reorder-cadence');

const DAY_MS = 86400000;
const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);
const MAX_PRODUCT_NAME = 120;

function itemsFor(order) {
  if (Array.isArray(order?.items)) return order.items;
  if (typeof order?.items !== 'string') return [];
  try {
    const parsed = JSON.parse(order.items);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function exactItem(item) {
  const productID = Number(item?.product_id);
  const variationID = Number(item?.variation_id || 0);
  if (!Number.isSafeInteger(productID) || productID <= 0 ||
      !Number.isSafeInteger(variationID) || variationID < 0) return null;
  return {
    productKey: `${productID}:${variationID}`,
    productID,
    variationID,
    name: typeof item?.name === 'string' ? item.name.trim().slice(0, MAX_PRODUCT_NAME) || null : null
  };
}

/**
 * Suppression rows in force at `now`. Reimplemented here rather than imported
 * because generation-service does not export it; the semantics are copied from
 * `activeSuppressionPhones()` there and the two must stay in step.
 */
function suppressedPhones(rows, now) {
  const phones = new Set();
  const at = now.getTime();
  for (const row of rows || []) {
    const phone = normalisePhone(row?.contact_phone);
    const effective = Date.parse(row?.effective_at);
    const expires = row?.expires_at == null ? null : Date.parse(row.expires_at);
    if (phone && row.active === true && Number.isFinite(effective) && effective <= at &&
        (expires === null || (Number.isFinite(expires) && expires > at))) phones.add(phone);
  }
  return phones;
}

function latestSupportByPhone(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const phone = normalisePhone(row?.contact_phone || row?.phone);
    const time = Date.parse(row?.observed_at);
    if (!phone || !Number.isFinite(time)) continue;
    const previous = out.get(phone);
    if (!previous || Date.parse(previous.observed_at) < time) out.set(phone, row);
  }
  return out;
}

/**
 * `clear`, `blocked` or `unknown`, from the same eligibility record the
 * campaign engine reads.
 *
 * "clear" is NOT permission to send. It means the commercial eligibility row
 * is current and says nothing is wrong. Consent, provider approval, STOP
 * state, quiet hours and cadence are all checked separately at send time and
 * none of them is visible here.
 */
function consentStateFor(phone, { support, supportAvailable, suppressions, now }) {
  if (suppressions.has(phone)) return 'blocked';
  if (!supportAvailable) return 'unknown';
  const state = authoritativeSupportState(support.get(phone), now);
  if (state === 'clear') return 'clear';
  if (state === 'unknown') return 'unknown';
  return 'blocked';
}

/**
 * The verified product catalogue a rule may name.
 *
 * Names come from inventory where it exists and from order lines otherwise,
 * because a product that has been bought but is no longer stocked is still a
 * legitimate thing to segment on. `available` records which is which, so the
 * builder can say so without excluding it.
 */
function buildProductCatalogue(sources, now) {
  const catalogue = new Map();
  for (const row of sources.inventory || []) {
    const productID = Number(row.product_id);
    const variationID = Number(row.variation_id || 0);
    if (!Number.isSafeInteger(productID) || productID <= 0) continue;
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, MAX_PRODUCT_NAME) : '';
    if (!name) continue;
    catalogue.set(`${productID}:${variationID}`, {
      productKey: `${productID}:${variationID}`,
      productID,
      variationID,
      name,
      available: Boolean(currentInventory(row, now))
    });
  }
  for (const order of sources.orders || []) {
    if (!PAID_STATUSES.has(String(order.status || '').toLowerCase())) continue;
    for (const rawItem of itemsFor(order)) {
      const item = exactItem(rawItem);
      if (!item || !item.name || catalogue.has(item.productKey)) continue;
      catalogue.set(item.productKey, {
        productKey: item.productKey,
        productID: item.productID,
        variationID: item.variationID,
        name: item.name,
        available: false
      });
    }
  }
  return [...catalogue.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.productKey.localeCompare(b.productKey));
}

/**
 * Build one fact record per known customer.
 *
 * @param {object} sources  readAuthoritativeGenerationSources() output
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {{ now: string, facts: object[], catalogue: object[], coverage: object }}
 */
function buildCustomerFacts(sources = {}, { now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const support = latestSupportByPhone(sources.support);
  const suppressions = suppressedPhones(sources.suppressions, at);
  const supportAvailable = sources.supportAvailable === true;

  const byPhone = new Map();
  function record(phone) {
    if (!byPhone.has(phone)) {
      byPhone.set(phone, {
        contactPhone: phone,
        contactID: null,
        contactName: null,
        orderTimes: new Map(),
        orderTotals: new Map(),
        products: new Map()
      });
    }
    return byPhone.get(phone);
  }

  // Contacts first, so a customer with no orders still exists as a person a
  // rule can be about. "Never ordered" is a real audience.
  for (const row of sources.contacts || []) {
    const phone = normalisePhone(row?.phone);
    if (!phone) continue;
    const entry = record(phone);
    const id = Number(row.id);
    entry.contactID = Number.isSafeInteger(id) && id > 0 ? id : null;
    entry.contactName = typeof row.name === 'string' ? row.name.trim().slice(0, 200) || null : null;
  }

  let ordersConsidered = 0;
  let nonExactOrderItems = 0;
  for (const order of sources.orders || []) {
    const phone = normalisePhone(order?.contact_phone);
    if (!phone) continue;
    if (!PAID_STATUSES.has(String(order.status || '').toLowerCase())) continue;
    const created = Date.parse(order.created_at);
    if (!Number.isFinite(created)) continue;
    const orderID = String(order.woo_order_id ?? order.id ?? '');
    if (!orderID) continue;
    ordersConsidered += 1;

    const entry = record(phone);
    entry.orderTimes.set(orderID, created);
    const total = Number(order.total);
    entry.orderTotals.set(orderID, Number.isFinite(total) && total > 0 ? total : 0);

    const seen = new Set();
    for (const rawItem of itemsFor(order)) {
      const item = exactItem(rawItem);
      if (!item) { nonExactOrderItems += 1; continue; }
      if (seen.has(item.productKey)) continue;
      seen.add(item.productKey);
      if (!entry.products.has(item.productKey)) {
        entry.products.set(item.productKey, { orderIDs: new Set(), lastOrderAt: created });
      }
      const product = entry.products.get(item.productKey);
      product.orderIDs.add(orderID);
      if (created > product.lastOrderAt) product.lastOrderAt = created;
    }
  }

  const facts = [];
  for (const entry of byPhone.values()) {
    const times = [...entry.orderTimes.values()].sort((a, b) => a - b);
    const orderCount = times.length;
    const lifetimeSpend = Math.round([...entry.orderTotals.values()]
      .reduce((sum, value) => sum + value, 0) * 100) / 100;
    const lastOrderTime = times.length ? times[times.length - 1] : null;
    const cadence = cadenceFromIntervals(intervalDays(qualifyingPurchaseTimes(
      times.map(time => new Date(time))
    )));

    const productOrderCounts = {};
    const productKeys = [];
    for (const [productKey, product] of entry.products) {
      productOrderCounts[productKey] = product.orderIDs.size;
      productKeys.push(productKey);
    }
    productKeys.sort();

    facts.push({
      contactPhone: entry.contactPhone,
      contactID: entry.contactID,
      contactName: entry.contactName,
      orderCount,
      lifetimeSpend,
      averageOrderValue: orderCount > 0 ? Math.round((lifetimeSpend / orderCount) * 100) / 100 : null,
      lastOrderAt: lastOrderTime === null ? null : new Date(lastOrderTime).toISOString(),
      daysSinceLastOrder: lastOrderTime === null
        ? null
        : Math.floor((at.getTime() - lastOrderTime) / DAY_MS),
      cadenceMedianDays: cadence.reliable ? Math.round(cadence.medianDays * 100) / 100 : null,
      cadenceConfidence: cadence.reliable ? cadence.confidence : 'none',
      cadenceIntervalCount: Number(cadence.intervalCount || 0),
      productKeys,
      productOrderCounts,
      consentState: consentStateFor(entry.contactPhone, {
        support, supportAvailable, suppressions, now: at
      })
    });
  }

  facts.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));

  return {
    now: at.toISOString(),
    facts,
    catalogue: buildProductCatalogue(sources, at),
    coverage: {
      customers: facts.length,
      ordersConsidered,
      nonExactOrderItems,
      commercialEligibilityAvailable: supportAvailable
    }
  };
}

module.exports = {
  PAID_STATUSES,
  buildCustomerFacts,
  buildProductCatalogue,
  consentStateFor,
  suppressedPhones
};
