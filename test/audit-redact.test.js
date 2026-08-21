'use strict';
/**
 * test/audit-redact.test.js — the allowlist, the secret screen, and the size cap.
 *
 * sms_audit_log cannot be updated or deleted. Anything these functions let
 * through is in the database permanently, so the interesting assertions here
 * are all about what does NOT get through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  MAX_METADATA_BYTES,
  capMetadata,
  looksLikeSignedURL,
  maskDeviceToken,
  messageFingerprint,
  redactMetadata
} = require('../lib/audit/redact');

test('an unrecognised key is dropped: the allowlist fails closed', () => {
  const { metadata, dropped } = redactMetadata('automation.queue_item.cancelled', {
    scheduled_id: 12,
    flow_type: 'hold-msg2',
    internal_debug_dump: { everything: 'in scope at the time' }
  });
  assert.deepEqual(Object.keys(metadata).sort(), ['flow_type', 'scheduled_id']);
  assert.ok(dropped.includes('internal_debug_dump'));
});

test('the SIP password is dropped even when the caller hands it straight over', () => {
  const env = { TELNYX_IOS_SIP_PASSWORD: 'sip-Pa55word-not-for-the-audit-log' };
  const { metadata, dropped } = redactMetadata('security.voice_credentials.issued', {
    login: 'vici_ios_agent',
    password: env.TELNYX_IOS_SIP_PASSWORD,
    dedicated_ios_pair: true
  }, { env });

  assert.equal(metadata.login, 'vici_ios_agent');
  assert.equal(metadata.dedicated_ios_pair, true);
  assert.equal('password' in metadata, false);
  assert.ok(dropped.includes('password'));
  assert.equal(JSON.stringify(metadata).includes(env.TELNYX_IOS_SIP_PASSWORD), false);
});

test('a secret value is dropped even when it arrives under an allowlisted key name', () => {
  const env = { TELNYX_API_KEY: 'KEY0177abcdefghijklmnop' };
  // `login` is allowlisted for this event, so only the value screen can catch
  // this one. That is the point of screening values as well as key names.
  const { metadata, dropped } = redactMetadata('security.voice_credentials.issued', {
    login: env.TELNYX_API_KEY
  }, { env });
  assert.deepEqual(metadata, {});
  assert.ok(dropped.includes('login'));
});

test('every named secret env var is screened out of an audit row', () => {
  const env = {
    TELNYX_API_KEY: 'telnyx-api-key-value',
    SUPABASE_SERVICE_KEY: 'supabase-service-key-value',
    INBOX_PASSWORD: 'inbox-password-value',
    SESSION_SECRET: 'session-secret-value',
    WC_CONSUMER_SECRET: 'wc-consumer-secret-value',
    APNS_KEY_P8_BASE64: 'apns-p8-base64-value'
  };
  for (const value of Object.values(env)) {
    const { metadata } = redactMetadata('security.voice_credentials.issued', { login: value }, { env });
    assert.deepEqual(metadata, {}, `${value} must never survive redaction`);
  }
});

test('a signed recording URL never reaches the audit trail', () => {
  const signed = 'https://project.supabase.co/storage/v1/object/sign/call-recordings/2026/call.mp3?token=eyJhbGciOi';
  assert.equal(looksLikeSignedURL(signed), true);
  const { metadata, dropped } = redactMetadata('recording.played', {
    call_log_id: 88,
    recording_archived: signed
  });
  assert.deepEqual(metadata, { call_log_id: 88 });
  assert.ok(dropped.includes('recording_archived'));
});

test('a message body is dropped under every name this codebase uses for it', () => {
  const { metadata, dropped } = redactMetadata('automation.queue_item.cancelled', {
    scheduled_id: 3,
    body: 'secret customer content',
    message_body: 'secret customer content',
    text: 'secret customer content',
    message: 'secret customer content',
    preview: 'secret customer content'
  });
  assert.deepEqual(metadata, { scheduled_id: 3 });
  for (const key of ['body', 'message_body', 'text', 'message', 'preview']) {
    assert.ok(dropped.includes(key));
  }
  assert.equal(JSON.stringify(metadata).includes('secret customer content'), false);
});

test('an APNs device token is reduced to its last 8 characters', () => {
  const token = '9f3c1a2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
  assert.equal(maskDeviceToken(token), token.slice(-8));
  assert.equal(maskDeviceToken(token).length, 8);
  assert.equal(maskDeviceToken(null), null);
});

test('oversized metadata is capped at 8KB and flagged rather than written whole', () => {
  const ids = Array.from({ length: 200 }, (_, index) => index + 1);
  const huge = { scheduled_ids: ids, cancelled_count: 200, scope: 'x'.repeat(20000) };
  const { metadata } = capMetadata(huge);
  assert.equal(metadata.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_BYTES);
  // The small, useful keys survive; only the oversized one is sacrificed.
  assert.equal(metadata.cancelled_count, 200);
  assert.equal('scope' in metadata, false);
});

test('metadata that already fits is passed through untouched and unflagged', () => {
  const small = { scope: 'order', cancelled_count: 3 };
  const { metadata } = capMetadata(small);
  assert.deepEqual(metadata, small);
  assert.equal('truncated' in metadata, false);
});

test('the redactor caps oversized metadata on its way through', () => {
  const { metadata } = redactMetadata('automation.queue_item.bulk_cancelled', {
    scope: 'order',
    cancelled_count: 1,
    flow_types: [ 'f'.repeat(9000) ]
  });
  assert.equal(metadata.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_BYTES);
});

test('a message is fingerprinted, never copied', () => {
  const body = 'Your order is still on hold, reply YES to release it.';
  const fingerprint = messageFingerprint(body);
  assert.equal(fingerprint.message_length, body.length);
  assert.equal(fingerprint.message_digest, crypto.createHash('sha256').update(body, 'utf8').digest('hex'));
  assert.equal(JSON.stringify(fingerprint).includes('on hold'), false);

  // The digest is what proves the source row still holds the same text.
  assert.notEqual(messageFingerprint(`${body} `).message_digest, fingerprint.message_digest);
  assert.deepEqual(messageFingerprint(null), { message_length: 0, message_digest: null });
});

test('an unknown event type gets an empty allowlist rather than a free pass', () => {
  const { metadata } = redactMetadata('some.type.that.does.not.exist', { anything: 1 });
  assert.deepEqual(metadata, {});
});

// ── Team events ────────────────────────────────────────────────────────────

/**
 * The team allowlists were written knowing exactly which keys were being kept
 * out. These assert that decision rather than leaving it as a property of what
 * the call sites happen to pass today.
 */
