'use strict';

const express = require('express');
const { logAudit, logAuditSafely } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');
const {
  CampaignNotReadyError,
  CampaignRequestError,
  createCampaignService
} = require('../lib/campaigns/service');
const { createCampaignGenerationService } = require('../lib/campaigns/generation-service');

const GENERATION_BODY_KEYS = new Set(['workflows', 'commit']);

function generationRequest(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !GENERATION_BODY_KEYS.has(key));
  if (unknown.length) {
    throw new CampaignRequestError(
      'Campaign opportunity evidence is server-owned; only workflows and commit may be provided.',
      'CAMPAIGN_GENERATION_INPUT_REJECTED', 400
    );
  }
  if (input.commit !== undefined && typeof input.commit !== 'boolean') {
    throw new CampaignRequestError('commit must be a boolean.', 'CAMPAIGN_GENERATION_INPUT_REJECTED', 400);
  }
  return { workflows: input.workflows, commit: input.commit === true };
}

function campaignSummaryName(campaign) {
  return campaign?.title ? `“${String(campaign.title).slice(0, 160)}”` : 'the campaign';
}

async function auditCampaign(eventType, req, campaign, details = {}) {
  return logAuditSafely({
    eventType,
    req,
    entityId: campaign?.id || req.params?.id,
    summary: details.summary,
    previousState: details.previousState,
    newState: details.newState,
    metadata: details.metadata,
    fingerprint: details.fingerprint
  });
}

async function auditCampaignApproval(req, prepared, writer = logAudit) {
  const input = {
    eventType: 'campaign.approved',
    req,
    entityId: prepared.campaign.id,
    summary: `Approved ${campaignSummaryName(prepared.campaign)} revision ${prepared.campaign.revision} for ${prepared.recipientCount} recipients`,
    previousState: {
      status: prepared.resumed ? 'approval_pending' : 'review_required',
      revision: prepared.campaign.revision
    },
    newState: { status: 'approval_pending', revision: prepared.campaign.revision },
    metadata: {
      revision: prepared.campaign.revision,
      recipient_count: prepared.recipientCount,
      audience_digest: prepared.audienceHash,
      message_digest: prepared.messageHash,
      message_length: String(prepared.campaign.final_message || '').length
    },
    fingerprint: `campaign-approved:${prepared.campaign.id}:${prepared.campaign.revision}`
  };
  // Keep the real writer call explicit: route-policy CI verifies that every
  // audit:true handler reaches an actual audit function. The alternate writer
  // is an offline test seam only.
  const result = writer === logAudit ? await logAudit(input) : await writer(input);
  if (!result.recorded && result.reason !== 'duplicate') {
    throw Object.assign(new Error('Campaign approval audit was not recorded.'), {
      code: 'CAMPAIGN_APPROVAL_AUDIT_REQUIRED', status: 503
    });
  }
  return { ...result, fingerprint: input.fingerprint };
}

function sendError(res, error) {
  if (error instanceof CampaignRequestError || error instanceof CampaignNotReadyError || error?.status) {
    return res.status(error.status || 400).json({ error: error.message, code: error.code || 'INVALID_CAMPAIGN_REQUEST' });
  }
  console.error('[CAMPAIGNS] Request failed:', error?.code || 'internal_error');
  return res.status(500).json({ error: 'The campaign request could not be completed.', code: 'CAMPAIGN_REQUEST_FAILED' });
}

