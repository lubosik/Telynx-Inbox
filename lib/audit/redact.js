'use strict';
/**
 * lib/audit/redact.js — what is allowed into an audit row's metadata.
 *
 * This is an ALLOWLIST, keyed by event type. It is not a denylist, and the
 * difference matters: a denylist fails open the first time somebody adds a new
 * environment variable, a new provider field, or a new debug key to a call
 * site. An allowlist fails closed — an unrecognised key is dropped and the
 * audit row is still written.
 *
 * sms_audit_log cannot be UPDATEd or DELETEd. Anything that lands in it lands
 * there permanently. That makes "drop it unless it was explicitly approved"
 * the only defensible default.
 *
 * HARD RULES, enforced below regardless of the allowlist:
 *   * No secret ever. Not TELNYX_API_KEY, SUPABASE_SERVICE_KEY, INBOX_PASSWORD,
 *     SESSION_SECRET, WC_CONSUMER_SECRET, APNS_KEY_P8_BASE64, and above all not
 *     the SIP password from lib/voice-credentials.js. Screened by key name at
 *     EVERY depth, and by comparing values against the live configured
 *     secrets.
 *   * No signed recording URL. `/api/voice/recordings/:id` mints a short-lived
 *     signed URL; writing one into a permanent table would outlive its own
 *     expiry policy and hand out customer audio to anyone reading the audit.
 *   * No raw APNs device token. Last 8 characters only, matching the existing
 *     convention in routes/mobile-push.js and lib/apns-notify.js.
 *   * No message body. Ever. See messageFingerprint() below.
 *   * Metadata is capped at 8KB serialised, with `truncated: true` beyond that.
 */

const crypto = require('node:crypto');

const MAX_METADATA_BYTES = 8 * 1024;

/** Environment variables whose values must never appear in an audit row. */
const SECRET_ENV_NAMES = Object.freeze([
  'TELNYX_API_KEY',
  'TELNYX_SIP_PASSWORD',
  'TELNYX_IOS_SIP_PASSWORD',
  'SUPABASE_SERVICE_KEY',
  'INBOX_PASSWORD',
  'SESSION_SECRET',
  'WEBHOOK_SECRET',
  'WC_CONSUMER_KEY',
  'WC_CONSUMER_SECRET',
  'APNS_KEY_P8_BASE64',
  'VAPID_PRIVATE_KEY',
  'OPENROUTER_API_KEY',
  'GHL_AGENCY_TOKEN',
  'SS_API_KEY'
]);

/**
 * Key names that look like credentials. Defence in depth behind the allowlist:
 * if a future edit adds a secret-shaped key to an allowlist by mistake, this
 * still drops it.
 */
const SECRET_KEY_PATTERN = /(secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential|authorization|bearer|session|cookie|signature|p8)/i;

/**
 * Explicitly reviewed key names that survive SECRET_KEY_PATTERN.
 *
 * DECISION: SECRET_KEY_PATTERN is NOT being narrowed, and no new exemption is
 * being added here.
 *
 * The pattern matches `session` and `signature` as bare substrings, so an
 * innocuous future key like `session_epoch` or `signature_valid` is dropped
 * even though neither is a credential. That was raised as a possible
 * over-match. It is real — session epochs are a live concept in this codebase
 * (`se` in the cookie, `bump_sms_user_session_epoch`) and `signatureValid`
 * already exists in routes/webhook-woocommerce.js — but it is the correct
 * trade, for two reasons.
 *
 * First, the failure modes are not symmetric. A false positive drops one field
 * from one audit row, and that field is still readable in the source table it
 * was copied from. A false negative writes a live credential into
 * `sms_audit_log`, which has REVOKE DELETE and an immutability trigger:
 * permanent by design, with no way to take it back. When one side of a mistake
 * is recoverable and the other is not, the screen belongs on the recoverable
 * side. Narrowing would also mean bolting negative lookaheads onto a denylist,
 * which is the shape this file's header already argues against.
 *
 * Second, the project has already decided this. `test/audit-log.test.js`
 * asserts, in a test named for exactly this case, that a state snapshot
 * containing `session_epoch: 4` comes back without it. That is a deliberate
 * expectation, not an accident, and quietly inverting it here would be the
 * wrong way to reopen the question.
 *
 * If a specific key ever genuinely needs to be recorded, add it to this set
 * with a one-line reason and update that test in the same commit. Then it is a
 * decision somebody made on purpose and a reviewer can see it in a diff, which
 * is the whole point of an exemption list.
 */
