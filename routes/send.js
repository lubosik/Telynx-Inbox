const { supabase } = require('../db');
const ghl = require('../ghl');
const { sendSMS } = require('../telnyx');

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/', async (req, res) => {
    try {
      const { to, message } = req.body;
      if (!to || !message) return res.status(400).json({ error: 'to and message required' });
      if (message.length > 1600) return res.status(400).json({ error: 'Message too long' });

      const { messageId } = await sendSMS(to, message);

      let ghlContactId = null;
      try {
        const { contactId } = await ghl.upsertContact(to);
        ghlContactId = contactId;
        await ghl.addOutboundMessage(contactId, message);
      } catch (ghlErr) {
        console.error('GHL outbound sync error:', ghlErr.message);
      }

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: to,
        direction: 'outbound',
        body: message,
        status: 'queued',
        ghl_contact_id: ghlContactId
      });

      await supabase.from('sms_contacts').upsert({
        phone: to,
        ghl_contact_id: ghlContactId,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      broadcastSSE({ type: 'new_message', phone: to, body: message, direction: 'outbound' });

      res.json({ success: true, messageId });
    } catch (err) {
      console.error('Send error:', err.message);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  return router;
};
