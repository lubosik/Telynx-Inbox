'use strict';

const crypto = require('node:crypto');

const { invalidateProductCatalogue } = require('./product-catalogue');

const WORKSPACE_ID = 'vici';

function stockSnapshot(product = {}) {
  const isVariation = Number(product.parent_id) > 0;
  const id = Number(product.id);
  const parentID = Number(product.parent_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const sourceTime = product.date_modified_gmt || product.date_modified || null;
  return {
    product_id: isVariation ? parentID : id,
    variation_id: isVariation ? id : 0,
    sku: typeof product.sku === 'string' ? product.sku.slice(0, 200) || null : null,
    name: typeof product.name === 'string' ? product.name.slice(0, 500) || null : null,
    stock_status: typeof product.stock_status === 'string' ? product.stock_status : null,
    stock_quantity: Number.isFinite(Number(product.stock_quantity)) ? Number(product.stock_quantity) : null,
    source_updated_at: sourceTime && Number.isFinite(Date.parse(sourceTime))
      ? new Date(sourceTime).toISOString() : null
  };
}

function isRestockTransition(previous, current) {
  if (!previous) return false; // first-seen in-stock is not evidence of a transition
  const statusRestock = previous.stock_status && previous.stock_status !== 'instock' && current.stock_status === 'instock';
  const quantityRestock = Number(previous.stock_quantity) <= 0 && Number(current.stock_quantity) > 0;
  return Boolean(statusRestock || quantityRestock);
}

async function recordTrustedProductEvent({ client, rawBody, headers, deliveryID, workspaceID = WORKSPACE_ID }) {
  const product = JSON.parse(rawBody.toString('utf8'));
  const current = stockSnapshot(product);
  if (!current) throw Object.assign(new Error('WooCommerce product payload has no valid product id.'), { code: 'INVALID_PRODUCT_PAYLOAD' });

  const { data: previous, error: previousError } = await client.from('sms_product_inventory').select('*')
    .eq('workspace_id', workspaceID).eq('product_id', current.product_id)
    .eq('variation_id', current.variation_id).maybeSingle();
  if (previousError) throw previousError;

  const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
  const topic = headers['x-wc-webhook-topic'] || 'product.unknown';
  const dedupeKey = deliveryID ? `delivery:${deliveryID}` : `digest:${digest}`;
  const restock = isRestockTransition(previous, current);

  const { error: eventError } = await client.from('sms_commerce_product_events').upsert({
    workspace_id: workspaceID,
    provider: 'woocommerce',
    delivery_id: deliveryID,
    topic,
    product_id: current.product_id,
    variation_id: current.variation_id,
    sku: current.sku,
    name: current.name,
    previous_stock_status: previous?.stock_status || null,
    current_stock_status: current.stock_status,
    previous_quantity: previous?.stock_quantity ?? null,
    current_quantity: current.stock_quantity,
    is_restock_candidate: restock,
    signature_valid: true,
    source_updated_at: current.source_updated_at,
    payload_digest: digest,
    dedupe_key: dedupeKey
  }, { onConflict: 'workspace_id,provider,dedupe_key', ignoreDuplicates: true });
  if (eventError) throw eventError;

  const { error: inventoryError } = await client.from('sms_product_inventory').upsert({
    workspace_id: workspaceID,
    ...current,
    updated_at: new Date().toISOString()
  }, { onConflict: 'workspace_id,product_id,variation_id' });
  if (inventoryError) throw inventoryError;

  // A product changed, so the cached catalogue in product-catalogue.js is now
  // wrong. This is the PRIMARY invalidation; its TTL is only the backstop for a
  // webhook that never arrives. Dropping an in-process cache cannot fail and
  // cannot affect the row writes above, both of which have already committed.
  invalidateProductCatalogue();

  // This is evidence ingestion only. A separate detector must perform the
  // documented debounce plus authoritative refetch before creating an
  // opportunity; one webhook never creates a draft by itself.
  return { recorded: true, restockCandidate: restock, product: current, dedupeKey };
}

module.exports = { isRestockTransition, recordTrustedProductEvent, stockSnapshot };
