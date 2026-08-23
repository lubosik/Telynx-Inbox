'use strict';
/**
 * lib/campaigns/segment-service.js — persistence for saved campaign segments.
 *
 * The engine in lib/campaigns/reorder-cadence.js and lib/campaigns/winback.js
 * already decides who belongs where. Its problem was that nobody could see the
 * answer. This service is the visibility layer: it stores the answer, keeps
 * per-member evidence next to it, and lets a person override it without
 * breaking the next recompute.
 *
 * SUPABASE RULES THIS FILE OBEYS, ALL THREE OF WHICH HAVE CAUSED AN OUTAGE HERE
 *   1. A query builder is a thenable with `then` only. Never `.catch()` on it.
 *      try/catch around the await, then check `error`.
 *   2. Never build an unbounded `.in()`. Every `.in()` below is over a slice
 *      capped at IN_CHUNK_SIZE.
 *   3. An unpaged read silently caps at 1000 rows. Every full-table read below
 *      pages explicitly.
 */

const { normalisePhone } = require('../phone');
const { IN_CHUNK_SIZE } = require('../fetch-all-rows');
const { WORKSPACE_ID } = require('./eligibility');
const { CampaignNotReadyError, CampaignRequestError } = require('./service');
const {
  SEGMENT_RULE_VERSION,
  computeSegmentMembers,
  segmentCatalogue,
  segmentDefinition
} = require('./segment-definitions');
const {
  computedSetDigest,
  isMaterialSegmentChange,
  reconcileSegmentMembership
} = require('./segment-membership');

const DB_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_MEMBER_ROWS = 100000;
const MAX_MANUAL_MEMBERS = 10000;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_REASON_LENGTH = 500;

function databaseError(error, fallback = 'SEGMENT_DATABASE_ERROR') {
  if (!error) return null;
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) {
    return new CampaignNotReadyError(
      'Segments are unavailable until scripts/campaign-segments-migration.sql is applied.'
    );
  }
  if (/does not exist|could not find|schema cache/i.test(String(error.message || ''))) {
    return new CampaignNotReadyError(
      'Segments are unavailable until scripts/campaign-segments-migration.sql is applied.'
    );
  }
  if (error.code === 'P0002') {
    return new CampaignRequestError('Segment not found.', 'SEGMENT_NOT_FOUND', 404);
  }
  if (error.code === 'P0001') {
    return new CampaignRequestError(
      segmentConflictMessage(error.message), 'SEGMENT_STATE_CONFLICT', 409
    );
  }
  if (error.code === '23505') {
    return new CampaignRequestError('That segment already exists.', 'SEGMENT_DUPLICATE', 409);
  }
  if (error.code === '23514') {
    return new CampaignRequestError('The segment or member failed a database constraint.', 'SEGMENT_INVALID', 400);
  }
  return Object.assign(new Error('Segment database operation failed.'), { code: fallback });
}

/** Turn the RPC's error tokens into something an operator can act on. */
function segmentConflictMessage(raw) {
  const text = String(raw || '');
  if (text.includes('segment_member_is_excluded_by_override')) {
    return 'That person is excluded from this segment. Revoke the exclusion first.';
  }
  if (text.includes('segment_is_automatic_use_override')) {
    return 'This is an automatic segment. Use a force include or exclude instead of editing members.';
  }
  if (text.includes('segment_is_manual_use_member_endpoints')) {
    return 'This is a manual segment. Add or remove members directly instead of overriding.';
  }
  if (text.includes('segment_is_manual_and_is_not_recomputable')) {
    return 'A manual segment has no detector and cannot be recomputed.';
  }
  if (text.includes('segment_archived')) return 'This segment is archived.';
  if (text.includes('segment_kind_is_immutable')) {
    return 'A segment cannot change between automatic and manual.';
  }
  return 'Segment state changed; reload and try again.';
}

function textField(value, name, maxLength, { required = true } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) throw new CampaignRequestError(`${name} is required.`, 'SEGMENT_INVALID', 400);
    return null;
  }
  if (text.length > maxLength) {
    throw new CampaignRequestError(`${name} is too long.`, 'SEGMENT_INVALID', 400);
  }
  return text;
}

