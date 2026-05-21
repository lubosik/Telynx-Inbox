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

async function wooGet(path, params = {}) {
  const url = new URL(`${WC_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: wooAuth() });
  if (!r.ok) throw new Error(`WooCommerce API ${path}: ${r.status}`);
  return { data: await r.json(), headers: r.headers };
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

module.exports = { normalizePhone, fetchOrders, fetchCustomers, wooGet };
