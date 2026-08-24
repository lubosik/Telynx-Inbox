'use strict';

/**
 * Persistence for conversation referrals. All state transitions go through
 * SECURITY DEFINER RPCs in scripts/referrals-migration.sql. In particular,
 * claim is never implemented as a JavaScript read followed by an update.
 */

const { selectIn } = require('../fetch-all-rows');

const WORKSPACE_ID = 'vici';
const MAX_LIST_ROWS = 200;
const MAX_RECIPIENTS = 500;

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function databaseError(error, fallback) {
  if (!error) return null;
  const text = String(error.message || '');
  const stable = text.match(/REFERRAL_[A-Z_]+/)?.[0];
  if (stable) return Object.assign(new Error(stable), { code: stable });
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) {
    return Object.assign(new Error('Conversation referrals are not installed.'), {
      code: 'REFERRALS_NOT_READY', status: 503
    });
  }
  return Object.assign(new Error(error.message || 'Referral database operation failed.'), {
    code: fallback || 'REFERRAL_DATABASE_ERROR'
  });
}

function createReferralStore({ client, workspaceID = WORKSPACE_ID } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }

  async function rpc(name, args) {
    const { data, error } = await db().rpc(name, args);
    if (error) throw databaseError(error, 'REFERRAL_TRANSITION_FAILED');
    const row = firstRow(data);
    if (!row) throw Object.assign(new Error('Referral transition returned no row.'), {
      code: 'REFERRAL_TRANSITION_FAILED'
    });
    return row;
  }

  async function eligibleUsers() {
    const { data: users, error } = await db().from('sms_users')
      .select('id,email,display_name,role,last_seen_at')
      .eq('is_active', true)
      .eq('is_legacy_shared', false)
      .order('last_seen_at', { ascending: false, nullsFirst: false })
      .limit(MAX_RECIPIENTS);
    if (error) throw databaseError(error, 'REFERRAL_RECIPIENTS_FAILED');
    const ids = (users || []).map(row => row.id);
    const permissions = await selectIn(
      db(), 'sms_effective_permissions', 'user_id,permission_key', 'user_id', ids
    );
    const byUser = new Map();
    for (const row of permissions) {
      const key = String(row.user_id);
      if (!byUser.has(key)) byUser.set(key, new Set());
      byUser.get(key).add(row.permission_key);
    }
    return (users || []).filter(user => {
      const grants = byUser.get(String(user.id)) || new Set();
      return grants.has('conversation.read') && grants.has('message.send')
        && grants.has('referral.read') && grants.has('referral.act');
    });
  }

  async function listRows({ actorID, actorRole, box = 'all', includeResolved = true, oversight = false } = {}) {
    let query = db().from('sms_conversation_referrals')
      .select('*')
      .eq('workspace_id', workspaceID)
      .order('updated_at', { ascending: false })
      .limit(MAX_LIST_ROWS);
    if (!includeResolved) query = query.in('state', ['pending', 'owned']);

    if (!oversight) {
      const clauses = [];
      if (box !== 'received') clauses.push(`referred_by_user_id.eq.${Number(actorID)}`);
      if (box !== 'sent') {
        clauses.push(`original_target_user_id.eq.${Number(actorID)}`);
        clauses.push(`owner_user_id.eq.${Number(actorID)}`);
        if (['owner', 'admin'].includes(actorRole)) clauses.push('and(target_kind.eq.any_admin,state.eq.pending)');
      }
      query = query.or(clauses.join(','));
    }
    const { data, error } = await query;
    if (error) throw databaseError(error, 'REFERRAL_LIST_FAILED');
    return data || [];
  }

  async function getRow(id) {
    const { data, error } = await db().from('sms_conversation_referrals')
      .select('*').eq('workspace_id', workspaceID).eq('id', id).maybeSingle();
    if (error) throw databaseError(error, 'REFERRAL_LOAD_FAILED');
    return data || null;
  }

  async function getEvents(id) {
    const { data, error } = await db().from('sms_conversation_referral_events')
      .select('*').eq('workspace_id', workspaceID).eq('referral_id', id)
      .order('id', { ascending: true }).limit(500);
    if (error) throw databaseError(error, 'REFERRAL_EVENTS_FAILED');
    return data || [];
  }

  async function contextFor(rows) {
    const list = Array.isArray(rows) ? rows : [rows].filter(Boolean);
    const userIDs = [];
    const phones = [];
    for (const row of list) {
      if (row.contact_phone) phones.push(row.contact_phone);
      userIDs.push(
        row.referred_by_user_id, row.original_target_user_id, row.owner_user_id,
        row.resolved_by_user_id, row.actor_user_id, row.from_user_id, row.to_user_id
      );
    }
    const [users, contacts] = await Promise.all([
      selectIn(db(), 'sms_users', 'id,email,display_name,role,is_active,is_legacy_shared', 'id', userIDs),
      selectIn(db(), 'sms_contacts', 'phone,name,first_name,last_name', 'phone', phones)
    ]);
    return {
      users: new Map(users.map(row => [String(row.id), row])),
      contacts: new Map(contacts.map(row => [row.phone, row]))
    };
  }

  return {
    eligibleUsers,
    listRows,
    getRow,
    getEvents,
    contextFor,
    create: args => rpc('create_sms_conversation_referral', {
      p_workspace_id: workspaceID,
      p_contact_phone: args.contactPhone,
      p_actor_user_id: args.actorID,
      p_target_kind: args.targetKind,
      p_target_user_id: args.targetUserID,
      p_note: args.note
    }),
    claim: args => rpc('claim_sms_conversation_referral', {
      p_workspace_id: workspaceID, p_referral_id: args.id, p_actor_user_id: args.actorID
    }),
    reassign: args => rpc('reassign_sms_conversation_referral', {
      p_workspace_id: workspaceID, p_referral_id: args.id, p_actor_user_id: args.actorID,
      p_target_user_id: args.targetUserID, p_note: args.note
    }),
    handBack: args => rpc('hand_back_sms_conversation_referral', {
      p_workspace_id: workspaceID, p_referral_id: args.id, p_actor_user_id: args.actorID,
      p_note: args.note
    }),
    resolve: args => rpc('resolve_sms_conversation_referral', {
      p_workspace_id: workspaceID, p_referral_id: args.id, p_actor_user_id: args.actorID
    })
  };
}

module.exports = { MAX_LIST_ROWS, WORKSPACE_ID, createReferralStore, databaseError };
