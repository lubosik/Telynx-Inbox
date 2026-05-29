const { supabase } = require('../db');
const ghl = require('../ghl');
const { verifyWebhookSignature } = require('../telnyx');
const { analyseConversation } = require('../intelligence');
const { sendPushToAll } = require('../push-notify');
const { cancelScheduledForCustomer } = require('../flows/utils');

const DELIVERY_EVENTS = new Set(['message.sent', 'message.delivered', 'message.finalized']);

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/telnyx', async (req, res) => {
    res.sendStatus(200);

    try {
      const rawBody = req.body;
      const body = JSON.parse(rawBody.toString());

      const sig = req.headers['x-telnyx-signature'];
      if (sig) {
        const valid = verifyWebhookSignature(rawBody, sig, process.env.WEBHOOK_SECRET);
        if (!valid) console.warn('Webhook signature mismatch — processing anyway');
      }

      const event = body?.data;
      const eventType = event?.event_type;
      const payload = event?.payload;

      // ── Delivery status update ──────────────────────────────────────────────
      if (DELIVERY_EVENTS.has(eventType)) {
        const messageId = payload?.id;
        if (!messageId) return;

        const toEntry = Array.isArray(payload.to) ? payload.to[0] : payload.to;
        const providerStatus = toEntry?.status || payload?.status || '';
        const toPhone = toEntry?.phone_number;

        let status;
        if (['delivered', 'received'].includes(providerStatus)) status = 'delivered';
        else if (['delivery_failed', 'sending_failed', 'failed', 'gw_timeout'].includes(providerStatus)) status = 'failed';
        else status = 'sent';

        const { data: updated } = await supabase
          .from('sms_messages')
          .update({ status })
          .eq('telnyx_message_id', messageId)
          .select('contact_phone')
          .maybeSingle();

        if (updated) {
          broadcastSSE({ type: 'status_update', messageId, status, phone: updated.contact_phone });
          console.log(`Delivery update: ${messageId} → ${status}`);
        }
        return;
      }

      // ── Inbound message ─────────────────────────────────────────────────────
      if (eventType !== 'message.received') return;

      const messageId = payload?.id;
      const fromPhone = payload?.from?.phone_number;
      const text = payload?.text;

      if (!messageId || !fromPhone || !text) return;

      const { data: existing } = await supabase
        .from('sms_messages')
        .select('id')
        .eq('telnyx_message_id', messageId)
        .maybeSingle();
      if (existing) { console.log('Duplicate message, skipping:', messageId); return; }

      await supabase.from('sms_contacts').upsert({
        phone: fromPhone,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      let ghlContactId = null;
      try {
        const { contactId } = await ghl.upsertContact(fromPhone);
        ghlContactId = contactId;
        await ghl.addInboundMessage(contactId, text);
      } catch (ghlErr) {
        console.error('GHL sync error:', ghlErr.message);
      }

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: fromPhone,
        direction: 'inbound',
        body: text,
        status: 'delivered',
        ghl_contact_id: ghlContactId,
        created_at: payload.received_at || new Date().toISOString()
      });

      await supabase.from('sms_contacts').update({
        last_seen: new Date().toISOString(),
        ghl_contact_id: ghlContactId
      }).eq('phone', fromPhone);

      await supabase.rpc('increment_contact_messages', { p_phone: fromPhone }).catch(() => {});

      // Customer replied — remove them from all pending automated sequences immediately
      const cancelled = await cancelScheduledForCustomer(fromPhone).catch(err => {
        console.error('[INBOUND] Sequence cancel error:', err.message);
        return 0;
      });
      if (cancelled > 0) {
        console.log(`[INBOUND] Cancelled ${cancelled} pending messages for ...${fromPhone.slice(-4)} (customer replied)`);
      }

      broadcastSSE({ type: 'new_message', phone: fromPhone, body: text, direction: 'inbound' });

      // Push notification to all subscribed devices
      const { data: contactRow } = await supabase
        .from('sms_contacts')
        .select('name')
        .eq('phone', fromPhone)
        .maybeSingle();
      const senderName = contactRow?.name || fromPhone;
      sendPushToAll({
        title: `New message from ${senderName}`,
        body: text.length > 100 ? text.slice(0, 97) + '…' : text,
        url: process.env.APP_URL || '/',
        icon: '/icons/icon-192.png'
      }).catch(err => console.error('Push notify error:', err.message));

      setTimeout(() => analyseConversation(fromPhone).catch(console.error), 5000);

    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  });

  return router;
};
