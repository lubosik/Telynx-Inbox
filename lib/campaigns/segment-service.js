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
const MAX_PURPOSE_LENGTH = 500;
/**
 * Ceiling on the contact scan behind the add-member picker. The scan pages
 * explicitly at DB_PAGE_SIZE; this is the point at which the workspace is told
 * to narrow its search rather than the server quietly returning a partial
 * answer, which is the failure mode the 1000-row cap already caused here once.
 */
const MAX_CANDIDATE_SCAN_ROWS = 20000;
const MAX_HELD_CANDIDATES = 200;

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
  if (text.includes('segment_purpose_required')) {
    return 'Say what this segment is for. Every manual segment carries one purpose, and it is shown as the reason for everybody in it.';
  }
  if (text.includes('segment_delete_mode_invalid')) {
    return 'A segment can be archived or removed, and nothing else.';
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

/**
 * The segment-level purpose. Required, and refused with a sentence that says
 * what to do rather than naming a field, because the person reading it is
 * looking at a form and not at this file.
 */
function requiredPurpose(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new CampaignRequestError(
      'Say what this segment is for. Every manual segment carries one purpose, and it is shown as the reason for everybody in it.',
      'SEGMENT_PURPOSE_REQUIRED', 400
    );
  }
  if (text.length > MAX_PURPOSE_LENGTH) {
    throw new CampaignRequestError(
      `That purpose is longer than ${MAX_PURPOSE_LENGTH} characters.`, 'SEGMENT_INVALID', 400
    );
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
    // One sentence, written once, that explains everybody in a manual segment.
    // Always null on an automatic segment: its detector definition is its
    // purpose, and a second free-text field beside it would be two answers to
    // the same question. Null on a manual segment only means the row predates
    // scripts/segment-lifecycle-migration.sql.
    purpose: row.purpose || null,
    kind: row.segment_kind,
    definition: row.definition || {},
    ruleVersion: row.rule_version || null,
    memberCount: Number(row.member_count || 0),
    lastComputedAt: row.last_computed_at || null,
    archivedAt: row.archived_at || null,
    archivedByUserId: row.archived_by ?? null,
    archiveReason: row.archive_reason || null,
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
    // ONE reason, for the whole segment, and it is not optional.
    //
    // A manual segment is a decision somebody made about a group of customers,
    // and "why does this group exist?" has exactly one answer. Asking it once
    // here is what makes it answerable for every member without anybody having
    // to type the same sentence next to each name.
    //
    // This is NOT the per-person reason. That still exists, on the member row
    // and on an override, and it says something different: why this named human
    // in particular. Do not collapse the two.
    const purpose = requiredPurpose(input?.purpose);
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
      p_purpose: purpose,
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
      // Deliberately null. The detector definition is an automatic segment's
      // purpose; the database CHECK refuses a second one.
      p_purpose: null,
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

  // -- Removing a segment ---------------------------------------------------

  /**
   * Which parts of this segment are a record of a decision.
   *
   * Read here so the route can write an accurate audit row BEFORE the
   * destructive statement runs. delete_sms_campaign_segment repeats every one
   * of these checks inside its own transaction, so a race between this read and
   * that write ends in an archive and never in a wrong delete. This is the
   * preview; the RPC is the authority.
   */
  async function deletionBlockers(segment) {
    const id = segment.id;
    const blockers = [];
    if (segment.archived_at) blockers.push('already_archived');

    // A campaign that was built against this segment. Nothing writes this key
    // yet, so today it never fires; it is asked anyway so the rule is already
    // right the day delivery starts recording which audience it used.
    for (const column of ['audience_definition->>segmentId', 'audience_definition->>segment_id']) {
      const { count, error } = await db().from('sms_campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceID).eq(column, String(id));
      if (error) throw databaseError(error, 'SEGMENT_DELETE_PREVIEW_FAILED');
      if ((count || 0) > 0) { blockers.push('campaign_reference'); break; }
    }

    if (segment.last_computed_at || segment.last_run_id) blockers.push('engine_has_run');

    const { count: runs, error: runError } = await db().from('sms_campaign_segment_runs')
      .select('id', { count: 'exact', head: true })
      .eq('segment_id', id).eq('workspace_id', workspaceID);
    if (runError) throw databaseError(runError, 'SEGMENT_DELETE_PREVIEW_FAILED');
    if ((runs || 0) > 0) blockers.push('recompute_history');

    const { count: overrides, error: overrideError } = await db()
      .from('sms_campaign_segment_overrides')
      .select('id', { count: 'exact', head: true })
      .eq('segment_id', id).eq('workspace_id', workspaceID);
    if (overrideError) throw databaseError(overrideError, 'SEGMENT_DELETE_PREVIEW_FAILED');
    if ((overrides || 0) > 0) blockers.push('override_history');

    // Read last, and only when nothing else has already decided the answer. An
    // automatic segment always has runs, so it short-circuits above and never
    // pays for this; a manual one is capped at MAX_MANUAL_MEMBERS.
    if (!blockers.length) {
      const rows = await allMembers(id, 'contact_phone,inclusion_evidence');
      const written = rows.some(row =>
        String(row.inclusion_evidence?.reason || '').trim().length > 0);
      if (written) blockers.push('member_reasons');
    }
    return blockers;
  }

  async function deletionPreview(id) {
    const segment = await loadSegment(id);
    const blockers = await deletionBlockers(segment);
    return { segment: shapeSegment(segment), blockers, destructible: blockers.length === 0 };
  }

  /**
   * Destroy a segment that records no decision, or archive anything that does.
   *
   * The decision is made in SQL, inside the same transaction that acts on it.
   * The RPC has no force-delete mode: a caller may ask for the archive and may
   * never ask for the destruction, only accept it.
   */
  async function remove(id, { mode = 'auto', reason } = {}, actor) {
    const requestedMode = mode === 'archive' ? 'archive' : 'auto';
    const { data, error } = await db().rpc('delete_sms_campaign_segment', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id),
      p_mode: requestedMode,
      p_reason: typeof reason === 'string' ? reason.slice(0, MAX_REASON_LENGTH) : null
    });
    if (error) throw databaseError(error, 'SEGMENT_DELETE_FAILED');
    const result = singleRPCRow(data);
    if (!result) {
      throw new CampaignRequestError('Segment removal returned no result.', 'SEGMENT_DELETE_FAILED', 500);
    }
    return {
      outcome: result.outcome,
      segmentId: String(result.segmentId || id),
      blockers: Array.isArray(result.blockers) ? result.blockers : [],
      name: result.name || null,
      kind: result.kind || null,
      membersRemoved: Number(result.membersRemoved || 0)
    };
  }

  /**
   * Put an archived segment back on the working list. Archiving removed
   * nothing, so this rebuilds nothing.
   */
  async function restore(id, actor) {
    const { data, error } = await db().rpc('restore_sms_campaign_segment', {
      p_segment_id: id,
      p_workspace_id: workspaceID,
      p_actor_user_id: positiveInteger(actor?.id)
    });
    if (error) throw databaseError(error, 'SEGMENT_RESTORE_FAILED');
    const restored = singleRPCRow(data);
    if (!restored) {
      throw new CampaignRequestError('Segment not found.', 'SEGMENT_NOT_FOUND', 404);
    }
    return { segment: shapeSegment(restored) };
  }

  // -- The add-someone picker -----------------------------------------------

  /**
   * Strip the characters PostgREST reads as filter STRUCTURE.
   *
   * `or=(name.ilike.%x%,phone.ilike.%x%)` is parsed, not escaped, by the client
   * library. A comma, bracket, quote, backslash or star inside the value would
   * change the filter rather than be searched for, and a `%` would turn a
   * literal into a wildcard. Dots survive on purpose: the grammar splits on the
   * first two only, and email addresses are searched here.
   */
  function candidateSearchTerm(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return '';
    return text.replace(/[,()"\\*%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function candidateName(row) {
    const parts = [row?.first_name, row?.last_name]
      .map(value => String(value || '').trim()).filter(Boolean);
    return parts.join(' ') || String(row?.name || '').trim() || null;
  }

  /** Every contact matching the search, paged. An unpaged read caps at 1000. */
  async function scanContacts(term) {
    const rows = [];
    for (let from = 0; from < MAX_CANDIDATE_SCAN_ROWS; from += DB_PAGE_SIZE) {
      let query = db().from('sms_contacts')
        .select('id,phone,first_name,last_name,name')
        .order('id', { ascending: true })
        .range(from, from + DB_PAGE_SIZE - 1);
      if (term) {
        query = query.or(
          `first_name.ilike.%${term}%,last_name.ilike.%${term}%,` +
          `name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`
        );
      }
      const { data, error } = await query;
      if (error) throw databaseError(error, 'SEGMENT_CANDIDATE_LOAD_FAILED');
      rows.push(...(data || []));
      if (!data || data.length < DB_PAGE_SIZE) return rows;
    }
    throw new CampaignRequestError(
      'There are too many contacts to list at once. Search for a name, phone number or email address.',
      'SEGMENT_CANDIDATE_SCAN_TOO_LARGE', 409
    );
  }

  /**
   * Who could be added to this segment, with the people already in it removed.
   *
   * THIS EXCLUSION BELONGS ON THE SERVER, NOT IN THE CLIENT MERGE.
   *   The picker is paged and searchable. Filtering the page the client happens
   *   to be holding hides the members on screen and leaves every other member
   *   visible one scroll or one search later, which is exactly the bug this
   *   fixes. The set being subtracted also lives on the server: membership runs
   *   to MAX_MANUAL_MEMBERS rows and the client never holds all of them.
   *   Subtracting first and paging second is the only way `total` and `hasMore`
   *   can be true statements.
   *
   *   It does not belong in routes/contacts.js either. That endpoint answers
   *   `contact.read`, which a Support Agent holds and which has nothing to do
   *   with campaigns, and teaching the contact list about segment membership
   *   would put a campaigns concept behind a contacts permission.
   *
   * THREE STATES, NOT TWO.
   *   A member is removed from the list entirely: offering to add somebody who
   *   is already in is the papercut.
   *   Somebody with an ACTIVE EXCLUDE override is not a member, but they are
   *   also not simply absent. A person decided to hold them out and that
   *   decision survives every recompute. They come back SEPARATELY, in `held`,
   *   with the override that explains it, so the interface can show the
   *   decision rather than swallowing the name. Adding them is refused by a
   *   database trigger until the exclusion is reversed, so the honest answer is
   *   to show why, not to pretend they do not exist.
   *   Everybody else is `available`.
   */
  async function candidates(id, { search, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const segment = await loadSegment(id);
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE));
    const term = candidateSearchTerm(search);

    const [memberRows, overrideRows, contactRows] = await Promise.all([
      allMembers(id, 'contact_phone'),
      allOverrides(id),
      scanContacts(term)
    ]);

    const members = new Set(memberRows.map(row => row.contact_phone));
    const heldByPhone = new Map();
    for (const row of overrideRows) {
      if (row.revoked_at || row.override_type !== 'exclude') continue;
      heldByPhone.set(row.contact_phone, row);
    }

    const seen = new Set();
    const available = [];
    const held = [];
    let alreadyInCount = 0;

    for (const row of contactRows) {
      const phone = normalisePhone(row.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      const contactName = candidateName(row);
      if (members.has(phone)) { alreadyInCount += 1; continue; }
      if (heldByPhone.has(phone)) {
        held.push({
          contactPhone: phone,
          contactId: row.id ?? null,
          contactName,
          state: 'held_out',
          override: shapeOverride(heldByPhone.get(phone))
        });
        continue;
      }
      available.push({
        contactPhone: phone, contactId: row.id ?? null, contactName, state: 'available'
      });
    }

    // Somebody can be held out of a segment without being in sms_contacts at
    // all. Losing them here would make the exclusion invisible in the one place
    // an operator goes looking to undo it.
    const digits = term.replace(/\D/g, '');
    for (const [phone, row] of heldByPhone) {
      if (seen.has(phone)) continue;
      if (term && !(digits && phone.includes(digits))) continue;
      held.push({
        contactPhone: phone, contactId: null, contactName: null,
        state: 'held_out', override: shapeOverride(row)
      });
    }

    available.sort((left, right) => {
      const leftNamed = Boolean(left.contactName);
      const rightNamed = Boolean(right.contactName);
      if (leftNamed !== rightNamed) return leftNamed ? -1 : 1;
      const byName = String(left.contactName || '').localeCompare(
        String(right.contactName || ''), undefined, { sensitivity: 'base', numeric: true }
      );
      return byName || left.contactPhone.localeCompare(right.contactPhone);
    });
    held.sort((left, right) => left.contactPhone.localeCompare(right.contactPhone));

    const start = (safePage - 1) * safeSize;
    return {
      segment: shapeSegment(segment),
      candidates: {
        items: available.slice(start, start + safeSize),
        page: safePage,
        pageSize: safeSize,
        total: available.length,
        hasMore: start + safeSize < available.length
      },
      held: held.slice(0, MAX_HELD_CANDIDATES),
      heldTotal: held.length,
      // How many people matching this search were taken off the list because
      // they are already in it. The interface says so, rather than leaving the
      // operator wondering where somebody went.
      alreadyInCount,
      memberCount: members.size,
      search: term
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
    candidates,
    catalogue: () => ({ ruleVersion: SEGMENT_RULE_VERSION, items: segmentCatalogue() }),
    createAutomatic,
    createManual,
    deletionPreview,
    detail,
    list,
    member,
    notificationUsers,
    recompute,
    remove,
    removeMember,
    restore,
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
