'use strict';
/**
 * routes/campaign-proposals.js — the review queue for campaign proposals.
 *
 * FIVE ENDPOINTS AND WHAT EACH ONE IS ALLOWED TO DO
 *   POST   /draft         draft proposals for one opportunity. Optionally
 *                         saves them. Writes no campaign, contacts nobody.
 *   GET    /              the queue.
 *   GET    /:id           one proposal, in full.
 *   POST   /:id/accept    creates an ORDINARY CAMPAIGN DRAFT and nothing else.
 *   POST   /:id/dismiss   discards it, with the reason, which is kept.
 *
 * There is no approve endpoint, no schedule endpoint and no send endpoint here
 * on purpose. Accepting a proposal hands the result to the existing campaign
 * lifecycle at its first state, `draft`, and every brake after that belongs to
 * routes/campaigns.js and the delivery gates, untouched by this file.
 *
 * WHY EVERY ENDPOINT IS campaigns.manage AND NOT campaigns.read
 *   Even the list. A proposal is unapproved copy aimed at a named cohort, with
 *   an offer sketched next to it. A Support Agent reading the queue would be
 *   reading marketing that nobody has signed off, and the obvious next thing a
 *   person does with a message on a screen is send it. See the same reasoning
 *   on the segment candidate picker in lib/route-policy.js.
 *
 * THE GUARD IS APPLIED HERE TOO
 *   `assertSurfaceable()` runs on every proposal on the way out of every read,
 *   not only on the way in. The writer checks, the service checks, and this
 *   file checks, so a row written by some future code path that skipped the
 *   validator still does not reach a screen.
 */

const express = require('express');
const { logAudit, logAuditSafely } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');
const { CampaignNotReadyError, CampaignRequestError } = require('../lib/campaigns/service');
const { ProposalDraftError, draftProposals } = require('../lib/campaigns/proposal-writer');
const { ProposalGuardError, isSurfaceable } = require('../lib/campaigns/proposal-guards');
const { createProposalService } = require('../lib/campaigns/proposal-service');

/**
 * Body keys accepted by POST /draft.
 *
 * Narrow, and enforced rather than filtered. There is no recipient here, no
 * phone, no contact id and no order: `lib/campaigns/opportunity-contract.js`
 * re-checks every field of the opportunity for identifier shapes and refuses
 * digits on everything that reaches a prompt.
 */
const DRAFT_BODY_KEYS = new Set([
  'opportunityId', 'opportunity', 'mechanismLimit', 'excludeMechanisms', 'linkUrl', 'commit'
]);

function sendError(res, error) {
  if (error instanceof CampaignNotReadyError) {
    return res.status(error.status || 503).json({ error: error.message, code: error.code });
  }
  if (
    error instanceof ProposalDraftError ||
    error instanceof ProposalGuardError ||
    error instanceof CampaignRequestError ||
    (error?.status && error?.code)
  ) {
    return res.status(error.status || 400).json({
      error: error.message,
      code: error.code || 'INVALID_PROPOSAL_REQUEST'
    });
  }
  console.error('[PROPOSALS] Request failed:', error?.code || 'internal_error');
  return res.status(500).json({
    error: 'The proposal request could not be completed.',
    code: 'PROPOSAL_REQUEST_FAILED'
  });
}

function draftRequest(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !DRAFT_BODY_KEYS.has(key));
  if (unknown.length) {
    throw new ProposalDraftError(
      `Proposal drafting accepts opportunity shape only; ${unknown.join(', ')} is not accepted. Recipient and customer evidence is server-owned.`,
      'CAMPAIGN_PROPOSALS_INPUT_REJECTED', 400
    );
  }
  if (input.commit !== undefined && typeof input.commit !== 'boolean') {
    throw new ProposalDraftError('commit must be a boolean.', 'CAMPAIGN_PROPOSALS_INPUT_REJECTED', 400);
  }
  return input;
}

/**
 * Only surfaceable proposals leave this process.
 *
 * A row that fails the guard is dropped from the response and logged, rather
 * than being shown with a warning. There is no version of "here is copy that
 * failed compliance, be careful" that is safe to put on a screen.
 */
function surfaceable(items, where) {
  const safe = [];
  let withheld = 0;
  for (const item of items) {
    if (isSurfaceable(item)) safe.push(item);
    else withheld += 1;
  }
  if (withheld) {
    console.error(`[PROPOSALS] Withheld ${withheld} stored proposal(s) from ${where}: copy did not pass validation.`);
  }
  return { items: safe, withheld };
}

