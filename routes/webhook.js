const { supabase, insertSmsMessage } = require('../db');
const ghl = require('../ghl');
const { verifyWebhookSignature, verifyWebhookSignatureV2 } = require('../telnyx');
const { analyseConversation } = require('../intelligence');
const { sendPushToAll } = require('../push-notify');
const { sendNativeMessagePush } = require('../lib/apns-notify');
const { cancelScheduledForCustomer, isOptedOut, markOptedOut } = require('../flows/utils');
const { rehostInboundMedia } = require('../lib/mms-media');
const { parseTapback, findTapbackTarget } = require('../lib/tapbacks');
const { normaliseTelnyxStatus, updateMessageStatus } = require('../lib/message-status');
const { classifyAndStoreSentiment } = require('../lib/analytics/sentiment');
const { reconcileAttributionForDeliveredMessage, recordTelnyxMessageEvent } = require('../lib/analytics/events');

const DELIVERY_EVENTS = new Set(['message.sent', 'message.delivered', 'message.finalized']);

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/telnyx', async (req, res) => {
    res.sendStatus(200);

    try {
      const rawBody = req.body;
      const body = JSON.parse(rawBody.toString());

      // Existing message handling remains backwards-compatible, but Analytics
      // trusts only current Telnyx v2 Ed25519 signatures with replay tolerance.
      const signatureV2 = req.headers['telnyx-signature-ed25519'];
      const timestampV2 = req.headers['telnyx-timestamp'];
      const analyticsSignatureValid = verifyWebhookSignatureV2(
        rawBody, signatureV2, timestampV2, process.env.TELNYX_PUBLIC_KEY
      );
      if (signatureV2 && !analyticsSignatureValid) {
        console.warn('[ANALYTICS] Telnyx v2 signature invalid; event excluded from trusted metrics');
      }

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

        const eventFallback = eventType === 'message.sent' ? 'sent' : null;
        const status = normaliseTelnyxStatus(providerStatus, eventFallback);
        const trustedWrite = recordTelnyxMessageEvent(event, {
          signatureValid: analyticsSignatureValid,
          status
        }).catch(error => {
          console.warn('[ANALYTICS] Trusted delivery capture skipped:', error.code || 'write_error');
          return { trusted: false };
        });
        const updated = await updateMessageStatus(supabase, messageId, status);

        if (updated) {
          broadcastSSE({ type: 'status_update', messageId, status, phone: updated.contact_phone });
          console.log(`Delivery update: ${messageId} → ${status}`);
          if (status === 'delivered' && analyticsSignatureValid) {
            trustedWrite
              .then(result => result.trusted && reconcileAttributionForDeliveredMessage(messageId));
          }
        }
        return;
      }

      // ── Inbound message ─────────────────────────────────────────────────────
      if (eventType !== 'message.received') return;

      const messageId = payload?.id;
      const fromPhone = payload?.from?.phone_number;
      const text = payload?.text || '';
      const inboundMedia = Array.isArray(payload?.media) ? payload.media : [];

      // Accept text-only, media-only (picture with no caption), or both
      if (!messageId || !fromPhone || (!text && inboundMedia.length === 0)) return;

      const { data: existing } = await supabase
        .from('sms_messages')
        .select('id')
        .eq('telnyx_message_id', messageId)
        .maybeSingle();
      if (existing) { console.log('Duplicate message, skipping:', messageId); return; }

      // STOP / opt-out detection — check before anything else
      const stopPattern = /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[\s-]?out|stop the messages|stop texting|stop messaging|no more texts|no more messages|these emails|stop these emails)$/i;
      if (stopPattern.test(text.trim())) {
        console.log(`[OPT-OUT] Received STOP from ...${fromPhone.slice(-4)}`);
        await markOptedOut(fromPhone);
        await cancelScheduledForCustomer(fromPhone).catch(() => {});
        // Log the inbound stop message but do not send any auto-reply
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: fromPhone,
          direction: 'inbound',
          body: text,
          status: 'delivered',
          created_at: payload.received_at || new Date().toISOString()
        }).catch(() => {});
        broadcastSSE({ type: 'opt_out', phone: fromPhone });
        return;
      }

      await supabase.from('sms_contacts').upsert({
        phone: fromPhone,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      // ── iPhone tapback (reaction) detection ─────────────────────────────────
      // "Loved \"...\"" / "Liked an image" etc. arrive as plain SMS text.
      // Attach the reaction to the message it targets and hide the raw text row
      // (the UI skips tapback rows that carry reply_to_message_id).
      const tapback = inboundMedia.length === 0 ? parseTapback(text) : null;
      if (tapback) {
        try {
          const target = await findTapbackTarget(supabase, fromPhone, tapback);
          if (target) {
            let reactions = Array.isArray(target.reactions) ? [...target.reactions] : [];
            if (tapback.action === 'add') {
              reactions = reactions.filter(r => !(r.type === tapback.type && r.source === 'customer'));
              reactions.push({ type: tapback.type, source: 'customer', at: new Date().toISOString() });
            } else {
              reactions = reactions.filter(r => !(r.type === tapback.type && r.source === 'customer'));
            }

            await supabase.from('sms_messages')
              .update({ reactions: reactions.length ? reactions : null })
              .eq('id', target.id);

            // Keep the raw row for audit + webhook-retry dedup, linked to its target
            await insertSmsMessage({
              telnyx_message_id: messageId,
              contact_phone: fromPhone,
              direction: 'inbound',
              body: text,
              status: 'delivered',
              reply_to_message_id: target.id,
              created_at: payload.received_at || new Date().toISOString()
            }).catch(() => {});

            broadcastSSE({ type: 'reaction_update', phone: fromPhone, message_id: target.id, reactions });

            const { data: reactor } = await supabase
              .from('sms_contacts').select('name').eq('phone', fromPhone).maybeSingle();
            sendPushToAll({
              title: reactor?.name || fromPhone,
              body: text,
              url: `/?thread=${encodeURIComponent(fromPhone)}`,
              icon: '/icons/icon-192.png',
              tag: `sms-${fromPhone}`
            }).catch(() => {});
            sendNativeMessagePush({
              title: reactor?.name || fromPhone,
              body: text,
              phone: fromPhone
            }).catch(err => console.error('APNs tapback error:', err.message));

            console.log(`[TAPBACK] ${tapback.action} ${tapback.type} on msg ${target.id} from ...${fromPhone.slice(-4)}`);
            return;
          }
          // No matching target — fall through and store as a normal message
        } catch (tapErr) {
          console.error('[TAPBACK] Error:', tapErr.message);
        }
      }

      // Re-host inbound pictures (Telnyx media URLs expire after 30 days)
      let mediaRecord = null;
      if (inboundMedia.length > 0) {
        const hosted = await rehostInboundMedia(messageId, inboundMedia);
        if (hosted.length > 0) mediaRecord = hosted;
      }

      let ghlContactId = null;
      try {
        const { contactId } = await ghl.upsertContact(fromPhone);
        ghlContactId = contactId;
        await ghl.addInboundMessage(contactId, text || '[Picture]');
      } catch (ghlErr) {
        console.error('GHL sync error:', ghlErr.message);
      }

      let insertedRow = null;
      const messageCreatedAt = payload.received_at || new Date().toISOString();
      try {
        insertedRow = await insertSmsMessage({
          telnyx_message_id: messageId,
          contact_phone: fromPhone,
          direction: 'inbound',
          body: text,
          status: 'delivered',
          ghl_contact_id: ghlContactId,
          media_urls: mediaRecord,
          created_at: messageCreatedAt
        });
        if (analyticsSignatureValid) {
          recordTelnyxMessageEvent(event, {
            signatureValid: true,
            status: 'delivered'
          }).catch(error => console.warn('[ANALYTICS] Trusted inbound capture skipped:', error.code || 'write_error'));
          classifyAndStoreSentiment(supabase, {
            id: insertedRow?.id,
            contact_phone: fromPhone,
            direction: 'inbound',
            body: text,
            created_at: messageCreatedAt
          }).catch(error => console.warn('[ANALYTICS] Sentiment classification skipped:', error.code || 'write_error'));
        }
      } catch (dbErr) {
        console.error('Inbound DB insert error:', dbErr.message);
      }

      await supabase.from('sms_contacts').update({
        last_seen: new Date().toISOString(),
        ghl_contact_id: ghlContactId
      }).eq('phone', fromPhone);

      try { await supabase.rpc('increment_contact_messages', { p_phone: fromPhone }); } catch {}
      try { await supabase.rpc('increment_unread', { p_phone: fromPhone }); } catch {}

      // Customer replied — cancel hold/failed sequences only.
      // Confirmed and shipped flows are NOT cancelled on reply (customer stays in that flow).
      const HOLD_FAILED_FLOWS = [
        'failed-msg1', 'failed-msg2', 'failed-msg3',
        'hold-msg1', 'hold-msg2', 'hold-msg3', 'hold-failed-nudge'
      ];
      const cancelled = await cancelScheduledForCustomer(fromPhone, HOLD_FAILED_FLOWS).catch(err => {
        console.error('[INBOUND] Sequence cancel error:', err.message);
        return 0;
      });
      if (cancelled > 0) {
        console.log(`[INBOUND] Cancelled ${cancelled} hold/failed messages for ...${fromPhone.slice(-4)} (customer replied)`);
      }

      broadcastSSE({
        type: 'new_message',
        phone: fromPhone,
        body: text,
        direction: 'inbound',
        id: insertedRow?.id || null,
        media_urls: mediaRecord
      });

      // Push notification to all subscribed devices
      const { data: contactRow } = await supabase
        .from('sms_contacts')
        .select('name')
        .eq('phone', fromPhone)
        .maybeSingle();
      const senderName = contactRow?.name || fromPhone;
      const pushBody = text
        ? (text.length > 100 ? text.slice(0, 97) + '…' : text)
        : `📷 Picture${mediaRecord && mediaRecord.length > 1 ? ` (${mediaRecord.length})` : ''}`;
      sendPushToAll({
        title: `New message from ${senderName}`,
        body: pushBody,
        url: `/?thread=${encodeURIComponent(fromPhone)}`,
        icon: '/icons/icon-192.png',
        tag: `sms-${fromPhone}`
      }).catch(err => console.error('Push notify error:', err.message));
      sendNativeMessagePush({
        title: `New message from ${senderName}`,
        body: pushBody,
        phone: fromPhone
      }).catch(err => console.error('APNs notify error:', err.message));

      setTimeout(() => analyseConversation(fromPhone).catch(console.error), 5000);

    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  });

  return router;
};
