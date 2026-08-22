'use strict';

function normaliseID(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function inventoryIdentity(snapshot) {
  const rawVariation = snapshot?.parent_id !== undefined || snapshot?.parentID !== undefined;
  return {
    productID: normaliseID(snapshot?.productID ?? snapshot?.product_id ?? snapshot?.parentID ?? snapshot?.parent_id ?? snapshot?.id),
    variationID: normaliseID(snapshot?.variationID ?? snapshot?.variation_id ?? (rawVariation ? snapshot?.id : null))
  };
}

function sameInventoryItem(left, right) {
  const a = inventoryIdentity(left);
  const b = inventoryIdentity(right);
  return Boolean(a.productID && b.productID) &&
    a.productID === b.productID && a.variationID === b.variationID;
}

function isDefinitelyUnavailable(snapshot) {
  const status = String(snapshot?.stockStatus ?? snapshot?.stock_status ?? '').toLowerCase();
  const quantity = Number(snapshot?.stockQuantity ?? snapshot?.stock_quantity);
  const managed = snapshot?.manageStock ?? snapshot?.manage_stock;
  if (status === 'outofstock') return true;
  if (snapshot?.purchasable === false) return true;
  return managed === true && Number.isFinite(quantity) && quantity <= 0 && snapshot?.backordersAllowed !== true;
}

function isDefinitelyAvailable(snapshot) {
  const status = String(snapshot?.stockStatus ?? snapshot?.stock_status ?? '').toLowerCase();
  const quantity = Number(snapshot?.stockQuantity ?? snapshot?.stock_quantity);
  const managed = snapshot?.manageStock ?? snapshot?.manage_stock;
  const publication = String(snapshot?.publicationStatus ?? snapshot?.status ?? 'publish').toLowerCase();
  if (status !== 'instock' || snapshot?.purchasable === false || publication !== 'publish') return false;
  if (managed === true && (!Number.isFinite(quantity) || quantity <= 0)) return false;
  return true;
}

function qualifyBackInStockTransition({
  previous,
  observed,
  authoritative,
  webhookTrusted = false,
  previousSnapshotTrusted = false,
  authoritativeRefetchTrusted = false,
  deliveryID = null,
  deliveryAlreadyProcessed = false,
  existingOpenOpportunity = false,
  observedAt,
  recheckedAt,
  debounceSeconds = 300
} = {}) {
  const reasons = [];
  if (!webhookTrusted) reasons.push('webhook_untrusted');
  if (!previousSnapshotTrusted) reasons.push('previous_snapshot_untrusted');
  if (!authoritativeRefetchTrusted) reasons.push('authoritative_refetch_untrusted');
  if (!String(deliveryID || '').trim()) reasons.push('delivery_id_missing');
  if (deliveryAlreadyProcessed) reasons.push('duplicate_delivery');
  if (existingOpenOpportunity) reasons.push('opportunity_already_open');
  if (!previous || !observed || !authoritative) reasons.push('inventory_snapshot_missing');

  if (previous && observed && !sameInventoryItem(previous, observed)) reasons.push('observed_identity_mismatch');
  if (observed && authoritative && !sameInventoryItem(observed, authoritative)) reasons.push('authoritative_identity_mismatch');
  if (previous && !isDefinitelyUnavailable(previous)) reasons.push('previous_state_not_definitely_unavailable');
  if (observed && !isDefinitelyAvailable(observed)) reasons.push('observed_state_not_definitely_available');
  if (authoritative && !isDefinitelyAvailable(authoritative)) reasons.push('authoritative_state_not_available');

  const observedTime = Date.parse(observedAt);
  const recheckedTime = Date.parse(recheckedAt);
  if (!Number.isFinite(observedTime) || !Number.isFinite(recheckedTime)) reasons.push('stability_timestamp_missing');
  else if (recheckedTime < observedTime + Math.max(0, Number(debounceSeconds) || 0) * 1000) reasons.push('debounce_not_elapsed');

  const uniqueReasons = [...new Set(reasons)];
  const identity = inventoryIdentity(authoritative || observed || previous);
  return {
    qualifies: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    productID: identity.productID,
    variationID: identity.variationID,
    transitionKey: uniqueReasons.length === 0
      ? `${identity.productID}:${identity.variationID || 'parent'}:${String(deliveryID)}`
      : null
  };
}

module.exports = {
  inventoryIdentity,
  isDefinitelyAvailable,
  isDefinitelyUnavailable,
  qualifyBackInStockTransition,
  sameInventoryItem
};
