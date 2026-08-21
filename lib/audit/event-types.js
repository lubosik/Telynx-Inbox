'use strict';
/**
 * lib/audit/event-types.js — the single registry of audit event types.
 *
 * Every audit row's category, entity type, visibility and severity is decided
 * here, not at the call site. Two reasons:
 *
 *   1. `category` is a stored column with a CHECK constraint, and it is what a
 *      UI tab filters on with `.eq()`. If tabs filtered by listing their event
 *      types instead, that list would grow forever and end up inside a Supabase
 *      `.in()`, which serialises into the request URL — the exact shape that
 *      took the inbox down on 20 August 2026. Deciding category centrally keeps
 *      the read path a single equality filter.
 *
 *   2. sms_audit_log cannot be UPDATEd. A row written with the wrong category
 *      or visibility is wrong permanently. One table of definitions is far
 *      easier to review than forty call sites.
 *
 * RESERVED TYPES
 *   The `campaign.*` types are declared now and marked `reserved: true`. The
 *   campaigns feature does not exist yet. They are declared early so the
 *   `category` CHECK constraint already permits 'campaigns' — widening a CHECK
 *   on a table nobody can UPDATE is not something to leave to a future rush.
 *   The writer THROWS on a reserved type, so a campaign event cannot be emitted
 *   before the feature that gives it meaning exists.
 */

const CATEGORIES = Object.freeze([
  'messages', 'calls', 'automations', 'campaigns', 'contacts', 'team', 'settings', 'security'
]);
const VISIBILITIES = Object.freeze(['feed', 'detail', 'audit']);
const SEVERITIES = Object.freeze(['info', 'notice', 'warning']);
const ACTOR_TYPES = Object.freeze(['user', 'system', 'integration', 'contact', 'anonymous']);

/**
 * visibility
 *   feed   — belongs in the main Activity Center list
 *   detail — correct and worth keeping, but too frequent for the main list;
 *            shown on an entity or contact timeline
 *   audit  — compliance/forensic only; hidden unless includeAudit=true
 *
 * severity
 *   info    — routine
 *   notice  — a deliberate human decision worth noticing
 *   warning — silently destructive or hard to reverse
 *
 * consentBearing
 *   A write failure for these types FAILS the originating request. A consent
 *   record that could not be written must stop the action, not be logged and
 *   shrugged off.
 */
