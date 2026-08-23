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
 *   Campaign draft/review/schedule call sites now exist, so their types are
 *   active. `campaign.launched` remains reserved because this release has no
 *   live delivery worker. The writer therefore still throws if code claims a
 *   launch occurred before that capability exists.
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
  // A name or phone change. Low stakes on its own, but it is how a display name
  // in every other audit row comes to differ from the one recorded there.
  'team.member.profile_updated': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'detail', severity: 'info'
  }),
  // Somebody ASKED to move an account onto another address. Nothing has changed
  // yet, and it may never be confirmed, which is exactly why this is recorded
  // separately: a hijacker with a borrowed session who requests a move to their
  // own address, and is thwarted by the victim ignoring the heads-up email,
  // would otherwise leave no trace anywhere.
  'team.member.email_change_requested': Object.freeze({
    category: 'team', entityType: 'user', visibility: 'feed', severity: 'warning'
  }),
  // An email change is an identity change: it is the address a password reset
  // is sent to, so an unnoticed one is how an account is taken over. `feed` and
  // `warning`, deliberately louder than a profile edit.
  'team.member.email_changed': Object.freeze({
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

  // ── Campaigns ────────────────────────────────────────────────────────────
  'campaign.created': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'info'
  }),
  'campaign.drafts.generated': Object.freeze({
    category: 'campaigns', entityType: 'campaign_generation', visibility: 'feed', severity: 'info'
  }),
  'campaign.edited': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'info'
  }),
  'campaign.review_submitted': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice'
  }),
  'campaign.rejected': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice'
  }),
  // Approval is consent-bearing: the campaign remains approval_pending until
  // the audit row exists, and therefore cannot be scheduled if this write
  // fails. This records the exact frozen revision/audience hashes.
  'campaign.approved': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', consentBearing: true
  }),
  'campaign.scheduled': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice'
  }),
  // Still reserved: this foundation intentionally has no delivery worker or
  // launch endpoint, so a launched event would be a false claim.
  'campaign.launched': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice', reserved: true
  }),
  'campaign.cancelled': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice'
  }),
  // Destroying a campaign row is the only genuinely irreversible action in the
  // campaigns feature, so it is a warning and it is on the feed. It is only
  // ever reachable for a draft with no approval history and no recipient that
  // reached a provider; everything else archives. See delete_sms_campaign in
  // scripts/campaign-segments-migration.sql, which enforces that in SQL rather
  // than trusting the route.
  'campaign.deleted': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'warning'
  }),
  // Reversible, and the row survives. It is how a campaign that carries an
  // audit trail leaves the working list without any evidence being destroyed.
  'campaign.archived': Object.freeze({
    category: 'campaigns', entityType: 'campaign', visibility: 'feed', severity: 'notice'
  }),

  // ── Campaign segments ────────────────────────────────────────────────────
  // A segment is who the engine says to talk to. Creating one, or overriding
  // one, is a decision about which customers get contacted, so it belongs on
  // the feed rather than only in the forensic view.
  'campaign.segment.created': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'feed', severity: 'info'
  }),
  // High volume once an operator is curating a list, so detail rather than
  // feed. The segment timeline still shows every one.
  'campaign.segment.member_added': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'detail', severity: 'info'
  }),
  'campaign.segment.member_removed': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'detail', severity: 'info'
  }),
  // An override is a person overruling the arithmetic. An exclusion in
  // particular is permanent until revoked and survives every recompute, so it
  // is a notice on the feed: somebody must be able to find out later who did it.
  'campaign.segment.override_set': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'feed', severity: 'notice'
  }),
  'campaign.segment.override_revoked': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'feed', severity: 'notice'
  }),
  // Routine and potentially frequent. Detail, not feed.
  'campaign.segment.recomputed': Object.freeze({
    category: 'campaigns', entityType: 'campaign_segment', visibility: 'detail', severity: 'info'
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
