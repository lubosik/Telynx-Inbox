'use strict';
/**
 * lib/campaigns/product-catalogue.js — the live WooCommerce catalogue, read
 * once and cached, plus the stock snapshot the detectors read availability
 * from.
 *
 * WHY IT IS CACHED
 *   Campaign generation resolves every historical line item against the
 *   catalogue. Reading the catalogue per recompute costs 1 request for the
 *   product list plus 1 per variable product (currently 24 requests against
 *   vicipeptides.com). That is fine occasionally and unacceptable on every
 *   segment recompute, of which there is one per segment.
 *
 * HOW IT INVALIDATES, IN ORDER OF WHICH ONE ACTUALLY FIRES
 *   1. EVENT. `invalidateProductCatalogue()` is called by the WooCommerce
 *      product webhook in lib/campaigns/product-webhooks.js. A product
 *      created, updated or deleted is precisely the event that makes this
 *      cache wrong, so in normal operation the cache is never stale for longer
 *      than webhook latency.
 *   2. TTL. `CAMPAIGN_CATALOGUE_TTL_MS`, default 15 minutes. This is the
 *      backstop for a missed or unconfigured webhook, not the primary
 *      mechanism.
 *   3. RESTART. The cache is in-process and per-worker. It holds no authority
 *      and losing it costs one refetch.
 *
 *   A refresh that FAILS does not clear the cache and does not throw at the
 *   caller: the previous snapshot keeps being served with `stale: true` and
 *   its true `fetchedAt`, and the caller decides what an old snapshot is worth.
 *   `currentInventory()` in generation-service.js already refuses to treat an
 *   observation older than 24 hours as evidence of stock, so an outage
 *   degrades to "no candidates" rather than to "candidates based on last
 *   week's stock".
 *
 * WHAT THIS FILE MUST NOT DO
 *   It must not manufacture a restock. `isRestockTransition()` in
 *   product-webhooks.js returns false when there is no previous snapshot,
 *   because a first sighting of "in stock" is not evidence that anything came
 *   back. Reading the catalogue is a first sighting. This module therefore
 *   produces stock ROWS and never product EVENTS, and there is a test that
 *   fails if that ever changes.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * How long a FAILED read is remembered before another is attempted.
 *
 * ── WHY A FAILURE NEEDS A CACHE OF ITS OWN ─────────────────────────────────
 *
 * A successful read is cached for fifteen minutes. A failed one was not
 * remembered at all, so every caller retried immediately, which is the right
 * instinct and the wrong behaviour when the store is actually down.
 *
 * Measured while vicipeptides.com was returning 522: each attempt took 19.7
 * seconds and every one of them failed. The campaign screen calls preview on
 * load, preview needs the catalogue, so opening a campaign cost twenty seconds
 * of waiting on a dead host, and opening three cost a minute. The app looked
 * broken because a third party was.
 *
 * Thirty seconds is short enough that a store coming back is picked up almost
 * immediately, and long enough that a burst of screen loads costs one attempt
 * rather than one each.
 */
const FAILURE_TTL_MS = 30 * 1000;

/**
 * How long to wait for the store before giving up on it.
 *
 * Cloudflare holds a 522 open for about twenty seconds before answering, and
 * nothing on a phone should wait that long for a product list. Eight seconds
 * is comfortably longer than a healthy read of this catalogue, which takes
 * under two, and short enough that failing feels like an answer.
 */
const REQUEST_TIMEOUT_MS = 8000;

/** The last failure, so a dead store is not re-dialled on every screen load. */
let lastFailure = null;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const VARIATION_CONCURRENCY = 4;

const { normaliseDose, normaliseSku, normaliseText, positiveInteger } = require('./product-identity');

let cached = null;
let inflight = null;