function createCampaignRouter({
  service,
  auditApprovalWriter,
  generationService,
  campaignNotificationSender,
  generationAuditWriter
} = {}) {
  const campaigns = service || createCampaignService();
  const generator = generationService || createCampaignGenerationService();
  const approvalWriter = auditApprovalWriter || logAudit;
  // Keep APNs lazy: campaign route/unit-test construction must not require
  // database or Apple credentials, and the feature flag is checked before the
  // sender resolves device rows.
  const notifyCampaignReview = campaignNotificationSender || ((...args) =>
    require('../lib/apns-notify').sendCampaignReadyNotifications(...args));
  const writeGenerationAudit = generationAuditWriter || logAuditSafely;
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.list(req.query));
    } catch (error) { return sendError(res, error); }
  });

  // Literal before /:id so Express never interprets "review-count" as an id.
  router.get('/review-count', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.reviewCount());
    } catch (error) { return sendError(res, error); }
  });

  // This endpoint accepts control inputs only. Orders, products, contacts,
  // support state and recipient evidence are read by the server-side generator
  // and cannot be supplied or overridden by the caller.
  router.post('/generate', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = generationRequest(req.body);
      const result = await generator.generate({ ...input, actor: req.actor });
      if (!input.commit) return res.json(result);

      let notification;
      try {
        notification = await notifyCampaignReview(result.notifications, { dryRun: false });
      } catch (error) {
        console.error('[CAMPAIGNS] Review notification failed after draft persistence:', error?.code || 'internal_error');
        notification = { sent: 0, targeted: 0, error: 'campaign_notification_dispatch_failed' };
      }

      const summary = result.summary || {};
      const metadata = {
        mode: summary.mode,
        workflows: Object.keys(summary.byWorkflow || {}).sort(),
        opportunities_prepared: Number(summary.opportunitiesPrepared || 0),
        drafts_prepared: Number(summary.draftsPrepared || 0),
        campaigns_inserted: Number(summary.persisted?.insertedCampaigns || 0),
        campaigns_reused: Number(summary.persisted?.reusedCampaigns || 0),
        notifications_targeted: Number(notification?.targeted || 0),
        notifications_sent: Number(notification?.sent || 0),
        notifications_disabled: notification?.disabled === true
      };
      const auditInput = {
        eventType: 'campaign.drafts.generated',
        req,
        summary: `Prepared ${metadata.drafts_prepared} campaign draft${metadata.drafts_prepared === 1 ? '' : 's'} from authoritative opportunity data`,
        metadata,
        fingerprint: `campaign-drafts-generated:${String(summary.generatedAt || '')}`
      };
      if (writeGenerationAudit === logAuditSafely) await logAuditSafely(auditInput);
      else await writeGenerationAudit(auditInput);

      return res.json({ ...result, notification: {
        sent: metadata.notifications_sent,
        targeted: metadata.notifications_targeted,
        disabled: metadata.notifications_disabled,
        ...(notification?.reason ? { reason: notification.reason } : {}),
        ...(notification?.error ? { error: notification.error } : {})
      } });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/', async (req, res) => {
    try {
      const result = await campaigns.create(req.body, req.actor);
      await auditCampaign('campaign.created', req, result.campaign, {
        summary: `Created ${campaignSummaryName(result.campaign)} as a manual draft for ${result.recipientCount} recipients`,
        newState: { status: 'draft', revision: result.campaign.revision },
        metadata: {
          campaign_type: result.campaign.campaign_type,
          workflow_category: result.campaign.workflow_category,
          recipient_count: result.recipientCount,
          ...messageFingerprint(result.campaign.proposed_message)
        }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.detail(req.params.id));
    } catch (error) { return sendError(res, error); }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const before = await campaigns.detail(req.params.id);
      const campaign = await campaigns.edit(req.params.id, req.body, req.actor);
      await auditCampaign('campaign.edited', req, campaign, {
        summary: `Edited ${campaignSummaryName(campaign)}; approval is required again for revision ${campaign.revision}`,
        previousState: { status: before.campaign.status, revision: before.campaign.revision },
        newState: { status: campaign.status, revision: campaign.revision },
        metadata: { revision: campaign.revision, ...messageFingerprint(campaign.proposed_message) }
      });
      return res.json({ campaign });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id/recipients', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.recipients(req.params.id, req.query));
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id/performance', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.performance(req.params.id));
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/submit-review', async (req, res) => {
    try {
      const result = await campaigns.submitReview(req.params.id, req.actor);
      await auditCampaign('campaign.review_submitted', req, result.campaign, {
        summary: `Submitted ${campaignSummaryName(result.campaign)} revision ${result.campaign.revision} for review`,
        previousState: { status: 'draft', revision: result.campaign.revision },
        newState: { status: 'review_required', revision: result.campaign.revision },
        metadata: { revision: result.campaign.revision, recipient_count: result.recipientCount }
      });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/reject', async (req, res) => {
    try {
      const campaign = await campaigns.reject(req.params.id, req.body?.reason, req.actor);
      await auditCampaign('campaign.rejected', req, campaign, {
        summary: `Rejected ${campaignSummaryName(campaign)} revision ${campaign.revision}`,
        previousState: { status: 'review_required', revision: campaign.revision },
        newState: { status: 'rejected', revision: campaign.revision },
        metadata: { revision: campaign.revision, reason: campaign.rejection_reason }
      });
      return res.json({ campaign });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/approve', async (req, res) => {
    try {
      // Phase 1 freezes the exact audience/revision. Phase 2 cannot run unless
      // the consent-bearing audit row has been recorded successfully.
      const prepared = await campaigns.approve(req.params.id, req.actor);
      const auditProof = await auditCampaignApproval(req, prepared, approvalWriter);
      const campaign = await campaigns.finalizeApproval(
        req.params.id, prepared.campaign.revision, auditProof
      );
      return res.json({ campaign, recipientCount: prepared.recipientCount });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/schedule', async (req, res) => {
    try {
      const campaign = await campaigns.schedule(req.params.id, req.body?.scheduledFor, req.actor);
      await auditCampaign('campaign.scheduled', req, campaign, {
        summary: `Scheduled ${campaignSummaryName(campaign)} for ${campaign.scheduled_for}`,
        previousState: { status: 'approved', revision: campaign.revision },
        newState: { status: 'scheduled', revision: campaign.revision, scheduled_for: campaign.scheduled_for },
        metadata: { revision: campaign.revision, scheduled_for: campaign.scheduled_for }
      });
      return res.json({ campaign });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/cancel', async (req, res) => {
    try {
      // Cancellation is the safety action and happens before best-effort audit.
      const campaign = await campaigns.cancel(req.params.id, req.body?.reason, req.actor);
      await auditCampaign('campaign.cancelled', req, campaign, {
        summary: `Cancelled ${campaignSummaryName(campaign)}`,
        newState: { status: 'cancelled', revision: campaign.revision },
        metadata: { revision: campaign.revision, reason: campaign.cancellation_reason }
      });
      return res.json({ campaign });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/dry-run', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.dryRun(req.params.id));
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createCampaignRouter;
module.exports.sendError = sendError;
