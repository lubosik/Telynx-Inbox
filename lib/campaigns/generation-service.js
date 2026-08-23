'use strict';

const { normalisePhone } = require('../phone');
const { stockSnapshot } = require('./product-webhooks');
const { calculateReorderCadence, intervalDays, qualifyingPurchaseTimes } = require('./reorder-cadence');
const { buildCatalogueIndex, resolveOrderItemIdentity, summariseResolutions } = require('./product-identity');
const { catalogueInventoryRows, productCatalogue } = require('./product-catalogue');
const {
  opportunityFeatureFlags,
  persistPreparedDraftRun,
  prepareOpportunityDraftRun
} = require('./opportunity-orchestrator');
const { prepareCampaignReadyNotifications } = require('./campaign-ready-notifications');

const WORKSPACE_ID = 'vici';
const PAGE_SIZE = 1000;
const MAX_ROWS = 100000;
const WORKFLOWS = new Set(['back_in_stock', 'reorder', 'winback']);
const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);
const PAYMENT_RECOVERY_STATUSES = new Set(['failed', 'on-hold', 'pending']);
const SUPPORT_FRESHNESS_HOURS = 24;
const INVENTORY_FRESHNESS_HOURS = 24;
const RESTOCK_LOOKBACK_DAYS = 14;

class CampaignGenerationError extends Error {
  constructor(message, code = 'CAMPAIGN_GENERATION_FAILED', status = 400) {
    super(message);
    this.name = 'CampaignGenerationError';
    this.code = code;
    this.status = status;
  }
}