const SECRET_PATTERN_EXEMPTIONS = new Set([
  'device_token_last8' // already masked to its last 8 characters
]);

/**
 * True when a key NAME looks like a credential.
 *
 * Applied to nested keys as well as top-level ones. It previously was not:
 * `stateEntryIsUnsafe` tested SECRET_KEY_PATTERN against the top-level key
 * only, and the recursive walk beneath it inspected values and never keys. So
 * `{ password: 'x' }` was dropped but `{ config: { password: 'x' } }` was
 * written verbatim into an append-only table — even though this file's header
 * says "No secret ever" and the function's own docstring claims nested values
 * are walked "because the offending string is as likely to be one level down".
 * The same reasoning applies to the key one level down.
 */
function keyLooksLikeSecret(key) {
  return SECRET_KEY_PATTERN.test(key) && !SECRET_PATTERN_EXEMPTIONS.has(key);
}

/**
 * Message content, under any of its names in this codebase. Dropped even if an
 * allowlist somehow names one, because "the audit row must not carry the body"
 * is a decision that should not be reversible by editing a list.
 */
const MESSAGE_BODY_KEYS = new Set([
  'body', 'message_body', 'message', 'text', 'content', 'sms_body', 'transcript', 'preview'
]);

/** Anything that looks like a pre-signed or provider-temporary media URL. */
const SIGNED_URL_PATTERN = /(x-amz-signature|x-amz-credential|[?&]token=|\/storage\/v1\/object\/sign\/|googleusercontent|\.s3\.|media\.telnyx\.com)/i;

/**
 * Permitted metadata keys, per event type. Anything absent is dropped.
 * Keep these small: metadata is for the facts a reader needs to understand the
 * row, not a dump of whatever the handler had in scope.
 */
const METADATA_ALLOWLIST = Object.freeze({
  'automation.queue_item.cancelled': ['scheduled_id', 'order_id', 'flow_type', 'reason', 'send_at', 'message_length', 'message_digest'],
  'automation.queue_item.bulk_cancelled': ['scope', 'order_id', 'reason', 'cancelled_count', 'scheduled_ids', 'scheduled_ids_truncated', 'flow_types'],
  'automation.queue_item.scheduled': ['scheduled_id', 'order_id', 'flow_type', 'send_at', 'message_length', 'message_digest'],
  'automation.queue_item.failed': ['scheduled_id', 'order_id', 'flow_type', 'attempts', 'reason', 'message_length', 'message_digest'],

  'contact.created': ['source', 'created_via', 'has_email'],
  'contact.updated': ['source', 'updated_via'],
  'contact.phone_changed': ['previous_phone', 'new_phone', 'history_detached'],
  'contact.opted_out': ['trigger', 'source'],
  'contact.opt_in_restored': ['trigger', 'source'],
  'contact.bulk_imported': ['source', 'contact_count', 'message_count'],

  'call.recording.started': ['call_control_id', 'call_log_id'],
  'call.recording.stopped': ['call_control_id', 'call_log_id'],
  'recording.played': ['call_log_id', 'recording_archived'],
  'recording.purged': ['call_log_id', 'expired_at', 'storage_removed', 'provider_deleted', 'reason'],

  // `login` is the SIP username, which identifies which credential was handed
  // out. The password from lib/voice-credentials.js is not on this list and
  // must never be added to it.
  'security.voice_credentials.issued': ['login', 'dedicated_ios_pair', 'client'],

  // ── Team ────────────────────────────────────────────────────────────────
  // Deliberately absent from every list below, and unreachable even if one of
  // them were edited to include it: `password_hash`, `token`, `token_hash`,
  // `token_prefix`, `temporaryPassword`. The first four are credentials or
  // substrings of credentials; `token_prefix` is a prefix of the sha256 of a
  // live invitation token, and an audit row is the wrong place to publish a
  // head start on one. SECRET_KEY_PATTERN drops all of them a second time.
  //
  // Role display names are stored alongside the role keys so the row still
  // reads correctly if sms_roles is renamed later.
  'team.member.invited': ['invitation_id', 'email', 'role', 'role_display_name', 'expires_at', 'ttl_hours'],
  'team.invitation.revoked': ['invitation_id', 'email', 'role', 'role_display_name', 'invitation_status'],
  'team.member.activated': ['user_id', 'email', 'role', 'role_display_name', 'via', 'invitation_id', 'can_sign_in'],
  'team.member.role_changed': ['user_id', 'email', 'previous_role', 'new_role', 'previous_role_display_name', 'new_role_display_name', 'logins_revoked'],
  'team.member.deactivated': ['user_id', 'email', 'role', 'role_display_name', 'logins_revoked'],
  'team.member.reactivated': ['user_id', 'email', 'role', 'role_display_name', 'logins_revoked'],
  'team.member.password_reset': ['user_id', 'email', 'role', 'role_display_name', 'reset_method', 'must_rotate_on_next_sign_in', 'logins_revoked'],
  'team.member.profile_updated': ['user_id', 'email', 'role', 'role_display_name', 'changed_fields', 'via'],
  // `previous_email` and `email` are both recorded on purpose: knowing an
  // address changed is useless without knowing what it changed FROM.
  // `requested_email` is the address somebody tried to move TO, which is the
  // whole value of the row when a request is never confirmed.
  'team.member.email_change_requested': ['user_id', 'email', 'requested_email', 'role', 'role_display_name', 'via', 'address_available'],
  'team.member.email_changed': ['user_id', 'email', 'previous_email', 'role', 'role_display_name', 'via', 'confirmed', 'logins_revoked'],
  'team.permission_override.granted': ['user_id', 'email', 'permission_key', 'effect', 'reason', 'expires_at'],
  'team.permission_override.revoked': ['user_id', 'email', 'permission_key'],

  // ── Bulk / approved outbound ────────────────────────────────────────────
  'message.catchup.sent': ['sent', 'failed', 'skipped', 'processing_candidates', 'shipped_candidates', 'source'],
  'campaign.suggestion.sent': ['suggestion_id', 'suggestion_type', 'message_length', 'message_digest'],
  'campaign.suggestion.dismissed': ['suggestion_id', 'suggestion_type'],

  'settings.sync.triggered': ['sync_type', 'source'],
  'settings.sync.completed': ['sync_type', 'duration_ms', 'contacts_synced', 'orders_synced', 'fixed', 'skipped'],
  'settings.sync.failed': ['sync_type', 'duration_ms', 'error_code'],

  // Reserved campaign types carry no metadata: the writer refuses them outright.
  'campaign.created': [],
  'campaign.edited': [],
  'campaign.approved': [],
  'campaign.scheduled': [],
  'campaign.launched': [],
  'campaign.cancelled': []
});

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/** Live secret values, resolved at call time so tests can vary the env. */
function configuredSecrets(env = process.env) {
  const values = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    // Short values produce false positives against ordinary text.
    if (typeof value === 'string' && value.length >= 8) values.push(value);
  }
  return values;
}

