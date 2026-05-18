/**
 * POST /webhook/send
 * Called by GHL custom webhook action to send an outbound SMS.
 * Mirrors the old bridge's /send endpoint format exactly.
 * Auth: x-webhook-secret header OR body.webhookSecret OR ?secret= query param.
 */

const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');

function isAuthorized(req) {
  if (!process.env.WEBHOOK_SECRET) return true;
  const provided =
    req.get('x-webhook-secret') ||
    req.body?.webhookSecret ||
    req.query?.secret;
  return provided === process.env.WEBHOOK_SECRET;
}

function extractPayload(body = {}) {
  const c = body.customData || body.custom_data || body.data?.customData || {};
  return {
    to:        body.to        || c.to        || body.phone       || body.contact?.phone,
    message:   body.message   || c.message   || body.text        || c.text,
    contactId: body.contactId || body.contactID || c.contactId   || c.contactID || body.contact?.id,
    name:      body.name      || c.name      || body.contact?.name ||
               [body.contact?.firstName, body.contact?.lastName].filter(Boolean).join(' ') || null
  };
}

function isValidPhone(phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/send', async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { to, message, contactId, name } = extractPayload(req.body);

    if (!to || !message) {
      console.warn('GHL send webhook missing fields. Body keys:', Object.keys(req.body || {}));
      return res.status(400).json({ success: false, error: 'Missing required fields: to, message' });
    }

    if (!isValidPhone(to)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number: ' + to });
    }

    try {
      // Send via Telnyx
      const { messageId } = await sendSMS(to, message);

      // Ensure contact exists in Supabase
      await supabase.from('sms_contacts').upsert({
        phone: to,
        name: name || null,
        ghl_contact_id: contactId || null,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      // Store message
      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: to,
        direction: 'outbound',
        body: message,
        status: 'queued',
        ghl_contact_id: contactId || null
      });

      // Push to inbox live
      broadcastSSE({ type: 'new_message', phone: to, body: message, direction: 'outbound' });

      console.log(`GHL automation SMS sent to ${to}: ${message.slice(0, 60)}`);
      return res.json({ success: true, messageId, status: 'accepted' });

    } catch (err) {
      console.error('GHL send webhook error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
