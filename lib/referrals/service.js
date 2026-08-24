'use strict';

const { createReferralStore } = require('./store');
const { assignedNotification, resolvedNotification } = require('./notifications');

const E164 = /^[+][1-9][0-9]{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTE_MAX = 1000;
const ATTENTION_AFTER_MS = 30 * 60 * 1000;

const STATUS_BY_CODE = Object.freeze({
  REFERRALS_NOT_READY: 503,
  REFERRAL_NOT_FOUND: 404,
  REFERRAL_CONVERSATION_NOT_FOUND: 404,
  REFERRAL_ALREADY_OPEN: 409,
  REFERRAL_ALREADY_CLAIMED: 409,
  REFERRAL_ALREADY_RESOLVED: 409,
  REFERRAL_ALREADY_HANDED_BACK: 409,
  REFERRAL_TARGET_UNCHANGED: 409,
  REFERRAL_NOT_CLAIMABLE: 403,
  REFERRAL_NOT_OWNED: 409,
  REFERRAL_ACTION_FORBIDDEN: 403,
  REFERRAL_ACTOR_INELIGIBLE: 403,
  REFERRAL_TARGET_INELIGIBLE: 400,
  REFERRAL_TARGET_INVALID: 400,
  REFERRAL_TARGET_KIND_INVALID: 400,
  REFERRAL_NOTE_REQUIRED: 400,
  REFERRAL_NOTE_TOO_LONG: 400,
  REFERRAL_PHONE_INVALID: 400,
  REFERRAL_USE_HAND_BACK: 409,
  REFERRAL_REFERRER_UNAVAILABLE: 409
});

class ReferralRequestError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ReferralRequestError';
    this.code = code;
    this.status = status;
  }
}

function normaliseError(error) {
  if (error instanceof ReferralRequestError) return error;
  const code = error?.code || String(error?.message || '').match(/REFERRAL_[A-Z_]+/)?.[0];
  if (code && STATUS_BY_CODE[code]) {
    const messages = {
      REFERRAL_ALREADY_OPEN: 'This conversation already has an open referral.',
      REFERRAL_ALREADY_CLAIMED: 'Another teammate already claimed this referral.',
      REFERRAL_NOT_CLAIMABLE: 'This referral is not available for this account to claim.',
      REFERRAL_USE_HAND_BACK: 'Use Hand Back when returning a referral to its original sender.',
      REFERRAL_REFERRER_UNAVAILABLE: 'The original referrer cannot currently receive this conversation.'
    };
    return new ReferralRequestError(messages[code] || 'The referral request was refused.', code, STATUS_BY_CODE[code]);
  }
  return error;
}

