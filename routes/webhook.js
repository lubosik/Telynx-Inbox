const { supabase, insertSmsMessage } = require('../db');
const ghl = require('../ghl');
const { verifyWebhookSignature, verifyWebhookSignatureV2 } = require('../telnyx');
const { analyseConversation } = require('../intelligence');
const { sendPushToAll } = require('../push-notify');
const { sendNativeMessagePush } = require('../lib/apns-notify');
const {
  ALERT_DELIVERY_BLOCKED, cancelScheduledForCustomer, emitOperationalAlert,
  isOptedOut, markOptedOut
} = require('../flows/utils');
const { suppressOptOut } = require('../lib/opt-out-suppression');
const { rehostInboundMedia } = require('../lib/mms-media');
const { parseTapback, findTapbackTarget } = require('../lib/tapbacks');
const { normaliseTelnyxStatus, updateMessageStatus } = require('../lib/message-status');
const { classifyAndStoreSentiment } = require('../lib/analytics/sentiment');
const { reconcileAttributionForDeliveredMessage, recordTelnyxMessageEvent } = require('../lib/analytics/events');
const { isOptOutRequest } = require('../lib/opt-out-language');
const { recordCampaignDeliveryResult } = require('../lib/campaigns/delivery-receipts');
const { handleCheckInReply } = require('../lib/campaigns/check-in-reply');
const { draftReplyForInbound } = require('../lib/campaigns/reply-triage');
const { recordCampaignReplyEvents } = require('../lib/campaigns/reply-events');
const { refreshProfileQuietly } = require('../lib/profiles/profile-builder');
const { sendSMS } = require('../telnyx');

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
        // Campaign recipients carry their own delivery state. This is a no-op
        // for every message that is not one, and it is deliberately not
        // awaited: a campaign bookkeeping write must never delay or fail the
        // status update the inbox is waiting on.
        void recordCampaignDeliveryResult({
          client: supabase,
          providerMessageId: messageId,
          status,
          occurredAt: event?.occurred_at || payload?.completed_at || undefined,
          errorCode: toEntry?.error_code || payload?.errors?.[0]?.code || null,
          eventId: event?.id || null,
          signatureValid: analyticsSignatureValid
        });

        const updated = await updateMessageStatus(supabase, messageId, status);

        if (updated) {
          broadcastSSE({ type: 'status_update', messageId, status, phone: updated.contact_phone });
          console.log(`Delivery update: ${messageId} → ${status}`);

          // ── A BLOCKED MESSAGE MUST NOT BE SILENT ───────────────────────
          //
          // A failed send was written to the database and nothing told
          // anybody. Two customers never received a payment request, their
          // orders sat unpaid at $1,458.88 between them, and it surfaced only
          // because somebody happened to notice one of them by chance.
          //
          // Carrier spam filtering (Telnyx 40002) is the case that matters:
          // the message never reached the handset, the customer has no idea
          // they were asked for anything, and the shop is waiting for money
          // that is never coming. Loudly, with the error code, so it can be
          // searched for and counted.
          if (status === 'failed') {
            const carrierError = (event?.payload?.errors || [])[0]
              || (payload?.to || [])[0]?.error_code
              || null;
            const code = carrierError?.code || carrierError || 'unknown';
            const looksLikePayment = /zelle|venmo|balance|outstanding|\$/i.test(updated.body || '');
            // Through the one definition site in flows/utils.js, not a
            // hand-rolled prefix. A test reserves the operational-alert prefix
            // precisely so an alarm built on it cannot be diluted into noise
            // by ordinary logging, and it matches on the literal, so even
            // naming it in a comment here trips it. That strictness is the
            // point.
            emitOperationalAlert(ALERT_DELIVERY_BLOCKED, {
              severity: looksLikePayment ? 'critical' : 'warning',
              code,
              phone: `...${String(updated.contact_phone || '').slice(-4)}`,
              payment_message: looksLikePayment,
              message_id: messageId
            });
            broadcastSSE({
              type: 'delivery_blocked',
              messageId,
              phone: updated.contact_phone,
              code: String(code),
              paymentMessage: looksLikePayment
            });
          }

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
      const trustedOptOutClassification = analyticsSignatureValid
        ? payload?.autoresponse_type
        : null;
      if (isOptOutRequest(text, trustedOptOutClassification)) {
        console.log(`[OPT-OUT] Received STOP from ...${fromPhone.slice(-4)}`);
        // The suppression work must survive a failure to AUDIT the suppression.
        //
        // markOptedOut writes the opt-out sentinel and then a consent-bearing
        // audit row that THROWS if it cannot be written. That throw is correct
        // for an action gated on consent being recorded — but honouring a STOP
        // is not such an action. If the audit row fails, the right outcome is
        // still to cancel this customer's queued messages and shout about the
        // missing record; the wrong outcome is to leave them subscribed because
        // a logging table was unavailable. An unrecorded suppression is a
        // bookkeeping problem. An unhonoured STOP is a regulatory one.
        try {
          await markOptedOut(fromPhone);
        } catch (optOutErr) {
          console.error(`[OPT-OUT] Proceeding with suppression despite an unrecorded consent event for ...${fromPhone.slice(-4)}: ${optOutErr.message}`);
        }
        await cancelScheduledForCustomer(fromPhone).catch(() => {});
        // Onto the visible do-not-contact list, and into the consent trail as
        // a withdrawal. The sentinel above already blocks them; this makes the
        // block VISIBLE, because a do-not-contact screen that does not list
        // everybody who texted STOP gets somebody added back to a campaign by
        // hand. Never throws: the STOP is already honoured by this point.
        await suppressOptOut(fromPhone);
        // Log the inbound stop message but do not send any auto-reply.
        //
        // This used to end in `.catch(() => {})`. A Supabase query builder is a
        // thenable with `then` only — it has no `catch` — so that threw
        // `TypeError: ...insert(...).catch is not a function` before the request
        // was dispatched, and the outer catch below swallowed it. The same shape
        // in markOptedOut (flows/utils.js) meant the STOP branch died at its
        // first statement: no opt-out sentinel, no sequence cancellation, no
        // record of the message, and no opt_out broadcast. Fixing only that one
        // would have moved the crash here. A PostgREST failure arrives in
        // `error`, never as a rejection, so try/catch around the await is the
        // correct shape.
        try {
          const { error: stopLogError } = await supabase.from('sms_messages').insert({
            telnyx_message_id: messageId,
            contact_phone: fromPhone,
            direction: 'inbound',
            body: text,
            status: 'delivered',
            created_at: payload.received_at || new Date().toISOString()
          });
          if (stopLogError) console.error('[OPT-OUT] Could not record the STOP message:', stopLogError.message);
        } catch (stopLogErr) {
          console.error('[OPT-OUT] Could not record the STOP message:', stopLogErr.message);
        }
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

      // Tell the campaign that somebody answered it.
      //
      // Campaign analytics read sms_campaign_recipient_events for replies and
      // opt-outs, and only the provider ever wrote there. A send where ten
      // people texted STOP reported optOuts: 0 — not approximately wrong, but
      // categorically wrong, and exactly the number somebody would use to
      // decide whether to run the campaign again.
      //
      // Deliberately not awaited into the response path and never allowed to
      // throw: the reply is already in the inbox and any opt-out is already
      // honoured by the suppression sentinel. This only decides what a chart
      // says, and must never risk the provider retrying a message whose real
      // work is done.
      recordCampaignReplyEvents({
        client: supabase,
        phone: fromPhone,
        body: text,
        occurredAt: messageCreatedAt
      }).catch(error => console.warn('[CAMPAIGN REPLY] skipped:', error.message));

      // An inbound message changes this contact's engagement tier, their
      // last_inbound_at and whether they have ever replied at all — and 559 of
      // the 809 contacts with any message have never sent one, so the first
      // reply somebody ever makes is the most significant profile change in
      // the database.
      //
      // Same posture as the line above it: not awaited, and structurally
      // unable to throw. The customer's message is already saved and any
      // opt-out is already honoured by this point; a profile column must never
      // make Telnyx retry a webhook whose real work is done.
      void refreshProfileQuietly({ client: supabase, phone: fromPhone });

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

      // ── Answering a 21-day check-in earns the code ──────────────────────
      //
      // Only reached when the message is NOT a STOP: opt-out is handled far
      // above and returns before here. The handler applies its own refusals
      // on top of that (no recent check-in, already sent, reply reads as a
      // complaint, opted out since), and never throws, because this webhook's
      // job is to record the customer's message and return 200. A discount
      // that failed to send must not become a retried webhook or a lost
      // inbound message.
      //
      // Deliberately not awaited into the response path for anything except
      // its log line: the customer's message is already saved by this point.
      handleCheckInReply({ client: supabase, phone: fromPhone, text, sendSMS })
        .then(async outcome => {
          if (outcome.sent) {
            console.log(`[CHECK-IN] Sent ${outcome.code} to ...${fromPhone.slice(-4)} after their reply`);
            return;
          }
          if (outcome.reason !== 'no_recent_check_in') {
            console.log(`[CHECK-IN] No code for ...${fromPhone.slice(-4)}: ${outcome.reason}`
              + (outcome.drafted ? ' (drafted a reply)' : ''));
            return;
          }

          // ── Not a check-in reply, so draft an answer anyway ─────────────
          //
          // Every other inbound message gets read and, unless it needs no
          // answer, a suggested reply waiting for a person. Nine a day, and
          // the real ones are questions worth answering properly.
          //
          // This path has NO coupon client and NO sendSMS. The discount lives
          // only in handleCheckInReply above, which requires a check-in the
          // customer actually received, so a stranger texting "all good
          // thanks" is read and drafted for but can never earn 15% off.
          const drafted = await draftReplyForInbound({ client: supabase, phone: fromPhone, text });
          if (drafted.drafted) {
            console.log(`[INBOUND] Drafted a ${drafted.intent} reply for ...${fromPhone.slice(-4)}`);
          }
        })
        .catch(err => console.error('[CHECK-IN] Reply handler error:', err.message));

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
