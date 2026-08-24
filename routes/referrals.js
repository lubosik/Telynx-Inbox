'use strict';

/**
 * Conversation handoffs only. This module intentionally has no dependency on
 * the SMS sender, Telnyx, GHL, sms_messages, or any outbound provider path.
 */

const express = require('express');
const { sendReferralNotifications } = require('../lib/apns-notify');
const { logAuditSafely } = require('../lib/audit/log');
const { ReferralRequestError, createReferralService, normaliseError } = require('../lib/referrals/service');

const CREATE_KEYS = new Set(['contactPhone', 'targetKind', 'targetUserId', 'note']);
const REASSIGN_KEYS = new Set(['targetUserId', 'note']);
const HAND_BACK_KEYS = new Set(['note']);

function strictBody(body, keys) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !keys.has(key));
  if (unknown.length) {
    throw new ReferralRequestError(
      `Unknown referral field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
      'REFERRAL_INPUT_REJECTED', 400
    );
  }
  return input;
}

function sendError(res, raw) {
  const error = normaliseError(raw);
  if (error instanceof ReferralRequestError || (error?.status && error?.code)) {
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  console.error('[REFERRALS] Request failed:', error?.code || 'internal_error');
  return res.status(500).json({
    error: 'The conversation referral request could not be completed.',
    code: 'REFERRAL_REQUEST_FAILED'
  });
}

function auditInput(eventType, result, req, { notePresent = false } = {}) {
  const referral = result.referral;
  const verb = {
    'conversation.referral.created': 'referred',
    'conversation.referral.claimed': 'claimed',
    'conversation.referral.reassigned': 'reassigned',
    'conversation.referral.handed_back': 'handed back',
    'conversation.referral.resolved': 'resolved'
  }[eventType] || 'updated';
  return {
    eventType,
    req,
    entityId: referral.id,
    contactPhone: referral.contactPhone,
    summary: `${req.actor.displayName || 'A teammate'} ${verb} a conversation`,
    newState: { state: referral.state, owner_user_id: referral.owner?.id || null, version: referral.version },
    metadata: {
      referral_id: referral.id,
      target_kind: referral.targetKind,
      target_user_id: referral.originalTarget?.id || null,
      owner_user_id: referral.owner?.id || null,
      state: referral.state,
      note_present: notePresent
    },
    fingerprint: `conversation-referral:${referral.id}:${eventType}:${referral.version}`
  };
}

async function recordReferralAudit(input, writer) {
  if (writer) return writer(input);
  return logAuditSafely(input);
}

function createReferralRouter({ service, notificationSender, auditWriter } = {}) {
  const referrals = service || createReferralService();
  const notify = notificationSender || sendReferralNotifications;
  const router = express.Router();

  async function notifyAfterEffect(result) {
    if (!result.notifications?.length) return { sent: 0, targeted: 0 };
    try {
      return await notify(result.notifications, { dryRun: false });
    } catch (error) {
      console.error('[REFERRALS] Non-fatal notification failure:', error?.code || error?.message || 'unknown');
      return { sent: 0, targeted: result.notifications.length, error: 'referral_notification_failed' };
    }
  }

  router.get('/recipients', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const recipients = await referrals.recipients(req.actor);
      return res.json({
        recipients,
        anyAdminAvailable: recipients.some(row => row.canReceiveAnyAdmin)
      });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await referrals.list(req.query, req.actor));
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await referrals.get(req.params.id, req.actor));
    } catch (error) { return sendError(res, error); }
  });

  router.post('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = strictBody(req.body, CREATE_KEYS);
      const result = await referrals.create(input, req.actor);
      // The same DB transaction already wrote the referral event; immutable
      // Activity audit follows the effect and contains no internal note.
      await recordReferralAudit(auditInput('conversation.referral.created', result, req, {
        notePresent: Boolean(String(input.note || '').trim())
      }), auditWriter);
      const notification = await notifyAfterEffect(result);
      return res.status(201).json({ referral: result.referral, notification });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/claim', async (req, res) => {
    try {
      strictBody(req.body, new Set());
      const result = await referrals.claim(req.params.id, req.actor);
      await recordReferralAudit(auditInput('conversation.referral.claimed', result, req), auditWriter);
      const notification = await notifyAfterEffect(result);
      return res.json({ referral: result.referral, notification });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/reassign', async (req, res) => {
    try {
      const input = strictBody(req.body, REASSIGN_KEYS);
      const result = await referrals.reassign(req.params.id, input, req.actor);
      await recordReferralAudit(auditInput('conversation.referral.reassigned', result, req, {
        notePresent: Boolean(String(input.note || '').trim())
      }), auditWriter);
      const notification = await notifyAfterEffect(result);
      return res.json({ referral: result.referral, notification });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/hand-back', async (req, res) => {
    try {
      const input = strictBody(req.body, HAND_BACK_KEYS);
      const result = await referrals.handBack(req.params.id, input, req.actor);
      await recordReferralAudit(auditInput(
        'conversation.referral.handed_back', result, req, { notePresent: true }
      ), auditWriter);
      const notification = await notifyAfterEffect(result);
      return res.json({ referral: result.referral, notification });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/resolve', async (req, res) => {
    try {
      strictBody(req.body, new Set());
      const result = await referrals.resolve(req.params.id, req.actor);
      await recordReferralAudit(auditInput('conversation.referral.resolved', result, req), auditWriter);
      const notification = await notifyAfterEffect(result);
      return res.json({ referral: result.referral, notification });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createReferralRouter;
module.exports.strictBody = strictBody;