function actorID(actor) {
  const id = Number(actor?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function has(actor, permission) {
  return actor?.can?.(permission) === true || actor?.permissions?.has?.(permission) === true;
}

function namedActor(actor, permission) {
  if (!actorID(actor) || actor?.isLegacyShared || actor?.viaLegacySession) {
    throw new ReferralRequestError(
      'Conversation referrals require a named team account.',
      'REFERRAL_NAMED_ACCOUNT_REQUIRED', 409
    );
  }
  if (permission && !has(actor, permission)) {
    throw new ReferralRequestError('You do not have access to this referral action.', 'REFERRAL_ACTION_FORBIDDEN', 403);
  }
  return actorID(actor);
}

function cleanNote(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ReferralRequestError('A hand-back note is required.', 'REFERRAL_NOTE_REQUIRED', 400);
    return null;
  }
  if (typeof value !== 'string') {
    throw new ReferralRequestError('The internal note must be text.', 'REFERRAL_NOTE_INVALID', 400);
  }
  const note = value.trim();
  if (!note && required) throw new ReferralRequestError('A hand-back note is required.', 'REFERRAL_NOTE_REQUIRED', 400);
  if (note.length > NOTE_MAX) throw new ReferralRequestError('The internal note is too long.', 'REFERRAL_NOTE_TOO_LONG', 400);
  return note || null;
}

function userShape(row) {
  if (!row) return null;
  return { id: String(row.id), name: row.display_name, role: row.role };
}

function contactName(row, fallback) {
  const full = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
  return row?.name || full || fallback;
}

function shapeRow(row, context, now = Date.now()) {
  const user = value => context.users.get(String(value));
  const contact = context.contacts.get(row.contact_phone);
  return {
    id: String(row.id),
    contactPhone: row.contact_phone,
    contactName: contactName(contact, row.contact_phone),
    referredBy: userShape(user(row.referred_by_user_id)),
    targetKind: row.target_kind,
    originalTarget: userShape(user(row.original_target_user_id)),
    owner: userShape(user(row.owner_user_id)),
    state: row.state,
    initialNote: row.initial_note || null,
    claimedAt: row.claimed_at || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: userShape(user(row.resolved_by_user_id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    attentionRequired: row.state === 'pending' && now - Date.parse(row.created_at) >= ATTENTION_AFTER_MS
  };
}

function shapeEvent(row, context) {
  const user = value => userShape(context.users.get(String(value)));
  return {
    id: String(row.id), action: row.action, actor: user(row.actor_user_id),
    from: user(row.from_user_id), to: user(row.to_user_id), note: row.note || null,
    occurredAt: row.occurred_at
  };
}

function maySee(row, actor) {
  const id = actorID(actor);
  if (!id) return false;
  if (['owner', 'admin'].includes(actor.role)) return true;
  return [row.referred_by_user_id, row.original_target_user_id, row.owner_user_id]
    .some(value => Number(value) === id);
}

function createReferralService({ store, now = () => Date.now() } = {}) {
  const records = store || createReferralStore();

  async function recipients(actor) {
    const id = namedActor(actor, 'referral.create');
    if (!has(actor, 'conversation.read') || !has(actor, 'message.send')) {
      throw new ReferralRequestError('You cannot refer a conversation you cannot work in.', 'REFERRAL_ACTION_FORBIDDEN', 403);
    }
    const rows = await records.eligibleUsers();
    return rows.filter(row => Number(row.id) !== id).map(row => ({
      id: String(row.id), name: row.display_name, role: row.role,
      lastSeenAt: row.last_seen_at || null,
      canReceiveAnyAdmin: ['owner', 'admin'].includes(row.role)
    }));
  }

  async function enrich(rows) {
    const context = await records.contextFor(rows);
    return { items: rows.map(row => shapeRow(row, context, now())), context };
  }

  async function list(query, actor) {
    const id = namedActor(actor, 'referral.read');
    const box = ['all', 'received', 'sent'].includes(query?.box) ? query.box : 'all';
    const includeResolved = query?.includeResolved !== 'false';
    const oversight = query?.oversight === 'true' && ['owner', 'admin'].includes(actor.role);
    const rows = await records.listRows({ actorID: id, actorRole: actor.role, box, includeResolved, oversight });
    const visible = rows.filter(row => maySee(row, actor));
    const { items } = await enrich(visible);
    // Context contains lookup Maps used only while shaping the response. Keep
    // that internal rather than relying on Map's current JSON representation
    // (`{}`), which could become an accidental metadata surface if the lookup
    // implementation changes later.
    return { items };
  }

  async function get(id, actor) {
    namedActor(actor, 'referral.read');
    if (!UUID.test(String(id || ''))) throw new ReferralRequestError('Referral not found.', 'REFERRAL_NOT_FOUND', 404);
    const row = await records.getRow(id);
    if (!row || !maySee(row, actor)) throw new ReferralRequestError('Referral not found.', 'REFERRAL_NOT_FOUND', 404);
    const events = await records.getEvents(id);
    const context = await records.contextFor([row, ...events]);
    return { referral: shapeRow(row, context, now()), events: events.map(event => shapeEvent(event, context)) };
  }

  async function create(input, actor) {
    const id = namedActor(actor, 'referral.create');
    if (!has(actor, 'conversation.read') || !has(actor, 'message.send')) {
      throw new ReferralRequestError('You cannot refer a conversation you cannot work in.', 'REFERRAL_ACTION_FORBIDDEN', 403);
    }
    const phone = String(input?.contactPhone || '').trim();
    if (!E164.test(phone)) throw new ReferralRequestError('A valid E.164 conversation phone is required.', 'REFERRAL_PHONE_INVALID', 400);
    if (!['directed', 'any_admin'].includes(input?.targetKind)) {
      throw new ReferralRequestError('Choose one teammate or explicitly choose Any Admin.', 'REFERRAL_TARGET_KIND_INVALID', 400);
    }
    const targetKind = input.targetKind;
    const note = cleanNote(input?.note);
    const eligible = await records.eligibleUsers();
    let targetUserID = null;
    let targets = [];
    if (targetKind === 'directed') {
      targetUserID = Number(input?.targetUserId);
      if (!Number.isSafeInteger(targetUserID) || targetUserID < 1) {
        throw new ReferralRequestError('Choose an eligible named teammate.', 'REFERRAL_TARGET_INELIGIBLE', 400);
      }
      const target = eligible.find(row => Number(row.id) === targetUserID && targetUserID !== id);
      if (!target) throw new ReferralRequestError('Choose an eligible named teammate.', 'REFERRAL_TARGET_INELIGIBLE', 400);
      targets = [target];
    } else {
      if (input?.targetUserId !== undefined && input?.targetUserId !== null) {
        throw new ReferralRequestError('Any Admin cannot also name one recipient.', 'REFERRAL_TARGET_INVALID', 400);
      }
      targets = eligible.filter(row => Number(row.id) !== id && ['owner', 'admin'].includes(row.role));
      if (!targets.length) throw new ReferralRequestError('No eligible Admin can receive this referral.', 'REFERRAL_TARGET_INELIGIBLE', 409);
    }
    let row;
    try {
      row = await records.create({ contactPhone: phone, actorID: id, targetKind, targetUserID, note });
    } catch (error) { throw normaliseError(error); }
    const context = await records.contextFor([row]);
    const referral = shapeRow(row, context, now());
    const notifications = targets.map(target => assignedNotification({
      referral: row, recipientUserID: target.id, referrerName: actor.displayName,
      contactName: referral.contactName, note
    }));
    return { referral, notifications };
  }

  async function transition(kind, input, actor) {
    const id = namedActor(actor, 'referral.act');
    if (!UUID.test(String(input?.id || ''))) throw new ReferralRequestError('Referral not found.', 'REFERRAL_NOT_FOUND', 404);
    if (kind === 'reassign') {
      const target = Number(input.targetUserId);
      if (!Number.isSafeInteger(target) || target < 1) {
        throw new ReferralRequestError('Choose an eligible named teammate.', 'REFERRAL_TARGET_INELIGIBLE', 400);
      }
    }
    let row;
    try {
      if (kind === 'claim') row = await records.claim({ id: input.id, actorID: id });
      if (kind === 'reassign') row = await records.reassign({
        id: input.id, actorID: id, targetUserID: Number(input.targetUserId), note: cleanNote(input.note)
      });
      if (kind === 'handBack') row = await records.handBack({ id: input.id, actorID: id, note: cleanNote(input.note, { required: true }) });
      if (kind === 'resolve') row = await records.resolve({ id: input.id, actorID: id });
    } catch (error) { throw normaliseError(error); }
    const context = await records.contextFor([row]);
    const referral = shapeRow(row, context, now());
    const notifications = [];
    if (kind === 'reassign' && row.owner_user_id) {
      notifications.push(assignedNotification({
        referral: row, recipientUserID: row.owner_user_id, referrerName: actor.displayName,
        contactName: referral.contactName, note: cleanNote(input.note)
      }));
    }
    if (kind === 'handBack' && row.owner_user_id && Number(row.owner_user_id) !== id) {
      notifications.push(assignedNotification({
        referral: row, recipientUserID: row.owner_user_id, referrerName: actor.displayName,
        contactName: referral.contactName, note: cleanNote(input.note, { required: true })
      }));
    }
    if (kind === 'resolve' && Number(row.referred_by_user_id) !== id) {
      notifications.push(resolvedNotification({
        referral: row, recipientUserID: row.referred_by_user_id, actorName: actor.displayName,
        contactName: referral.contactName
      }));
    }
    return { referral, notifications };
  }

  return {
    recipients, list, get, create,
    claim: (id, actor) => transition('claim', { id }, actor),
    reassign: (id, input, actor) => transition('reassign', { id, ...input }, actor),
    handBack: (id, input, actor) => transition('handBack', { id, ...input }, actor),
    resolve: (id, actor) => transition('resolve', { id }, actor)
  };
}

module.exports = {
  ATTENTION_AFTER_MS, ReferralRequestError, createReferralService, normaliseError, shapeRow
};
