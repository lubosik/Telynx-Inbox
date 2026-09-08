'use strict';
/**
 * test/checkin-offer-inbox-visibility.test.js — the CHECKIN20 offer must
 * appear in the conversation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 *
 *   A customer received the 21-day check-in, replied warmly, and the system
 *   recognised the positive reply and sent her a 20% code to keep her. She
 *   loved it. Staff never saw it.
 *
 *   The offer was written to `sms_sent_log`, which is a dedup ledger, and
 *   never to `sms_messages`, which is the only table the inbox reads
 *   (routes/conversations.js joins on contact_phone and filters nothing). So
 *   the thread showed her reply, then a staff message, then a tapback from her
 *   LOVING a message that was not in the thread:
 *
 *     16:07  inbound   "I appreciate your company so much..."
 *     16:08  outbound  "That's so great to hear Mia!..."
 *     16:08  ✗ the CHECKIN20 offer — sent, received, absent
 *     16:09  inbound   Loved "...CHECKIN20 is 20% off your next order."
 *
 *   The shop owner: "I didn't see the checkin20 text go out but they loved it".
 *
 *   It looked intermittent because it was: the quiet-hours branch defers
 *   through scheduleSMS and comes back out through sendAndLog, which does
 *   write both tables. The same offer was visible when held until morning and
 *   invisible when sent straight away.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', 'check-in-reply.js'), 'utf8');

test('the offer is written to the table the inbox reads', () => {
  assert.match(SRC, /from\('sms_messages'\)\s*\.insert\(/,
    'sms_sent_log is a dedup ledger; sms_messages is the conversation');
});

test('it is written with the fields a thread needs to render', () => {
  const block = SRC.slice(SRC.indexOf("from('sms_messages')"));
  const insert = block.slice(0, block.indexOf('});') + 3);
  for (const field of ['contact_phone', 'direction', 'body', 'status', 'created_at']) {
    assert.match(insert, new RegExp(field), `${field} is required to render the message`);
  }
  assert.match(insert, /direction:\s*'outbound'/, 'it came from the shop');
  // Attributed to its campaign, like any other campaign send. Without this the
  // message shows in the thread but the campaign gets no credit for the
  // reorder it buys.
  assert.match(insert, /campaign_id/, 'the offer belongs to the check-in campaign');
});

test('the thread is bumped so it surfaces in the inbox list', () => {
  assert.match(SRC, /from\('sms_contacts'\)\s*\.update\(\{\s*last_seen/,
    'without this the conversation does not rise like any other reply');
});

test('a failure to record it never loses the message', () => {
  // The SMS has already left and the dedup row is already written. This runs
  // un-awaited inside the Telnyx webhook, so a throw would lose the thread and
  // gain nothing.
  const block = SRC.slice(SRC.indexOf("from('sms_messages')"));
  const guarded = SRC.slice(0, SRC.indexOf("from('sms_messages')")).lastIndexOf('try {');
  assert.ok(guarded > -1, 'the insert is inside a try');
  assert.match(block, /catch \(inboxError\)/, 'and its failure is caught');
  assert.match(block, /console\.error/, 'and reported rather than swallowed silently');
  assert.doesNotMatch(block.slice(0, block.indexOf('return')), /throw /,
    'and never rethrown');
});

test('the send itself still records to the dedup ledger', () => {
  // The unique index on (order_id, flow_type, phone) is the real guard against
  // a double send. Adding inbox visibility must not have displaced it.
  assert.match(SRC, /from\('sms_sent_log'\)\s*\.insert\(/);
  assert.ok(
    SRC.indexOf("from('sms_sent_log')") < SRC.indexOf("from('sms_messages')"),
    'the dedup row is written first, so a crash between the two cannot double-send'
  );
});
