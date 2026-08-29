'use strict';

const express = require('express');
const { validateCopy, septetLength } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');
const { logAudit, logAuditSafely } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');
const {
  CampaignNotReadyError,
  CampaignRequestError,
  createCampaignService
} = require('../lib/campaigns/service');
const { createCampaignGenerationService } = require('../lib/campaigns/generation-service');
const { CopyDraftError, draftCandidates } = require('../lib/campaigns/copy-writer');
const {
  createOpportunityPortfolioService
} = require('../lib/campaigns/opportunity-portfolio');
const { recipeCatalogue } = require('../lib/campaigns/recipes');
const { buildFromRecipe } = require('../lib/campaigns/audience-builder');

const GENERATION_BODY_KEYS = new Set(['workflows', 'commit']);

/**
 * Body keys accepted by POST /copy-suggestions.
 *
 * Narrow on purpose, and enforced rather than filtered. Everything here is
 * campaign shape, never customer evidence: there is no recipient, no phone, no
 * contact id and no order. `lib/campaigns/copy-writer.js` re-checks each value
 * for identifier shapes before anything reaches a model.
 */
const COPY_SUGGESTION_BODY_KEYS = new Set([
  'workflowType', 'productName', 'cadence', 'brief', 'candidateCount', 'linkUrl', 'approvedProductCodes'
]);

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

