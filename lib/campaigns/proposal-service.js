'use strict';
/**
 * lib/campaigns/proposal-service.js — storing campaign proposals, and the one
 * path by which an accepted proposal becomes an ordinary campaign draft.
 *
 * WHAT THIS FILE IS ALLOWED TO DO
 *   Insert, read, dismiss, accept. That is the whole surface. It does not
 *   submit for review, does not approve, does not schedule, does not send, and
 *   holds no provider client. An accepted proposal produces a campaign in
 *   `draft` through the SAME `create_sms_campaign_draft` path a person gets by
 *   typing one out by hand, and from that point onward it is subject to every
 *   existing brake without exception.
 *
 * THE ACCEPTANCE ORDER, WHICH IS DELIBERATE
 *   Claim first, then create.
 *
 *     1. compare-and-swap `proposed` -> `accepted`, matched on the status
 *     2. create the campaign draft
 *     3. attach the campaign id to the claimed row
 *
 *   Losing the swap means somebody else already accepted it, and the answer is
 *   a conflict rather than a second campaign. If step 2 fails the row is put
 *   back to `proposed` and the error is surfaced, so the worst case is a
 *   proposal that has to be accepted again. The alternative order — create the
 *   campaign, then record the acceptance — has a worst case of a campaign that
 *   exists with no human acceptance recorded against it, and that is the exact
 *   thing this feature is not allowed to produce.
 *
 * ON UPSERT AND DISMISSED ROWS
 *   Re-running generation for an opportunity refreshes rows that are still
 *   `proposed`. It must never resurrect one a human dismissed: a dismissal is
 *   a decision, and a detector that reappears every hour would otherwise
 *   overwrite it silently. `saveBatch()` therefore reads the existing keys
 *   first and skips anything already accepted or dismissed, reporting it as
 *   `skipped` rather than pretending it wrote.
 */

const { WORKSPACE_ID } = require('./eligibility');
const { CampaignNotReadyError, CampaignRequestError, createCampaignService } = require('./service');
const {
  ProposalGuardError,
  assertAudienceIsSaved,
  assertDismissalReason,
  assertHumanAcceptance,
  assertSurfaceable
} = require('./proposal-guards');

const PAGE_SIZE = 50;
const DB_PAGE_SIZE = 1000;
const MAX_SEGMENT_MEMBER_ROWS = 50_000;
/** One proposal per mechanism; the catalogue is a closed list of six. */
const MAX_BATCH = 25;
const SELECT_COLUMNS = '*';

function databaseError(error, fallback = 'PROPOSAL_DATABASE_ERROR') {
  if (!error) return null;
  // An unapplied migration is "not ready", never "broken". The same mapping
  // the campaign service uses, for the same reason: PostgREST reports a
  // missing relation as a client error and it must not read as a bug.
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return new CampaignNotReadyError();
  if (error.code === '23505') {
    return new CampaignRequestError('This proposal changed while it was being saved.', 'PROPOSAL_STATE_CONFLICT', 409);
  }
  if (error.code === '23514') {
    return new CampaignRequestError(
      'The database refused this proposal state. A dismissal needs a reason and an acceptance needs a person.',
      'PROPOSAL_STATE_REJECTED', 409
    );
  }
  return Object.assign(new Error(error.message || 'Proposal database operation failed.'), { code: fallback });
}