const EVENT_TYPES = Object.freeze({
  // ── Automations ─────────────────────────────────────────────────────────
  // The flagship: one Admin needs to see what another Admin cancelled.
  'automation.queue_item.cancelled': Object.freeze({
    category: 'automations', entityType: 'scheduled_message', visibility: 'feed', severity: 'notice'
  }),
  // One summary row per bulk cancel, never one row per message. A single
  // WooCommerce webhook can cancel a dozen queued messages, and twelve rows
  // would bury everything a human actually needs to read.
  'automation.queue_item.bulk_cancelled': Object.freeze({
    category: 'automations', entityType: 'scheduled_message_set', visibility: 'feed', severity: 'notice'
  }),
  // High volume and automatic, so it stays off the main feed but remains on
  // the order/contact timeline, where "why was this queued?" gets asked.
  'automation.queue_item.scheduled': Object.freeze({
    category: 'automations', entityType: 'scheduled_message', visibility: 'detail', severity: 'info'
  }),
  // Failures are audited. Successful automated sends are NOT: sms_sent_log is
  // already that ledger, and its unique index makes a double-insert impossible.
  'automation.queue_item.failed': Object.freeze({
    category: 'automations', entityType: 'scheduled_message', visibility: 'feed', severity: 'warning'
  }),

  // ── Contacts ────────────────────────────────────────────────────────────
  'contact.created': Object.freeze({
    category: 'contacts', entityType: 'contact', visibility: 'feed', severity: 'info'
  }),
  'contact.updated': Object.freeze({
    category: 'contacts', entityType: 'contact', visibility: 'detail', severity: 'info'
  }),
  // Warning, not info: changing the phone number silently detaches every
  // message and order in the history, because those rows key on the number.
  'contact.phone_changed': Object.freeze({
    category: 'contacts', entityType: 'contact', visibility: 'feed', severity: 'warning'
  }),
  'contact.opted_out': Object.freeze({
    category: 'contacts', entityType: 'contact', visibility: 'feed', severity: 'notice', consentBearing: true
  }),
  'contact.opt_in_restored': Object.freeze({
    category: 'contacts', entityType: 'contact', visibility: 'feed', severity: 'notice', consentBearing: true
  }),
  'contact.bulk_imported': Object.freeze({
    category: 'contacts', entityType: 'contact_set', visibility: 'feed', severity: 'warning'
  }),

  // ── Calls ───────────────────────────────────────────────────────────────
  'call.recording.started': Object.freeze({
    category: 'calls', entityType: 'call', visibility: 'detail', severity: 'notice'
  }),
  'call.recording.stopped': Object.freeze({
    category: 'calls', entityType: 'call', visibility: 'detail', severity: 'info'
  }),
  // Who listened to a customer recording is a compliance question, not feed
  // material, so it is visibility 'audit'.
  'recording.played': Object.freeze({
    category: 'calls', entityType: 'call_recording', visibility: 'audit', severity: 'notice'
  }),
  'recording.purged': Object.freeze({
    category: 'calls', entityType: 'call_recording', visibility: 'audit', severity: 'warning'
  }),

  // ── Team ────────────────────────────────────────────────────────────────
  // The other flagship, alongside automation.queue_item.cancelled. "One Admin
  // must be able to see what another Admin did" is meaningless if the most
  // sensitive class of admin action — granting and revoking access — is
  // invisible. sms_auth_events records who signed in, not who changed what
  // somebody is allowed to do.
  //
  // Every summary for these types names the actor AND the target explicitly,
  // and spells roles with their catalogue display names ('Support Agent', not
  // 'agent'), because the summary is rendered once and must still read
  // correctly years after the roles table has been edited.
  //
  // No password hash, invitation token, or token hash may ever appear on one
  // of these rows. The metadata allowlists in lib/audit/redact.js deliberately
  // omit every such key, SECRET_KEY_PATTERN drops them a second time even if
  // an allowlist is edited by mistake, and test/audit-team.test.js asserts
  // their absence in the serialised row.
  'team.member.invited': Object.freeze({
    category: 'team', entityType: 'user_invitation', visibility: 'feed', severity: 'notice'
  }),
  'team.invitation.revoked': Object.freeze({
    category: 'team', entityType: 'user_invitation', visibility: 'feed', severity: 'notice'
  }),
  // Fires when an account becomes able to sign in: an invitation redeemed, or
  // an account created directly with a password.
  'team.member.activated': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'notice'
  }),
  // THE flagship team event. Carries previous_state/new_state/changed_fields
  // so the row answers "what was it before?" without a second lookup.
  'team.member.role_changed': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'warning'
  }),
  // Warning: it revokes every live session and locks the person out mid-shift.
  'team.member.deactivated': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'warning'
  }),
  'team.member.reactivated': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'notice'
  }),
  // Warning: an admin-issued temporary password is an account-takeover path by
  // design. Who reset whose password, and when, is the question afterwards.
  'team.member.password_reset': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'warning'
  }),
  // Per-user permission overrides from PATCH /api/users/:id. These sidestep the
  // role catalogue entirely, so they need their own rows rather than being
  // folded into a role change.
  'team.permission_override.granted': Object.freeze({
    category: 'team', entityType: 'user_permission_grant', visibility: 'feed', severity: 'warning'
  }),
  'team.permission_override.revoked': Object.freeze({
    category: 'team', entityType: 'user_permission_grant', visibility: 'feed', severity: 'notice'
  }),

  // ── Messages (bulk, human-triggered) ────────────────────────────────────
  // Routine outbound sends are NOT audited: sms_sent_log and sms_messages are
  // already that ledger. These two are, because a person pressed a button that
  // messaged customers who were not expecting it.
  //
  // One summary row per run, never one per recipient, for the same reason
  // automation.queue_item.bulk_cancelled is a single row.
  'message.catchup.sent': Object.freeze({
    category: 'messages', entityType: 'catchup_run', visibility: 'feed', severity: 'warning'
  }),
  // A campaign suggestion is one AI-drafted message to one contact, approved
  // and released by a human. Category 'campaigns' because that is the tab it
  // belongs on; it is unrelated to the reserved campaign.* types below, which
  // describe a campaigns feature that does not exist yet.
  'campaign.suggestion.sent': Object.freeze({
    category: 'campaigns', entityType: 'campaign_suggestion', visibility: 'feed', severity: 'notice'
  }),
  'campaign.suggestion.dismissed': Object.freeze({
    category: 'campaigns', entityType: 'campaign_suggestion', visibility: 'detail', severity: 'info'
  }),

  // ── Security ────────────────────────────────────────────────────────────
  // Records that SIP credentials were issued, and to whom. The password is
  // never part of this row; see lib/audit/redact.js.
  'security.voice_credentials.issued': Object.freeze({
    category: 'security', entityType: 'sip_credential', visibility: 'audit', severity: 'notice'
  }),

  // ── Settings / sync ─────────────────────────────────────────────────────
  'settings.sync.triggered': Object.freeze({
    category: 'settings', entityType: 'sync_job', visibility: 'feed', severity: 'info'
  }),
  'settings.sync.completed': Object.freeze({
    category: 'settings', entityType: 'sync_job', visibility: 'detail', severity: 'info'
  }),
  'settings.sync.failed': Object.freeze({
    category: 'settings', entityType: 'sync_job', visibility: 'feed', severity: 'warning'
  }),

  // ── Campaigns (reserved — the writer throws on these) ────────────────────
  'campaign.created': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'info', reserved: true
  }),
  'campaign.edited': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'info', reserved: true
  }),
  'campaign.approved': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', reserved: true
  }),
  'campaign.scheduled': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', reserved: true
  }),
  'campaign.launched': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', reserved: true
  }),
  'campaign.cancelled': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', reserved: true
  })
});

const EVENT_TYPE_NAMES = Object.freeze(Object.keys(EVENT_TYPES));

function eventDefinition(eventType) {
  return EVENT_TYPES[eventType] || null;
}

function isReservedEventType(eventType) {
  return Boolean(EVENT_TYPES[eventType]?.reserved);
}

function isConsentBearing(eventType) {
  return Boolean(EVENT_TYPES[eventType]?.consentBearing);
}

module.exports = {
  ACTOR_TYPES,
  CATEGORIES,
  EVENT_TYPES,
  EVENT_TYPE_NAMES,
  SEVERITIES,
  VISIBILITIES,
  eventDefinition,
  isConsentBearing,
  isReservedEventType
};