test('no credential-shaped key survives into a team audit row, whatever the call site passes', () => {
  const attempts = [
    ['team.member.activated', {
      user_id: 4,
      email: 'sarah@example.com',
      role: 'agent',
      password_hash: 'scrypt$1$abc$def',
      temporaryPassword: 'a-fresh-temporary-password'
    }],
    ['team.member.password_reset', {
      user_id: 4,
      email: 'sarah@example.com',
      reset_method: 'admin_temporary_password',
      password: 'plaintext-should-be-impossible',
      new_password_hash: 'scrypt$1$abc$def'
    }],
    ['team.member.invited', {
      invitation_id: 'a1b2',
      email: 'newbie@example.com',
      role: 'agent',
      // The raw token, its sha256, and a prefix of that sha256. None of the
      // three may be written: the table has REVOKE DELETE, so a head start on
      // a live credential would be permanent.
      token: 'sZ2m8k-raw-invitation-token',
      token_hash: crypto.createHash('sha256').update('sZ2m8k-raw-invitation-token').digest('hex'),
      token_prefix: 'deadbeef'
    }],
    ['team.member.role_changed', {
      user_id: 4,
      previous_role: 'agent',
      new_role: 'admin',
      session_epoch: 7,
      password_hash: 'scrypt$1$abc$def'
    }]
  ];

  for (const [eventType, metadata] of attempts) {
    const { metadata: clean, dropped } = redactMetadata(eventType, metadata);
    const serialised = JSON.stringify(clean);

    for (const key of ['password_hash', 'temporaryPassword', 'password', 'new_password_hash', 'token', 'token_hash', 'token_prefix', 'session_epoch']) {
      if (!(key in metadata)) continue;
      assert.equal(key in clean, false, `${eventType}: ${key} must be dropped`);
      assert.ok(dropped.includes(key), `${eventType}: ${key} must be reported as dropped`);
      assert.equal(serialised.includes(String(metadata[key])), false, `${eventType}: the value of ${key} must not survive under any key`);
    }

    // The facts a reader actually needs do survive.
    assert.equal(clean.email, metadata.email ?? clean.email);
  }
});

test('a team row keeps the role key and its display name side by side', () => {
  const { metadata } = redactMetadata('team.member.role_changed', {
    user_id: 4,
    email: 'sarah@example.com',
    previous_role: 'agent',
    new_role: 'admin',
    previous_role_display_name: 'Support Agent',
    new_role_display_name: 'Admin',
    logins_revoked: true
  });

  assert.equal(metadata.previous_role, 'agent');
  assert.equal(metadata.previous_role_display_name, 'Support Agent');
  assert.equal(metadata.new_role, 'admin');
  assert.equal(metadata.new_role_display_name, 'Admin');
  assert.equal(metadata.logins_revoked, true);
});

test('the bulk catch-up row carries counts, and the campaign suggestion carries a digest rather than the draft', () => {
  const draft = 'Hey Sarah! Your order is on its way.';

  const catchup = redactMetadata('message.catchup.sent', {
    sent: 42, failed: 1, skipped: 3, processing_candidates: 40, shipped_candidates: 6,
    source: 'manual_catchup', results: [{ phone: '+13055551234' }]
  }).metadata;
  assert.equal(catchup.sent, 42);
  assert.equal(catchup.skipped, 3);
  assert.equal('results' in catchup, false, 'the per-recipient detail is not audit material');

  const suggestion = redactMetadata('campaign.suggestion.sent', {
    suggestion_id: 'c3d4',
    suggestion_type: 'reorder_nudge',
    body: draft,
    ...messageFingerprint(draft)
  }).metadata;
  assert.equal(suggestion.message_length, draft.length);
  assert.equal(suggestion.message_digest, crypto.createHash('sha256').update(draft, 'utf8').digest('hex'));
  assert.equal(JSON.stringify(suggestion).includes(draft), false, 'the drafted message body must never be stored');
});

