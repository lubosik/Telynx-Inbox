const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
require('dotenv').config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

async function main() {
  // Get all failed/on-hold/pending orders
  const { data: failedOrders, error: e1 } = await supabase
    .from('sms_orders')
    .select('woo_order_id, contact_phone, status, created_at, items')
    .in('status', ['failed', 'on-hold', 'pending'])
    .order('created_at', { ascending: false });

  if (e1) { console.error('sms_orders error:', e1.message); return; }

  const phones = [...new Set(failedOrders.map(o => o.contact_phone))];

  // Get ALL orders for these phones so we can find their true latest order
  const { data: allOrders, error: e2 } = await supabase
    .from('sms_orders')
    .select('woo_order_id, contact_phone, status, created_at, items')
    .in('contact_phone', phones)
    .order('created_at', { ascending: false });

  if (e2) { console.error('all orders error:', e2.message); return; }

  // Keep only the most recent order per phone
  const latestByPhone = {};
  for (const order of allOrders) {
    if (!latestByPhone[order.contact_phone]) latestByPhone[order.contact_phone] = order;
  }

  // Only care about phones whose LATEST order is still failed/on-hold/pending
  const targetOrders = Object.values(latestByPhone)
    .filter(o => ['failed', 'on-hold', 'pending'].includes(o.status));

  if (targetOrders.length === 0) {
    console.log('No customers with failed/pending latest order found.');
    return;
  }

  const targetPhones = targetOrders.map(o => o.contact_phone);

  // Check for any outbound message in the last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentOutbound, error: e3 } = await supabase
    .from('sms_messages')
    .select('contact_phone, body, created_at')
    .eq('direction', 'outbound')
    .gte('created_at', thirtyDaysAgo)
    .in('contact_phone', targetPhones);

  if (e3) { console.error('sms_messages error:', e3.message); return; }

  const lastOutboundByPhone = {};
  for (const msg of recentOutbound) {
    const ex = lastOutboundByPhone[msg.contact_phone];
    if (!ex || msg.created_at > ex.created_at) lastOutboundByPhone[msg.contact_phone] = msg;
  }

  // Contact names
  const { data: contacts } = await supabase
    .from('sms_contacts')
    .select('phone, name')
    .in('phone', targetPhones);

  const nameByPhone = {};
  for (const c of (contacts || [])) nameByPhone[c.phone] = c.name;

  const alreadyMessaged = [];
  const notYetMessaged = [];

  for (const order of targetOrders) {
    const phone = order.contact_phone;
    const name = nameByPhone[phone] || 'Unknown';
    const lastMsg = lastOutboundByPhone[phone];
    const items = Array.isArray(order.items)
      ? order.items.map(i => i.name).filter(Boolean).join(', ')
      : '';

    const entry = {
      name,
      phone,
      phoneLast4: phone.slice(-4),
      status: order.status,
      orderId: order.woo_order_id,
      orderDate: (order.created_at || '').slice(0, 10),
      items,
      lastMsgDate: lastMsg ? lastMsg.created_at.slice(0, 10) : null,
      lastMsgPreview: lastMsg ? lastMsg.body.slice(0, 100) : null
    };

    if (lastMsg) alreadyMessaged.push(entry);
    else notYetMessaged.push(entry);
  }

  console.log('\n========= ALREADY MESSAGED — skip these =========');
  if (!alreadyMessaged.length) console.log('  (none)');
  for (const c of alreadyMessaged) {
    console.log(`\n• ${c.name} | ...${c.phoneLast4} | Order #${c.orderId} (${c.status}) | ${c.orderDate}`);
    console.log(`  Items: ${c.items || '—'}`);
    console.log(`  Last msg ${c.lastMsgDate}: "${c.lastMsgPreview}"`);
  }

  console.log('\n========= NOT YET MESSAGED — reach out =========');
  if (!notYetMessaged.length) console.log('  (none — everyone covered)');
  for (const c of notYetMessaged) {
    console.log(`\n• ${c.name} | ...${c.phoneLast4} | Order #${c.orderId} (${c.status}) | ${c.orderDate}`);
    console.log(`  Items: ${c.items || '—'}`);
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`Already messaged: ${alreadyMessaged.length}`);
  console.log(`Need outreach:    ${notYetMessaged.length}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