function ttlFrom(env) {
  const parsed = Number(env?.CAMPAIGN_CATALOGUE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

/** The dose option a Woo variation represents, normalised. */
function variationDose(variation) {
  const attribute = (variation?.attributes || []).find(row => row && row.option);
  const source = attribute?.option || variation?.name;
  const dose = normaliseDose(source);
  return dose || null;
}

/**
 * Flatten a Woo product plus its variations into resolver entries.
 * A parent entry has `variationID: 0`; a variation entry carries both.
 */
function catalogueEntries(product, variations = []) {
  const productID = positiveInteger(product?.id);
  if (!productID) return [];
  const parentName = typeof product?.name === 'string' ? product.name.trim().slice(0, 500) : '';
  const publicationStatus = String(product?.status || 'publish').toLowerCase();
  // The product's own page on the store. Only ever read from WooCommerce, so
  // it cannot drift from where the product actually lives, and it is validated
  // against the approved-host rule before it can reach a message.
  const permalink = typeof product?.permalink === 'string' ? product.permalink.trim() : '';

  const parent = {
    productID,
    variationID: 0,
    permalink: permalink || null,
    sku: normaliseSku(product?.sku) || null,
    name: parentName || null,
    parentName: parentName || null,
    baseName: parentName ? normaliseText(parentName) : null,
    dose: null,
    stockStatus: typeof product?.stock_status === 'string' ? product.stock_status.toLowerCase() : null,
    stockQuantity: Number.isFinite(Number(product?.stock_quantity)) ? Number(product.stock_quantity) : null,
    manageStock: product?.manage_stock === true,
    purchasable: product?.purchasable !== false,
    publicationStatus,
    sourceUpdatedAt: product?.date_modified_gmt || product?.date_modified || null
  };

  const rows = [parent];
  for (const variation of variations) {
    const variationID = positiveInteger(variation?.id);
    if (!variationID) continue;
    const status = String(variation?.status || publicationStatus).toLowerCase();
    rows.push({
      permalink: permalink || null,
      productID,
      variationID,
      sku: normaliseSku(variation?.sku) || null,
      name: typeof variation?.name === 'string' ? variation.name.trim().slice(0, 500) || null : null,
      parentName: parentName || null,
      // Deliberately null: see buildCatalogueIndex, variations are not name-indexed.
      baseName: null,
      dose: variationDose(variation),
      stockStatus: typeof variation?.stock_status === 'string' ? variation.stock_status.toLowerCase() : null,
      stockQuantity: Number.isFinite(Number(variation?.stock_quantity)) ? Number(variation.stock_quantity) : null,
      manageStock: variation?.manage_stock === true,
      purchasable: variation?.purchasable !== false,
      publicationStatus: status,
      sourceUpdatedAt: variation?.date_modified_gmt || variation?.date_modified || null
    });
  }
  return rows;
}

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

/**
 * Read the whole catalogue from WooCommerce. No caching here; that is
 * `productCatalogue()`.
 *
 * `now` is the observation instant and defaults to the wall clock. Callers
 * pass their own, so the cache's age arithmetic and the caller's freshness
 * arithmetic use ONE clock. It is also conservative: `now` is captured before
 * the read begins, so `fetchedAt` is never later than the moment the data
 * actually arrived, and an observation can only look older than it is.
 *
 * @param {(path: string, params?: object) => Promise<{data: any, headers: any}>} wooGet
 * @param {object} [options]
 * @param {Date|string} [options.now]
 * @returns {Promise<{ fetchedAt: string, entries: Array<object>, productCount: number, variationCount: number }>}
 */
async function fetchProductCatalogue(wooGet, { now = new Date() } = {}) {
  if (typeof wooGet !== 'function') throw new Error('A WooCommerce reader is required.');
  const observedTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // The short timeout is the point: this runs behind a screen, and waiting
    // twenty seconds for Cloudflare to admit the origin is unreachable makes
    // the app look broken when the store is.
    const { data, headers } = await wooGet(
      '/products', { per_page: PER_PAGE, page, status: 'publish' },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
    const rows = Array.isArray(data) ? data : [];
    products.push(...rows);
    const totalPages = Number(headers?.get?.('X-WP-TotalPages') || '1');
    if (rows.length < PER_PAGE || page >= totalPages) break;
  }

  const variable = products.filter(product => String(product?.type || '') === 'variable' && positiveInteger(product?.id));
  const variationSets = await mapWithConcurrency(variable, VARIATION_CONCURRENCY, async product => {
    const { data } = await wooGet(
      `/products/${product.id}/variations`, { per_page: PER_PAGE },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
    return Array.isArray(data) ? data : [];
  });
  const variationsByProduct = new Map(variable.map((product, index) => [product.id, variationSets[index] || []]));

  const entries = [];
  for (const product of products) {
    entries.push(...catalogueEntries(product, variationsByProduct.get(product.id) || []));
  }
  return {
    fetchedAt: new Date(Number.isFinite(observedTime) ? observedTime : Date.now()).toISOString(),
    entries,
    productCount: products.length,
    variationCount: entries.filter(entry => entry.variationID).length
  };
}

/** Drop the cache. Called by the product webhook; see the header. */
function invalidateProductCatalogue() {
  cached = null;
}

/** Test seam. Never call this from application code. */
function primeProductCatalogue(snapshot) {
  cached = snapshot ? { ...snapshot, stale: false } : null;
  inflight = null;
  return cached;
}

/**
 * The cached catalogue.
 *
 * Never throws for a provider failure. A first load that fails returns
 * `{ available: false }`; a refresh that fails returns the previous snapshot
 * marked stale. Both are states the resolver understands, and both produce
 * fewer candidates rather than wrong ones.
 *
 * @param {object} [options]
 * @param {Function} [options.wooGet]
 * @param {object} [options.env]
 * @param {Date} [options.now]
 * @param {boolean} [options.forceRefresh]
 * @returns {Promise<{ available: boolean, stale: boolean, fetchedAt: string|null,
 *   ageMs: number|null, entries: Array<object>, error: string|null,
 *   productCount: number, variationCount: number }>}
 */
async function productCatalogue({ wooGet, env = process.env, now = new Date(), forceRefresh = false } = {}) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  const ttl = ttlFrom(env);
  const fresh = cached && Number.isFinite(Date.parse(cached.fetchedAt)) &&
    at - Date.parse(cached.fetchedAt) < ttl;
  if (fresh && !forceRefresh) return snapshotResult(cached, at, null);

  // A failure this recent means the store is down and asking again costs
  // another twenty seconds for the same answer.
  if (!forceRefresh && lastFailure && at - lastFailure.at < FAILURE_TTL_MS) {
    if (cached) return snapshotResult(cached, at, lastFailure.message, true);
    return {
      available: false, zeroEntries: true, stale: true, fetchedAt: null, ageMs: null,
      entries: [], error: lastFailure.message, productCount: 0, variationCount: 0,
      recentlyFailed: true
    };
  }

  const read = wooGet || ((...args) => require('../../woocommerce').wooGet(...args));
  // One in-flight read is shared by every concurrent caller, so a recompute of
  // four segments costs one catalogue fetch rather than four.
  if (!inflight) {
    inflight = (async () => {
      try {
        const snapshot = await fetchProductCatalogue(read, { now });
        cached = { ...snapshot, stale: false };
        lastFailure = null;
        return cached;
      } finally {
        inflight = null;
      }
    })();
  }
  try {
    const snapshot = await inflight;
    return snapshotResult(snapshot, at, null);
  } catch (error) {
    const message = String(error?.message || error || 'catalogue read failed');
    lastFailure = { at, message };
    if (cached) return snapshotResult(cached, at, message, true);
    return {
      available: false, zeroEntries: true, stale: true, fetchedAt: null, ageMs: null,
      entries: [], error: message, productCount: 0, variationCount: 0
    };
  }
}

/**
 * AN EMPTY CATALOGUE IS NOT AN AVAILABLE ONE.
 *
 * A fetch that throws is already handled by the caller: no cache means
 * `available: false`, a cache means the previous snapshot marked stale. Both
 * are honest. The gap this closes is the fetch that SUCCEEDS and returns
 * nothing — a 200 with an empty page, a credential that lost `read_products`
 * scope, every product briefly unpublished, a paging bug. That path used to
 * report `available: true` with `entries: []`, and an empty catalogue index
 * resolves almost no order line, so every downstream count silently changed
 * meaning instead of degrading.
 *
 * Measured against live data: with the catalogue present, 2356 of 2360 order
 * lines resolve and `one_time_multi_product` holds 328 people. With it empty
 * but reported available, 28 resolve and the same cohort holds 11 — a 97 per
 * cent under-count, with nothing anywhere saying so. The docstring on
 * productCatalogue() promises "fewer candidates rather than wrong ones", and
 * that was the one path that broke the promise.
 *
 * `available: false` is a state every caller already understands: the resolver
 * stops claiming identity, availability reads `unknown` rather than `none`,
 * and cohorts that depend on knowing what somebody bought decline to answer.
 * Refusing is correct here, because the alternative is a confident wrong
 * number. `zeroEntries` is on the result so a caller can say WHY identity is
 * unavailable; a provider that was never reachable is told apart from one that
 * answered with nothing by `fetchedAt`, which is null only in the first case.
 */
function snapshotResult(snapshot, at, error, forcedStale = false) {
  const fetchedTime = Date.parse(snapshot.fetchedAt);
  const ageMs = Number.isFinite(fetchedTime) ? at - fetchedTime : null;
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const zeroEntries = entries.length === 0;
  return {
    available: !zeroEntries,
    zeroEntries,
    stale: forcedStale || snapshot.stale === true,
    fetchedAt: snapshot.fetchedAt,
    ageMs,
    entries,
    error: error || (zeroEntries
      ? 'catalogue fetch returned no products, so product identity is unavailable'
      : null),
    productCount: snapshot.productCount,
    variationCount: snapshot.variationCount
  };
}

/**
 * Catalogue entries rendered as `sms_product_inventory` rows.
 *
 * The shape is deliberately identical to the table, so `currentInventory()` in
 * generation-service.js applies its existing freshness and stock rules
 * unchanged and there is no second definition of "available".
 *
 * These rows are OBSERVATIONS OF CURRENT STOCK. They are not transitions and
 * must never be turned into `sms_commerce_product_events`.
 *
 * `now` clamps the observation time, and the reason is not cosmetic. A
 * generation run captures `now` first and reads the catalogue afterwards, and
 * that read takes seconds. `currentInventory()` rejects any observation dated
 * after the evaluation instant, on purpose, so an unclamped `fetchedAt` made
 * every single catalogue row look like it came from the future and suppressed
 * every candidate with `inventory_unknown_or_unavailable`. Clamping moves the
 * timestamp only BACKWARDS, so it can make a row expire sooner but can never
 * make a stale row look fresh.
 *
 * @param {{ entries: Array<object>, fetchedAt: string }} snapshot
 * @param {object} [options]
 * @param {string} [options.workspaceID]
 * @param {Date|string} [options.now]
 * @returns {Array<object>}
 */
function catalogueInventoryRows(snapshot, { workspaceID = 'vici', now = null } = {}) {
  const fetchedTime = Date.parse(snapshot?.fetchedAt);
  const nowTime = now === null ? Number.POSITIVE_INFINITY
    : (now instanceof Date ? now.getTime() : Date.parse(now));
  const resolvedTime = Number.isFinite(fetchedTime) ? fetchedTime : Date.now();
  const observedAt = new Date(
    Number.isFinite(nowTime) ? Math.min(resolvedTime, nowTime) : resolvedTime
  ).toISOString();
  return (snapshot?.entries || [])
    .filter(entry => entry && entry.publicationStatus === 'publish' && positiveInteger(entry.productID))
    .map(entry => ({
      workspace_id: workspaceID,
      product_id: entry.productID,
      variation_id: entry.variationID || 0,
      sku: entry.sku,
      name: entry.name,
      // Woo can report a variable parent as out of stock while a published,
      // purchasable variation of it still has quantity. Neither record is
      // rewritten here: both are stored, and the reader prefers the exact
      // variation because that is the more specific fact.
      stock_status: entry.purchasable === false ? 'outofstock' : entry.stockStatus,
      stock_quantity: entry.stockQuantity,
      source_updated_at: entry.sourceUpdatedAt && Number.isFinite(Date.parse(entry.sourceUpdatedAt))
        ? new Date(entry.sourceUpdatedAt).toISOString()
        : null,
      updated_at: observedAt
    }));
}

/** Testing seam: forget both caches. */
function resetProductCatalogueCache() {
  cached = null;
  inflight = null;
  lastFailure = null;
}

module.exports = {
  DEFAULT_TTL_MS,
  FAILURE_TTL_MS,
  REQUEST_TIMEOUT_MS,
  resetProductCatalogueCache,
  catalogueEntries,
  catalogueInventoryRows,
  fetchProductCatalogue,
  invalidateProductCatalogue,
  primeProductCatalogue,
  productCatalogue,
  variationDose
};