function createCampaignProposalRouter({
  service,
  proposalDrafter,
  // Wired when the cohort opportunity detector exists. Until then a caller
  // supplies the opportunity in the body and every proposal is stamped
  // `client_supplied`, so an operator-typed count is never presented as a
  // measured one.
  opportunityReader,
  acceptAuditWriter,
  dismissAuditWriter
} = {}) {
  const proposals = service || createProposalService();
  const drafter = proposalDrafter || draftProposals;
  // Acceptance produces a campaign. The row must exist before the effect, so
  // this is logAudit and not logAuditSafely: no audit row, no campaign.
  const writeAcceptAudit = acceptAuditWriter || logAudit;
  const writeDismissAudit = dismissAuditWriter || logAuditSafely;
  const router = express.Router();

  router.post('/draft', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = draftRequest(req.body);

      let opportunity = null;
      let opportunitySource = 'detector';
      if (opportunityReader) {
        if (input.opportunity !== undefined) {
          throw new ProposalDraftError(
            'Opportunities are server-owned. Send opportunityId, not the opportunity itself.',
            'CAMPAIGN_PROPOSALS_INPUT_REJECTED', 400
          );
        }
        opportunity = await opportunityReader(String(input.opportunityId || ''));
        if (!opportunity) {
          throw new ProposalDraftError(
            'That opportunity was not found.', 'CAMPAIGN_PROPOSALS_OPPORTUNITY_NOT_FOUND', 404
          );
        }
      } else {
        if (!input.opportunity) {
          throw new ProposalDraftError(
            'No cohort opportunity detector is wired to this server yet, so an opportunity must be supplied with the request. Every proposal produced from one is marked client_supplied.',
            'CAMPAIGN_PROPOSALS_NO_DETECTOR', 400
          );
        }
        opportunity = input.opportunity;
        opportunitySource = 'client_supplied';
      }

      const result = await drafter({
        opportunity,
        opportunitySource,
        mechanismLimit: input.mechanismLimit,
        excludeMechanisms: input.excludeMechanisms,
        linkUrl: input.linkUrl
      });

      let saved = null;
      if (input.commit === true) {
        saved = await proposals.saveBatch(result.proposals, { model: result.model });
      }

      return res.json({
        opportunity: result.opportunity,
        opportunitySource: result.opportunitySource,
        schemaVersion: result.schemaVersion,
        catalogueVersion: result.catalogueVersion,
        requested: result.requested,
        returned: result.returned,
        proposals: result.proposals,
        // Refusals are rule identity only. Their draft text never leaves this
        // process, so a reviewer cannot lift a message that failed compliance
        // out of a response body and paste it into a campaign.
        refused: result.refused,
        model: result.model,
        committed: input.commit === true,
        saved: saved ? saved.saved.map(item => item.id) : [],
        skipped: saved ? saved.skipped : [],
        reviewRequirements: result.reviewRequirements
      });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const result = await proposals.list(req.query);
      const screened = surfaceable(result.items, 'the proposal queue');
      return res.json({ ...result, items: screened.items, withheld: screened.withheld });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const proposal = await proposals.get(req.params.id);
      if (!isSurfaceable(proposal)) {
        console.error('[PROPOSALS] Withheld a stored proposal: copy did not pass validation.');
        return res.status(409).json({
          error: 'This proposal cannot be shown: its copy does not pass the compliance validator.',
          code: 'PROPOSAL_COPY_REJECTED'
        });
      }
      return res.json({ proposal });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/accept', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const result = await proposals.accept(req.params.id, req.actor);

      // Keep the real writer call explicit: route-policy CI verifies that
      // every audit:true handler reaches an actual audit function.
      const auditInput = {
        eventType: 'campaign.proposal.accepted',
        req,
        entityId: result.proposal.id,
        summary: `Accepted the "${result.proposal.mechanismLabel}" proposal and created a campaign draft for ${result.recipientCount} recipients`,
        previousState: { status: 'proposed', created_campaign_id: null },
        newState: { status: 'accepted', created_campaign_id: result.campaign?.id || null },
        metadata: {
          proposal_id: result.proposal.id,
          opportunity_id: result.proposal.opportunityId,
          opportunity_kind: result.proposal.opportunityKind,
          mechanism: result.proposal.mechanism,
          offer_kind: result.proposal.offer?.kind || 'none',
          segment_key: result.proposal.segmentKey,
          campaign_id: result.campaign?.id || null,
          recipient_count: result.recipientCount,
          ...messageFingerprint(result.proposal.copy.text)
        },
        fingerprint: `campaign-proposal-accepted:${result.proposal.id}`
      };
      const proof = writeAcceptAudit === logAudit
        ? await logAudit(auditInput)
        : await writeAcceptAudit(auditInput);
      if (!proof?.recorded && proof?.reason !== 'duplicate') {
        throw Object.assign(new Error('Campaign proposal acceptance audit was not recorded.'), {
          code: 'PROPOSAL_ACCEPT_AUDIT_REQUIRED', status: 503
        });
      }

      return res.json({
        proposal: result.proposal,
        campaign: result.campaign,
        recipientCount: result.recipientCount,
        campaignStatus: result.campaignStatus,
        nextSteps: result.nextSteps
      });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/dismiss', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const proposal = await proposals.dismiss(req.params.id, req.body?.reason, req.actor);
      const auditInput = {
        eventType: 'campaign.proposal.dismissed',
        req,
        entityId: proposal.id,
        summary: `Dismissed the "${proposal.mechanismLabel}" proposal`,
        previousState: { status: 'proposed' },
        newState: { status: 'dismissed' },
        metadata: {
          proposal_id: proposal.id,
          opportunity_id: proposal.opportunityId,
          opportunity_kind: proposal.opportunityKind,
          mechanism: proposal.mechanism,
          offer_kind: proposal.offer?.kind || 'none',
          reason: proposal.dismissedReason
        },
        fingerprint: `campaign-proposal-dismissed:${proposal.id}`
      };
      // Keep the real writer call explicit: route-policy CI verifies that
      // every audit:true handler reaches an actual audit function, and it
      // cannot see through an injected alias. logAuditSafely, not logAudit:
      // the dismissal has already happened when this runs, and a failed audit
      // must not turn a recorded decision into a server error.
      if (writeDismissAudit === logAuditSafely) await logAuditSafely(auditInput);
      else await writeDismissAudit(auditInput);
      return res.json({ proposal });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createCampaignProposalRouter;
module.exports.sendError = sendError;
