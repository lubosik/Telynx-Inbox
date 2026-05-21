const SS_URL = 'https://ssapi.shipstation.com';
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;

function ssAuth() {
  return 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
}

async function ssGet(path, params = {}) {
  const url = new URL(`${SS_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: { Authorization: ssAuth() } });
  if (!r.ok) throw new Error(`ShipStation API ${path}: ${r.status}`);
  return r.json();
}

async function getShipments(params = {}) {
  return ssGet('/shipments', params);
}

async function getOrder(orderNumber) {
  const data = await ssGet('/orders', { orderNumber });
  return data.orders?.[0] || null;
}

// Fetch a ShipStation resource URL directly (used in webhook callbacks)
async function fetchResourceUrl(url) {
  const r = await fetch(url, { headers: { Authorization: ssAuth() } });
  if (!r.ok) throw new Error(`ShipStation resource fetch: ${r.status}`);
  return r.json();
}

// Register ShipStation webhooks (run once with --register flag)
async function registerWebhooks(targetUrl) {
  const events = [
    { name: 'ORDER_NOTIFY', target: `${targetUrl}/webhook/shipstation?event=ORDER_NOTIFY` },
    { name: 'SHIP_NOTIFY', target: `${targetUrl}/webhook/shipstation?event=SHIP_NOTIFY` }
  ];

  const results = [];
  for (const ev of events) {
    const r = await fetch(`${SS_URL}/webhooks/subscribe`, {
      method: 'POST',
      headers: { Authorization: ssAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_url: ev.target, event: ev.name })
    });
    results.push({ event: ev.name, status: r.status, ok: r.ok });
  }
  return results;
}

module.exports = { ssAuth, ssGet, getShipments, getOrder, fetchResourceUrl, registerWebhooks };
