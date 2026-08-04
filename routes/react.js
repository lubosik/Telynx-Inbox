'use strict';
/**
 * routes/react.js — POST /api/react
 *
 * Operator tapbacks: long-press a customer message → react. Sends the same
 * plain-text fallback an iPhone would ("Loved \"...\"" / "Removed a heart
 * from \"...\"") so it renders natively on the customer's phone, and stores
 * the reaction on the target message for our UI. Reacting twice with the
 * same type toggles it off.
 *
 * Body: { messageId, type } — type ∈ loved|liked|disliked|laughed|emphasized|questioned
 */

const { supabase, insertSmsMessage } = require('../db');
const { sendSMS } = require('../telnyx');
const { isOptedOut } = require('../flows/utils');

const VERBS = {
  loved:      { add: 'Loved',      remove: 'Removed a heart from' },
  liked:      { add: 'Liked',      remove: 'Removed a like from' },
  disliked:   { add: 'Disliked',   remove: 'Removed a dislike from' },
  laughed:    { add: 'Laughed at', remove: 'Removed a laugh from' },
  emphasized: { add: 'Emphasized', remove: 'Removed an exclamation from' },
  questioned: { add: 'Questioned', remove: 'Removed a question mark from' }
};

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/', async (req, res) => {
    try {
      const { messageId, type } = req.body || {};
      if (!messageId || !VERBS[type]) {
        return res.status(400).json({ error: 'messageId and valid type required' });
      }

      const { data: target } = await supabase
        .from('sms_messages')
        .select('id, contact_phone, body, media_urls, reactions')
        .eq('id', messageId)
        .maybeSingle();
      if (!target) return res.status(404).json({ error: 'Message not found' });
      if (await isOptedOut(target.contact_phone)) {
        return res.status(403).json({ error: 'This contact opted out of messages' });
      }

      const existing = Array.isArray(target.reactions) ? [...target.reactions] : [];
      const already = existing.find(r => r.type === type && r.source === 'operator');
      const removing = !!already;

      const verb = removing ? VERBS[type].remove : VERBS[type].add;
      const hasBody = (target.body || '').trim().length > 0;
      const text = hasBody
        ? `${verb} “${target.body.trim()}”`
        : `${verb} an image`;

      const { messageId: telnyxId } = await sendSMS(target.contact_phone, text);

      const reactions = removing
        ? existing.filter(r => !(r.type === type && r.source === 'operator'))
        : [...existing.filter(r => !(r.type === type && r.source === 'operator')),
           { type, source: 'operator', at: new Date().toISOString() }];

      await supabase.from('sms_messages')
        .update({ reactions: reactions.length ? reactions : null })
        .eq('id', target.id);

      // Store the outbound tapback row (hidden by the UI via reply_to_message_id)
      await insertSmsMessage({
        telnyx_message_id: telnyxId,
        contact_phone: target.contact_phone,
        direction: 'outbound',
        body: text,
        status: 'queued',
        reply_to_message_id: target.id
      }).catch(() => {});

      broadcastSSE({
        type: 'reaction_update',
        phone: target.contact_phone,
        message_id: target.id,
        reactions
      });

      res.json({ success: true, reactions, removed: removing });
    } catch (err) {
      console.error('React error:', err.message);
      res.status(500).json({ error: 'Failed to send reaction' });
    }
  });

  return router;
};
