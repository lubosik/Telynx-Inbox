'use strict';
/**
 * lib/campaigns/product-identity.js — turn one `sms_orders.items` entry into a
 * WooCommerce product identity, or refuse.
 *
 * WHY THIS FILE EXISTS
 *   The detectors need to know which product a historical line item was. They
 *   used to ask the line item directly, via `product_id`/`variation_id`. On the
 *   live Vici database only 9 of 2,343 paid line items carry those fields; the
 *   other 2,334 are `{sku, name, total, quantity}` written by an older sync.
 *   Every one of them was counted as `nonExactOrderItems` and thrown away, so
 *   the reorder, win-back and back-in-stock detectors produced nothing at all
 *   and every automatic segment was empty. The population is real: 50 phone
 *   numbers have four or more paid orders.
 *
 * THE RULE THAT MATTERS MOST
 *   A wrong identity is worse than no identity. It produces a wrong cadence,
 *   and a wrong cadence eventually produces a text message to a real person at
 *   the wrong moment about a product they did not buy. So every rule below is
 *   an EQUALITY test against the live catalogue. There is no prefix matching,
 *   no substring containment, no edit distance, no "closest match", and no
 *   model. When two catalogue entries could both be meant, the answer is
 *   "unresolved" and the item is counted, not guessed.
 *
 * WHAT AN IDENTITY IS: TWO LEVELS, DELIBERATELY
 *   `productID`   the parent product. This is the CADENCE identity.
 *   `variationID` the exact dose. This is the AVAILABILITY identity.
 *
 *   Dose variants are ONE product for cadence and TWO products for stock.
 *   "Retatrutide - 10mg" and "Retatrutide - 30mg" are the same molecule in a
 *   different vial, and customers titrate between them constantly: the live
 *   data has the same people across RT10/RT20/RT30. Splitting the series by
 *   dose leaves every customer with two or three purchases of each dose, below
 *   the three-interval floor in reorder-cadence.js, so nobody ever gets a
 *   reliable cadence and the answer is zero forever. Merging them answers the
 *   question the detector is actually asking, which is "how often does this
 *   person come back for this molecule".
 *
 *   Availability cannot be merged the same way, because "your BPC-157 is back"
 *   is a factual claim about one vial size. So stock is always checked against
 *   the exact variation the customer last bought, and only falls back to the
 *   parent when no variation-level record exists.
 *
 * COMBINATION PRODUCTS ARE ONE IDENTITY AND ARE NEVER DECOMPOSED
 *   "GHK-Cu + BPC-157 + TB-500" (SKU BBG70) and
 *   "GHK-Cu + BPC-157 + TB-500 + KPV" (SKU KLOW80) are two separate catalogue
 *   products with separate stock and separate prices, and both appear in the
 *   live order history. A customer who buys the KLOW combo and later buys
 *   BPC-157 alone has bought two different things: you cannot fulfil a
 *   "BPC-157 reorder" from a KLOW purchase, the amounts are not comparable
 *   (80mg across four peptides against 10mg of one), and a cadence built by
 *   pooling them would fire at a time supported by neither series. So the
 *   component list is used ONLY to recognise a renamed bundle, by SET EQUALITY,
 *   and never to relate a bundle to its parts. Set equality is also exactly
 *   what keeps BBG70 and KLOW80 apart, which is the case the live data
 *   contains.
 *
 * THE RESOLUTION LADDER, IN ORDER
 *   1. order_item_ids   the line item already carries Woo product/variation IDs
 *   2. catalogue_sku    the line item SKU equals exactly one catalogue SKU
 *   3. catalogue_name   the base name equals exactly one catalogue product name
 *   4. curated_alias    the base name is in the reviewed alias table below
 *   5. component_set    the canonical molecule set equals exactly one product's
 *   otherwise           unresolved, with a reason
 *
 *   When both a SKU and a name resolve and they disagree about the PARENT, the
 *   item is unresolved (`sku_name_conflict`). When they agree on the parent but
 *   disagree about the dose, the parent is kept and the dose is dropped, which
 *   is the honest reading of a discontinued vial size.
 */

const DOSE_UNIT = '(?:mg|mcg|ml|g|iu)';
const DOSE_PATTERN = new RegExp(
  `^\\d+(?:\\.\\d+)?\\s*${DOSE_UNIT}(?:\\s*\\+\\s*\\d+(?:\\.\\d+)?\\s*${DOSE_UNIT})*$`
);