function copySuggestionRequest(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !COPY_SUGGESTION_BODY_KEYS.has(key));
  if (unknown.length) {
    throw new CampaignRequestError(
      `Copy drafting accepts campaign shape only; ${unknown.join(', ')} is not accepted. Recipient and customer evidence is server-owned.`,
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  return input;
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
  generationAuditWriter,
  campaignDeletionAuditWriter,
  copyDrafter,
  opportunityPortfolio,
  campaignClient
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
  // Deletion is the one campaign action whose audit row must exist before the
  // effect. logAudit, not logAuditSafely: no row, no delete.
  const deletionAuditWriter = campaignDeletionAuditWriter || logAudit;
  // Injectable so route tests never construct an OpenRouter client.
  const drafter = copyDrafter || draftCandidates;
  // Lazily constructed for the same reason: building it must not require
  // database or WooCommerce credentials, and the first read happens inside the
  // handler. The instance is per-router so its cache is shared across requests.
  const portfolio = opportunityPortfolio || createOpportunityPortfolioService();
  // Lazy for the same reason as the portfolio above: constructing this router
  // must not require database credentials, because the route tests build it
  // without any. Resolved on first use, inside a handler.
  const db = () => (campaignClient || require('../db').supabase);
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.list(req.query));
    } catch (error) { return sendError(res, error); }
  });

  // Literal before /:id so Express never interprets "review-count" as an id.
  /**
   * The campaigns this app can build by itself.
   *
   * Static data, so it needs no database and answers instantly. It is what
   * turns "create a campaign" from a terminal script into a screen: each entry
   * already knows who is in the audience, what the message says, what it
   * offers, and how long before the same person may receive it again.
   */
  router.get('/recipes', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json({ recipes: recipeCatalogue() });
    } catch (error) { return sendError(res, error); }
  });

  /**
   * Build one recipe into reviewable drafts.
   *
   * Creates DRAFTS and nothing else: no submit, no approve, no schedule, no
   * coupon. Minting happens at approval, by a person.
   *
   * `dryRun: true` reports the numbers without writing anything, which is what
   * the app calls first so the owner sees "376 qualify, 364 already had this,
   * 12 to send" before deciding whether a build is worth doing at all.
   */
  router.post('/build', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const result = await buildFromRecipe({
        client: db(),
        recipeKey: req.body?.recipe,
        actorID: Number(req.actor?.id) || null,
        dryRun: req.body?.dryRun === true
      });
      if (!result.created?.length || result.dryRun) return res.json(result);

      await auditCampaign('campaign.created', req, { id: result.created[0].id }, {
        summary: `Built ${result.created.length} draft(s) from the "${result.name}" recipe `
          + `for ${result.audience} people; ${result.suppressedAsDuplicate} were left out as already contacted`,
        newState: { status: 'draft' },
        metadata: {
          recipe: result.recipe,
          audience: result.audience,
          suppressed_as_duplicate: result.suppressedAsDuplicate,
          campaigns: result.created.map(row => row.id)
        }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/review-count', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await campaigns.reviewCount());
    } catch (error) { return sendError(res, error); }
  });

  /**
   * WHERE THE REVENUE ACTUALLY IS, at portfolio level.
   *
   * Literal before /:id, so Express never reads "opportunities" as a campaign
   * id, and declared literally in lib/route-policy.js for the same reason.
   *
   * campaigns.read, not campaigns.manage. It writes nothing, sends nothing,
   * creates no campaign and creates no draft: it counts customers and reports
   * what has already happened. A Support Agent who can see a segment can see
   * why it matters.
   *
   * `?refresh=true` recomputes from WooCommerce and Supabase rather than
   * serving the cached picture. It remains a read: the debounce inside the
   * service is what stops a held-down refresh control becoming a load test.
   *
   * Not audited, because nothing changes. See the same reasoning on
   * POST /copy-suggestions.
   */
  router.get('/opportunities', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const unknown = Object.keys(req.query || {}).filter(key => key !== 'refresh');
      if (unknown.length) {
        throw new CampaignRequestError(
          'The opportunity portfolio accepts refresh only. Every population, rate and figure in it '
          + 'is server-owned and cannot be supplied by a caller.',
          'CAMPAIGN_OPPORTUNITY_INPUT_REJECTED', 400
        );
      }
      const refresh = String(req.query?.refresh ?? '') === 'true';
      return res.json(await portfolio.current({ refresh }));
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

  // A DRAFTING AID. It returns candidate wording for a human to choose from
  // and edit. It creates nothing, submits nothing for review, approves
  // nothing, schedules nothing and sends nothing - a candidate becomes a
  // campaign only when somebody posts it to POST /api/campaigns, which is a
  // separate, audited action.
  //
  // Behind campaigns.manage, so Support Agents cannot reach it: the agent role
  // holds campaigns.read and nothing else in the campaign family.
  //
  // Deliberately not `audit: true`. That flag means "the handler writes an
  // audit row", and lib/route-policy.js records that asserting coverage the
  // code does not provide is worse than no flag at all. This handler mutates
  // nothing, so there is no state change to record; the campaign that
  // eventually carries this wording is audited at creation, with its message
  // fingerprint.
  /**
   * POST /check-copy — run the compliance rules over a message and say what,
   * if anything, is wrong with it.
   *
   * WHY THIS EXISTS. Every rule in copy-rules.js was enforced in exactly one
   * place: the AI drafting path. A message a person typed or edited reached
   * `rendered_message` with nothing checked but `char_length BETWEEN 1 AND
   * 1600`. So the 160-septet cap, the brand prefix, the exact opt-out suffix,
   * the compound names and the surveillance terms were all unenforced on the
   * text that actually ships.
   *
   * IT REPORTS, IT DOES NOT REFUSE. Editing stays possible and the operator is
   * told plainly what a change breaks. That is a deliberate choice: a hard
   * block on the edit screen is how somebody ends up sending from somewhere
   * else, and the drafting path still refuses outright.
   */
  router.post('/check-copy', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const text = typeof req.body?.message === 'string' ? req.body.message : '';
      if (!text.trim()) {
        return res.status(400).json({ error: 'A message is required.', code: 'MESSAGE_REQUIRED' });
      }
      if (text.length > 1600) {
        return res.status(400).json({ error: 'That message is too long to check.', code: 'MESSAGE_TOO_LONG' });
      }
      const verdict = validateCopy(text, {
        brandName: RULES.brand.defaultName,
        approvedProductCodes: RULES.defaultApprovedProductCodes
      });
      return res.json({
        ok: verdict.ok === true,
        septets: septetLength(text),
        maxSeptets: RULES.length.maxSeptets,
        // The validator's own words, unparaphrased. A restatement here is how
        // a rule quietly loosens.
        failures: (verdict.failures || []).map(failure => ({
          check: failure.check,
          reason: failure.reason,
          term: failure.detail?.term || null
        }))
      });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/copy-suggestions', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = copySuggestionRequest(req.body);
      const result = await drafter(input);
      // Rejected drafts leave this process as rule ids and reasons only. Their
      // text is never returned, so a reviewer cannot lift a draft that failed
      // validation out of a response body and paste it into a campaign.
      return res.json({
        workflowType: result.workflowType,
        brandName: result.brandName,
        requested: result.requested,
        returned: result.returned,
        candidates: result.candidates,
        rejected: result.rejected,
        model: result.model,
        copyStatus: result.copyStatus,
        reviewRequirements: result.reviewRequirements
      });
    } catch (error) {
      if (error instanceof CopyDraftError) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      return sendError(res, error);
    }
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

  /**
   * The actual messages, per person, before anything is approved or minted.
   *
   * WHY THIS EXISTS SEPARATELY FROM dry-run
   *   dry-run answers "who would this reach", which is about consent, quiet
   *   hours and suppression. This answers "what would they read", which until
   *   now nothing answered at all. A reviewer approving copy containing
   *   {{first_name}} was approving a template and had no way to see a single
   *   rendered message, which is how a campaign that renders for 216 of 376
   *   people looks identical on screen to one that renders for all of them.
   *
   * IT MINTS NOTHING. `dryRun: true` substitutes a placeholder code of the same
   *   shape and length as a real one, so validation and segment counts behave
   *   exactly as they will at approval, and WooCommerce is never touched. A
   *   preview that passed and a send that then failed on one extra character
   *   would be worse than having no preview.
   */
  router.post('/:id/preview', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const limit = Math.min(Math.max(Number(req.body?.limit) || 20, 1), 100);
      return res.json(await campaigns.preview(req.params.id, { limit }));
    } catch (error) { return sendError(res, error); }
  });

  /**
   * Remove a campaign from the list.
   *
   * DESTROY OR ARCHIVE IS NOT THE CALLER'S DECISION.
   *   A draft that was never submitted, never approved, never scheduled and
   *   whose recipients never reached a provider is somebody's abandoned
   *   experiment. It proves nothing and keeping it forever is clutter, so it
   *   is genuinely deleted.
   *
   *   Anything else is evidence. An approval row records who authorised a
   *   promotional send and against which frozen audience hash. A recipient
   *   with a provider message id is the only proof that a specific customer
   *   was messaged, and the revenue attribution chain hangs off it. Deleting
   *   those would destroy the answer to "did we have permission, and who
   *   said so?" That campaign is archived: it leaves the working list, the row
   *   stays, and `?archived=true` still finds it.
   *
   *   The body may ask for `mode: "archive"`. It may NOT ask for a delete.
   *   delete_sms_campaign has no force path, and it repeats every blocker
   *   check inside the transaction, so a campaign that gets approved between
   *   the preview below and the statement ends up archived rather than gone.
   *
   * AUDIT ORDER. The row is written BEFORE the destructive statement, with
   *   `logAudit` so a failed write refuses the delete outright. After the
   *   delete there is nothing left to describe. Over-recording an attempt that
   *   then failed is a bookkeeping error; under-recording a destruction that
   *   succeeded is a hole in the audit trail, and only one of those is
   *   recoverable.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const requestedMode = req.body?.mode === 'archive' ? 'archive' : 'auto';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
      const preview = await campaigns.deletionPreview(req.params.id);
      const willDelete = requestedMode !== 'archive' && preview.destructible === true;

      if (willDelete) {
        const proof = await deletionAuditWriter({
          eventType: 'campaign.deleted',
          req,
          entityId: preview.campaign.id,
          summary: `Deleted the unapproved draft ${campaignSummaryName(preview.campaign)}`,
          previousState: { status: preview.campaign.status, revision: preview.campaign.revision },
          metadata: {
            campaign_type: preview.campaign.campaign_type,
            workflow_category: preview.campaign.workflow_category,
            revision: preview.campaign.revision,
            reason
          },
          fingerprint: `campaign-deleted:${preview.campaign.id}`
        });
        if (!proof?.recorded && proof?.reason !== 'duplicate') {
          throw Object.assign(new Error('Campaign deletion audit was not recorded.'), {
            code: 'CAMPAIGN_DELETE_AUDIT_REQUIRED', status: 503
          });
        }
      }

      const result = await campaigns.remove(req.params.id, { mode: requestedMode, reason }, req.actor);

      if (result.outcome === 'archived') {
        await auditCampaign('campaign.archived', req, preview.campaign, {
          summary: `Archived ${campaignSummaryName(preview.campaign)}; it holds approval or delivery evidence and cannot be deleted`,
          previousState: { status: preview.campaign.status, archived: false },
          newState: { status: result.status, archived: true },
          metadata: {
            revision: preview.campaign.revision,
            requested_mode: requestedMode,
            blockers: result.blockers,
            reason
          },
          fingerprint: `campaign-archived:${preview.campaign.id}`
        });
      } else if (!willDelete) {
        // The preview said archive, the RPC destroyed it. That means the two
        // disagree about the rules, which is a bug worth shouting about rather
        // than a row worth writing quietly.
        console.error('[CAMPAIGNS] Deletion preview and delete_sms_campaign disagreed; the row is gone and unaudited.');
      }

      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createCampaignRouter;
module.exports.sendError = sendError;
