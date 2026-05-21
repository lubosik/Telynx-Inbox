/**
 * Catchup: send order-confirmation SMS to processing orders
 * that have never been texted.
 *
 * Logic:
 *   - Only touches orders with status = 'processing'
 *   - Only sends if the contact has ZERO rows in sms_messages (truly never texted)
 *   - Marks order_sms_sent = true immediately before sending to prevent any race
 *   - 400ms delay between sends to stay within Telnyx rate limits
 *
 * Safe to re-run: anyone already marked sent will be skipped.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');

const ORDER_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Vici — Processing Order SMS Catchup      ');
  console.log('═══════════════════════════════════════════\n');

  // Fetch all processing orders
  const { data: processingOrders, error: ordErr } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id, order_sms_sent')
    .eq('status', 'processing');

  if (ordErr) { console.error('DB error:', ordErr.message); process.exit(1); }
  if (!processingOrders?.length) {
    console.log('No processing orders found. Nothing to send.');
    process.exit(0);
  }

  console.log(`Processing orders in DB: ${processingOrders.length}`);

  // Check which phones have any SMS history at all
  const phones = [...new Set(processingOrders.map(o => o.contact_phone))];
  const { data: msgHistory } = await supabase
    .from('sms_messages')
    .select('contact_phone')
    .in('contact_phone', phones);

  const phonesWithHistory = new Set((msgHistory || []).map(m => m.contact_phone));

  // Eligible: processing AND contact has no SMS history whatsoever
  const eligible = processingOrders.filter(o => !phonesWithHistory.has(o.contact_phone));

  // Of those, split into already-flagged-unsent vs flagged-as-sent-but-untexted
  const unsent    = eligible.filter(o => !o.order_sms_sent);
  const resetable = eligible.filter(o =>  o.order_sms_sent);

  console.log(`  With no SMS history:     ${eligible.length}`);
  console.log(`  Already flagged unsent:  ${unsent.length}`);
  console.log(`  Flagged sent (reset):    ${resetable.length}`);

  if (eligible.length === 0) {
    console.log('\nEveryone with a processing order has already been texted. Nothing to do.');
    process.exit(0);
  }

  // Reset historical-but-untexted flags so they're in the same pool
  if (resetable.length > 0) {
    const ids = resetable.map(o => o.id);
    await supabase.from('sms_orders').update({ order_sms_sent: false }).in('id', ids);
    console.log(`\nReset ${resetable.length} order(s) from historical → pending\n`);
  }

  const toSend = eligible; // all eligible, flags now consistent

  console.log(`\nSending to ${toSend.length} customer(s)...\n`);

  let sent = 0;
  let failed = 0;

  for (const order of toSend) {
    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('name')
      .eq('phone', order.contact_phone)
      .maybeSingle();

    const firstName = contact?.name?.split(' ')?.[0] || 'there';
    const msg = ORDER_SMS(firstName);

    // Mark as sent BEFORE calling Telnyx — prevents any re-run from double-sending
    // even if the process crashes mid-loop
    await supabase.from('sms_orders').update({ order_sms_sent: true }).eq('id', order.id);

    try {
      const { messageId } = await sendSMS(order.contact_phone, msg);

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: order.contact_phone,
        direction: 'outbound',
        body: msg,
        status: 'sent',
        created_at: new Date().toISOString()
      });

      await supabase.from('sms_contacts')
        .update({ last_seen: new Date().toISOString() })
        .eq('phone', order.contact_phone);

      console.log(`  ✓  ${contact?.name || order.contact_phone}  (order #${order.woo_order_id})`);
      sent++;
    } catch (err) {
      // Telnyx failed — reset flag so it can be retried manually via CATCHUP button
      await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('id', order.id);
      console.error(`  ✗  ${order.contact_phone} (order #${order.woo_order_id}): ${err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Sent: ${sent}   Failed: ${failed}`);
  console.log(`  Dashboard updates automatically every 30s`);
  console.log(`═══════════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