/**
 * Curated whole-name aliases. Each entry is a human-reviewed claim that two
 * strings name the same catalogue product, and each is justified by the
 * store's own records rather than by resemblance.
 *
 * EVIDENCE, from the live paid order history:
 *   'glp3-ret'   shares SKU RT10/RT20/RT30 with 'rt'          (SKU-confirmed)
 *   'glp2 - tirz' shares SKU TR20/TR30 with 'tz'              (SKU-confirmed)
 *   'klow (...)' name sits on SKUs KLOW and KLOW80, and KLOW80 is the
 *                catalogue SKU for 'GHK-Cu + BPC-157 + TB-500 + KPV'
 *   'glow (...)' name sits on SKU BBG70 alongside the catalogue name
 *                'GHK-Cu + BPC-157 + TB-500'                  (SKU-confirmed)
 *   'retatrutide', 'tirzepatide', 'semaglutide' are the full molecule names of
 *                the catalogue's 'RT', 'TZ' and 'SM'. These three are the only
 *                entries NOT confirmed by a shared SKU, because those line
 *                items carry no SKU at all. They are the reason this table is
 *                curated and reviewable rather than inferred.
 *
 * Nothing may be added here on the strength of a resemblance. An entry is a
 * statement about this catalogue and belongs in review.
 */
const CURATED_NAME_ALIASES = Object.freeze({
  'retatrutide': 'rt',
  'glp3-ret': 'rt',
  'tirzepatide': 'tz',
  'glp2 - tirz': 'tz',
  'semaglutide': 'sm',
  'klow (tb + bpc-157 + ghk + kpv)': 'ghk-cu + bpc-157 + tb-500 + kpv',
  'glow (tb + bpc-157 + ghk)': 'ghk-cu + bpc-157 + tb-500'
});

/**
 * Curated component-token aliases, applied per molecule inside a combination
 * name. Same standard of evidence as the table above.
 */
const CURATED_COMPONENT_ALIASES = Object.freeze({
  'tb': 'tb-500',
  'ghk': 'ghk-cu',
  'ipa': 'ipa',
  'retatrutide': 'rt',
  'tirzepatide': 'tz',
  'semaglutide': 'sm'
});

/** Lower-case, collapse whitespace, and fold the unicode dashes to a hyphen. */
function normaliseText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseSku(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '').trim();
}

/** "10 mg + 10 mg" and "10mg+10mg" are the same vial pair. */
function normaliseDose(value) {
  return normaliseText(value)
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/(\d(?:\.\d+)?)\s+(mg|mcg|ml|g|iu)\b/g, '$1$2');
}

/**
 * Split "Retatrutide - 30mg" into base and dose.
 *
 * The tail is only treated as a dose when it actually looks like one, which is
 * why "GLP2 - Tirz" keeps its whole name instead of becoming base "glp2" with
 * a dose of "tirz".
 *
 * @param {string} name
 * @returns {{ base: string, dose: string|null }}
 */
function splitProductName(name) {
  const text = normaliseText(name);
  const cut = text.lastIndexOf(' - ');
  if (cut < 0) return { base: text, dose: null };
  const tail = text.slice(cut + 3).trim();
  if (!DOSE_PATTERN.test(tail)) return { base: text, dose: null };
  return { base: text.slice(0, cut).trim(), dose: normaliseDose(tail) };
}

/**
 * The canonical molecule set for a base name, as a stable key.
 * Returns null when the name has no usable tokens.
 */
function componentKey(base) {
  const tokens = normaliseText(base)
    .split(/\s\+\s/)
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => CURATED_COMPONENT_ALIASES[token] || token);
  if (!tokens.length) return null;
  return [...new Set(tokens)].sort().join(' + ');
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Build the lookup indexes the resolver needs from a flat list of catalogue
 * entries. Only published, non-empty entries are indexed: a draft product with
 * a blank name must never become a match target.
 *
 * An index key that two DIFFERENT parent products could claim is recorded as
 * ambiguous and thereafter resolves to nothing. That is the mechanism that
 * makes "refuse rather than guess" structural instead of a matter of care.
 *
 * @param {Array<object>} entries `catalogueEntries()` output
 * @returns {object} index consumed by resolveOrderItemIdentity
 */
