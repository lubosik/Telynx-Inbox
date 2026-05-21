require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runWooSync } = require('../sync-woocommerce');
const { supabase } = require('../db');
const { fetchOrders, wooGet, normalizePhone } = require('../woocommerce');

async function fixUnknownNames() {
  console.log('\n── Fixing unknown contact names ──');
  const { data: unknowns } = await supabase
    .from('sms_contacts')
    .select('phone')
    .or('name.is.null,name.eq.Unknown,name.eq.unknown');

  if (!unknowns?.length) { console.log('No unknown contacts found.'); return; }
  console.log(`Found ${unknowns.length} contacts with unknown names.`);

  let fixed = 0;

  // Try matching by phone via WooCommerce customers endpoint
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const { data: customers, headers } = await wooGet('/customers', { per_page: 100, page });
    if (page === 1) totalPages = parseInt(headers.get('X-WP-TotalPages') || '1');

    for (const customer of customers) {
      const rawPhone = customer.billing?.phone;
      const phone = normalizePhone(rawPhone);
      if (!phone) continue;

      const firstName = customer.billing?.first_name || customer.first_name || '';
      const lastName = customer.billing?.last_name || customer.last_name || '';
      const name = [firstName, lastName].filter(Boolean).join(' ');
      if (!name) continue;

      const isUnknown = unknowns.some(u => u.phone === phone);
      if (!isUnknown) continue;

      await supabase.from('sms_contacts').update({
        name,
        email: customer.email || customer.billing?.email || null,
        city: customer.billing?.city || null,
        state: customer.billing?.state || null,
        country: customer.billing?.country || null,
        woo_customer_id: customer.id || null
      }).eq('phone', phone);

      console.log(`  Fixed: ${phone} → ${name}`);
      fixed++;
    }

    page++;
    if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
  }

  // Second pass: match via order billing data for remaining unknowns
  const stillUnknown = unknowns.filter(u => {
    return true; // Re-check all — the order sync may have already fixed some
  });

  console.log(`Fixed ${fixed} names from customer records.`);
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  Vici Peptides — WooCommerce Backfill  ');
  console.log('═══════════════════════════════════════');
  console.log('\nNOTE: Historical orders will be marked as SMS-already-sent.');
  console.log('Only NEW orders from today onward will trigger the 3-SMS flow.\n');

  console.log('── Running order sync ──');
  const result = await runWooSync();
  console.log(`\nOrder sync complete:`);
  console.log(`  Orders processed: ${result.total_orders}`);
  console.log(`  Contacts synced:  ${result.synced_contacts}`);

  await fixUnknownNames();

  const { count } = await supabase
    .from('sms_contacts')
    .select('*', { count: 'exact', head: true });

  const { count: orderCount } = await supabase
    .from('sms_orders')
    .select('*', { count: 'exact', head: true });

  console.log(`\n── Final counts ──`);
  console.log(`  Total contacts in DB: ${count}`);
  console.log(`  Total orders in DB:   ${orderCount}`);
  console.log('\nBackfill complete. Safe to go live.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\nBackfill failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