function actorID(actor) {
  const parsed = Number(actor?.id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Row -> the shape every reader of this module sees. */
function shapeProposal(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    proposalKey: row.proposal_key,
    opportunityId: row.opportunity_id,
    opportunityKind: row.opportunity_kind,
    opportunityTitle: row.opportunity_title,
    opportunitySource: row.opportunity_source || 'detector',
    mechanism: row.mechanism,
    mechanismLabel: row.mechanism_label,
    distinctnessClass: row.distinctness_class,
    title: row.title,
    audience: row.audience || {},
    segmentKey: row.segment_key || null,
    offer: row.offer || {},
    copy: {
      text: row.copy_text,
      septets: row.copy_septets,
      // Persisted only after passing the validator, so a stored row is a
      // validated row. Said explicitly rather than implied, because
      // assertSurfaceable() reads this field and a silent default of
      // `undefined` would make every stored proposal unsurfaceable.
      validated: true,
      failedChecks: [],
      copyRulesVersion: row.copy_rules_version
    },
    reasoning: row.reasoning || {},
    costs: Array.isArray(row.costs) ? row.costs : [],
    risks: Array.isArray(row.risks) ? row.risks : [],
    projections: Array.isArray(row.projections) ? row.projections : [],
    schemaVersion: row.schema_version,
    catalogueVersion: row.catalogue_version,
    contractVersion: row.contract_version,
    model: row.model || null,
    status: row.status,
    acceptedAt: row.accepted_at || null,
    acceptedBy: row.accepted_by ?? null,
    createdCampaignId: row.created_campaign_id || null,
    dismissedAt: row.dismissed_at || null,
    dismissedBy: row.dismissed_by ?? null,
    dismissedReason: row.dismissed_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** The drafted proposal -> the row. Nothing is derived from client input. */
function toRow(proposal, workspaceID, model) {
  return {
    workspace_id: workspaceID,
    proposal_key: proposal.proposalKey,
    opportunity_id: proposal.opportunityId,
    opportunity_kind: proposal.opportunityKind,
    opportunity_title: proposal.opportunityTitle,
    opportunity_source: proposal.opportunitySource === 'client_supplied' ? 'client_supplied' : 'detector',
    mechanism: proposal.mechanism,
    mechanism_label: proposal.mechanismLabel,
    distinctness_class: proposal.distinctnessClass,
    title: String(proposal.title).slice(0, 300),
    audience: proposal.audience || {},
    segment_key: proposal.audience?.segmentKey || null,
    offer: proposal.offer || {},
    copy_text: proposal.copy.text,
    copy_septets: proposal.copy.septets,
    copy_rules_version: proposal.copy.copyRulesVersion,
    reasoning: proposal.reasoning || {},
    costs: proposal.costs || [],
    risks: proposal.risks || [],
    projections: proposal.projections || [],
    schema_version: proposal.schemaVersion,
    catalogue_version: proposal.catalogueVersion,
    contract_version: proposal.contractVersion,
    model: model || null,
    status: 'proposed',
    updated_at: new Date().toISOString()
  };
}

function createProposalService({
  client,
  workspaceID = WORKSPACE_ID,
  campaignService,
  segmentMemberReader
} = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }
  let campaigns = campaignService || null;
  function campaignsService() {
    if (!campaigns) campaigns = createCampaignService({ client: injected, workspaceID });
    return campaigns;
  }

  /**
   * Persist a batch of drafted proposals.
   *
   * Every proposal is re-checked with `assertSurfaceable()` before it can
   * reach an INSERT. The writer already checked; checking again here means a
   * future caller that assembles a proposal by some other route still cannot
   * store one whose copy failed validation.
   */
  async function saveBatch(proposals, { model = null } = {}) {
    const list = Array.isArray(proposals) ? proposals : [];
    if (!list.length) return { saved: [], skipped: [] };
    for (const proposal of list) assertSurfaceable(proposal);

    const keys = list.map(proposal => proposal.proposalKey);
    if (keys.length > MAX_BATCH) {
      throw new CampaignRequestError('Too many proposals in one batch.', 'PROPOSAL_BATCH_TOO_LARGE', 400);
    }
    const { data: existingRows, error: existingError } = await db()
      .from('sms_campaign_proposals')
      .select('proposal_key,status')
      .eq('workspace_id', workspaceID)
      // One key per mechanism. The mechanism catalogue is a closed literal of
      // six and the MAX_BATCH throw above turns that into an enforced ceiling
      // rather than a belief, so bounded: this list cannot grow with the
      // customer list the way the one that took the inbox down did.
      .in('proposal_key', keys);
    if (existingError) throw databaseError(existingError, 'PROPOSAL_LOAD_FAILED');

    const decided = new Map((existingRows || [])
      .filter(row => row.status !== 'proposed')
      .map(row => [row.proposal_key, row.status]));

    const writable = [];
    const skipped = [];
    for (const proposal of list) {
      const status = decided.get(proposal.proposalKey);
      if (status) {
        // A human already decided this one. Regenerating must not undo that.
        skipped.push({ proposalKey: proposal.proposalKey, reason: `already_${status}` });
        continue;
      }
      writable.push(toRow(proposal, workspaceID, model));
    }
    if (!writable.length) return { saved: [], skipped };

    const { data, error } = await db()
      .from('sms_campaign_proposals')
      .upsert(writable, { onConflict: 'workspace_id,proposal_key' })
      .select(SELECT_COLUMNS);
    if (error) throw databaseError(error, 'PROPOSAL_SAVE_FAILED');
    return { saved: (data || []).map(shapeProposal), skipped };
  }

  async function list({ page = 1, pageSize = PAGE_SIZE, status, opportunityId } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || PAGE_SIZE));
    let query = db().from('sms_campaign_proposals')
      .select(SELECT_COLUMNS, { count: 'exact' })
      .eq('workspace_id', workspaceID)
      .order('created_at', { ascending: false })
      .range((safePage - 1) * safeSize, safePage * safeSize - 1);
    if (status) query = query.eq('status', String(status));
    if (opportunityId) query = query.eq('opportunity_id', String(opportunityId));
    const { data, error, count } = await query;
    if (error) throw databaseError(error, 'PROPOSAL_LIST_FAILED');
    return {
      items: (data || []).map(shapeProposal),
      page: safePage,
      pageSize: safeSize,
      total: count || 0
    };
  }

  async function load(id) {
    const { data, error } = await db().from('sms_campaign_proposals')
      .select(SELECT_COLUMNS)
      .eq('id', id).eq('workspace_id', workspaceID).maybeSingle();
    if (error) throw databaseError(error, 'PROPOSAL_LOAD_FAILED');
    if (!data) throw new CampaignRequestError('Proposal not found.', 'PROPOSAL_NOT_FOUND', 404);
    return shapeProposal(data);
  }

  async function get(id) {
    return load(id);
  }

  /**
   * Discard a proposal, with the reason.
   *
   * The reason is required by `assertDismissalReason()` here and by a CHECK
   * constraint in the table. Two enforcements of one rule, because this one is
   * the loop's only training signal and losing it is silent.
   */
  async function dismiss(id, reason, actor) {
    const cleanReason = assertDismissalReason(reason);
    const who = actorID(actor);
    if (!who) {
      throw new ProposalGuardError(
        'Dismissing a proposal requires a named, signed-in person.',
        'PROPOSAL_ACTOR_REQUIRED', 403
      );
    }
    const { data, error } = await db().from('sms_campaign_proposals')
      .update({
        status: 'dismissed',
        dismissed_at: new Date().toISOString(),
        dismissed_by: who,
        dismissed_reason: cleanReason
      })
      .eq('id', id).eq('workspace_id', workspaceID)
      .eq('status', 'proposed')       // compare-and-swap: bounded, fixed state
      .select(SELECT_COLUMNS).maybeSingle();
    if (error) throw databaseError(error, 'PROPOSAL_DISMISS_FAILED');
    if (!data) {
      // Either it is gone or somebody already decided it. Load to say which,
      // rather than reporting "not found" for a proposal sitting on screen.
      const current = await load(id);
      throw new ProposalGuardError(
        `This proposal is ${current.status} and can no longer be dismissed.`,
        'PROPOSAL_NOT_OPEN', 409
      );
    }
    return shapeProposal(data);
  }

  /**
   * Resolve the recipients behind a proposal's saved segment.
   *
   * Reads membership as it stands now. It does not recompute, does not add
   * anybody, and does not decide whether any of these people may lawfully be
   * messaged: eligibility, consent, DND, STOP, quiet hours and cadence are all
   * applied by the existing approval and delivery path, on the campaign, later.
   * A proposal that resolves to nobody is refused rather than turned into an
   * empty campaign.
   */
  async function resolveSegmentRecipients(segmentKey) {
    if (segmentMemberReader) return segmentMemberReader(segmentKey);

    const { data: segment, error: segmentError } = await db()
      .from('sms_campaign_segments')
      .select('id,segment_key,name,archived_at')
      .eq('workspace_id', workspaceID).eq('segment_key', segmentKey).maybeSingle();
    if (segmentError) throw databaseError(segmentError, 'PROPOSAL_SEGMENT_LOAD_FAILED');
    if (!segment) {
      throw new CampaignRequestError(
        `The segment "${segmentKey}" this proposal targets no longer exists.`,
        'PROPOSAL_SEGMENT_NOT_FOUND', 409
      );
    }
    if (segment.archived_at) {
      throw new CampaignRequestError(
        `The segment "${segmentKey}" this proposal targets has been archived.`,
        'PROPOSAL_SEGMENT_ARCHIVED', 409
      );
    }

    const rows = [];
    for (let from = 0; from < MAX_SEGMENT_MEMBER_ROWS; from += DB_PAGE_SIZE) {
      const { data, error } = await db().from('sms_campaign_segment_members')
        .select('contact_phone,contact_id,contact_name_snapshot')
        .eq('segment_id', segment.id).eq('workspace_id', workspaceID)
        .order('contact_phone', { ascending: true })
        .range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw databaseError(error, 'PROPOSAL_SEGMENT_MEMBERS_FAILED');
      rows.push(...(data || []));
      if (!data || data.length < DB_PAGE_SIZE) break;
      if (from + DB_PAGE_SIZE >= MAX_SEGMENT_MEMBER_ROWS) {
        throw new CampaignRequestError(
          'That segment exceeded the safe row ceiling for a campaign draft.',
          'PROPOSAL_SEGMENT_TOO_LARGE', 409
        );
      }
    }
    return {
      segment: { id: segment.id, key: segment.segment_key, name: segment.name },
      recipients: rows.map(row => ({
        phone: row.contact_phone,
        contactId: row.contact_id ?? undefined,
        name: row.contact_name_snapshot || undefined,
        reason: { source: 'campaign_proposal', segment_key: segmentKey }
      }))
    };
  }

  /**
   * Accept a proposal: create an ordinary campaign DRAFT from it.
   *
   * Nothing about this schedules, approves or sends. The created campaign
   * enters at `draft` and needs submit, review, approval, an unarchived
   * segment, evidenced consent, provider approval and both live-send brakes
   * before a single message exists. Accepting is the human saying "this is
   * worth working on", not "send it".
   */
  async function accept(id, actor) {
    const proposal = await load(id);
    assertHumanAcceptance(proposal, actor);
    assertAudienceIsSaved(proposal);
    const who = actorID(actor);

    const { segment, recipients } = await resolveSegmentRecipients(proposal.segmentKey);
    if (!recipients.length) {
      throw new CampaignRequestError(
        `The segment "${segment.name}" behind this proposal currently has no members, so there is nothing to draft a campaign for.`,
        'PROPOSAL_SEGMENT_EMPTY', 409
      );
    }

    // 1. CLAIM. Compare-and-swap on the status. Losing this is a conflict, not
    //    a second campaign.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await db().from('sms_campaign_proposals')
      .update({ status: 'accepted', accepted_at: claimedAt, accepted_by: who })
      .eq('id', id).eq('workspace_id', workspaceID)
      .eq('status', 'proposed')       // compare-and-swap: bounded, fixed state
      .select(SELECT_COLUMNS).maybeSingle();
    if (claimError) throw databaseError(claimError, 'PROPOSAL_ACCEPT_FAILED');
    if (!claimed) {
      const current = await load(id);
      throw new ProposalGuardError(
        `This proposal is ${current.status} and can no longer be accepted.`,
        'PROPOSAL_NOT_OPEN', 409
      );
    }

    // 2. CREATE THE DRAFT, through the ordinary path.
    let created;
    try {
      created = await campaignsService().create({
        title: proposal.title.slice(0, 160),
        message: proposal.copy.text,
        workflowCategory: 'proposal',
        recipients
      }, actor);
    } catch (error) {
      // 3a. Put it back. A proposal that has to be accepted twice is a much
      //     better failure than a campaign nobody accepted.
      const { error: revertError } = await db().from('sms_campaign_proposals')
        .update({ status: 'proposed', accepted_at: null, accepted_by: null })
        .eq('id', id).eq('workspace_id', workspaceID)
        .eq('status', 'accepted')     // compare-and-swap: bounded, fixed state
        .is('created_campaign_id', null);
      if (revertError) {
        console.error('[PROPOSALS] Accept failed and the claim could not be released:', revertError.code || 'unknown');
      }
      throw error;
    }

    // 3b. Attach the campaign. The CHECK constraint refuses this on any row
    //     that is not accepted, so the link cannot exist without the decision.
    const { data: linked, error: linkError } = await db().from('sms_campaign_proposals')
      .update({ created_campaign_id: created.campaign.id })
      .eq('id', id).eq('workspace_id', workspaceID)
      .eq('status', 'accepted')       // compare-and-swap: bounded, fixed state
      .select(SELECT_COLUMNS).maybeSingle();
    if (linkError) throw databaseError(linkError, 'PROPOSAL_LINK_FAILED');

    return {
      proposal: shapeProposal(linked || claimed),
      campaign: created.campaign,
      recipientCount: created.recipientCount,
      segment,
      // Said in the payload because a client that forgets to say it presents a
      // draft as a decision.
      campaignStatus: created.campaign?.status || 'draft',
      nextSteps: [
        'review_and_edit_the_message',
        'attach_any_offer_terms_in_the_store_first',
        'submit_for_review',
        'approval_and_delivery_remain_separately_gated'
      ]
    };
  }

  return { accept, dismiss, get, list, saveBatch, resolveSegmentRecipients };
}

module.exports = {
  PAGE_SIZE,
  createProposalService,
  shapeProposal,
  toRow
};
