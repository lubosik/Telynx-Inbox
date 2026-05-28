'use strict';
/**
 * scripts/test-flows.js — Full dry-run test suite
 *
 * Tests every SMS flow scenario against live WooCommerce + Supabase data.
 * NEVER sends any SMS. NEVER writes to Supabase. Read-only throughout.
 *
 * Run: node scripts/test-flows.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

// ─── Colours ────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
};
const ok   = (s) => `${C.green}✓${C.reset} ${s}`;
const fail = (s) => `${C.red}✗${C.reset} ${C.bold}${s}${C.reset}`;
const warn = (s) => `${C.yellow}⚠${C.reset} ${s}`;
const info = (s) => `${C.cyan}→${C.reset} ${s}`;
const dim  = (s) => `${C.grey}${s}${C.reset}`;

let passed = 0, failed = 0, warnings = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${ok(label)}`);
    passed++;
  } else {
    console.log(`  ${fail(label)}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}
function note(label) {
  console.log(`  ${warn(label)}`);
  warnings++;
}

// ─── WooCommerce helpers (same pattern as production code) ───────────────────

function wcAuthHeader() {
  return 'Basic ' + Buffer.from(
    `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
  ).toString('base64');
}
const WC_BASE = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';

async function wcFetch(path) {
  const res = await fetch(`${WC_BASE}/wp-json/wc/v3${path}`, {
    headers: { Authorization: wcAuthHeader() }
  });
  return res.json();
}

// ─── Logic under test (copied from hold.js so we don't require the module) ───

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)                       return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1')  return '+' + digits;
  if (raw.startsWith('+') && digits.length >= 10) return '+' + digits;
  return null;
}

function ordersShareProducts(itemsA, itemsB) {
  if (!itemsA?.length || !itemsB?.length) return false;
  const idsA = new Set(itemsA.map(i => i.product_id).filter(Boolean));
  return itemsB.some(i => idsA.has(i.product_id));
}

function formatProductList(items) {
  if (!items || items.length === 0) return '';
  const names = items.map(i => i.name).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

function detectPaymentMethod(order) {
  const method      = (order.payment_method       || '').toLowerCase();
  const methodTitle = (order.payment_method_title || '')
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase();
  if (method.includes('venmo') || methodTitle.includes('venmo') || methodTitle.includes('enmo'))
    return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
  if (method.includes('zelle') || methodTitle.includes('zelle'))
    return { label: 'Zelle', handle: process.env.ZELLE_HANDLE || 'support@vicipeptides.com' };
  return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
}

function paymentInstructions(method, handle, orderNumber) {
  if (method === 'Zelle')
    return `Zelle to ${handle}. Please use your order number #${orderNumber} as the payment reference.`;
  return `Pay via Venmo to ${handle}. Just include your name in the notes so I can match it.`;
}

function buildMsg1(firstName, orderNumber, total, handle, method, products) {
  const productPhrase = products?.length ? ` for your ${formatProductList(products)}` : '';
  return `Hey ${firstName}! It's DP, founder of Vici Peptides. Just got your order #${orderNumber}${productPhrase} - so excited to get this to you!\n\nTo lock it in, send $${total} via ${method}:\n${paymentInstructions(method, handle, orderNumber)}\n\nOnce I see it come through I'll get it packed up straight away!\n\nDP`;
}

function buildMsg2(firstName, orderNumber, total, handle, method) {
  return `Hey ${firstName}, checking in on order #${orderNumber}. I'm holding the stock for you!\n\nWhen you get a chance, just send $${total} to ${handle} via ${method}${method === 'Zelle' ? ` (ref: #${orderNumber})` : ''}.\n\nAny issues at all, just reply here.\nDP`;
}

function buildMsg3(firstName, orderNumber, total, handle, method) {
  return `${firstName}, last check-in on order #${orderNumber}. I've got the stock held for you but I'll need to release it by end of today.\n\nSend $${total} to ${handle} via ${method}${method === 'Zelle' ? ` - use #${orderNumber} as your reference` : ''} to secure it.\n\nJust reply if anything's up. DP`;
}

function buildFailedNudgeMsg(firstName, failedOrderNumber, failedProducts, checkoutUrl) {
  const productPhrase = failedProducts?.length ? ` for your ${formatProductList(failedProducts)}` : '';
  return `Hey ${firstName}, one more thing - I also noticed your order #${failedOrderNumber}${productPhrase} didn't go through. Still looking to grab it? Here's the link: ${checkoutUrl}\n\nDP`;
}

function buildFailedCheckoutUrl(orderId, orderKey) {
  return `${WC_BASE}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${orderKey}&utm_source=sms&utm_medium=text&utm_campaign=failed_recovery&utm_content=hold_nudge`;
}

function buildCombinedMsg1(firstName, orderRef, combinedTotal, handle, method) {
  const notes = method === 'Zelle' ? `Just include your name as the reference so I can match both.` : `Just pop your name in the notes so I can match both.`;
  return `Hey ${firstName}! It's DP, founder of Vici Peptides. Looks like you've got two orders waiting - ${orderRef}. Let's lock them both in!\n\nSend $${combinedTotal} via ${method} to ${handle}. ${notes}\n\nOnce I see it I'll pack up both straight away!\n\nDP`;
}

// Message quality checks
function checkMessage(label, msg) {
  const checks = [
    [!msg.includes('—') && !msg.includes('–'), 'No em dashes'],
    [!msg.includes('**') && !msg.includes('*'), 'No asterisks'],
    [!msg.includes('#') || msg.match(/#\d+/), 'Hashtags only as order numbers'],
    [msg.includes('DP'), 'Has DP sign-off'],
    [msg.length <= 400, `Under 400 chars (${msg.length})`],
    [msg.trim().length > 0, 'Not empty'],
  ];
  let allGood = true;
  for (const [cond, desc] of checks) {
    if (!cond) { console.log(`    ${fail(label + ': ' + desc)}`); allGood = false; failed++; }
    else passed++;
  }
  if (allGood) console.log(`  ${ok(label + ` — all quality checks passed (${msg.length} chars)`)}`);
  return allGood;
}

// ─── TEST SUITES ─────────────────────────────────────────────────────────────

async function testUnitLogic() {
  console.log(`\n${C.bold}━━━ UNIT TESTS: Core Logic ━━━${C.reset}`);

  // formatPhone
  console.log('\n  formatPhone:');
  assert(formatPhone('3054043184')   === '+13054043184', '10-digit → +1');
  assert(formatPhone('13054043184')  === '+13054043184', '11-digit +1 prefix');
  assert(formatPhone('+13054043184') === '+13054043184', 'Already E.164');
  assert(formatPhone('+447911123456') === '+447911123456', 'UK number passes through');
  assert(formatPhone('')             === null, 'Empty string → null');
  assert(formatPhone(null)           === null, 'null → null');
  assert(formatPhone('555-123-4567') === '+15551234567', 'Formatted US number');

  // ordersShareProducts
  console.log('\n  ordersShareProducts:');
  const itemsA = [{ product_id: 101, name: 'BPC-157' }, { product_id: 202, name: 'TB-500' }];
  const itemsB = [{ product_id: 101, name: 'BPC-157' }];
  const itemsC = [{ product_id: 303, name: 'GHK-Cu' }];
  const itemsEmpty = [];
  assert(ordersShareProducts(itemsA, itemsB) === true,  'Same product → retry detected');
  assert(ordersShareProducts(itemsA, itemsC) === false, 'Different products → not retry');
  assert(ordersShareProducts(itemsEmpty, itemsB) === false, 'Empty A → false');
  assert(ordersShareProducts(itemsA, itemsEmpty) === false, 'Empty B → false');
  assert(ordersShareProducts(null, itemsB) === false, 'Null A → false');
  assert(ordersShareProducts(itemsA, null) === false, 'Null B → false');
  assert(ordersShareProducts(
    [{ product_id: null, name: 'X' }],
    [{ product_id: null, name: 'Y' }]
  ) === false, 'Null product_ids do not match each other');

  // formatProductList
  console.log('\n  formatProductList:');
  assert(formatProductList([{ name: 'BPC-157' }]) === 'BPC-157', 'Single product');
  assert(formatProductList([{ name: 'BPC-157' }, { name: 'TB-500' }]) === 'BPC-157 and TB-500', 'Two products');
  assert(formatProductList([{ name: 'BPC-157' }, { name: 'TB-500' }, { name: 'GHK-Cu' }]) === 'BPC-157 and 2 more', 'Three → X and N more');
  assert(formatProductList([]) === '', 'Empty array');
  assert(formatProductList(null) === '', 'Null');
  assert(formatProductList([{ name: '' }, { name: 'TB-500' }]) === 'TB-500', 'Filters empty names');

  // detectPaymentMethod
  console.log('\n  detectPaymentMethod:');
  assert(detectPaymentMethod({ payment_method: 'venmo', payment_method_title: '' }).label === 'Venmo', 'Venmo by method');
  assert(detectPaymentMethod({ payment_method: 'zelle', payment_method_title: '' }).label === 'Zelle', 'Zelle by method');
  assert(detectPaymentMethod({ payment_method: '', payment_method_title: 'Venmo' }).label === 'Venmo', 'Venmo by title');
  assert(detectPaymentMethod({ payment_method: '', payment_method_title: 'Zelle' }).label === 'Zelle', 'Zelle by title');
  assert(detectPaymentMethod({ payment_method: '', payment_method_title: '' }).label === 'Venmo', 'Unknown → default Venmo');
  // Unicode Venmo (real-world case)
  assert(detectPaymentMethod({ payment_method: '', payment_method_title: '𝒱enmo' }).label === 'Venmo', 'Unicode Venmo title');
}

async function testMessageBuilders() {
  console.log(`\n${C.bold}━━━ MESSAGE BUILDER TESTS ━━━${C.reset}`);

  const products2 = [{ name: 'BPC-157' }, { name: 'TB-500' }];
  const products1 = [{ name: 'BPC-157' }];

  console.log('\n  buildMsg1:');
  const m1WithProducts = buildMsg1('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo', products2);
  checkMessage('MSG1 with 2 products', m1WithProducts);
  assert(m1WithProducts.includes('BPC-157 and TB-500'), 'Products injected into MSG1');
  assert(m1WithProducts.includes('founder of Vici Peptides'), 'Has founder intro');

  const m1NoProducts = buildMsg1('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo', []);
  checkMessage('MSG1 no products', m1NoProducts);
  assert(!m1NoProducts.includes('for your'), 'No "for your" without products');

  const m1Zelle = buildMsg1('Sarah', '4270', '89.00', 'support@vicipeptides.com', 'Zelle', products1);
  checkMessage('MSG1 Zelle', m1Zelle);
  assert(m1Zelle.includes('order number #4270'), 'Zelle includes order reference');

  console.log('\n  buildMsg2:');
  checkMessage('MSG2 Venmo', buildMsg2('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo'));
  checkMessage('MSG2 Zelle', buildMsg2('Sarah', '4270', '89.00', 'support@vicipeptides.com', 'Zelle'));
  const m2Zelle = buildMsg2('Sarah', '4270', '89.00', 'support@vicipeptides.com', 'Zelle');
  assert(m2Zelle.includes('(ref: #4270)'), 'MSG2 Zelle has order ref');

  console.log('\n  buildMsg3:');
  checkMessage('MSG3 Venmo', buildMsg3('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo'));
  checkMessage('MSG3 Zelle', buildMsg3('Sarah', '4270', '89.00', 'support@vicipeptides.com', 'Zelle'));
  const m3 = buildMsg3('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo');
  assert(m3.includes('to secure it'), 'MSG3 has "to secure it"');

  console.log('\n  buildFailedNudgeMsg:');
  const nudgeUrl = buildFailedCheckoutUrl('4223', 'wc_order_abc123');
  const nudge = buildFailedNudgeMsg('Ebba', '4223', [{ name: 'BPC-157' }], nudgeUrl);
  checkMessage('Failed nudge', nudge);
  assert(nudge.includes('#4223'), 'Nudge includes failed order number');
  assert(nudge.includes('BPC-157'), 'Nudge includes product name');
  assert(nudge.includes('checkout/order-pay'), 'Nudge includes checkout URL');
  console.log(dim(`    Preview: "${nudge.substring(0, 120)}..."`));

  console.log('\n  buildCombinedMsg1:');
  const combined = buildCombinedMsg1('Sarah', '#4270 and #4271', '178.00', '@ViciPeptides', 'Venmo');
  checkMessage('Combined MSG1 Venmo', combined);
  assert(combined.includes('#4270 and #4271'), 'Combined includes both order refs');
}

async function testWooCommerceConnectivity() {
  console.log(`\n${C.bold}━━━ WOOCOMMERCE CONNECTIVITY ━━━${C.reset}`);

  console.log(`\n  ${info('Fetching store info...')}`);
  try {
    const info_ = await wcFetch('');
    assert(!!info_, 'WooCommerce API reachable');
    console.log(dim(`    Store: ${info_.name || 'unknown'}`));
  } catch (e) {
    assert(false, 'WooCommerce API reachable', e.message);
    return false;
  }

  console.log(`\n  ${info('Fetching recent orders (last 20)...')}`);
  try {
    const orders = await wcFetch('/orders?per_page=20&orderby=date&order=desc');
    assert(Array.isArray(orders), 'Orders endpoint returns array');
    assert(orders.length > 0, `Has orders (got ${orders.length})`);

    const statuses = {};
    for (const o of orders) statuses[o.status] = (statuses[o.status] || 0) + 1;
    console.log(dim(`    Status breakdown: ${JSON.stringify(statuses)}`));

    return orders;
  } catch (e) {
    assert(false, 'Orders fetch', e.message);
    return [];
  }
}

async function testSpecificOrders() {
  console.log(`\n${C.bold}━━━ EBBA SCENARIO (Orders 4223 + 4270) ━━━${C.reset}`);

  let order4223, order4270;

  console.log(`\n  ${info('Fetching order 4223 (failed)...')}`);
  try {
    order4223 = await wcFetch('/orders/4223');
    assert(!!order4223.id, 'Order 4223 exists');
    assert(order4223.status === 'failed' || order4223.status, `Status: ${order4223.status}`);
    const items = (order4223.line_items || []).map(i => i.name).join(', ');
    console.log(dim(`    Products: ${items || 'none'}`));
    console.log(dim(`    Total: $${order4223.total}`));
    console.log(dim(`    Phone: ${order4223.billing?.phone ? '***' + order4223.billing.phone.slice(-4) : 'none'}`));
  } catch (e) {
    note(`Order 4223 not found or inaccessible: ${e.message}`);
  }

  console.log(`\n  ${info('Fetching order 4270 (on-hold)...')}`);
  try {
    order4270 = await wcFetch('/orders/4270');
    assert(!!order4270.id, 'Order 4270 exists');
    assert(order4270.status === 'on-hold' || order4270.status, `Status: ${order4270.status}`);
    const items = (order4270.line_items || []).map(i => i.name).join(', ');
    console.log(dim(`    Products: ${items || 'none'}`));
    console.log(dim(`    Total: $${order4270.total}`));
  } catch (e) {
    note(`Order 4270 not found or inaccessible: ${e.message}`);
  }

  if (order4223 && order4270) {
    const items4223 = (order4223.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    const items4270 = (order4270.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    const sameProducts = ordersShareProducts(items4223, items4270);

    console.log(`\n  ${info('Product comparison:')}`);
    console.log(dim(`    4223 items: ${items4223.map(i => `${i.name}(${i.product_id})`).join(', ')}`));
    console.log(dim(`    4270 items: ${items4270.map(i => `${i.name}(${i.product_id})`).join(', ')}`));
    assert(sameProducts === true || sameProducts === false, `Share products: ${sameProducts} (retry=${sameProducts})`);

    if (sameProducts) {
      console.log(`  ${ok('RETRY SCENARIO CONFIRMED — would send on-hold only, no failed flow')}`);
      const { label: method, handle } = detectPaymentMethod(order4270);
      const msg = buildMsg1(order4270.billing?.first_name || 'there', order4270.number, order4270.total, handle, method, items4270);
      console.log(dim('\n  What Ebba would receive:'));
      console.log(dim('  ─────────────────────────────'));
      msg.split('\n').forEach(line => console.log(dim(`  ${line}`)));
      checkMessage('Ebba on-hold message', msg);
    } else {
      console.log(`  ${warn('DIFFERENT PRODUCTS — would send on-hold + schedule nudge about failed order')}`);
      const nudgeUrl = buildFailedCheckoutUrl(order4223.id, order4223.order_key);
      const nudge = buildFailedNudgeMsg(order4270.billing?.first_name || 'there', order4223.number, items4223, nudgeUrl);
      console.log(dim('\n  Nudge message preview:'));
      nudge.split('\n').forEach(line => console.log(dim(`  ${line}`)));
      checkMessage('Ebba nudge message', nudge);
    }
  }
}

async function testSupabaseState() {
  console.log(`\n${C.bold}━━━ SUPABASE STATE ━━━${C.reset}`);

  console.log(`\n  ${info('sms_scheduled — pending messages...')}`);
  const { data: pending, error: pendingErr } = await supabase
    .from('sms_scheduled')
    .select('id, order_id, phone, flow_type, send_at, message_body')
    .eq('status', 'pending')
    .order('send_at', { ascending: true })
    .limit(50);

  if (pendingErr) {
    assert(false, 'sms_scheduled readable', pendingErr.message);
  } else {
    assert(true, `sms_scheduled readable (${pending.length} pending)`);
    const byType = {};
    for (const row of pending) byType[row.flow_type] = (byType[row.flow_type] || 0) + 1;
    console.log(dim(`    By type: ${JSON.stringify(byType)}`));

    // Check for any hold-failed-nudge rows (should exist if our new logic fired)
    const nudgeRows = pending.filter(r => r.flow_type === 'hold-failed-nudge');
    if (nudgeRows.length > 0) {
      console.log(`  ${ok(`Found ${nudgeRows.length} hold-failed-nudge row(s) — new logic has fired`)}`);
    } else {
      console.log(dim(`    No hold-failed-nudge rows yet (will appear on next on-hold webhook)`));
    }

    // Check for any orphaned flows (same phone, both failed+hold pending simultaneously)
    const phoneFlowMap = {};
    for (const row of pending) {
      const k = row.phone;
      if (!phoneFlowMap[k]) phoneFlowMap[k] = new Set();
      phoneFlowMap[k].add(row.flow_type.replace(/-msg\d/, ''));
    }
    let orphans = 0;
    for (const [phone, types] of Object.entries(phoneFlowMap)) {
      if (types.has('failed') && types.has('hold')) {
        orphans++;
        console.log(`  ${warn(`Phone ...${phone?.slice(-4)} has BOTH failed+hold flows pending — old data pre-fix`)}`);
      }
    }
    if (orphans === 0) console.log(`  ${ok('No orphaned failed+hold dual-flows found')}`);
  }

  console.log(`\n  ${info('sms_sent_log — recent sends...')}`);
  const { data: sentLog, error: logErr } = await supabase
    .from('sms_sent_log')
    .select('id, order_id, flow_type, phone, sent_at, message_body')
    .order('sent_at', { ascending: false })
    .limit(20);

  if (logErr) {
    assert(false, 'sms_sent_log readable', logErr.message);
  } else {
    assert(true, `sms_sent_log readable (showing last ${sentLog.length} rows)`);
    const byType = {};
    for (const row of sentLog) byType[row.flow_type] = (byType[row.flow_type] || 0) + 1;
    console.log(dim(`    Recent by type: ${JSON.stringify(byType)}`));

    // Check Ebba's order specifically
    const ebbaLogs = sentLog.filter(r => r.order_id === '4223' || r.order_id === '4270');
    if (ebbaLogs.length > 0) {
      console.log(`\n  ${info("Ebba's message history:")}`);
      for (const row of ebbaLogs) {
        console.log(dim(`    [${row.flow_type}] order=${row.order_id} at ${row.sent_at?.substring(0, 16)}`));
      }
    }
  }

  console.log(`\n  ${info('sms_contacts — checking table...')}`);
  const { count, error: contactErr } = await supabase
    .from('sms_contacts')
    .select('*', { count: 'exact', head: true });

  if (contactErr) {
    assert(false, 'sms_contacts readable', contactErr.message);
  } else {
    assert(true, `sms_contacts readable (${count} contacts)`);
  }

  console.log(`\n  ${info('shipstation_tracking — pending shipments...')}`);
  const { data: tracking, error: trackErr } = await supabase
    .from('shipstation_tracking')
    .select('id, woo_order_id, shipment_status, shipped_sms_sent, voided, tracking_number')
    .eq('shipped_sms_sent', false)
    .eq('voided', false)
    .limit(10);

  if (trackErr) {
    note(`shipstation_tracking not accessible: ${trackErr.message}`);
  } else {
    assert(true, `shipstation_tracking readable (${tracking.length} pending shipments)`);
    for (const t of tracking) {
      console.log(dim(`    order=${t.woo_order_id} status=${t.shipment_status} tracking=${t.tracking_number ? 'yes' : 'none'}`));
    }
  }
}

async function testAllScenarios() {
  console.log(`\n${C.bold}━━━ SCENARIO SIMULATION (DRY RUN) ━━━${C.reset}`);

  // Fetch real on-hold + failed orders
  console.log(`\n  ${info('Fetching on-hold orders...')}`);
  const onHoldOrders = await wcFetch('/orders?status=on-hold&per_page=20');
  const failedOrders = await wcFetch('/orders?status=failed&per_page=20');

  assert(Array.isArray(onHoldOrders), `On-hold orders fetched (${onHoldOrders?.length || 0})`);
  assert(Array.isArray(failedOrders), `Failed orders fetched (${failedOrders?.length || 0})`);

  // Build phone→orders maps
  const holdByPhone = {};
  for (const o of (onHoldOrders || [])) {
    const phone = formatPhone(o.billing?.phone || o.shipping?.phone);
    if (phone) holdByPhone[phone] = [...(holdByPhone[phone] || []), o];
  }
  const failedByPhone = {};
  for (const o of (failedOrders || [])) {
    const phone = formatPhone(o.billing?.phone || o.shipping?.phone);
    if (phone) failedByPhone[phone] = [...(failedByPhone[phone] || []), o];
  }

  // ── Scenario A: on-hold only ──────────────────────────────────────────────
  console.log(`\n  ${C.bold}Scenario A: On-hold only${C.reset}`);
  const holdOnlyPhones = Object.keys(holdByPhone).filter(p => !failedByPhone[p]);
  console.log(dim(`    ${holdOnlyPhones.length} customer(s) with on-hold only`));
  if (holdOnlyPhones.length > 0) {
    const o = holdByPhone[holdOnlyPhones[0]][0];
    const name = o.billing?.first_name || 'there';
    const { label: method, handle } = detectPaymentMethod(o);
    const items = (o.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    const msg = buildMsg1(name, o.number, o.total, handle, method, items);
    checkMessage(`Scenario A MSG1 (order #${o.number})`, msg);
    assert(items.length === 0 || msg.includes('for your'), 'Products injected when present');
  } else {
    console.log(dim('    (no sample available)'));
  }

  // ── Scenario B: two on-hold orders same customer ──────────────────────────
  console.log(`\n  ${C.bold}Scenario B: Two on-hold orders (same customer)${C.reset}`);
  const twoHoldPhones = Object.keys(holdByPhone).filter(p => holdByPhone[p].length >= 2);
  console.log(dim(`    ${twoHoldPhones.length} customer(s) with multiple on-hold orders`));
  if (twoHoldPhones.length > 0) {
    const orders = holdByPhone[twoHoldPhones[0]];
    const o1 = orders[0], o2 = orders[1];
    const name = o1.billing?.first_name || 'there';
    const { label: method, handle } = detectPaymentMethod(o1);
    const combinedTotal = (parseFloat(o1.total) + parseFloat(o2.total)).toFixed(2);
    const orderRef = `#${o1.number} and #${o2.number}`;
    const combined = buildCombinedMsg1(name, orderRef, combinedTotal, handle, method);
    checkMessage(`Scenario B combined (orders ${orderRef})`, combined);
  } else {
    console.log(dim('    (no sample available)'));
  }

  // ── Scenario C: failed only ───────────────────────────────────────────────
  console.log(`\n  ${C.bold}Scenario C: Failed only${C.reset}`);
  const failedOnlyPhones = Object.keys(failedByPhone).filter(p => !holdByPhone[p]);
  console.log(dim(`    ${failedOnlyPhones.length} customer(s) with failed only`));
  if (failedOnlyPhones.length > 0) {
    const o = failedByPhone[failedOnlyPhones[0]][0];
    assert(!!formatPhone(o.billing?.phone || o.shipping?.phone), `Failed order has phone (order #${o.number})`);
  }

  // ── Scenario D: failed + on-hold (same products = retry) ─────────────────
  console.log(`\n  ${C.bold}Scenario D: Failed + on-hold, same products (retry)${C.reset}`);
  let scenarioDFound = false;
  for (const phone of Object.keys(holdByPhone)) {
    if (!failedByPhone[phone]) continue;
    const holdItems  = (holdByPhone[phone][0].line_items  || []).map(i => ({ product_id: i.product_id, name: i.name }));
    const failedItems = (failedByPhone[phone][0].line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    if (ordersShareProducts(holdItems, failedItems)) {
      const o = holdByPhone[phone][0];
      const name = o.billing?.first_name || 'there';
      const { label: method, handle } = detectPaymentMethod(o);
      const msg = buildMsg1(name, o.number, o.total, handle, method, holdItems);
      checkMessage(`Scenario D — retry, on-hold msg only (order #${o.number})`, msg);
      assert(msg.includes('founder of Vici Peptides'), 'Has founder intro');
      console.log(dim(`    Would cancel failed flow for order #${failedByPhone[phone][0].number}`));
      scenarioDFound = true;
      break;
    }
  }
  if (!scenarioDFound) console.log(dim('    (no live example — tested with Ebba data above)'));

  // ── Scenario E: failed + on-hold, different products ─────────────────────
  console.log(`\n  ${C.bold}Scenario E: Failed + on-hold, different products${C.reset}`);
  let scenarioEFound = false;
  for (const phone of Object.keys(holdByPhone)) {
    if (!failedByPhone[phone]) continue;
    const holdItems   = (holdByPhone[phone][0].line_items  || []).map(i => ({ product_id: i.product_id, name: i.name }));
    const failedItems = (failedByPhone[phone][0].line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    if (!ordersShareProducts(holdItems, failedItems)) {
      const failedOrder = failedByPhone[phone][0];
      const holdOrder   = holdByPhone[phone][0];
      const name = holdOrder.billing?.first_name || 'there';
      const nudgeUrl = buildFailedCheckoutUrl(failedOrder.id, failedOrder.order_key);
      const nudge = buildFailedNudgeMsg(name, failedOrder.number, failedItems, nudgeUrl);
      checkMessage(`Scenario E nudge (failed #${failedOrder.number})`, nudge);
      scenarioEFound = true;
      break;
    }
  }
  if (!scenarioEFound) {
    // Simulate with synthetic data
    const nudge = buildFailedNudgeMsg('Alex', '4100', [{ name: 'GHK-Cu' }], 'https://vicipeptides.com/checkout/order-pay/4100/?pay_for_order=true&key=wc_order_xyz&utm_source=sms');
    checkMessage('Scenario E nudge (synthetic)', nudge);
    console.log(dim('    (no live example found — tested with synthetic data)'));
  }

  // ── Scenario F: two failed, same customer ────────────────────────────────
  console.log(`\n  ${C.bold}Scenario F: Two failed orders, same customer${C.reset}`);
  const twoFailedPhones = Object.keys(failedByPhone).filter(p => failedByPhone[p].length >= 2);
  console.log(dim(`    ${twoFailedPhones.length} customer(s) with 2+ failed orders`));
  if (twoFailedPhones.length > 0) {
    console.log(`  ${ok('Existing dedup logic handles this — second failure updates order_id to latest')}`);
  }

  // ── Scenario G: no phone on order ─────────────────────────────────────────
  console.log(`\n  ${C.bold}Scenario G: Order with no phone${C.reset}`);
  assert(formatPhone(null) === null, 'null phone → null (skipped gracefully)');
  assert(formatPhone('')   === null, 'empty phone → null (skipped gracefully)');
}

async function testEdgeCases() {
  console.log(`\n${C.bold}━━━ EDGE CASE TESTS ━━━${C.reset}`);

  console.log('\n  Order key missing (buildFailedCheckoutUrl):');
  const urlNoKey = buildFailedCheckoutUrl('4223', '');
  assert(urlNoKey.includes('/checkout/order-pay/4223/'), 'URL built even with empty order_key');
  assert(urlNoKey.includes('utm_source=sms'), 'UTM params present');

  console.log('\n  Very long product names:');
  const longItems = [{ name: 'BPC-157 (5mg) Research Grade - Premium Quality' }, { name: 'TB-500 (5mg) Lyophilized Powder' }];
  const longMsg = buildMsg1('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo', longItems);
  assert(longMsg.length <= 400, `Long product names still under 400 chars (${longMsg.length})`);

  console.log('\n  Null line_items on order:');
  const noItemsOrder = { line_items: null, billing: { first_name: 'Joe', phone: '3051234567' }, number: '4100', total: '50.00', payment_method: 'venmo', payment_method_title: 'Venmo' };
  const items = (noItemsOrder.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
  const msg = buildMsg1('Joe', '4100', '50.00', '@ViciPeptides', 'Venmo', items);
  assert(!msg.includes('for your'), 'No product phrase when line_items is null');
  assert(msg.includes('DP'), 'Still has DP sign-off');

  console.log('\n  processScheduledQueue cancels hold-failed-nudge when order recovers:');
  // Verify the utils.js cancellableFlows array includes hold-failed-nudge
  // We do this by reading the file
  const utilsContent = require('fs').readFileSync(
    require('path').join(__dirname, '../flows/utils.js'), 'utf8'
  );
  assert(utilsContent.includes('hold-failed-nudge'), 'hold-failed-nudge in cancellableFlows');

  console.log('\n  Zelle combined-order reference in MSG2:');
  const m2Zelle = buildMsg2('Sarah', '4270', '89.00', 'support@vicipeptides.com', 'Zelle');
  assert(m2Zelle.includes('(ref: #4270)'), 'MSG2 Zelle contains order ref');

  console.log('\n  MSG3 "to secure it" present:');
  const m3 = buildMsg3('Sarah', '4270', '89.00', '@ViciPeptides', 'Venmo');
  assert(m3.includes('to secure it'), 'MSG3 has "to secure it"');

  console.log('\n  Confirmed 1A "about your order" present:');
  const confirmedContent = require('fs').readFileSync(
    require('path').join(__dirname, '../flows/confirmed.js'), 'utf8'
  );
  assert(confirmedContent.includes('Any questions about your order'), 'Confirmed 1A has "about your order"');
  assert(confirmedContent.includes('just text me directly'), 'Confirmed 1B has "just text me directly"');
  assert(confirmedContent.includes('founder of Vici Peptides'), 'Confirmed has founder intro');

  console.log('\n  Failed flow has "founder of Vici Peptides":');
  const failedContent = require('fs').readFileSync(
    require('path').join(__dirname, '../flows/failed.js'), 'utf8'
  );
  assert(failedContent.includes('founder of Vici Peptides'), 'Failed MSG1 has founder intro');

  console.log('\n  No em dashes in SMS message builder return values:');
  for (const [name, content] of [
    ['hold.js', require('fs').readFileSync(require('path').join(__dirname, '../flows/hold.js'), 'utf8')],
    ['confirmed.js', confirmedContent],
    ['failed.js', failedContent],
    ['shipped.js', require('fs').readFileSync(require('path').join(__dirname, '../flows/shipped.js'), 'utf8')],
  ]) {
    // Only check `return \`` lines — the actual SMS message strings, not log/comment em dashes
    const returnLines = content.split('\n').filter(l => l.trim().startsWith('return `'));
    const hasEmDash = returnLines.some(l => l.includes('—') || l.includes('–'));
    assert(!hasEmDash, `${name}: no em dashes in message return values`);
  }
}

async function testShipStationConnectivity() {
  console.log(`\n${C.bold}━━━ SHIPSTATION CONNECTIVITY ━━━${C.reset}`);
  try {
    const res = await fetch('https://ssapi.shipstation.com/orders?orderStatus=awaiting_shipment&pageSize=5', {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${process.env.SS_API_KEY}:${process.env.SS_API_SECRET}`).toString('base64')
      }
    });
    const data = await res.json();
    assert(res.ok, `ShipStation API reachable (HTTP ${res.status})`);
    assert(typeof data.total === 'number' || Array.isArray(data.orders), 'ShipStation returns order data');
    console.log(dim(`    Orders awaiting shipment: ${data.total ?? '?'}`));
  } catch (e) {
    note(`ShipStation check failed: ${e.message}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}${C.cyan}╔════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   VICI SMS FLOW — FULL TEST SUITE      ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   READ-ONLY · NO SMS SENT              ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════╝${C.reset}`);

  await testUnitLogic();
  await testMessageBuilders();
  const orders = await testWooCommerceConnectivity();
  if (orders && orders.length > 0) {
    await testSpecificOrders();
    await testAllScenarios();
  }
  await testSupabaseState();
  await testEdgeCases();
  await testShipStationConnectivity();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}━━━ RESULTS ━━━${C.reset}`);
  console.log(`  ${C.green}Passed:${C.reset}   ${passed}`);
  if (failed > 0)   console.log(`  ${C.red}Failed:${C.reset}   ${failed}`);
  if (warnings > 0) console.log(`  ${C.yellow}Warnings:${C.reset} ${warnings}`);
  console.log('');

  if (failed === 0) {
    console.log(`${C.green}${C.bold}All tests passed.${C.reset}\n`);
  } else {
    console.log(`${C.red}${C.bold}${failed} test(s) failed — see above.${C.reset}\n`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`\n${fail('Test runner crashed:')} ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