function missingRelation(error) {
  return ['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code) ||
    /does not exist|could not find|schema cache/i.test(String(error?.message || ''));
}

async function pageRows(makeQuery, label, { maxRows = MAX_ROWS } = {}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (missingRelation(error)) {
        const missing = new CampaignGenerationError(
          `${label} is unavailable until the additive campaign migration is applied.`,
          'CAMPAIGNS_NOT_READY', 503
        );
        missing.cause = error;
        throw missing;
      }
      throw Object.assign(new Error(`${label} could not be read.`), {
        code: error.code || 'CAMPAIGN_SOURCE_READ_FAILED', cause: error
      });
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw new CampaignGenerationError(`${label} exceeded the safe row ceiling.`, 'CAMPAIGN_SOURCE_TRUNCATED', 409);
}

async function optionalPageRows(makeQuery, label) {
  try {
    return { available: true, rows: await pageRows(makeQuery, label) };
  } catch (error) {
    if (missingRelation(error.cause || error)) return { available: false, rows: [] };
    throw error;
  }
}

function selectedWorkflows(input) {
  if (input === undefined || input === null) return [...WORKFLOWS];
  if (!Array.isArray(input) || !input.length) {
    throw new CampaignGenerationError('workflows must be a non-empty array.');
  }
  const unique = [...new Set(input.map(value => String(value || '').trim()))];
  if (unique.some(value => !WORKFLOWS.has(value))) {
    throw new CampaignGenerationError('Unsupported campaign detector workflow.');
  }
  return unique;
}

function itemsFor(order) {
  if (Array.isArray(order?.items)) return order.items;
  if (typeof order?.items !== 'string') return [];
  try {
    const parsed = JSON.parse(order.items);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * The identity of one order line item.
 *
 * `exactItem` used to be the whole of this: it read `product_id` and
 * `variation_id` straight off the line item and returned null otherwise. On
 * the live database 2,334 of 2,343 paid line items have neither field, so it
 * returned null for 99.6% of the history and the detectors saw an empty world.
 * Identity now comes from lib/campaigns/product-identity.js, which resolves a
 * SKU or a name against the live catalogue and still returns null when it
 * cannot be sure.
 *
 * Two keys come back, and the difference is the whole design:
 *   `cadenceKey`      parent product only. Dose variants share it, because a
 *                     customer titrating 10mg to 30mg is one reorder series.
 *   `availabilityKey` parent plus exact variation. Stock is dose-specific and
 *                     is never merged.
 */
function itemIdentity(item, index, catalogueAvailable) {
  const resolution = resolveOrderItemIdentity(item, index, { catalogueAvailable });
  if (!resolution.resolved) return { resolution, identity: null };
  return {
    resolution,
    identity: {
      productID: resolution.productID,
      variationID: resolution.variationID,
      cadenceKey: `product:${resolution.productID}`,
      availabilityKey: `${resolution.productID}:${resolution.variationID}`,
      productName: resolution.productName ||
        (typeof item?.name === 'string' ? item.name.trim().slice(0, 500) || null : null)
    }
  };
}

/**
 * Availability for a customer-product group.
 *
 * The exact variation wins when a record for it exists, even when the parent
 * record disagrees: Woo reports a variable parent as out of stock while a
 * published, purchasable variation of it still has quantity, and on the live
 * catalogue that is true of BPC-157, BPC-157 + TB-500 and Ipamorelin right
 * now. Falling back to the parent for those would suppress every one of their
 * buyers. The fallback to the parent row exists only for the case where no
 * variation-level record was ever observed.
 */
function inventoryFor(inventory, productID, variationID) {
  if (variationID) {
    const exact = inventory.get(`${productID}:${variationID}`);
    if (exact) return exact;
  }
  return inventory.get(`${productID}:0`) || null;
}

/**
 * Merge observed stock from two sources into one map keyed
 * `productID:variationID`.
 *
 * `sources.inventory` is `sms_product_inventory`, written by the verified
 * WooCommerce product webhook. `sources.catalogueInventory` is a direct read of
 * the catalogue. Neither is automatically better: the webhook row is
 * authenticated but only exists for products that have changed since the
 * webhook was registered, and the catalogue read is complete but unsigned. The
 * newer observation wins, and a row with an unreadable timestamp never
 * displaces a readable one.
 */
function mergedInventory(sources) {
  const merged = new Map();
  const consider = row => {
    const productID = Number(row?.product_id);
    if (!Number.isFinite(productID)) return;
    const key = `${productID}:${Number(row.variation_id || 0)}`;
    const current = merged.get(key);
    if (!current) { merged.set(key, row); return; }
    const incoming = Date.parse(row.updated_at);
    const existing = Date.parse(current.updated_at);
    if (!Number.isFinite(incoming)) return;
    if (!Number.isFinite(existing) || incoming >= existing) merged.set(key, row);
  };
  for (const row of sources.catalogueInventory || []) consider(row);
  for (const row of sources.inventory || []) consider(row);
  return merged;
}

function latestByPhone(rows, timeField) {
  const out = new Map();
  for (const row of rows || []) {
    const phone = normalisePhone(row?.contact_phone || row?.phone);
    const time = Date.parse(row?.[timeField]);
    if (!phone || !Number.isFinite(time)) continue;
    const previous = out.get(phone);
    if (!previous || Date.parse(previous[timeField]) < time) out.set(phone, row);
  }
  return out;
}

function authoritativeSupportState(row, now, maxAgeHours = SUPPORT_FRESHNESS_HOURS) {
  const nowTime = now.getTime();
  const observed = Date.parse(row?.observed_at);
  const expires = row?.expires_at == null ? null : Date.parse(row.expires_at);
  if (!row || !Number.isFinite(observed) || observed > nowTime ||
      observed < nowTime - maxAgeHours * 3600000 ||
      (expires !== null && (!Number.isFinite(expires) || expires <= nowTime))) return 'unknown';
  return row.status === 'clear' ? 'clear' : row.status || 'unknown';
}

function currentInventory(row, now, maxAgeHours = INVENTORY_FRESHNESS_HOURS) {
  const observed = Date.parse(row?.updated_at);
  if (!Number.isFinite(observed) || observed > now.getTime() ||
      observed < now.getTime() - maxAgeHours * 3600000) return false;
  if (String(row?.stock_status || '').toLowerCase() !== 'instock') return false;
  return row.stock_quantity === null || row.stock_quantity === undefined || Number(row.stock_quantity) > 0;
}

function activeSuppressionPhones(rows, now) {
  const phones = new Set();
  for (const row of rows || []) {
    const phone = normalisePhone(row?.contact_phone);
    const effective = Date.parse(row?.effective_at);
    const expires = row?.expires_at == null ? null : Date.parse(row.expires_at);
    if (phone && row.active === true && Number.isFinite(effective) && effective <= now.getTime() &&
        (expires === null || (Number.isFinite(expires) && expires > now.getTime()))) phones.add(phone);
  }
  return phones;
}

/**
 * TWO DIFFERENT QUESTIONS, AND WHY THEY NEEDED SEPARATING
 *
 *   WHO MATCHES THIS PATTERN?    behaviour. Purchase history, cadence,
 *                                product identity, recency.
 *   MAY WE CONTACT THIS PERSON?  permission. Consent, STOP, DND freshness,
 *                                quiet hours, frequency, support state.
 *
 * Until this option existed the second question gated the first: a phone with
 * no current row in `sms_customer_commercial_eligibility` answered "unknown",
 * failed closed, and never became a candidate at all. That is the correct
 * answer to the SECOND question and the wrong answer to the first. With that
 * table empty in production it made every segment read zero, and an empty
 * screen is indistinguishable from a broken engine.
 *
 *   'gate'     the historical behaviour, unchanged to the byte. An uncleared
 *              phone produces no candidate. This is what draft generation and
 *              every delivery path use, and nothing here relaxes it.
 *   'observe'  the candidate is built regardless and carries
 *              `commercialClearance: { clear, reason }` as INFORMATION. The
 *              whole input is stamped `segmentationOnly: true`, and
 *              prepareOpportunityDraftRun() throws on sight of that stamp, so
 *              a widened view can never become a widened send.
 *
 * Observe mode widens what can be SEEN. It widens nothing that can be SENT.
 */
const CLEARANCE_MODES = Object.freeze(['gate', 'observe']);

function clearanceMode(value) {
  const mode = value === undefined || value === null ? 'gate' : String(value);
  if (!CLEARANCE_MODES.includes(mode)) {
    throw new CampaignGenerationError(
      `clearanceMode must be one of ${CLEARANCE_MODES.join(', ')}.`, 'CAMPAIGN_CLEARANCE_MODE_INVALID'
    );
  }
  return mode;
}

function buildGenerationInput(sources, {
  now = new Date(), workflows = [...WORKFLOWS], workspaceID = WORKSPACE_ID,
  clearance = 'gate'
} = {}) {
  const mode = clearanceMode(clearance);
  const observing = mode === 'observe';
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new CampaignGenerationError('now must be valid.');
  const enabled = new Set(selectedWorkflows(workflows));
  const contacts = new Map((sources.contacts || []).map(row => [normalisePhone(row.phone), row]).filter(([phone]) => phone));
  const support = latestByPhone(sources.support || [], 'observed_at');
  const suppressionPhones = activeSuppressionPhones(sources.suppressions, at);
  const inventory = mergedInventory(sources);
  const catalogueAvailable = sources.catalogueAvailable !== false;
  const catalogueIndex = sources.catalogueIndex || buildCatalogueIndex(sources.catalogueEntries || []);
  const ledgerByPhone = new Map();
  for (const row of sources.ledger || []) {
    const phone = normalisePhone(row.contact_phone);
    if (!phone) continue;
    if (!ledgerByPhone.has(phone)) ledgerByPhone.set(phone, []);
    ledgerByPhone.get(phone).push(row);
  }

  const groups = new Map();
  const productCustomers = new Map();
  const activePaymentRecoveryPhones = new Set();
  const resolutions = [];

  /**
   * Buyers are indexed under BOTH the exact variation and the parent, so a
   * restock event finds the right people whichever level Woo reported it at. A
   * variation-level event reaches only the buyers of that vial size; a
   * parent-level event reaches everyone who bought the product.
   */
  function recordBuyer(key, phone, createdAt) {
    if (!productCustomers.has(key)) productCustomers.set(key, new Map());
    const customers = productCustomers.get(key);
    if (!customers.has(phone)) customers.set(phone, []);
    customers.get(phone).push(createdAt);
  }

  for (const order of sources.orders || []) {
    const phone = normalisePhone(order.contact_phone);
    if (!phone) continue;
    const status = String(order.status || '').toLowerCase();
    if (PAYMENT_RECOVERY_STATUSES.has(status)) activePaymentRecoveryPhones.add(phone);
    if (!PAID_STATUSES.has(status) || !Number.isFinite(Date.parse(order.created_at))) continue;
    const seen = new Set();
    for (const rawItem of itemsFor(order)) {
      const { resolution, identity } = itemIdentity(rawItem, catalogueIndex, catalogueAvailable);
      resolutions.push(resolution);
      if (!identity) continue;
      // Two lines of one order for the same vial are one purchase event.
      if (seen.has(identity.availabilityKey)) continue;
      seen.add(identity.availabilityKey);
      const key = `${phone}\u0000${identity.cadenceKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          phone,
          productID: identity.productID,
          variationID: identity.variationID,
          cadenceKey: identity.cadenceKey,
          productName: identity.productName,
          lastVariationAt: 0,
          purchases: []
        });
      }
      const group = groups.get(key);
      const orderedAt = Date.parse(order.created_at);
      // The candidate names the vial bought MOST RECENTLY: that is the one a
      // message would be about, and the one whose stock decides availability.
      if (identity.variationID && orderedAt >= group.lastVariationAt) {
        group.variationID = identity.variationID;
        group.lastVariationAt = orderedAt;
      }
      if (identity.productName && !group.productName) group.productName = identity.productName;
      group.purchases.push({
        id: order.woo_order_id || order.id,
        status,
        createdAt: order.created_at,
        total: order.total
      });
      recordBuyer(identity.cadenceKey, phone, order.created_at);
      recordBuyer(`${identity.productID}:0`, phone, order.created_at);
      if (identity.variationID) recordBuyer(identity.availabilityKey, phone, order.created_at);
    }
  }

  const identityCoverage = summariseResolutions(resolutions);

  const productCadences = new Map();
  for (const [key, customers] of productCustomers) {
    const intervals = [];
    for (const dates of customers.values()) intervals.push(...intervalDays(qualifyingPurchaseTimes(dates)));
    productCadences.set(key, { intervals, uniqueCustomers: customers.size });
  }

  const sourceSuppressions = [];

  /**
   * The commercial-clearance verdict for one phone at one workflow stage.
   *
   * It ALWAYS records the suppression, in both modes, so the counts an
   * operator reads are the same counts a send would obey. What differs is only
   * whether the caller then drops the candidate.
   */
  function commercialClearance(phone, workflow) {
    let reason = null;
    if (!sources.supportAvailable) reason = 'support_state_source_unavailable';
    else {
      const state = authoritativeSupportState(support.get(phone), at);
      if (state !== 'clear') reason = state === 'unknown' ? 'support_state_unknown' : 'customer_experience_block';
    }
    if (!reason && suppressionPhones.has(phone)) reason = 'authoritative_suppression';
    if (reason) sourceSuppressions.push({ stage: workflow, reasons: [reason] });
    return { clear: !reason, reason };
  }

  /** True when this candidate may be BUILT. In gate mode that means cleared. */
  function mayObserve(clearance) {
    return observing || clearance.clear;
  }

  const reorderCandidates = [];
  const winbackCandidates = [];
  for (const group of groups.values()) {
    const stock = inventoryFor(inventory, group.productID, group.variationID);
    if (!currentInventory(stock, at)) {
      if (enabled.has('reorder')) sourceSuppressions.push({ stage: 'reorder', reasons: ['inventory_unknown_or_unavailable'] });
      if (enabled.has('winback')) sourceSuppressions.push({ stage: 'winback', reasons: ['inventory_unknown_or_unavailable'] });
      continue;
    }
    const contact = contacts.get(group.phone);
    const ledger = ledgerByPhone.get(group.phone) || [];
    const lastPurchaseAt = qualifyingPurchaseTimes(group.purchases).at(-1);
    // Matched on the PARENT product only, to stay in step with the cadence
    // identity. A reorder message already sent about the 10mg vial must
    // suppress a second one about the 30mg vial of the same molecule: they are
    // one series, so they are one conversation. Widening the match can only
    // suppress more contact, never cause more.
    const relevantContacts = ledger.filter(row =>
      Number(row.product_id) === group.productID && row.accepted_at);
    const reorderClearance = enabled.has('reorder')
      ? commercialClearance(group.phone, 'reorder') : null;
    if (reorderClearance && mayObserve(reorderClearance)) {
      reorderCandidates.push({
        phone: group.phone,
        contactID: contact?.id,
        customerID: contact?.woo_customer_id,
        productID: group.productID,
        variationID: group.variationID,
        productName: stock?.name || group.productName,
        productAvailable: true,
        purchases: group.purchases,
        productCadence: productCadences.get(group.cadenceKey),
        alreadyContactedForLastPurchase: relevantContacts.some(row =>
          String(row.workflow_category || '').startsWith('reorder') && Date.parse(row.accepted_at) > lastPurchaseAt),
        // Present only in observe mode. In gate mode an uncleared candidate
        // does not exist, so there is nothing to annotate.
        ...(observing ? { commercialClearance: reorderClearance } : {})
      });
    }

    const winbackClearance = enabled.has('winback')
      ? commercialClearance(group.phone, 'winback') : null;
    if (winbackClearance && mayObserve(winbackClearance)) {
      const cadenceResult = calculateReorderCadence({
        purchases: group.purchases,
        productCadence: productCadences.get(group.cadenceKey),
        now: at,
        productAvailable: true
      });
      if (cadenceResult.cadence?.reliable) {
        const winbackTimes = relevantContacts
          .filter(row => row.workflow_category === 'winback')
          .map(row => row.accepted_at).filter(Boolean).sort();
        winbackCandidates.push({
          phone: group.phone,
          contactID: contact?.id,
          customerID: contact?.woo_customer_id,
          productID: group.productID,
          variationID: group.variationID,
          productName: stock?.name || group.productName,
          productAvailable: true,
          cadence: cadenceResult.cadence,
          lastPurchaseAt: cadenceResult.lastPurchaseAt,
          lifetimePurchaseCount: cadenceResult.purchaseCount,
          lastWinbackContactAt: winbackTimes.at(-1) || null,
          unresolvedComplaint: false,
          refundOpen: false,
          recentNegativeSupport: false,
          ...(observing ? { commercialClearance: winbackClearance } : {})
        });
      }
    }
  }

  const backInStockCandidates = [];
  if (enabled.has('back_in_stock')) {
    for (const event of sources.restockEvents || []) {
      const key = `${Number(event.product_id)}:${Number(event.variation_id || 0)}`;
      const buyers = productCustomers.get(key);
      if (!buyers) continue;
      for (const phone of buyers.keys()) {
        const clearance = commercialClearance(phone, 'back_in_stock');
        if (!mayObserve(clearance)) continue;
        const contact = contacts.get(phone);
        backInStockCandidates.push({
          id: `woo-restock:${event.id}`,
          phone,
          contactID: contact?.id,
          customerID: contact?.woo_customer_id,
          productID: Number(event.product_id),
          variationID: Number(event.variation_id || 0),
          productName: event.name,
          deliveryID: event.delivery_id || event.dedupe_key,
          previous: {
            productID: Number(event.product_id), variationID: Number(event.variation_id || 0),
            stockStatus: event.previous_stock_status, stockQuantity: event.previous_quantity
          },
          observed: {
            productID: Number(event.product_id), variationID: Number(event.variation_id || 0),
            stockStatus: event.current_stock_status, stockQuantity: event.current_quantity
          },
          observedAt: event.received_at,
          webhookTrusted: event.signature_valid === true,
          previousSnapshotTrusted: true,
          repeatBuyer: (buyers.get(phone) || []).length > 1,
          ...(observing ? { commercialClearance: clearance } : {})
        });
      }
    }
  }

  return {
    workspaceID,
    now: at.toISOString(),
    clearanceMode: mode,
    // The stamp that makes the split enforceable rather than merely intended.
    // prepareOpportunityDraftRun() refuses an input carrying it. See the
    // CLEARANCE_MODES comment above and test/campaign-segmentation-seam.test.js.
    segmentationOnly: observing,
    existingDedupeKeys: (sources.opportunities || []).map(row => row.dedupe_key),
    activePaymentRecoveryPhones: [...activePaymentRecoveryPhones],
    backInStockCandidates,
    reorderCandidates,
    winbackCandidates,
    notificationUsers: sources.notificationUsers || [],
    sourceSuppressions,
    sourceCoverage: {
      orders: (sources.orders || []).length,
      contacts: (sources.contacts || []).length,
      inventory: inventory.size,
      inventoryFromWebhook: (sources.inventory || []).length,
      inventoryFromCatalogue: (sources.catalogueInventory || []).length,
      restockEvents: (sources.restockEvents || []).length,
      supportStateAvailable: sources.supportAvailable === true,
      catalogueAvailable,
      catalogueStale: sources.catalogueStale === true,
      catalogueFetchedAt: sources.catalogueFetchedAt || null,
      catalogueEntries: catalogueIndex.size,
      // An item nobody could identify is REPORTED, never absorbed. This is the
      // number that made the original failure invisible: it was 2,334 out of
      // 2,343 and nothing else on the summary said so.
      nonExactOrderItems: identityCoverage.unresolved,
      productIdentity: identityCoverage
    }
  };
}

/**
 * The ONLY supported way to build engine input for segmentation.
 *
 * It exists as a named function rather than a call-site option so that "does
 * this code path see uncleared people?" is answerable by grep. A caller cannot
 * reach observe mode by accident, and a delivery path that started calling
 * this would be visible in one line of diff.
 *
 * The result answers WHO MATCHES THIS PATTERN. It is not, and can never be
 * turned into, an answer to MAY WE CONTACT THIS PERSON.
 */
function buildSegmentationInput(sources, options = {}) {
  return buildGenerationInput(sources, { ...options, clearance: 'observe' });
}

async function readAuthoritativeGenerationSources({
  client, now = new Date(), workspaceID = WORKSPACE_ID, wooGet, env = process.env
}) {
  if (workspaceID !== WORKSPACE_ID) {
    throw new CampaignGenerationError(
      'Legacy order and contact sources are not tenant-scoped for this workspace.',
      'CAMPAIGN_WORKSPACE_SOURCE_UNAVAILABLE', 409
    );
  }
  const restockFloor = new Date(now.getTime() - RESTOCK_LOOKBACK_DAYS * 86400000).toISOString();
  // Cached, and never fatal: productCatalogue() reports a provider failure as
  // `available: false` instead of throwing, so a WooCommerce outage costs the
  // run its candidates rather than costing it the whole generation.
  const catalogue = await productCatalogue({ wooGet, env, now });
  const [orders, contacts, inventory, restockEvents, opportunities, ledger, suppressions, support, users, approvers] = await Promise.all([
    pageRows(() => client.from('sms_orders').select('id,woo_order_id,contact_phone,status,items,total,created_at')
      .order('created_at').order('id'), 'orders'),
    pageRows(() => client.from('sms_contacts').select('id,phone,name,woo_customer_id').order('id'), 'contacts'),
    pageRows(() => client.from('sms_product_inventory').select('*').eq('workspace_id', workspaceID)
      .order('updated_at').order('product_id').order('variation_id'), 'product inventory'),
    pageRows(() => client.from('sms_commerce_product_events').select('*')
      .eq('workspace_id', workspaceID).eq('signature_valid', true).eq('is_restock_candidate', true)
      .gte('received_at', restockFloor).order('received_at').order('id'), 'restock events'),
    pageRows(() => client.from('sms_campaign_opportunities').select('dedupe_key,source_id,status,created_campaign_id')
      .eq('workspace_id', workspaceID).order('created_at').order('dedupe_key'), 'campaign opportunities'),
    pageRows(() => client.from('sms_commercial_contact_ledger')
      .select('contact_phone,workflow_category,product_id,variation_id,accepted_at')
      .eq('workspace_id', workspaceID).order('created_at').order('id'), 'commercial contact ledger'),
    pageRows(() => client.from('sms_campaign_suppressions').select('*')
      .eq('workspace_id', workspaceID).eq('active', true).order('effective_at').order('id'), 'campaign suppressions'),
    optionalPageRows(() => client.from('sms_customer_commercial_eligibility').select('*')
      .eq('workspace_id', workspaceID).order('observed_at').order('contact_phone'), 'customer commercial eligibility'),
    pageRows(() => client.from('sms_users').select('id,role,is_active').eq('is_active', true).order('id'), 'active users'),
    pageRows(() => client.from('sms_effective_permissions').select('user_id,permission_key')
      .eq('permission_key', 'campaigns.approve').order('user_id'), 'campaign approvers')
  ]);
  const approverIDs = new Set(approvers.map(row => String(row.user_id)));
  return {
    orders, contacts, inventory, restockEvents, opportunities, ledger, suppressions,
    catalogueEntries: catalogue.entries,
    catalogueAvailable: catalogue.available,
    catalogueStale: catalogue.stale,
    catalogueFetchedAt: catalogue.fetchedAt,
    // Stock observed directly from the catalogue. These are current-state rows
    // for `sms_product_inventory`, not transitions: nothing here creates a
    // restock event, because a first sighting of "in stock" is not evidence
    // that anything came back. See lib/campaigns/product-catalogue.js.
    catalogueInventory: catalogue.available ? catalogueInventoryRows(catalogue, { workspaceID, now }) : [],
    support: support.rows,
    supportAvailable: support.available,
    notificationUsers: users.map(user => ({
      id: user.id,
      role: user.role,
      isActive: user.is_active === true,
      canApproveCampaigns: approverIDs.has(String(user.id))
    }))
  };
}

function createAuthoritativeWooRefetch(wooGet) {
  if (typeof wooGet !== 'function') throw new CampaignGenerationError('WooCommerce refetch is unavailable.', 'WOO_REFETCH_UNAVAILABLE', 503);
  return async ({ productID, variationID }) => {
    const path = variationID && String(variationID) !== '0'
      ? `/products/${productID}/variations/${variationID}`
      : `/products/${productID}`;
    const { data } = await wooGet(path);
    const snapshot = stockSnapshot(data);
    if (!snapshot || String(snapshot.product_id) !== String(productID) ||
        Number(snapshot.variation_id || 0) !== Number(variationID || 0)) {
      return { snapshot: null, trusted: false, recheckedAt: new Date().toISOString() };
    }
    return { snapshot, trusted: true, recheckedAt: new Date().toISOString() };
  };
}

function createAtomicOpportunityDraftAdapter({ client, workspaceID = WORKSPACE_ID, actorID }) {
  const parsedActorID = Number(actorID);
  const safeActorID = Number.isSafeInteger(parsedActorID) && parsedActorID > 0 ? parsedActorID : null;
  return {
    async persistOpportunityDraftBundle(bundle) {
      if (bundle.workspaceID !== workspaceID) throw new CampaignGenerationError('Workspace mismatch.');
      const { data, error } = await client.rpc('persist_sms_opportunity_draft_bundle', {
        p_workspace_id: workspaceID,
        p_actor_user_id: safeActorID,
        p_rule_version: bundle.ruleVersion,
        p_opportunities: bundle.opportunities,
        p_drafts: bundle.drafts
      });
      if (error) {
        if (missingRelation(error)) throw new CampaignGenerationError(
          'Campaign generation is unavailable until the additive migration is applied.',
          'CAMPAIGNS_NOT_READY', 503
        );
        throw Object.assign(new Error('Campaign drafts could not be persisted.'), {
          code: error.code || 'CAMPAIGN_DRAFT_PERSIST_FAILED'
        });
      }
      return data || { campaigns: [], insertedCampaigns: 0, reusedCampaigns: 0 };
    }
  };
}

function aggregateRun(run, generationInput, persistence = null) {
  const suppressionReasons = {};
  for (const row of [...(generationInput.sourceSuppressions || []), ...(run.suppressed || [])]) {
    for (const reason of row.reasons || []) suppressionReasons[reason] = (suppressionReasons[reason] || 0) + 1;
  }
  for (const row of run.collisionSuppressions || []) {
    suppressionReasons[row.reason] = (suppressionReasons[row.reason] || 0) + 1;
  }
  const byWorkflow = {};
  for (const draft of run.drafts || []) byWorkflow[draft.workflowCategory] = (byWorkflow[draft.workflowCategory] || 0) + 1;
  return {
    mode: persistence ? 'drafts_persisted' : 'authoritative_dry_run',
    generatedAt: run.generatedAt,
    sourceCoverage: generationInput.sourceCoverage,
    opportunitiesPrepared: run.opportunities.length,
    draftsPrepared: run.drafts.length,
    byWorkflow,
    suppressionReasons,
    persisted: persistence ? {
      insertedCampaigns: Number(persistence.insertedCampaigns || 0),
      reusedCampaigns: Number(persistence.reusedCampaigns || 0),
      campaigns: (persistence.campaigns || []).map(row => ({ id: row.id, status: row.status, workflowCategory: row.workflow_category }))
    } : null
  };
}

function createCampaignGenerationService({
  client,
  env = process.env,
  workspaceID = WORKSPACE_ID,
  sourceReader = readAuthoritativeGenerationSources,
  wooGet
} = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }
  const fetchWoo = wooGet || ((...args) => require('../../woocommerce').wooGet(...args));

  return {
    async generate({ workflows, commit = false, actor } = {}) {
      const selected = selectedWorkflows(workflows);
      const flags = opportunityFeatureFlags(env);
      if (commit) {
        if (!Number.isSafeInteger(Number(actor?.id)) || Number(actor.id) <= 0) {
          throw new CampaignGenerationError(
            'An authenticated campaign manager is required.', 'CAMPAIGN_GENERATION_ACTOR_REQUIRED', 403
          );
        }
        if (flags.opportunityDraftsEnabled !== true) {
          throw new CampaignGenerationError(
            'Opportunity draft persistence is disabled.', 'CAMPAIGN_GENERATION_DISABLED', 409
          );
        }
        for (const workflow of selected) {
          if (flags.detectors[workflow] !== true) {
            throw new CampaignGenerationError(
              `${workflow} detector draft persistence is disabled.`,
              'CAMPAIGN_DETECTOR_DISABLED', 409
            );
          }
        }
      }
      const now = new Date();
      const sources = await sourceReader({ client: db(), now, workspaceID, wooGet: fetchWoo, env });
      const input = buildGenerationInput(sources, { now, workflows: selected, workspaceID });
      const run = await prepareOpportunityDraftRun(input, {
        authoritativeProductRefetch: createAuthoritativeWooRefetch(fetchWoo)
      });
      if (!commit) return { summary: aggregateRun(run, input), notifications: [] };

      const persistence = await persistPreparedDraftRun(
        run,
        createAtomicOpportunityDraftAdapter({ client: db(), workspaceID, actorID: actor?.id }),
        { destinationStatus: 'draft', featureFlags: flags }
      );
      const persistedDrafts = (persistence.campaigns || []).map(row => ({
        id: row.id, status: row.status, workflowCategory: row.workflow_category
      }));
      const notifications = prepareCampaignReadyNotifications({
        generatedAt: run.generatedAt,
        drafts: persistedDrafts,
        users: sources.notificationUsers
      });
      return { summary: aggregateRun(run, input, persistence), notifications };
    }
  };
}

module.exports = {
  CLEARANCE_MODES,
  CampaignGenerationError,
  WORKSPACE_ID,
  aggregateRun,
  authoritativeSupportState,
  buildGenerationInput,
  buildSegmentationInput,
  createAtomicOpportunityDraftAdapter,
  createAuthoritativeWooRefetch,
  createCampaignGenerationService,
  currentInventory,
  inventoryFor,
  itemIdentity,
  mergedInventory,
  pageRows,
  readAuthoritativeGenerationSources,
  selectedWorkflows
};
