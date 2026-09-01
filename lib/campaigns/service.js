'use strict';

const crypto = require('node:crypto');
const { normalisePhone } = require('../phone');
const { estimateCampaignCost } = require('./cost');
const { campaignOperationalMetrics } = require('./analytics');
const {
  WORKSPACE_ID,
  activeSuppressionReason,
  campaignLiveSendEligibility,
  evaluateRecipient,
  loadCampaignSettings
} = require('./eligibility');
const { fieldsUsed } = require('./merge-fields');
const { personaliseCampaign } = require('./personalise');
const { campaignCouponRedemptions } = require('./coupon-attribution');
const { filterEligibleForCode } = require('./code-budget');

const PAGE_SIZE = 100;
const DB_PAGE_SIZE = 1000;
const INSERT_CHUNK_SIZE = 200;
const MAX_TITLE_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 1600;
const MUTABLE_STATUSES = new Set(['draft', 'rejected']);

/**
 * What a {{code}} is worth when the campaign did not say.
 *
 * Deliberately the low end. A campaign that forgot to state its discount and
 * silently mints a generous one costs real margin on every redemption, and the
 * mistake is invisible until the WooCommerce reports come in. Fifteen is the
 * figure the win-back was sized on.
 */
const DEFAULT_DISCOUNT_PERCENT = 15;

class CampaignRequestError extends Error {
  constructor(message, code = 'INVALID_CAMPAIGN_REQUEST', status = 400) {
    super(message);
    this.name = 'CampaignRequestError';
    this.code = code;
    this.status = status;
  }
}

class CampaignNotReadyError extends Error {
  constructor(message = 'Campaigns are unavailable until the additive database migration is applied.') {
    super(message);
    this.name = 'CampaignNotReadyError';
    this.code = 'CAMPAIGNS_NOT_READY';
    this.status = 503;
  }
}

function databaseError(error, fallback = 'CAMPAIGN_DATABASE_ERROR') {
  if (!error) return null;
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return new CampaignNotReadyError();
  if (error.code === 'P0002') return new CampaignRequestError('Campaign not found.', 'CAMPAIGN_NOT_FOUND', 404);
  if (error.code === 'P0001' || error.code === '23505') {
    return new CampaignRequestError('Campaign state changed; reload and try again.', 'CAMPAIGN_STATE_CONFLICT', 409);
  }
  return Object.assign(new Error(error.message || 'Campaign database operation failed.'), { code: fallback });
}

function textField(value, name, maxLength) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new CampaignRequestError(`${name} is required.`);
  if (result.length > maxLength) throw new CampaignRequestError(`${name} is too long.`);
  return result;
}

function normaliseAudience(input) {
  if (!Array.isArray(input)) throw new CampaignRequestError('recipients must be an array.');
  const byPhone = new Map();
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item?.phone;
    const phone = normalisePhone(raw);
    if (!phone) throw new CampaignRequestError(`Invalid recipient phone: ${String(raw || '')}`);
    if (!byPhone.has(phone)) {
      byPhone.set(phone, {
        contact_phone: phone,
        contact_id: Number.isSafeInteger(Number(item?.contactId)) && Number(item.contactId) > 0
          ? Number(item.contactId) : null,
        contact_name_snapshot: typeof item?.name === 'string' ? item.name.trim().slice(0, 200) || null : null,
        inclusion_reason: item?.reason && typeof item.reason === 'object' ? item.reason : { source: 'manual' }
      });
    }
  }
  return [...byPhone.values()];
}