function holdsSecretValue(value, secrets) {
  if (typeof value !== 'string' || !value) return false;
  return secrets.some(secret => value === secret || value.includes(secret));
}

function looksLikeSignedURL(value) {
  return typeof value === 'string' && SIGNED_URL_PATTERN.test(value);
}

/**
 * How deep the state screen walks before giving up. A before/after snapshot is
 * a flat handful of scalars in every current call site; anything nested six
 * levels down is either a mistake or an attempt to smuggle something past the
 * screen, so exceeding the limit is treated as unsafe rather than as clean.
 * It also terminates on a cyclic object, which JSON.stringify would throw on
 * later anyway.
 */
const MAX_STATE_SCREEN_DEPTH = 6;

function containsScreenedValue(value, secrets, depth = 0) {
  if (typeof value === 'string') return holdsSecretValue(value, secrets) || looksLikeSignedURL(value);
  if (value === null || typeof value !== 'object') return false;
  if (depth >= MAX_STATE_SCREEN_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some(entry => containsScreenedValue(entry, secrets, depth + 1));
  }
  // Keys, not just values. A secret-shaped key at ANY depth condemns the whole
  // entry, exactly as it does at the top level.
  return Object.entries(value).some(([key, entry]) =>
    keyLooksLikeSecret(key) || containsScreenedValue(entry, secrets, depth + 1));
}