function requiredPhone(value) {
  const phone = normalisePhone(value);
  if (!phone) throw new CampaignRequestError('A valid E.164 phone number is required.', 'SEGMENT_INVALID', 400);
  return phone;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function singleRPCRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

/**
 * A slug derived from the operator's name, made unique by a short suffix. Only
 * manual segments get one; an automatic segment's key IS its definition key.
 */
function manualSegmentKey(name, suffix) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `manual:${slug || 'segment'}:${suffix}`;
}

function shapeSegment(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    key: row.segment_key,
    name: row.name,
    description: row.description || null,
    kind: row.segment_kind,
    definition: row.definition || {},
    ruleVersion: row.rule_version || null,
    memberCount: Number(row.member_count || 0),
    lastComputedAt: row.last_computed_at || null,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function shapeMember(row) {
  if (!row) return null;
  return {
    contactPhone: row.contact_phone,
    contactId: row.contact_id ?? null,
    contactName: row.contact_name_snapshot || null,
    membershipSource: row.membership_source,
    inclusionEvidence: row.inclusion_evidence || {},
    evidenceRuleVersion: row.evidence_rule_version || null,
    engineMatched: row.engine_matched === true,
    engineEvidence: row.engine_evidence || null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * An override is shown to the operator as a sentence, never as an invisible
 * flag: "Manually excluded by <person> on <date>, reason: <reason>." So the
 * actor ids travel with it and the UI never has to guess who did this.
 */
function shapeOverride(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    contactPhone: row.contact_phone,
    overrideType: row.override_type,
    reason: row.reason || null,
    createdAt: row.created_at,
    createdByUserId: row.created_by ?? null,
    revokedAt: row.revoked_at || null,
    revokedByUserId: row.revoked_by ?? null,
    revokeReason: row.revoke_reason || null
  };
}

function createSegmentService({
  client,
  workspaceID = WORKSPACE_ID,
  env = process.env,
  generationInputReader
} = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }

  /**
   * Read the authoritative engine input. Deliberately the SAME reader the
   * draft generator uses, so a segment can never disagree with a draft about
   * who qualifies.
   */
  async function readEngineInput(now) {
    if (typeof generationInputReader === 'function') return generationInputReader({ now, workspaceID });
    const {
      buildGenerationInput,
      readAuthoritativeGenerationSources
    } = require('./generation-service');
    const sources = await readAuthoritativeGenerationSources({ client: db(), now, workspaceID });
    return buildGenerationInput(sources, { now, workspaceID });
  }

  /** Every member row of one segment, paged. An unpaged read caps at 1000. */
  async function allMembers(segmentID, columns = '*') {
    const rows = [];
    for (let from = 0; from < MAX_MEMBER_ROWS; from += DB_PAGE_SIZE) {
      const { data, error } = await db().from('sms_campaign_segment_members')
        .select(columns)
        .eq('segment_id', segmentID).eq('workspace_id', workspaceID)
        .order('contact_phone', { ascending: true })
        .range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw databaseError(error, 'SEGMENT_MEMBER_LOAD_FAILED');
      rows.push(...(data || []));
      if (!data || data.length < DB_PAGE_SIZE) return rows;
    }
    throw new CampaignRequestError(
      'Segment membership exceeded the safe row ceiling.', 'SEGMENT_TOO_LARGE', 409
    );
  }

  async function allOverrides(segmentID) {
    const rows = [];
    for (let from = 0; from < MAX_MEMBER_ROWS; from += DB_PAGE_SIZE) {
      const { data, error } = await db().from('sms_campaign_segment_overrides')
        .select('id,contact_phone,override_type,reason,created_by,created_at,revoked_at,revoked_by,revoke_reason')
        .eq('segment_id', segmentID).eq('workspace_id', workspaceID)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw databaseError(error, 'SEGMENT_OVERRIDE_LOAD_FAILED');
      rows.push(...(data || []));
      if (!data || data.length < DB_PAGE_SIZE) return rows;
    }
    throw new CampaignRequestError(
      'Segment override history exceeded the safe row ceiling.', 'SEGMENT_TOO_LARGE', 409
    );
  }

  async function loadSegment(id) {
    const { data, error } = await db().from('sms_campaign_segments').select('*')
      .eq('id', id).eq('workspace_id', workspaceID).maybeSingle();
    if (error) throw databaseError(error, 'SEGMENT_LOAD_FAILED');
    if (!data) throw new CampaignRequestError('Segment not found.', 'SEGMENT_NOT_FOUND', 404);
    return data;
  }

  async function list({ page = 1, pageSize = DEFAULT_PAGE_SIZE, kind, archived } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE));
    let query = db().from('sms_campaign_segments').select('*', { count: 'exact' })
      .eq('workspace_id', workspaceID)
      .order('segment_kind', { ascending: true }).order('name', { ascending: true })
      .range((safePage - 1) * safeSize, safePage * safeSize - 1);
    if (kind === 'automatic' || kind === 'manual') query = query.eq('segment_kind', kind);
    if (String(archived) !== 'true') query = query.is('archived_at', null);
    const { data, error, count } = await query;
    if (error) throw databaseError(error, 'SEGMENT_LIST_FAILED');

    // The catalogue is returned alongside so the client can offer every
    // automatic definition that has not been saved yet without a second call.
    const savedKeys = new Set((data || []).map(row => row.segment_key));
    return {
      items: (data || []).map(shapeSegment),
      page: safePage,
      pageSize: safeSize,
      total: count || 0,
      ruleVersion: SEGMENT_RULE_VERSION,
      available: segmentCatalogue().filter(entry => !savedKeys.has(entry.key))
    };
  }

  async function detail(id, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const segment = await loadSegment(id);
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE));
    const { data, error, count } = await db().from('sms_campaign_segment_members')
      .select('contact_phone,contact_id,contact_name_snapshot,membership_source,inclusion_evidence,evidence_rule_version,engine_matched,engine_evidence,first_seen_at,last_seen_at', { count: 'exact' })
      .eq('segment_id', id).eq('workspace_id', workspaceID)
      .order('contact_phone', { ascending: true })
      .range((safePage - 1) * safeSize, safePage * safeSize - 1);
    if (error) throw databaseError(error, 'SEGMENT_MEMBER_LOAD_FAILED');

    const overrides = (await allOverrides(id)).map(shapeOverride);
    return {
      segment: shapeSegment(segment),
      members: {
        items: (data || []).map(shapeMember),
        page: safePage,
        pageSize: safeSize,
        total: count || 0
      },
      overrides: {
        active: overrides.filter(row => !row.revokedAt),
        revoked: overrides.filter(row => row.revokedAt)
      }
    };
  }

  /** "Why is this person in this segment?" answered from stored evidence. */
  async function member(id, rawPhone) {
    const segment = await loadSegment(id);
    const phone = requiredPhone(rawPhone);
    const { data, error } = await db().from('sms_campaign_segment_members').select('*')
      .eq('segment_id', id).eq('workspace_id', workspaceID).eq('contact_phone', phone).maybeSingle();
    if (error) throw databaseError(error, 'SEGMENT_MEMBER_LOAD_FAILED');

    const { data: overrideRows, error: overrideError } = await db()
      .from('sms_campaign_segment_overrides')
      .select('id,contact_phone,override_type,reason,created_by,created_at,revoked_at,revoked_by,revoke_reason')
      .eq('segment_id', id).eq('workspace_id', workspaceID).eq('contact_phone', phone)
      .order('created_at', { ascending: false }).limit(50);
    if (overrideError) throw databaseError(overrideError, 'SEGMENT_OVERRIDE_LOAD_FAILED');

    const overrides = (overrideRows || []).map(shapeOverride);
    const activeOverride = overrides.find(row => !row.revokedAt) || null;
    if (!data && !activeOverride) {
      throw new CampaignRequestError('That person is not in this segment.', 'SEGMENT_MEMBER_NOT_FOUND', 404);
    }
    return {
      segment: shapeSegment(segment),
      member: shapeMember(data),
      activeOverride,
      overrideHistory: overrides
    };
  }

  async function createManual(input, actor) {
    const name = textField(input?.name, 'name', MAX_NAME_LENGTH);
    const description = textField(input?.description, 'description', MAX_DESCRIPTION_LENGTH, { required: false });
    const rawMembers = input?.members === undefined ? [] : input.members;
    if (!Array.isArray(rawMembers)) {
      throw new CampaignRequestError('members must be an array.', 'SEGMENT_INVALID', 400);
    }
    if (rawMembers.length > MAX_MANUAL_MEMBERS) {
      throw new CampaignRequestError(
        `A manual segment may hold at most ${MAX_MANUAL_MEMBERS} people.`, 'SEGMENT_TOO_LARGE', 400
      );
    }
    const byPhone = new Map();
    for (const entry of rawMembers) {
      const phone = requiredPhone(typeof entry === 'string' ? entry : entry?.phone ?? entry?.contactPhone);
      if (byPhone.has(phone)) continue;
      byPhone.set(phone, {
        contactPhone: phone,
        contactID: positiveInteger(entry?.contactId ?? entry?.contactID),
        contactName: typeof entry?.name === 'string' ? entry.name.trim().slice(0, 200) || null : null,
        inclusionEvidence: {
          source: 'manual_selection',
          reason: textField(entry?.reason, 'reason', MAX_REASON_LENGTH, { required: false }),
          addedByUserID: positiveInteger(actor?.id)
        }
      });
    }

    const key = manualSegmentKey(name, Date.now().toString(36));
    const { data, error } = await db().rpc('create_sms_campaign_segment', {
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_segment_key: key,
      p_name: name,
      p_description: description,
      p_segment_kind: 'manual',
      p_definition: { kind: 'manual', createdFrom: 'operator' },
      p_rule_version: SEGMENT_RULE_VERSION,
      p_members: [...byPhone.values()]
    });
    if (error) throw databaseError(error, 'SEGMENT_CREATE_FAILED');
    const created = singleRPCRow(data);
    if (!created) throw new CampaignRequestError('Segment was not returned.', 'SEGMENT_CREATE_FAILED', 500);
    return { segment: shapeSegment(created), memberCount: byPhone.size };
  }

  /**
   * Save an automatic segment from the catalogue. Idempotent by segment key:
   * asking twice returns the segment that already exists rather than a
   * duplicate with a different id.
   */
  async function createAutomatic(input, actor) {
    const definition = segmentDefinition(input?.definitionKey);
    if (!definition) {
      throw new CampaignRequestError(
        'Unknown segment definition. Read GET /api/segments/catalogue for the supported keys.',
        'SEGMENT_DEFINITION_UNKNOWN', 400
      );
    }
    const { data: existing, error: existingError } = await db().from('sms_campaign_segments')
      .select('*').eq('workspace_id', workspaceID).eq('segment_key', definition.key).maybeSingle();
    if (existingError) throw databaseError(existingError, 'SEGMENT_LOAD_FAILED');
    if (existing) return { segment: shapeSegment(existing), created: false };

    const { data, error } = await db().rpc('create_sms_campaign_segment', {
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_segment_key: definition.key,
      p_name: textField(input?.name, 'name', MAX_NAME_LENGTH, { required: false }) || definition.name,
      p_description: definition.description,
      p_segment_kind: 'automatic',
      p_definition: { detector: definition.detector, definitionKey: definition.key },
      p_rule_version: SEGMENT_RULE_VERSION,
      p_members: null
    });
    if (error) throw databaseError(error, 'SEGMENT_CREATE_FAILED');
    const created = singleRPCRow(data);
    if (!created) throw new CampaignRequestError('Segment was not returned.', 'SEGMENT_CREATE_FAILED', 500);
    return { segment: shapeSegment(created), created: true };
  }

  async function addMember(id, input, actor) {
    const phone = requiredPhone(input?.phone ?? input?.contactPhone);
    const { data, error } = await db().rpc('add_sms_campaign_segment_member', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_contact_phone: phone,
      p_contact_id: positiveInteger(input?.contactId ?? input?.contactID),
      p_contact_name: typeof input?.name === 'string' ? input.name.trim().slice(0, 200) : null,
      p_reason: textField(input?.reason, 'reason', MAX_REASON_LENGTH, { required: false })
    });
    if (error) throw databaseError(error, 'SEGMENT_MEMBER_ADD_FAILED');
    const added = singleRPCRow(data);
    if (!added) throw new CampaignRequestError('Member was not returned.', 'SEGMENT_MEMBER_ADD_FAILED', 500);
    return { member: shapeMember(added) };
  }

  async function removeMember(id, rawPhone, actor) {
    const phone = requiredPhone(rawPhone);
    const { data, error } = await db().rpc('remove_sms_campaign_segment_member', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_contact_phone: phone
    });
    if (error) throw databaseError(error, 'SEGMENT_MEMBER_REMOVE_FAILED');
    const removed = Number(singleRPCRow(data) ?? data ?? 0);
    if (!removed) {
      throw new CampaignRequestError('That person is not in this segment.', 'SEGMENT_MEMBER_NOT_FOUND', 404);
    }
    return { removed, contactPhone: phone };
  }

  async function setOverride(id, input, actor) {
    const overrideType = input?.overrideType === 'exclude' ? 'exclude'
      : input?.overrideType === 'include' ? 'include' : null;
    if (!overrideType) {
      throw new CampaignRequestError(
        'overrideType must be "include" or "exclude".', 'SEGMENT_INVALID', 400
      );
    }
    const phone = requiredPhone(input?.phone ?? input?.contactPhone);
    const { data, error } = await db().rpc('set_sms_campaign_segment_override', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_contact_phone: phone,
      p_override_type: overrideType,
      p_reason: textField(input?.reason, 'reason', MAX_REASON_LENGTH, { required: false }),
      p_contact_id: positiveInteger(input?.contactId ?? input?.contactID),
      p_contact_name: typeof input?.name === 'string' ? input.name.trim().slice(0, 200) : null
    });
    if (error) throw databaseError(error, 'SEGMENT_OVERRIDE_FAILED');
    const override = singleRPCRow(data);
    if (!override) throw new CampaignRequestError('Override was not returned.', 'SEGMENT_OVERRIDE_FAILED', 500);
    return { override: shapeOverride(override) };
  }

  async function revokeOverride(id, rawPhone, input, actor) {
    const phone = requiredPhone(rawPhone);
    const { data, error } = await db().rpc('revoke_sms_campaign_segment_override', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_contact_phone: phone,
      p_reason: textField(input?.reason, 'reason', MAX_REASON_LENGTH, { required: false })
    });
    if (error) throw databaseError(error, 'SEGMENT_OVERRIDE_REVOKE_FAILED');
    const override = singleRPCRow(data);
    if (!override) {
      throw new CampaignRequestError('No active override for that person.', 'SEGMENT_OVERRIDE_NOT_FOUND', 404);
    }
    return { override: shapeOverride(override) };
  }

  /**
   * Recompute one automatic segment.
   *
   * Idempotent twice over: the run key is the digest of what the engine
   * computed, so replaying an unchanged world is recognised as the same run
   * and changes nothing, and the RPC itself refuses a duplicate run key.
   */
  async function recompute(id, actor, { now = new Date() } = {}) {
    const segment = await loadSegment(id);
    if (segment.segment_kind !== 'automatic') {
      throw new CampaignRequestError(
        'A manual segment has no detector and cannot be recomputed.',
        'SEGMENT_NOT_RECOMPUTABLE', 409
      );
    }
    if (segment.archived_at) {
      throw new CampaignRequestError('This segment is archived.', 'SEGMENT_ARCHIVED', 409);
    }
    const definitionKey = segment.definition?.definitionKey || segment.segment_key;
    if (!segmentDefinition(definitionKey)) {
      throw new CampaignRequestError(
        'This segment references a definition that no longer exists.',
        'SEGMENT_DEFINITION_UNKNOWN', 409
      );
    }

    const at = now instanceof Date ? now : new Date(now);
    const input = await readEngineInput(at);
    const computed = computeSegmentMembers(definitionKey, input, { now: at });

    const [existing, overrides] = await Promise.all([
      allMembers(id, 'contact_phone,membership_source,inclusion_evidence,engine_matched'),
      allOverrides(id)
    ]);
    const reconciled = reconcileSegmentMembership({
      existing: existing.map(row => ({
        contactPhone: row.contact_phone,
        membershipSource: row.membership_source,
        inclusionEvidence: row.inclusion_evidence,
        engineMatched: row.engine_matched
      })),
      computed,
      overrides
    });

    const digest = computedSetDigest(computed);
    const runKey = `${definitionKey}:${digest}`;

    // Idempotency is decided here as well as in the RPC, so the caller can be
    // told "nothing moved" without inferring it from timestamps. The RPC is
    // still the authority; this read only labels the outcome.
    const { data: priorRun, error: priorError } = await db().from('sms_campaign_segment_runs')
      .select('id').eq('segment_id', id).eq('workspace_id', workspaceID)
      .eq('run_key', runKey).maybeSingle();
    if (priorError) throw databaseError(priorError, 'SEGMENT_RECOMPUTE_FAILED');
    const replayed = Boolean(priorRun);

    const { data, error } = await db().rpc('apply_sms_campaign_segment_recompute', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_run_key: runKey,
      p_rule_version: SEGMENT_RULE_VERSION,
      p_input_digest: digest,
      p_members: reconciled.submit
    });
    if (error) throw databaseError(error, 'SEGMENT_RECOMPUTE_FAILED');
    const run = singleRPCRow(data);
    if (!run) throw new CampaignRequestError('Recompute returned no run.', 'SEGMENT_RECOMPUTE_FAILED', 500);

    const summary = {
      memberCount: Number(run.member_count || 0),
      joinedCount: Number(run.joined_count || 0),
      leftCount: Number(run.left_count || 0),
      refreshedCount: Number(run.refreshed_count || 0),
      forcedIncludeCount: Number(run.forced_include_count || 0),
      excludedCount: Number(run.excluded_count || 0)
    };
    const minimumDelta = Number.parseInt(env.SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA, 10) || 1;
    return {
      segment: shapeSegment({ ...segment, member_count: summary.memberCount, last_computed_at: run.completed_at }),
      run: { id: String(run.id), runKey, digest, replayed, completedAt: run.completed_at, ...summary },
      expected: reconciled.summary,
      blockedByExclusion: reconciled.blockedByExclusion,
      keptByOverride: reconciled.keptByOverride,
      material: !replayed && isMaterialSegmentChange(summary, { minimumDelta })
    };
  }

  /**
   * Owners and Admins who may manage campaigns, for notification targeting.
   * Bounded by construction: `.in()` runs over a slice capped at IN_CHUNK_SIZE.
   */
  async function notificationUsers() {
    const users = [];
    for (let from = 0; from < MAX_MEMBER_ROWS; from += DB_PAGE_SIZE) {
      const { data, error } = await db().from('sms_users').select('id,role,is_active')
        .eq('is_active', true).order('id', { ascending: true })
        .range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw databaseError(error, 'SEGMENT_NOTIFICATION_USERS_FAILED');
      users.push(...(data || []));
      if (!data || data.length < DB_PAGE_SIZE) break;
    }
    const eligible = users.filter(user => ['owner', 'admin'].includes(String(user.role || '').toLowerCase()));
    const ids = eligible.map(user => user.id);
    const managers = new Set();
    for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
      // bounded: slice is capped at IN_CHUNK_SIZE (200), well below URL limits.
      const chunk = ids.slice(i, i + IN_CHUNK_SIZE);
      const { data, error } = await db().from('sms_effective_permissions')
        .select('user_id').eq('permission_key', 'campaigns.manage').in('user_id', chunk);
      if (error) throw databaseError(error, 'SEGMENT_NOTIFICATION_USERS_FAILED');
      for (const row of data || []) managers.add(String(row.user_id));
    }
    return eligible.map(user => ({
      id: user.id,
      role: user.role,
      isActive: user.is_active === true,
      canManageCampaigns: managers.has(String(user.id))
    }));
  }

  return {
    addMember,
    catalogue: () => ({ ruleVersion: SEGMENT_RULE_VERSION, items: segmentCatalogue() }),
    createAutomatic,
    createManual,
    detail,
    list,
    member,
    notificationUsers,
    recompute,
    removeMember,
    revokeOverride,
    setOverride
  };
}

module.exports = {
  createSegmentService,
  manualSegmentKey,
  segmentConflictMessage,
  shapeMember,
  shapeOverride,
  shapeSegment
};