function buildCatalogueIndex(entries = []) {
  const published = entries.filter(entry =>
    entry && entry.publicationStatus === 'publish' && positiveInteger(entry.productID));

  const byProductID = new Map();
  const byVariationID = new Map();
  const bySku = new Map();
  const byName = new Map();
  const byComponents = new Map();
  const variationsByProduct = new Map();
  const doseByProduct = new Map();

  function claim(map, key, entry) {
    if (!key) return;
    const current = map.get(key);
    if (current === undefined) { map.set(key, entry); return; }
    if (current === null) return;
    // Two entries of the SAME parent are a refinement, not a conflict; keep the
    // more specific one. Two different parents are a genuine ambiguity.
    if (current.productID === entry.productID) {
      if (!current.variationID && entry.variationID) map.set(key, entry);
      return;
    }
    map.set(key, null);
  }

  for (const entry of published) {
    if (entry.variationID) {
      byVariationID.set(entry.variationID, entry);
      if (!variationsByProduct.has(entry.productID)) variationsByProduct.set(entry.productID, []);
      variationsByProduct.get(entry.productID).push(entry);
      if (entry.dose) {
        doseByProduct.set(`${entry.productID} ${entry.dose}`, entry);
      }
    } else {
      byProductID.set(entry.productID, entry);
    }
    if (entry.sku) claim(bySku, entry.sku, entry);
    // Names are indexed for PARENTS only. A Woo variation is named after its
    // dose option ("10mg"), not after the product, so indexing variations by
    // name would put "10mg" in the table and let two unrelated products both
    // claim it.
    if (!entry.variationID && entry.baseName) {
      claim(byName, entry.baseName, entry);
      const components = componentKey(entry.baseName);
      if (components) claim(byComponents, components, entry);
    }
  }

  return {
    byProductID, byVariationID, bySku, byName, byComponents,
    variationsByProduct, doseByProduct,
    size: published.length
  };
}

/** An empty index. The resolver degrades to `order_item_ids` only. */
function emptyCatalogueIndex() {
  return buildCatalogueIndex([]);
}

function unresolved(reasons, extra = {}) {
  return {
    resolved: false,
    method: 'unresolved',
    productID: null,
    variationID: 0,
    productName: null,
    variantName: null,
    dose: null,
    doseResolved: false,
    reasons: [...new Set(reasons)].sort(),
    ...extra
  };
}

/**
 * Resolve the parent product implied by a name, without touching the dose.
 * Returns `{ productID, method }`, `null` for no match, or `'ambiguous'`.
 */
function resolveByName(base, index) {
  if (!base) return null;
  const aliased = CURATED_NAME_ALIASES[base] || base;
  const method = aliased === base ? 'catalogue_name' : 'curated_alias';

  const named = index.byName.get(aliased);
  if (named === null) return 'ambiguous';
  if (named) return { productID: named.productID, method };

  const components = componentKey(aliased);
  const combined = components ? index.byComponents.get(components) : undefined;
  if (combined === null) return 'ambiguous';
  if (combined) return { productID: combined.productID, method: aliased === base ? 'component_set' : 'curated_alias' };

  return null;
}

/**
 * Resolve one `sms_orders.items` entry.
 *
 * @param {object} item     `{ product_id?, variation_id?, sku?, name? }`
 * @param {object} index    `buildCatalogueIndex()` output
 * @param {object} [options]
 * @param {boolean} [options.catalogueAvailable] false when the Woo catalogue
 *   could not be read at all. Everything except `order_item_ids` then becomes
 *   `catalogue_unavailable` rather than silently matching against nothing.
 * @returns {object} resolution
 */