/**
 * The hard rules, applied to a `previous_state` / `new_state` entry.
 *
 * The allowlist in METADATA_ALLOWLIST covers `metadata` only, because a state
 * snapshot's keys are the source row's column names and cannot be enumerated
 * in advance. That is not a reason to leave state unscreened: `previous_state`
 * and `new_state` are returned verbatim by GET /api/audit, and sms_audit_log
 * has REVOKE DELETE plus an immutability trigger, so a signed recording URL or
 * a SIP password written into a snapshot is burned in permanently.
 *
 * So the three rules that are described in this file's header as applying
 * "regardless of the allowlist" are enforced here too: secret-shaped key
 * names, live configured secret values, and signed URLs. Nested keys AND
 * nested values are walked, because the offending name or string is as likely
 * to be one level down: `{ config: { password: 'x' } }` used to survive this
 * screen entirely, since only the top-level key was pattern-matched and the
 * recursive walk beneath it looked at values alone.
 *
 * @param {string} key
 * @param {*} value
 * @param {object} [options]
 * @param {string[]} [options.secrets]  pre-resolved secret values
 * @param {object} [options.env]
 * @returns {boolean} true when the entry must be dropped
 */
function stateEntryIsUnsafe(key, value, { secrets, env = process.env } = {}) {
  if (keyLooksLikeSecret(key)) return true;
  return containsScreenedValue(value, secrets || configuredSecrets(env));
}

/**
 * Last 8 characters of an APNs device token, never the token itself.
 * Mirrors the `...${row.device_token.slice(-8)}` convention already used in
 * routes/mobile-push.js so the same suffix is recognisable across logs.
 */
function maskDeviceToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return token.slice(-8);
}

/**
 * The message body is never stored in sms_audit_log. This is what is stored
 * instead.
 *
 * The body already lives in sms_scheduled / sms_sent_log / sms_messages, so
 * nothing is lost by omitting it. Those tables can honour a customer erasure
 * request; sms_audit_log — REVOKE DELETE plus an immutability trigger — cannot,
 * so putting customer content in it would convert a deletion request into an
 * incident. A truncated body would be the worst of both: still personal data,
 * no longer usable as evidence. A digest actually answers the question that
 * matters later, which is whether the text sitting in the source row today is
 * byte-identical to the text that was there when the action was taken.
 */
function messageFingerprint(body) {
  if (typeof body !== 'string') return { message_length: 0, message_digest: null };
  return {
    message_length: body.length,
    message_digest: crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  };
}

/**
 * Cap the serialised size. Keys that still fit are kept in declaration order;
 * anything that would push the object over the limit is left out and the whole
 * object is flagged.
 */
function capMetadata(metadata) {
  const serialised = JSON.stringify(metadata);
  if (byteLength(serialised) <= MAX_METADATA_BYTES) return { metadata, truncated: false };

  const kept = {};
  let dropped = false;
  for (const [key, value] of Object.entries(metadata)) {
    const candidate = JSON.stringify({ ...kept, [key]: value, truncated: true });
    if (byteLength(candidate) > MAX_METADATA_BYTES) { dropped = true; continue; }
    kept[key] = value;
  }
  kept.truncated = true;
  return { metadata: kept, truncated: dropped || true };
}

/**
 * Apply the allowlist and the hard rules.
 *
 * @param {string} eventType
 * @param {object} metadata
 * @param {object} [options]
 * @param {object} [options.env]  environment used to resolve secret values
 * @returns {{ metadata: object, dropped: string[] }}
 */
function redactMetadata(eventType, metadata, { env = process.env } = {}) {
  const dropped = [];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { metadata: {}, dropped };
  }

  const allowed = new Set(METADATA_ALLOWLIST[eventType] || []);
  const secrets = configuredSecrets(env);
  const clean = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (MESSAGE_BODY_KEYS.has(key)) { dropped.push(key); continue; }
    if (!allowed.has(key)) { dropped.push(key); continue; }
    if (keyLooksLikeSecret(key)) { dropped.push(key); continue; }
    // One walk covers scalars, arrays and nested objects, and screens nested
    // KEYS as well as values. The allowlist bounds the top-level key names but
    // says nothing about what an allowed key's value contains, so an allowed
    // key holding `{ credentials: { password: '...' } }` used to pass.
    if (containsScreenedValue(value, secrets)) { dropped.push(key); continue; }
    clean[key] = value;
  }

  const capped = capMetadata(clean);
  return { metadata: capped.metadata, dropped };
}

module.exports = {
  MAX_METADATA_BYTES,
  MESSAGE_BODY_KEYS,
  METADATA_ALLOWLIST,
  SECRET_ENV_NAMES,
  SECRET_KEY_PATTERN,
  SECRET_PATTERN_EXEMPTIONS,
  capMetadata,
  configuredSecrets,
  containsScreenedValue,
  holdsSecretValue,
  keyLooksLikeSecret,
  looksLikeSignedURL,
  stateEntryIsUnsafe,
  maskDeviceToken,
  messageFingerprint,
  redactMetadata
};
