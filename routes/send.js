const { supabase, insertSmsMessage } = require('../db');
const ghl = require('../ghl');
const { sendSMS } = require('../telnyx');
const { formatPhone, isOptedOut } = require('../flows/utils');

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/', async (req, res) => {
    try {
      const { to, message, mediaUrls, replyToMessageId } = req.body;
      const media = Array.isArray(mediaUrls)
        ? mediaUrls.filter(u => typeof u === 'string' && u.startsWith('https://')).slice(0, 10)
        : [];
      const text = (message || '').trim();

      if (!to) return res.status(400).json({ error: 'to required' });
      const normalisedTo = formatPhone(to);
      if (!normalisedTo) return res.status(400).json({ error: 'Invalid phone number format' });
      if (!text && media.length === 0) return res.status(400).json({ error: 'message or media required' });
      if (text.length > 1600) return res.status(400).json({ error: 'Message too long' });
      if (await isOptedOut(normalisedTo)) {
        return res.status(403).json({ error: 'This contact opted out of messages' });
      }

      const { messageId } = await sendSMS(normalisedTo, text, media.length ? media : null);

      let ghlContactId = null;
      try {
        const { contactId } = await ghl.upsertContact(normalisedTo);
        ghlContactId = contactId;
        await ghl.addOutboundMessage(contactId, text || '[Picture]');
      } catch (ghlErr) {
        console.error('GHL outbound sync error:', ghlErr.message);
      }

      const mediaRecord = media.length ? media.map(u => ({ url: u })) : null;
      const replyTo = Number.isFinite(Number(replyToMessageId)) && replyToMessageId !== null && replyToMessageId !== undefined
        ? Number(replyToMessageId)
        : null;

      let inserted = null;
      try {
        inserted = await insertSmsMessage({
          telnyx_message_id: messageId,
          contact_phone: normalisedTo,
          direction: 'outbound',
          body: text,
          status: 'queued',
          ghl_contact_id: ghlContactId,
          media_urls: mediaRecord,
          reply_to_message_id: replyTo
        });
      } catch (dbErr) {
        console.error('Send DB insert error:', dbErr.message);
      }

      await supabase.from('sms_contacts').upsert({
        phone: normalisedTo,
        ghl_contact_id: ghlContactId,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      broadcastSSE({
        type: 'new_message',
        phone: normalisedTo,
        body: text,
        direction: 'outbound',
        id: inserted?.id || null,
        telnyx_message_id: messageId,
        media_urls: mediaRecord,
        reply_to_message_id: replyTo
      });

      res.json({ success: true, messageId, id: inserted?.id || null });
    } catch (err) {
      console.error('Send error:', err.message);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  return router;
};
