const { supabase } = require('../db');

function isValidPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function mapDirection(dir) {
  if (!dir) return 'outbound';
  return String(dir).toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/ghl', async (req, res) => {
    // Respond immediately — GHL expects fast 200
    res.sendStatus(200);

    try {
      const body = req.body;
      const type = body.type;
      const locationId = body.locationId;

      // Only handle events for our location
      if (locationId && locationId !== process.env.GHL_LOCATION_ID) return;

      // ── New contact created (WooCommerce order → GHL contact) ──────────────
      if (type === 'ContactCreate' || type === 'ContactCreated') {
        const phone = body.phone;
        if (!isValidPhone(phone)) return;

        const name = [body.firstName, body.lastName].filter(Boolean).join(' ') || null;

        await supabase.from('sms_contacts').upsert({
          phone,
          name,
          ghl_contact_id: body.id || body.contactId,
          first_seen: body.dateAdded || new Date().toISOString(),
          last_seen: body.dateAdded || new Date().toISOString()
        }, { onConflict: 'phone' });

        console.log(`GHL webhook: new contact ${phone} (${name})`);

        broadcastSSE({ type: 'contact_added', phone, name });
        return;
      }

      // ── Contact updated (phone number added later) ──────────────────────────
      if (type === 'ContactUpdate' || type === 'ContactUpdated') {
        const phone = body.phone;
        if (!isValidPhone(phone)) return;

        const name = [body.firstName, body.lastName].filter(Boolean).join(' ') || null;

        await supabase.from('sms_contacts').upsert({
          phone,
          name,
          ghl_contact_id: body.id || body.contactId,
          last_seen: new Date().toISOString()
        }, { onConflict: 'phone' });

        broadcastSSE({ type: 'contact_added', phone, name });
        return;
      }

      // ── Outbound SMS from GHL automation ───────────────────────────────────
      // Fires when GHL workflows/automations send an SMS
      if (
        type === 'OutboundMessage' ||
        type === 'ConversationProviderOutboundMessage' ||
        (type === 'ConversationMessage' && mapDirection(body.direction) === 'outbound')
      ) {
        if (body.messageType !== 'TYPE_SMS' && body.messageType !== 'TYPE_CUSTOM_SMS' && body.type !== 'SMS') {
          if (!['SMS', 'TYPE_SMS', 'TYPE_CUSTOM_SMS'].includes(body.messageType)) return;
        }

        const messageBody = body.body || body.message || body.text;
        if (!messageBody) return;

        // Get phone from contactId if not directly on payload
        let phone = body.phone || body.to;
        if (!phone && body.contactId) {
          const { data: contact } = await supabase
            .from('sms_contacts')
            .select('phone')
            .eq('ghl_contact_id', body.contactId)
            .maybeSingle();
          phone = contact?.phone;
        }
        if (!isValidPhone(phone)) return;

        // Ensure contact exists
        await supabase.from('sms_contacts').upsert({
          phone,
          ghl_contact_id: body.contactId,
          last_seen: new Date().toISOString()
        }, { onConflict: 'phone' });

        // Store message (dedup by GHL message id)
        const msgId = body.id || body.messageId || `ghl-out-${body.contactId}-${Date.now()}`;
        const createdAt = body.dateAdded || body.createdAt || new Date().toISOString();
        const { data: storedMessage } = await supabase.from('sms_messages').upsert({
          telnyx_message_id: msgId,
          contact_phone: phone,
          direction: 'outbound',
          body: messageBody,
          status: 'delivered',
          ghl_contact_id: body.contactId,
          ghl_conversation_id: body.conversationId,
          ghl_message_id: body.id || body.messageId,
          created_at: createdAt
        }, { onConflict: 'telnyx_message_id' }).select('id').maybeSingle();

        console.log(`GHL webhook: outbound SMS stored for ...${phone.replace(/\D/g, '').slice(-4)} id=${storedMessage?.id || 'unknown'}`);
        broadcastSSE({ type: 'new_message', phone, body: messageBody, direction: 'outbound' });
        return;
      }

      // ── Inbound SMS reply to GHL automation (customer replies to GHL's SMS) ─
      if (
        type === 'InboundMessage' ||
        (type === 'ConversationMessage' && mapDirection(body.direction) === 'inbound')
      ) {
        if (body.messageType !== 'TYPE_SMS' && body.messageType !== 'TYPE_CUSTOM_SMS') return;

        const messageBody = body.body || body.message || body.text;
        if (!messageBody) return;

        let phone = body.phone || body.from;
        if (!phone && body.contactId) {
          const { data: contact } = await supabase
            .from('sms_contacts')
            .select('phone')
            .eq('ghl_contact_id', body.contactId)
            .maybeSingle();
          phone = contact?.phone;
        }
        if (!isValidPhone(phone)) return;

        await supabase.from('sms_contacts').upsert({
          phone,
          ghl_contact_id: body.contactId,
          last_seen: new Date().toISOString()
        }, { onConflict: 'phone' });

        const msgId = body.id || body.messageId || `ghl-in-${body.contactId}-${Date.now()}`;
        const createdAt = body.dateAdded || body.createdAt || new Date().toISOString();
        const { data: storedMessage } = await supabase.from('sms_messages').upsert({
          telnyx_message_id: msgId,
          contact_phone: phone,
          direction: 'inbound',
          body: messageBody,
          status: 'delivered',
          ghl_contact_id: body.contactId,
          ghl_conversation_id: body.conversationId,
          ghl_message_id: body.id || body.messageId,
          created_at: createdAt
        }, { onConflict: 'telnyx_message_id' }).select('id').maybeSingle();

        console.log(`GHL webhook: inbound SMS stored for ...${phone.replace(/\D/g, '').slice(-4)} id=${storedMessage?.id || 'unknown'}`);
        broadcastSSE({ type: 'new_message', phone, body: messageBody, direction: 'inbound' });
        return;
      }

    } catch (err) {
      console.error('GHL webhook error:', err.message);
    }
  });

  return router;
};