// ── Nested keys ────────────────────────────────────────────────────────────

test('a secret-shaped key one level down is dropped, not just a top-level one', () => {
  // `stateEntryIsUnsafe` used to apply SECRET_KEY_PATTERN to the top-level key
  // ONLY; the recursive walk beneath it checked values and never keys. So
  // `{ password: 'x' }` was dropped and `{ config: { password: 'x' } }` was
  // written verbatim into a table with REVOKE DELETE and an immutability
  // trigger. The docstring claimed otherwise, which is how it went unnoticed.
  const { stateEntryIsUnsafe } = require('../lib/audit/redact');
  const env = {};

  assert.equal(stateEntryIsUnsafe('password', 'x', { env }), true, 'top level still dropped');
  assert.equal(stateEntryIsUnsafe('config', { password: 'x' }, { env }), true, 'one level down');
  assert.equal(stateEntryIsUnsafe('config', { inner: { api_key: 'x' } }, { env }), true, 'two levels down');
  assert.equal(stateEntryIsUnsafe('items', [{ private_key: 'x' }], { env }), true, 'inside an array');
  assert.equal(
    stateEntryIsUnsafe('sip', { credentials: { login: 'user' } }, { env }), true,
    'the key alone condemns the entry even when every value looks harmless'
  );

  // ...and an ordinary snapshot is still kept.
  assert.equal(stateEntryIsUnsafe('role', 'admin', { env }), false);
  assert.equal(stateEntryIsUnsafe('previous', { role: 'agent', is_active: true }, { env }), false);
  assert.equal(stateEntryIsUnsafe('ids', [1, 2, 3], { env }), false);
});

test('nested metadata values are screened, not only scalars and flat arrays', () => {
  // redactMetadata checked the value, then array entries, and stopped. An
  // allowlisted key holding a nested object went through unscreened.
  const { redactMetadata } = require('../lib/audit/redact');
  const env = { TELNYX_API_KEY: 'KEY0123456789abcdef' };

  const { metadata, dropped } = redactMetadata('contact.opted_out', {
    trigger: 'inbound_stop',
    source: { nested: { password: 'anything' } }
  }, { env });

  assert.equal(metadata.trigger, 'inbound_stop', 'clean keys survive');
  assert.equal('source' in metadata, false, 'a nested secret-shaped key is dropped');
  assert.ok(dropped.includes('source'));
});

test('SECRET_KEY_PATTERN is deliberately over-broad, and stays that way', () => {
  // The pattern matches `session` and `signature` as substrings, so a future
  // `session_epoch` or `signature_valid` is dropped even though neither is a
  // credential. That over-match is kept on purpose: a false positive loses one
  // field from one audit row and the value is still in its source table, while
  // a false negative writes a credential permanently into a table with REVOKE
  // DELETE and an immutability trigger.
  //
  // test/audit-log.test.js already asserts that `session_epoch: 4` is dropped
  // from a state snapshot, so this is the project's existing decision, not a
  // new one. Reopening it means adding the key to SECRET_PATTERN_EXEMPTIONS
  // and updating that test in the same commit.
  const { keyLooksLikeSecret, SECRET_PATTERN_EXEMPTIONS } = require('../lib/audit/redact');

  assert.deepEqual([...SECRET_PATTERN_EXEMPTIONS], ['device_token_last8'],
    'an exemption is a reviewed decision; adding one must show up in this diff');
  assert.equal(keyLooksLikeSecret('device_token_last8'), false, 'already masked to 8 chars');

  assert.equal(keyLooksLikeSecret('session_epoch'), true, 'over-match, accepted knowingly');
  assert.equal(keyLooksLikeSecret('signature_valid'), true, 'over-match, accepted knowingly');

  for (const key of [
    'session_id', 'session_token', 'signature', 'password', 'passwd',
    'api_key', 'apiKey', 'private_key', 'access_key', 'credential',
    'authorization', 'bearer', 'cookie', 'p8', 'client_secret'
  ]) {
    assert.equal(keyLooksLikeSecret(key), true, `${key} must be treated as a secret`);
  }

  for (const key of [
    'role', 'is_active', 'email', 'order_id', 'flow_type', 'user_id',
    'send_at', 'attempts', 'status', 'phone', 'login'
  ]) {
    assert.equal(keyLooksLikeSecret(key), false, `${key} must survive the screen`);
  }
});

test('an exemption never extends to what the exempted key contains', () => {
  const { keyLooksLikeSecret, containsScreenedValue } = require('../lib/audit/redact');
  assert.equal(keyLooksLikeSecret('device_token_last8'), false);
  assert.equal(containsScreenedValue({ device_token_last8: { password: 'x' } }, []), true,
    'exempting the wrapper name must not exempt what it contains');
});
