const WC_URL = process.env.WC_URL || 'https://vicipeptides.com/wp-json/wc/v3';
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;

function wooAuth() {
  const creds = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64');
  return { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' };
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

// Normalise carrier name from plugin labels to our internal codes
function normalizeCarrier(provider) {
  const p = (provider || '').toLowerCase().replace(/[_\-\s]/g, '');
  if (p.includes('usps') || p.includes('stamps')) return 'usps';
  if (p.includes('ups')) return 'ups';
  if (p.includes('fedex')) return 'fedex';
  if (p.includes('dhl')) return 'dhl';
  if (p.includes('ontrac')) return 'ontrac';
  return provider || null;
}

// Build a public tracking URL from carrier + tracking number
function buildTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null;
  const c = (carrier || '').toLowerCase().replace(/[_\-\s]/g, '');
  if (c === 'usps' || c.includes('stamps'))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (c === 'ups')
    return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes('fedex'))
    return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes('dhl'))
    return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  if (c === 'ontrac')
    return `https://www.ontrac.com/tracking.asp?tn=${trackingNumber}`;
  // Universal fallback
  return `https://www.17track.net/en/track?nums=${trackingNumber}`;
}

// Extract tracking number + carrier from WooCommerce order meta_data.
// Handles multiple popular WooCommerce shipment tracking plugins.
function extractTracking(order) {
  const meta = order.meta_data || [];
  if (!meta.length) return null;

  // WooCommerce Shipment Tracking (official) + Advanced Shipment Tracking
  for (const key of ['_wc_shipment_tracking_items', 'wc_shipment_tracking_items']) {
    const m = meta.find(m => m.key === key);
    if (m?.value) {
      const items = Array.isArray(m.value) ? m.value : [m.value];
      const first = items[0];
      if (first) {
        const num = first.tracking_number || first.TrackingNumber || null;
        if (num) {
          return {
            trackingNumber: num,
            carrier: normalizeCarrier(first.tracking_provider || first.custom_tracking_provider || ''),
            trackingUrl: first.tracking_link || null,
            shippedDate: first.date_shipped || null
          };
        }
      }
    }
  }

  // Try flat key pairs from various plugins (TrackShip, WooShipping, generic)
  const candidates = [
    ['_wc_ast_tracking_number',   '_wc_ast_tracking_provider_name'],
    ['_trackship_tracking_number','_trackship_carrier_code'],
    ['tracking_number',           'tracking_provider'],
    ['_tracking_number',          '_tracking_provider'],
    ['_wc_shipment_tracking_number', '_wc_shipment_tracking_carrier'],
    ['woo_tracking_number',       'woo_tracking_provider'],
  ];

  for (const [numKey, provKey] of candidates) {
    const num = meta.find(m => m.key === numKey)?.value;
    if (num && typeof num === 'string' && num.trim()) {
      const provider = meta.find(m => m.key === provKey)?.value || '';
      return {
        trackingNumber: num.trim(),
        carrier: normalizeCarrier(provider),
        trackingUrl: null,
        shippedDate: null
      };
    }
  }

  return null;
}

/**
 * How long to wait for the store.
 *
 * There was no timeout at all, so a read waited for whatever the network gave
 * it. When vicipeptides.com went down, Cloudflare held each request open for
 * about twenty seconds before answering 522, and anything on a screen that
 * needed the store inherited that wait.
 *
 * Twenty seconds is generous for a bulk sync and absurd for a phone, so
 * callers on a screen pass something shorter. The default stays high enough
 * not to break a paged order sync over a slow link.
 */
const WOO_TIMEOUT_MS = Number(process.env.WC_TIMEOUT_MS) || 20000;

async function wooGet(path, params = {}, { timeoutMs = WOO_TIMEOUT_MS } = {}) {
  const url = new URL(`${WC_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url.toString(), { headers: wooAuth(), signal: controller.signal });
    if (!r.ok) throw new Error(`WooCommerce API ${path}: ${r.status}`);
    return { data: await r.json(), headers: r.headers };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`WooCommerce API ${path}: timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOrders(page = 1, perPage = 100, status = 'any') {
  const { data, headers } = await wooGet('/orders', { per_page: perPage, page, status });
  return {
    orders: data,
    totalPages: parseInt(headers.get('X-WP-TotalPages') || '1'),
    total: parseInt(headers.get('X-WP-Total') || '0')
  };
}

async function fetchCustomers(page = 1, perPage = 100) {
  const { data, headers } = await wooGet('/customers', { per_page: perPage, page });
  return {
    customers: data,
    totalPages: parseInt(headers.get('X-WP-TotalPages') || '1')
  };
}

module.exports = { normalizePhone, normalizeCarrier, buildTrackingUrl, extractTracking, fetchOrders, fetchCustomers, wooGet };
