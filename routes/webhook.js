const { supabase } = require('../db');
const ghl = require('../ghl');
const { verifyWebhookSignature } = require('../telnyx');
const { analyseConversation } = require('../intelligence');

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
      if (event?.event_type !== 'message.received') return;

      const payload = event.payload;
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
        ghl_contact_id: ghlContactId,
        unread_count: supabase.rpc ? undefined : 1
      }).eq('phone', fromPhone);

      // Increment unread_count via raw SQL workaround
      await supabase.rpc('increment_contact_messages', { p_phone: fromPhone })
        .catch(() => {});

      broadcastSSE({ type: 'new_message', phone: fromPhone, body: text, direction: 'inbound' });

      setTimeout(() => analyseConversation(fromPhone).catch(console.error), 5000);

    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  });

  return router;
};