function stableHash(value) {
  const stable = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value;
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function audienceHash(rows) {
  return stableHash((rows || [])
    .filter(row => row.selected !== false)
    .map(row => normalisePhone(row.contact_phone))
    .filter(Boolean)
    .sort());
}

function messageHash(message) {
  return crypto.createHash('sha256').update(String(message || '')).digest('hex');
}

function actorID(actor) {
  const parsed = Number(actor?.id);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function approvalRetryMatches(campaign, approval, hashes) {
  return Boolean(
    campaign?.status === 'approval_pending' &&
    campaign.approval_audit_recorded_at == null &&
    approval?.decision === 'approved' &&
    Number(approval.revision) === Number(campaign.revision) &&
    approval.audience_hash === hashes.audienceHash &&
    approval.message_hash === hashes.messageHash
  );
}

/**
 * Normalise the `archived` list filter. Default is the working list.
 *
 *   undefined / 'false' / false -> 'live'      only unarchived campaigns
 *   'true' / true               -> 'archived'  only archived campaigns
 *   'all'                       -> 'all'       everything
 */
function archivedFilter(value) {
  if (value === undefined || value === null || value === '') return 'live';
  const text = String(value).toLowerCase();
  if (text === 'all') return 'all';
  if (text === 'true' || text === '1' || text === 'yes') return 'archived';
  return 'live';
}

/**
 * The campaign-row half of "may this be destroyed?".
 *
 * Deliberately NOT the whole answer. It reads only the campaign row, so it
 * cannot see recipient provider state, approval rows, ledger entries or
 * attribution. delete_sms_campaign checks all of those inside the transaction
 * and is the authority. This exists so the route can describe the likely
 * outcome in its audit row before the statement runs, and so an obviously
 * undestroyable campaign is refused without a round trip.
 *
 * Any doubt resolves to false. A campaign wrongly archived is an inconvenience.
 * A campaign wrongly destroyed is evidence that no longer exists.
 */
function campaignLooksDestructible(campaign) {
  if (!campaign || campaign.status !== 'draft') return false;
  if (campaign.archived_at) return false;
  return [
    'approved_at', 'approval_audit_recorded_at', 'scheduled_for',
    'submitted_for_review_at', 'completed_at', 'rejected_at', 'cancelled_at'
  ].every(column => campaign[column] === null || campaign[column] === undefined);
}

function campaignMaySchedulePreview(preview) {
  return Number(preview?.eligible || 0) > 0;
}

function singleRPCRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

async function fetchCampaignRecipients(client, campaignID, workspaceID = WORKSPACE_ID) {
  const rows = [];
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await client
      .from('sms_campaign_recipients')
      .select('*')
      .eq('campaign_id', campaignID)
      .eq('workspace_id', workspaceID)
      .order('created_at', { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw databaseError(error, 'CAMPAIGN_RECIPIENT_LOAD_FAILED');
    rows.push(...(data || []));
    if (!data || data.length < DB_PAGE_SIZE) return rows;
  }
}

async function fetchCampaignRecipientEvents(client, campaignID, workspaceID = WORKSPACE_ID, maxRows = 50000) {
  const rows = [];
  for (let from = 0; from < maxRows; from += DB_PAGE_SIZE) {
    const { data, error } = await client
      .from('sms_campaign_recipient_events')
      .select('id,recipient_id,event_type,occurred_at,reason_code,provider,provider_event_id,provider_message_id,trusted,trust_source,metadata,dedupe_key')
      .eq('campaign_id', campaignID)
      .eq('workspace_id', workspaceID)
      .order('occurred_at', { ascending: true })
      .range(from, Math.min(from + DB_PAGE_SIZE - 1, maxRows - 1));
    if (error) throw databaseError(error, 'CAMPAIGN_EVENTS_LOAD_FAILED');
    rows.push(...(data || []));
    if (!data || data.length < DB_PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function loadCampaign(client, id, workspaceID = WORKSPACE_ID) {
  const { data, error } = await client.from('sms_campaigns').select('*')
    .eq('id', id).eq('workspace_id', workspaceID).maybeSingle();
  if (error) throw databaseError(error, 'CAMPAIGN_LOAD_FAILED');
  if (!data) throw new CampaignRequestError('Campaign not found.', 'CAMPAIGN_NOT_FOUND', 404);
  return data;
}

async function loadDryRunEvidence(client, phones, workspaceID) {
  const contacts = [];
  const consents = [];
  const sentinels = [];
  const suppressions = [];
  for (let i = 0; i < phones.length; i += INSERT_CHUNK_SIZE) {
    const chunk = phones.slice(i, i + INSERT_CHUNK_SIZE);
    // bounded: chunk is capped at INSERT_CHUNK_SIZE (200), below URL limits.
    const contactQuery = client.from('sms_contacts')
      .select('phone, opted_out, ghl_dnd, ghl_sms_dnd_status, ghl_dnd_synced_at').in('phone', chunk);
    // bounded: chunk is capped at INSERT_CHUNK_SIZE (200), below URL limits.
    const consentQuery = client.from('sms_consent_events').select('id, contact_phone, event_type, source, evidence_ref, purpose, brand_id, occurred_at')
      .eq('workspace_id', workspaceID).eq('brand_id', workspaceID)
      .eq('purpose', 'promotional_sms').in('contact_phone', chunk);
    // bounded: chunk is capped at INSERT_CHUNK_SIZE (200), below URL limits.
    const sentinelQuery = client.from('sms_sent_log').select('phone').eq('flow_type', 'opted-out').in('phone', chunk);
    // bounded: chunk is capped at INSERT_CHUNK_SIZE (200), below URL limits.
    const suppressionQuery = client.from('sms_campaign_suppressions')
      .select('contact_phone, reason_code, active, effective_at, expires_at')
      .eq('workspace_id', workspaceID).eq('active', true).in('contact_phone', chunk);
    const [contactResult, consentResult, sentinelResult, suppressionResult] = await Promise.all([
      contactQuery, consentQuery, sentinelQuery, suppressionQuery
    ]);
    const error = contactResult.error || consentResult.error || sentinelResult.error || suppressionResult.error;
    if (error) throw databaseError(error, 'CAMPAIGN_ELIGIBILITY_LOAD_FAILED');
    contacts.push(...(contactResult.data || []));
    consents.push(...(consentResult.data || []));
    sentinels.push(...(sentinelResult.data || []));
    suppressions.push(...(suppressionResult.data || []));
  }
  return { contacts, consents, sentinels, suppressions };
}

/**
 * The memorable code a campaign uses, if its recipe defined one.
 *
 * Read from audience_definition, which is where buildFromRecipe records what
 * the campaign was built from. A campaign with no recipe gets a generated
 * code, exactly as before.
 */
/**
 * The discount a campaign actually offers.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT JUST `campaign.discount_percent`
 *
 *   It was, and the column is NULL for every campaign built from a recipe:
 *   create_sms_campaign_draft records the recipe's discount in
 *   audience_definition and never writes the column. So approval read null,
 *   fell back to 15, and minted a 15% coupon for a campaign whose message
 *   says 20% off.
 *
 *   Three places held the answer and the emptiest one won. The same shape as
 *   every other bug in this subsystem.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/** Whether this campaign's recipe asked for an unrestricted code. */
function campaignPublicCode(campaign) {
  const key = campaign?.audience_definition?.recipe;
  if (!key) return false;
  const { recipe } = require('./recipes');
  return recipe(key)?.publicCode === true;
}

function campaignDiscountPercent(campaign) {
  const column = Number(campaign?.discount_percent);
  if (Number.isFinite(column) && column > 0) return column;
  const fromRecipe = Number(campaign?.audience_definition?.discount_percent);
  if (Number.isFinite(fromRecipe) && fromRecipe > 0) return fromRecipe;
  return DEFAULT_DISCOUNT_PERCENT;
}

/**
 * Refuse to mint a coupon that disagrees with the message.
 *
 * The message is the promise. "Here's a code for 20% off your next order" is
 * a commitment made to 376 people, and a coupon worth anything else makes the
 * business a liar at the checkout, one customer at a time, with no error
 * anywhere.
 *
 * So the percentage is read back OUT of the copy that will actually be sent
 * and compared with the one about to be created. A campaign that states no
 * percentage is left alone; a campaign that states one must honour it.
 */
function assertDiscountMatchesMessage(message, percentOff) {
  const stated = String(message || '').match(/(\d{1,2})\s*%/);
  if (!stated) return;
  const promised = Number(stated[1]);
  if (!Number.isFinite(promised) || promised === Number(percentOff)) return;
  throw new CampaignRequestError(
    `This message promises ${promised}% but the coupon would be worth ${percentOff}%. `
    + 'Nothing was created. Fix the message or the campaign discount so they agree.',
    'CAMPAIGN_DISCOUNT_MISMATCH', 409
  );
}

function campaignCouponCode(campaign) {
  const key = campaign?.audience_definition?.recipe;
  if (!key) return null;
  const { recipe } = require('./recipes');
  return recipe(key)?.couponCode || null;
}

function createCampaignService({ client, env = process.env, workspaceID = WORKSPACE_ID } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }

  async function list({ page = 1, pageSize = PAGE_SIZE, status, archived } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || 25));
    let query = db().from('sms_campaigns').select('*', { count: 'exact' })
      .eq('workspace_id', workspaceID).order('created_at', { ascending: false })
      .range((safePage - 1) * safeSize, safePage * safeSize - 1);
    if (status) query = query.eq('status', String(status));
    // Archived campaigns leave the working list but are never destroyed. The
    // caller has to ask for them explicitly, which is the whole point of
    // archiving something rather than deleting it.
    const wanted = archivedFilter(archived);
    if (wanted === 'live') query = query.is('archived_at', null);
    else if (wanted === 'archived') query = query.not('archived_at', 'is', null);
    const { data, error, count } = await query;
    if (error) throw databaseError(error, 'CAMPAIGN_LIST_FAILED');
    return {
      items: data || [], page: safePage, pageSize: safeSize, total: count || 0, archived: wanted
    };
  }

  /**
   * Delete a draft that never mattered, or archive anything that did.
   *
   * The decision is made in SQL, inside the same transaction that acts on it,
   * because the blockers are rows in six other tables and a check performed
   * here would be a read that a concurrent approval could invalidate before
   * the delete ran. The RPC has no force-delete mode: a caller cannot ask for
   * the destructive path, only accept it.
   */
  async function remove(id, { mode = 'auto', reason } = {}, actor) {
    const requestedMode = mode === 'archive' ? 'archive' : 'auto';
    const { data, error } = await db().rpc('delete_sms_campaign', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: actorID(actor),
      p_mode: requestedMode,
      p_reason: typeof reason === 'string' ? reason.slice(0, 500) : null
    });
    if (error) throw databaseError(error, 'CAMPAIGN_DELETE_FAILED');
    const result = singleRPCRow(data);
    if (!result) {
      throw new CampaignRequestError('Campaign deletion returned no result.', 'CAMPAIGN_DELETE_FAILED', 500);
    }
    return {
      outcome: result.outcome,
      campaignId: String(result.campaignId || id),
      blockers: Array.isArray(result.blockers) ? result.blockers : [],
      title: result.title || null,
      status: result.status || null,
      recipientsRemoved: Number(result.recipientsRemoved || 0)
    };
  }

  /**
   * Pre-flight the same decision without acting, so the route can write an
   * accurate audit row BEFORE the destructive statement runs. The RPC repeats
   * every check transactionally, so a race between this read and that write
   * ends in an archive, never in a wrong delete.
   */
  async function deletionPreview(id) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    return { campaign, destructible: campaignLooksDestructible(campaign) };
  }

  async function reviewCount() {
    const { count, error } = await db().from('sms_campaigns').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceID).eq('status', 'review_required');
    if (error) throw databaseError(error, 'CAMPAIGN_REVIEW_COUNT_FAILED');
    return { count: count || 0 };
  }

  async function detail(id) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    // Approval rows have no independent workspace column; campaign_id is a
    // foreign key to the already workspace-verified campaign above.
    const { data: approval, error } = await db().from('sms_campaign_approvals').select('*')
      .eq('campaign_id', id).order('decided_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw databaseError(error, 'CAMPAIGN_APPROVAL_LOAD_FAILED');
    return { campaign, latestApproval: approval || null };
  }

  async function recipients(id, { page = 1, pageSize = PAGE_SIZE } = {}) {
    await loadCampaign(db(), id, workspaceID);
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || 50));
    const { data, error, count } = await db().from('sms_campaign_recipients')
      .select('id, contact_id, contact_phone, contact_name_snapshot, selected, inclusion_reason, state, suppression_reason, planned_send_at, provider_status, sent_at, delivered_at, failed_at', { count: 'exact' })
      .eq('campaign_id', id).eq('workspace_id', workspaceID).order('created_at', { ascending: true })
      .range((safePage - 1) * safeSize, safePage * safeSize - 1);
    if (error) throw databaseError(error, 'CAMPAIGN_RECIPIENT_LOAD_FAILED');
    return { items: data || [], page: safePage, pageSize: safeSize, total: count || 0 };
  }

  async function performance(id) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    const [recipientRows, eventResult, coupons] = await Promise.all([
      fetchCampaignRecipients(db(), id, workspaceID),
      fetchCampaignRecipientEvents(db(), id, workspaceID),
      // Never fatal. A campaign's delivery numbers must still render on a
      // database where scripts/coupon-attribution-migration.sql has not been
      // applied, and an unavailable revenue figure has to read as unavailable
      // rather than as zero.
      campaignCouponRedemptions({ client: db(), campaignID: id, workspaceID })
        .catch(error => ({ available: false, reason: 'coupon_read_failed', error: error.message }))
    ]);
    return {
      campaign: {
        id: String(campaign.id),
        title: campaign.title,
        status: campaign.status,
        campaignType: campaign.campaign_type,
        workflowCategory: campaign.workflow_category,
        revision: campaign.revision,
        createdAt: campaign.created_at,
        scheduledFor: campaign.scheduled_for || null,
        completedAt: campaign.completed_at || null
      },
      operational: campaignOperationalMetrics(recipientRows, eventResult.rows),
      // Redeemed per-person codes and the revenue behind them. This is
      // measured, not modelled: every figure traces to a specific code on a
      // specific paid order. A campaign that offered nothing reports issued: 0
      // rather than pretending to a revenue number it cannot have.
      coupons,
      availability: {
        operational: true,
        financial: false,
        couponRevenue: coupons?.available === true
      },
      warnings: eventResult.truncated ? [{
        code: 'CAMPAIGN_EVENTS_TRUNCATED',
        message: 'Campaign event history reached the 50,000-row safety ceiling.'
      }] : []
    };
  }

  async function create(input, actor) {
    const settings = await loadCampaignSettings(db(), workspaceID);
    if (!settings) throw new CampaignNotReadyError();
    if (settings.drafts_enabled !== true) {
      throw new CampaignRequestError('Campaign drafting is disabled.', 'CAMPAIGN_DRAFTING_DISABLED', 409);
    }
    const title = textField(input?.title, 'title', MAX_TITLE_LENGTH);
    const proposedMessage = textField(input?.message, 'message', MAX_MESSAGE_LENGTH);
    const audience = normaliseAudience(input?.recipients);
    if (!audience.length) throw new CampaignRequestError('At least one recipient is required.');
    const limit = settings.max_recipients_per_campaign || 10000;
    if (audience.length > limit) throw new CampaignRequestError(`Audience exceeds the ${limit}-recipient limit.`);

    const { data: campaign, error } = await db().rpc('create_sms_campaign_draft', {
      p_workspace_id: workspaceID,
      p_campaign_type: 'manual',
      p_workflow_category: String(input?.workflowCategory || 'manual').slice(0, 64),
      p_title: title,
      p_message: proposedMessage,
      p_audience_definition: { kind: 'manual', requested_count: audience.length },
      p_recipients: audience,
      p_actor_user_id: actorID(actor)
    });
    if (error) throw databaseError(error, 'CAMPAIGN_CREATE_FAILED');
    const created = singleRPCRow(campaign);
    if (!created) throw new CampaignRequestError('Campaign draft was not returned.', 'CAMPAIGN_CREATE_FAILED', 500);
    return { campaign: created, recipientCount: audience.length };
  }

  async function edit(id, input, actor) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    if (!MUTABLE_STATUSES.has(campaign.status)) {
      throw new CampaignRequestError('Only draft or rejected campaigns can be edited.', 'CAMPAIGN_NOT_EDITABLE', 409);
    }
    if (!input || !['title', 'message', 'recipients'].some(key => input[key] !== undefined)) {
      throw new CampaignRequestError('At least one editable field is required.');
    }
    const title = input?.title === undefined ? null : textField(input.title, 'title', MAX_TITLE_LENGTH);
    const message = input?.message === undefined ? null : textField(input.message, 'message', MAX_MESSAGE_LENGTH);
    const audience = input?.recipients === undefined ? null : normaliseAudience(input.recipients);
    if (audience && !audience.length) throw new CampaignRequestError('At least one recipient is required.');
    const { data, error } = await db().rpc('replace_sms_campaign_draft', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_expected_revision: campaign.revision,
      p_title: title,
      p_message: message,
      p_recipients: audience,
      p_actor_user_id: actorID(actor)
    });
    if (error) throw databaseError(error, 'CAMPAIGN_EDIT_FAILED');
    const edited = singleRPCRow(data);
    if (!edited) throw new CampaignRequestError('Campaign changed while it was being edited.', 'CAMPAIGN_REVISION_CONFLICT', 409);
    return edited;
  }

  async function submitReview(id, actor) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    if (!MUTABLE_STATUSES.has(campaign.status)) {
      throw new CampaignRequestError('Campaign is not ready to submit.', 'CAMPAIGN_NOT_SUBMITTABLE', 409);
    }
    const audience = await fetchCampaignRecipients(db(), id, workspaceID);
    if (!audience.some(row => row.selected !== false)) throw new CampaignRequestError('Campaign audience is empty.');
    const { data, error } = await db().from('sms_campaigns').update({
      status: 'review_required',
      final_message: campaign.proposed_message,
      submitted_for_review_at: new Date().toISOString(),
      submitted_by: actorID(actor),
      updated_at: new Date().toISOString()
    }).eq('id', id).eq('workspace_id', workspaceID).eq('revision', campaign.revision)
      .in('status', ['draft', 'rejected']) // bounded: fixed lifecycle states.
      .select('*').maybeSingle();
    if (error) throw databaseError(error, 'CAMPAIGN_SUBMIT_FAILED');
    if (!data) throw new CampaignRequestError('Campaign changed while it was submitted.', 'CAMPAIGN_REVISION_CONFLICT', 409);
    return { campaign: data, recipientCount: audience.filter(row => row.selected !== false).length };
  }

  async function reject(id, reason, actor) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    if (!['review_required', 'approval_pending'].includes(campaign.status)) {
      throw new CampaignRequestError('Campaign is not awaiting a decision.', 'CAMPAIGN_NOT_REVIEWABLE', 409);
    }
    const cleanReason = textField(reason, 'reason', 500);
    const audience = (await fetchCampaignRecipients(db(), id, workspaceID)).filter(row => row.selected !== false);
    const { data, error } = await db().rpc('reject_sms_campaign', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: actorID(actor),
      p_revision: campaign.revision,
      p_reason: cleanReason,
      p_audience_hash: audienceHash(audience),
      p_message_hash: messageHash(campaign.final_message)
    });
    if (error) throw databaseError(error, 'CAMPAIGN_REJECT_FAILED');
    if (!data) throw new CampaignRequestError('Campaign changed while it was rejected.', 'CAMPAIGN_REVISION_CONFLICT', 409);
    return singleRPCRow(data);
  }

  /**
   * What each person would actually read, without minting or writing anything.
   *
   * Returns a sample of rendered messages plus the FULL exclusion accounting,
   * because the number that matters to a reviewer is not the twenty messages
   * on screen but the count of people who would silently drop out. A campaign
   * that renders beautifully for the first twenty and fails for a third of the
   * list is the exact failure this is here to make visible.
   */
  async function preview(id, { limit = 20, message = null } = {}) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    // An unsaved override, so the editor can show what copy WOULD look like
    // before committing it to a revision. Without this, seeing a real rendered
    // message meant saving first, which bumps the revision and drops any
    // existing approval, so checking your wording had a cost.
    const override = typeof message === 'string' ? message.trim() : '';
    const template = override || campaign.final_message || campaign.proposed_message || '';
    const fields = fieldsUsed(template);
    const audience = await fetchCampaignRecipients(db(), id, workspaceID);
    const selected = audience.filter(row => row.selected !== false);

    if (!fields.length) {
      // No merge fields, so everybody reads the same thing and there is
      // nothing that can fail to render.
      return {
        personalised: false,
        template,
        unsaved: Boolean(override),
        audienceCount: selected.length,
        renderedCount: selected.length,
        excludedCount: 0,
        reasons: {},
        samples: selected.slice(0, limit).map(row => ({ phone: row.contact_phone, message: template })),
        excluded: []
      };
    }

    const outcome = await personaliseCampaign({
      client: db(),
      campaignID: id,
      template,
      phones: selected.map(row => row.contact_phone).filter(Boolean),
      percentOff: campaignDiscountPercent(campaign),
      dryRun: true,
      // Must match the real approval below, or the preview describes a
      // different message from the one that gets sent.
      sharedCode: true,
      fixedCode: campaignCouponCode(campaign),
      publicCode: campaignPublicCode(campaign)
    });

    return {
      personalised: true,
      template,
      // So the caller can tell a preview of saved copy from a preview of
      // something still being typed.
      unsaved: Boolean(override),
      fields,
      discountPercent: campaignDiscountPercent(campaign),
      audienceCount: selected.length,
      renderedCount: outcome.rendered.length,
      excludedCount: outcome.excluded.length,
      reasons: outcome.reasons,
      samples: outcome.rendered.slice(0, limit),
      // Capped: a reviewer needs to know who and why, not to scroll 160 rows.
      excluded: outcome.excluded.slice(0, limit)
    };
  }

  async function prepareApproval(id, actor) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    if (!['review_required', 'approval_pending'].includes(campaign.status)) {
      throw new CampaignRequestError('Campaign is not awaiting approval.', 'CAMPAIGN_NOT_REVIEWABLE', 409);
    }
    const audience = await fetchCampaignRecipients(db(), id, workspaceID);
    const selected = audience.filter(row => row.selected !== false);
    const hashes = { audienceHash: audienceHash(selected), messageHash: messageHash(campaign.final_message) };

    // If the audit insert failed after phase one, a retry must resume the same
    // frozen revision instead of stranding it forever. It may only resume when
    // the immutable approval hashes still match exactly.
    if (campaign.status === 'approval_pending') {
      const { data: approval, error: approvalError } = await db().from('sms_campaign_approvals').select('*')
        .eq('campaign_id', id).eq('workspace_id', workspaceID)
        .eq('revision', campaign.revision).eq('decision', 'approved').maybeSingle();
      if (approvalError) throw databaseError(approvalError, 'CAMPAIGN_APPROVAL_LOAD_FAILED');
      if (!approvalRetryMatches(campaign, approval, hashes)) {
        throw new CampaignRequestError(
          'Pending approval does not match the frozen revision.',
          'CAMPAIGN_APPROVAL_RETRY_MISMATCH', 409
        );
      }
      return { campaign, recipientCount: selected.length, ...hashes, preparation: approval, resumed: true };
    }

    // ── Personalisation, before the RPC and never after ──────────────────
    //
    // A template with no merge fields is left entirely alone: the RPC copies
    // final_message to every row exactly as it always did. A template WITH
    // merge fields is rendered per person here, written per person, and the
    // RPC then verifies rather than overwrites. Doing it in that order is the
    // whole point, because the alternative is substituting at send time, which
    // would mean the approver read a template and the customer got something
    // nobody had seen.
    //
    // This is also where coupons are minted, so it must not run on the
    // approval_pending retry path above: that branch returns before reaching
    // here, having already established the frozen revision still matches.
    const personalised = fieldsUsed(campaign.final_message).length > 0;
    let personalisation = null;
    if (personalised) {
      personalisation = await renderAndFreeze(id, campaign, selected);
    }

    const { data, error } = await db().rpc('prepare_sms_campaign_approval', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: actorID(actor),
      p_revision: campaign.revision,
      p_audience_hash: hashes.audienceHash,
      p_message_hash: hashes.messageHash,
      p_personalised: personalised
    });
    if (error) throw databaseError(error, 'CAMPAIGN_APPROVAL_PREPARE_FAILED');
    return {
      campaign,
      recipientCount: selected.length,
      ...hashes,
      preparation: data,
      personalisation
    };
  }

  /**
   * Render one message per recipient, write it, and deselect anybody it could
   * not be rendered for.
   *
   * DESELECTING IS THE POINT. The RPC refuses to approve a personalised
   * campaign while any SELECTED recipient has an empty rendered_message, so a
   * person the renderer could not handle has to leave the audience or the
   * whole campaign is stuck. Dropping them is also the right answer on its own
   * merits: the alternative is "Hi , it has been a while", which is worse than
   * not writing to them at all.
   *
   * The audience hash was computed from the pre-render selection, so it is
   * recomputed by the caller path only when nothing was dropped. When somebody
   * IS dropped the operator has to look, which is why this throws instead of
   * quietly approving a smaller campaign than the one that was reviewed.
   */
  async function renderAndFreeze(id, campaign, selected) {
    // ── Refuse before minting, not after ────────────────────────────────
    //
    // Coupon creation is the one irreversible step in this function, and the
    // RPC call that follows it is the one that fails when
    // scripts/personalised-approval-migration.sql has not been applied: the
    // old signature has no p_personalised, so PostgREST cannot find it. In
    // that order, approving on an unmigrated database mints 376 real
    // WooCommerce coupons and THEN errors, leaving live discount codes behind
    // for a campaign that did not happen.
    //
    // `discount_percent` is added by the same migration that adds the
    // parameter, so its presence on a `select *` row is a free and exact
    // proxy for "the migration ran". No extra query.
    // The message is the promise. Checked BEFORE minting, for the same reason
    // as the migration check below: a coupon worth less than the message says
    // makes the business a liar at the checkout, one customer at a time, with
    // no error anywhere. Approval already shipped a 15% coupon for a message
    // that said 20%.
    assertDiscountMatchesMessage(
      campaign.final_message || campaign.proposed_message,
      campaignDiscountPercent(campaign)
    );

    if (!Object.hasOwn(campaign, 'discount_percent')) {
      throw new CampaignNotReadyError(
        'Personalised campaigns need scripts/personalised-approval-migration.sql. '
        + 'Approving now would mint coupons for a campaign that cannot be approved.'
      );
    }

    const phones = selected.map(row => row.contact_phone).filter(Boolean);

    // ── The code budget, before a single coupon is minted ────────────────
    //
    // Only for campaigns that actually offer one. A campaign whose copy has no
    // {{code}} is unaffected, which is most of them.
    //
    // Refusing here rather than silently skipping those recipients is the
    // point: the reviewed audience and the sent audience must be the same
    // audience, so a person who may not be given a code has to come OUT of the
    // campaign by hand rather than receive a message with a hole where the
    // code should be.
    if (fieldsUsed(campaign.final_message).includes('code')) {
      const budget = await filterEligibleForCode({ client: db(), phones });
      if (budget.refused.length) {
        const counts = budget.refused.reduce((tally, row) => {
          tally[row.reason] = (tally[row.reason] || 0) + 1;
          return tally;
        }, {});
        throw new CampaignRequestError(
          `${budget.refused.length} of ${phones.length} recipients may not be given another code. `
          + `Deselect them and re-approve. Reasons: ${JSON.stringify(counts)}`,
          'CAMPAIGN_CODE_BUDGET_EXCEEDED',
          409
        );
      }
    }

    const outcome = await personaliseCampaign({
      client: db(),
      campaignID: id,
      template: campaign.final_message,
      phones,
      percentOff: campaign.discount_percent ?? DEFAULT_DISCOUNT_PERCENT,
      dryRun: false,
      // ONE coupon for the campaign, restricted to its audience, rather than
      // one per person. See issueSharedCode in personalise.js for why.
      sharedCode: true,
      fixedCode: campaignCouponCode(campaign),
      publicCode: campaignPublicCode(campaign)
    });

    if (outcome.excluded.length) {
      // Not a silent shrink. The reviewed audience and the sent audience must
      // be the same audience, so a difference stops the approval and is
      // reported with the reasons and the count.
      throw new CampaignRequestError(
        `${outcome.excluded.length} of ${phones.length} recipients cannot be personalised. `
        + `Deselect them and re-approve. Reasons: ${JSON.stringify(outcome.reasons)}`,
        'CAMPAIGN_PERSONALISATION_INCOMPLETE',
        409
      );
    }

    for (let index = 0; index < outcome.rendered.length; index += INSERT_CHUNK_SIZE) {
      const chunk = outcome.rendered.slice(index, index + INSERT_CHUNK_SIZE);
      await Promise.all(chunk.map(row => db()
        .from('sms_campaign_recipients')
        .update({
          rendered_message: row.message,
          // The code this person was given. This is the join that makes a
          // redeemed coupon attributable to the campaign that sent it; see
          // scripts/coupon-attribution-migration.sql. Null for a campaign
          // that offers nothing, which is most of them.
          ...(row.couponCode ? { issued_coupon_code: row.couponCode } : {}),
          updated_at: new Date().toISOString()
        })
        .eq('campaign_id', id).eq('workspace_id', workspaceID).eq('contact_phone', row.phone)));
    }

    return {
      rendered: outcome.rendered.length,
      couponsIssued: outcome.couponsIssued,
      couponFailures: outcome.couponFailures
    };
  }

  async function finalizeApproval(id, revision, auditProof = {}) {
    const fingerprint = typeof auditProof.fingerprint === 'string' ? auditProof.fingerprint.trim() : '';
    const auditID = Number(auditProof.id);
    if (!fingerprint) {
      throw new CampaignRequestError('Approval audit proof is required.', 'CAMPAIGN_APPROVAL_AUDIT_REQUIRED', 503);
    }
    const { data, error } = await db().rpc('finalize_sms_campaign_approval', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_revision: revision,
      p_audit_log_id: Number.isSafeInteger(auditID) && auditID > 0 ? auditID : null,
      p_audit_fingerprint: fingerprint
    });
    if (error) throw databaseError(error, 'CAMPAIGN_APPROVAL_FINALIZE_FAILED');
    return singleRPCRow(data);
  }

  async function schedule(id, scheduledFor, actor) {
    const eligibility = await campaignLiveSendEligibility({ client: db(), env, workspaceID });
    if (!eligibility.allowed) {
      throw new CampaignRequestError(
        'Live campaign scheduling is disabled pending explicit provider approval.',
        'CAMPAIGN_LIVE_SEND_DISABLED', 409
      );
    }
    const preview = await dryRun(id);
    if (!campaignMaySchedulePreview(preview)) {
      throw new CampaignRequestError(
        'Campaign has no recipients with current send eligibility.',
        'CAMPAIGN_AUDIENCE_NOT_ELIGIBLE', 409
      );
    }
    const when = new Date(scheduledFor);
    if (!scheduledFor || Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
      throw new CampaignRequestError('scheduledFor must be a current or future timestamp.');
    }
    const { data, error } = await db().rpc('schedule_sms_campaign', {
      p_campaign_id: id, p_workspace_id: workspaceID,
      p_actor_user_id: actorID(actor), p_scheduled_for: when.toISOString()
    });
    if (error) throw databaseError(error, 'CAMPAIGN_SCHEDULE_FAILED');
    return singleRPCRow(data);
  }

  /**
   * Cancel a campaign, and optionally take it off the working list at once.
   *
   * ── WHY `archive` IS AN OPTION AND NOT A SEPARATE CALL ─────────────────
   *
   * There are two reasons a campaign gets cancelled and they deserve
   * different endings. Somebody deciding not to send one is a decision, and
   * the row should sit in the list until they say otherwise. A campaign
   * cancelled because it was REBUILT is bookkeeping — nobody chose it, it is
   * not news, and it should never have appeared.
   *
   * The owner archived every cancelled campaign in the app and then watched
   * four more appear. His archives had held perfectly; each rebuild was
   * cancelling the previous drafts and depositing fresh cancelled rows in
   * front of him. Superseding something and then remembering to tidy up after
   * it is exactly the kind of two-step nobody performs reliably, so it is one
   * call now.
   */
  async function cancel(id, reason, actor, { archive = false } = {}) {
    const { data, error } = await db().rpc('cancel_sms_campaign', {
      p_campaign_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: actorID(actor),
      p_reason: typeof reason === 'string' ? reason.slice(0, 500) : null
    });
    if (error) throw databaseError(error, 'CAMPAIGN_CANCEL_FAILED');
    const cancelled = singleRPCRow(data);

    if (archive) {
      // Best effort by design. The cancel is the part that matters and has
      // already succeeded; failing the whole call because the tidying did not
      // would turn a cosmetic problem into a real one.
      const { error: archiveError } = await db()
        .from('sms_campaigns')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', workspaceID).is('archived_at', null);
      if (archiveError) {
        console.error(`[CAMPAIGNS] Cancelled ${id} but could not archive it: ${archiveError.message}`);
      }
    }
    return cancelled;
  }

  async function dryRun(id) {
    const campaign = await loadCampaign(db(), id, workspaceID);
    const settings = await loadCampaignSettings(db(), workspaceID);
    if (!settings) throw new CampaignNotReadyError();
    const recipientRows = (await fetchCampaignRecipients(db(), id, workspaceID)).filter(row => row.selected !== false);
    const phones = recipientRows.map(row => row.contact_phone);
    const evidence = await loadDryRunEvidence(db(), phones, workspaceID);
    const contacts = new Map(evidence.contacts.map(row => [normalisePhone(row.phone), row]));
    const sentinelPhones = new Set(evidence.sentinels.map(row => normalisePhone(row.phone)).filter(Boolean));
    const consentByPhone = new Map();
    for (const event of evidence.consents) {
      const phone = normalisePhone(event.contact_phone);
      if (!consentByPhone.has(phone)) consentByPhone.set(phone, []);
      consentByPhone.get(phone).push(event);
    }
    const suppressionsByPhone = new Map();
    for (const suppression of evidence.suppressions) {
      const phone = normalisePhone(suppression.contact_phone);
      if (!suppressionsByPhone.has(phone)) suppressionsByPhone.set(phone, []);
      suppressionsByPhone.get(phone).push(suppression);
    }
    const results = recipientRows.map(row => {
      const phone = normalisePhone(row.contact_phone);
      return evaluateRecipient({
        phone,
        contactOptedOut: contacts.get(phone)?.opted_out === true,
        contactDnd: contacts.get(phone)?.ghl_dnd,
        smsDndStatus: contacts.get(phone)?.ghl_sms_dnd_status,
        dndSyncedAt: contacts.get(phone)?.ghl_dnd_synced_at,
        dndMaxAgeHours: settings.dnd_status_max_age_hours,
        optOutSentinel: sentinelPhones.has(phone),
        consentEvents: consentByPhone.get(phone) || [],
        consentEvidenceRequired: settings.consent_evidence_required !== false,
        authoritativeSuppressionReason: activeSuppressionReason(suppressionsByPhone.get(phone) || [])
      });
    });
    const reasons = {};
    for (const row of results) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
    const live = campaignLiveSendEligibility({
      client: db(), env, workspaceID, skipDatabaseWhenEnvironmentDisabled: false
    });
    return Promise.resolve(live).then(liveEligibility => ({
      campaignId: campaign.id,
      revision: campaign.revision,
      total: results.length,
      eligible: results.filter(row => row.eligible).length,
      suppressed: results.filter(row => !row.eligible).length,
      reasons,
      liveEligibility,
      recipients: results.slice(0, 500),
      recipientsTruncated: results.length > 500,
      // What approving this will actually cost. Read from the FROZEN rendered
      // messages where they exist, because the template has no length until a
      // name and a product are in it, and the estimate is about the real send.
      cost: estimateCampaignCost({
        messages: recipientRows
          .filter(row => results.find(r => r.phone === normalisePhone(row.contact_phone))?.eligible)
          .map(row => row.rendered_message || campaign.final_message || campaign.proposed_message || ''),
        env
      })
    }));
  }

  return {
    approve: prepareApproval,
    cancel,
    create,
    detail,
    dryRun,
    edit,
    finalizeApproval,
    list,
    performance,
    preview,
    recipients,
    reject,
    remove,
    deletionPreview,
    reviewCount,
    schedule,
    submitReview
  };
}

module.exports = {
  approvalRetryMatches,
  CampaignNotReadyError,
  CampaignRequestError,
  archivedFilter,
  audienceHash,
  campaignLooksDestructible,
  campaignMaySchedulePreview,
  createCampaignService,
  messageHash,
  normaliseAudience,
  singleRPCRow,
  stableHash
};