function resolveOrderItemIdentity(item, index = emptyCatalogueIndex(), { catalogueAvailable = true } = {}) {
  const rawProductID = positiveInteger(item?.product_id);
  const rawVariationID = positiveInteger(item?.variation_id) || 0;
  const sku = normaliseSku(item?.sku);
  const { base, dose } = splitProductName(item?.name);

  // 1. The line item already carries authoritative Woo identifiers.
  if (rawProductID) {
    const known = rawVariationID
      ? index.byVariationID.get(rawVariationID)
      : index.byProductID.get(rawProductID);
    return {
      resolved: true,
      method: 'order_item_ids',
      productID: rawProductID,
      variationID: rawVariationID,
      productName: known?.parentName || (typeof item?.name === 'string' ? item.name.trim().slice(0, 500) || null : null),
      variantName: known?.name || null,
      dose: known?.dose || dose,
      doseResolved: rawVariationID > 0,
      reasons: known ? [] : ['catalogue_unknown_product']
    };
  }

  if (!catalogueAvailable) {
    return unresolved(['catalogue_unavailable']);
  }
  if (!index.size) {
    return unresolved(['catalogue_empty']);
  }

  // 2. SKU equality. A SKU shared by a parent and its own variation resolves to
  //    the variation, because that is the same product described more exactly.
  let skuEntry = null;
  let skuAmbiguous = false;
  if (sku) {
    const found = index.bySku.get(sku);
    if (found === null) skuAmbiguous = true;
    else if (found) skuEntry = found;
  }

  // 3/4/5. Name equality, curated alias, then component-set equality.
  const named = resolveByName(base, index);
  const nameAmbiguous = named === 'ambiguous';
  const nameProductID = named && named !== 'ambiguous' ? named.productID : null;

  if (skuAmbiguous && !nameProductID) return unresolved(['ambiguous_sku']);
  if (nameAmbiguous && !skuEntry) return unresolved(['ambiguous_name']);

  // A SKU and a name that name two different parents is a data conflict, and a
  // conflict is never resolved in favour of one of them.
  if (skuEntry && nameProductID && skuEntry.productID !== nameProductID) {
    return unresolved(['sku_name_conflict']);
  }

  const productID = skuEntry?.productID || nameProductID;
  if (!productID) {
    const reasons = [];
    if (sku) reasons.push('sku_not_in_catalogue');
    if (base) reasons.push('name_not_in_catalogue');
    if (!reasons.length) reasons.push('no_sku_or_name');
    return unresolved(reasons);
  }

  const parent = index.byProductID.get(productID) || null;
  const method = skuEntry ? 'catalogue_sku' : named.method;

  // Pin the dose. Priority: the variation the SKU named, then the printed dose
  // matched against this parent's published variations, then the sole variation
  // when the parent has exactly one.
  const reasons = [];
  let variation = skuEntry?.variationID ? skuEntry : null;
  if (variation && dose && variation.dose && variation.dose !== dose) {
    // The SKU and the printed dose disagree. Believe neither about the vial.
    reasons.push('sku_dose_conflict');
    variation = null;
  }
  if (!variation && dose) {
    variation = index.doseByProduct.get(`${productID} ${dose}`) || null;
    if (!variation) reasons.push('dose_not_in_catalogue');
  }
  if (!variation && !dose) {
    const all = index.variationsByProduct.get(productID) || [];
    if (all.length === 1) variation = all[0];
    else if (all.length > 1) reasons.push('dose_missing_from_order_item');
  }

  return {
    resolved: true,
    method,
    productID,
    variationID: variation?.variationID || 0,
    productName: parent?.parentName || variation?.parentName || null,
    variantName: variation?.name || null,
    dose: variation?.dose || dose || null,
    doseResolved: Boolean(variation?.variationID),
    reasons: [...new Set(reasons)].sort()
  };
}

/**
 * Aggregate resolutions for reporting. Contains counts only: no product name,
 * no SKU, no customer, nothing that identifies a person.
 *
 * @param {Array<object>} resolutions
 * @returns {object}
 */
function summariseResolutions(resolutions = []) {
  const byMethod = {};
  const unresolvedReasons = {};
  const doseNotes = {};
  let resolvedCount = 0;
  let doseResolvedCount = 0;
  for (const row of resolutions) {
    if (!row) continue;
    byMethod[row.method] = (byMethod[row.method] || 0) + 1;
    if (row.resolved) {
      resolvedCount += 1;
      if (row.doseResolved) doseResolvedCount += 1;
      for (const reason of row.reasons || []) doseNotes[reason] = (doseNotes[reason] || 0) + 1;
    } else {
      for (const reason of row.reasons || []) unresolvedReasons[reason] = (unresolvedReasons[reason] || 0) + 1;
    }
  }
  return {
    items: resolutions.length,
    resolved: resolvedCount,
    unresolved: resolutions.length - resolvedCount,
    doseResolved: doseResolvedCount,
    byMethod,
    unresolvedReasons,
    resolvedWithNotes: doseNotes
  };
}

module.exports = {
  CURATED_COMPONENT_ALIASES,
  CURATED_NAME_ALIASES,
  buildCatalogueIndex,
  componentKey,
  emptyCatalogueIndex,
  normaliseDose,
  normaliseSku,
  normaliseText,
  positiveInteger,
  resolveOrderItemIdentity,
  splitProductName,
  summariseResolutions
};
