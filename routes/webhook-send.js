'use strict';
/**
 * POST /webhook/send
 * Called by GHL custom webhook action to send an outbound SMS.
 * Mirrors the old bridge's /send endpoint format exactly.
 * Auth: x-webhook-secret header OR body.webhookSecret OR ?secret= query param.
 *
 * THIS ENDPOINT FAILS CLOSED. It used to return true when no secret was
 * configured. That is the wrong default anywhere, and specifically wrong here:
 * this route sends an SMS to any number in the request body, on the company's
 * Telnyx account, with no session and no rate limit in front of it. An unset or
 * renamed WEBHOOK_SECRET would have turned it into an open SMS relay. An
 * unconfigured secret is now a 503, which is visible, rather than an allow,
 * which is not.
 *
 * `GHL_WEBHOOK_SECRET` is the dedicated variable for this caller.
 * `WEBHOOK_SECRET` — which routes/webhook.js also uses as the legacy Telnyx v1
 * signing secret — remains accepted so the live GHL automation keeps working
 * through the deploy that splits them.
 */

const crypto = require('crypto');
const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { normaliseTelnyxStatus } = require('../lib/message-status');

const UNCONFIGURED = 'unconfigured';
const MISMATCH = 'mismatch';

let didLogMissingSecret = false;

function expectedSecrets() {
  return [process.env.GHL_WEBHOOK_SECRET, process.env.WEBHOOK_SECRET]
    .filter(value => typeof value === 'string' && value.length > 0);
}

/**
 * Constant-time comparison over fixed-length digests. `===` on strings returns
 * at the first differing character, which leaks how much of a guess was right.
 */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @returns {true|'unconfigured'|'mismatch'} — the caller distinguishes a
 * deployment fault (503, ours to fix) from a bad credential (401, theirs).
 */
function authorize(req) {
  const accepted = expectedSecrets();
  if (!accepted.length) {
    if (!didLogMissingSecret) {
      didLogMissingSecret = true;
      console.error('[WEBHOOK] /webhook/send refused: neither GHL_WEBHOOK_SECRET nor WEBHOOK_SECRET is configured. Outbound SMS through this route is disabled until one is set.');
    }
    return UNCONFIGURED;
  }

  const provided =
    req.get('x-webhook-secret') ||
    req.body?.webhookSecret ||
    req.query?.secret;
  return accepted.some(secret => secretsMatch(provided, secret)) ? true : MISMATCH;
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
    const authorization = authorize(req);
    if (authorization === UNCONFIGURED) {
      return res.status(503).json({ success: false, error: 'Webhook send is not configured', code: 503 });
    }
    if (authorization !== true) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 401 });
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
      const { messageId, status: providerStatus } = await sendSMS(to, message);

      // Insert before secondary contact work so an immediate Telnyx delivery
      // callback always has a row to update.
      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: to,
        direction: 'outbound',
        body: message,
        status: normaliseTelnyxStatus(providerStatus),
        ghl_contact_id: contactId || null
      });

      // Ensure contact exists in Supabase
      await supabase.from('sms_contacts').upsert({
        phone: to,
        name: name || null,
        ghl_contact_id: contactId || null,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

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

module.exports.authorize = authorize;
