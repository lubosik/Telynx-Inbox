'use strict';
/**
 * test/campaign-offer-timing.test.js — an offer waits for a civil hour.
 *
 * check-in-reply sends the moment somebody answers, and the justification for
 * skipping the campaign gate is that it is a reply, seconds after the customer
 * wrote first. That holds for a thank-you and thins as the commercial content
 * grows. At 20% off it is a marketing message prompted by a reply, and one at
 * 03:00 is still one at 03:00.
 *
 * The REPLY is never held. Somebody texting at 3am gets answered at 3am,
 * because that is a conversation. Only the offer waits.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { inQuietHours, whenToSendOffer } = require('../lib/campaigns/offer-timing');

/** Hour and minute as the shop sees them. */
const inNY = (date) => date.toLocaleString('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
});

test('the quiet window wraps midnight', () => {
  // The case a naive `start <= h < end` gets exactly backwards: with a 20:00
  // start and a 09:00 end it would call 22:00 fine and midday quiet.
  assert.equal(inQuietHours(new Date('2026-09-01T17:00:00Z')), false, '13:00 NY');
  assert.equal(inQuietHours(new Date('2026-09-02T01:00:00Z')), true, '21:00 NY');
  assert.equal(inQuietHours(new Date('2026-09-02T05:00:00Z')), true, '01:00 NY');
  assert.equal(inQuietHours(new Date('2026-09-01T12:00:00Z')), true, '08:00 NY, just before open');
  assert.equal(inQuietHours(new Date('2026-09-01T13:00:00Z')), false, '09:00 NY, open');
});

test('a 3am reply holds the offer until 9am, in the shop timezone', () => {
  const decision = whenToSendOffer(new Date('2026-09-02T07:00:00Z'));   // 03:00 NY
  assert.equal(decision.sendNow, false);
  assert.equal(decision.reason, 'held_for_quiet_hours');
  assert.equal(inNY(decision.sendAt), '09:00');
});

test('an evening reply holds until the next morning, not the same one', () => {
  const decision = whenToSendOffer(new Date('2026-09-02T01:00:00Z'));   // 21:00 NY
  assert.equal(decision.sendNow, false);
  assert.equal(inNY(decision.sendAt), '09:00');
  assert.ok(decision.sendAt > new Date('2026-09-02T01:00:00Z'), 'it must be in the future');
  // Twelve hours later, not twelve hours earlier.
  const hours = (decision.sendAt - new Date('2026-09-02T01:00:00Z')) / 3600000;
  assert.ok(hours > 11 && hours < 13, `expected ~12 hours, got ${hours}`);
});

test('a daytime reply sends immediately', () => {
  const decision = whenToSendOffer(new Date('2026-09-01T17:00:00Z'));   // 13:00 NY
  assert.deepEqual(decision, { sendNow: true, sendAt: null, reason: 'within_business_hours' });
});

test('the boundary minute is open, not quiet', () => {
  // 09:00 exactly is business hours. An off-by-one here would hold every
  // 9am reply for a further 24 hours.
  assert.equal(whenToSendOffer(new Date('2026-09-01T13:00:00Z')).sendNow, true);
  assert.equal(whenToSendOffer(new Date('2026-09-01T12:59:00Z')).sendNow, false);
});

test('the offer is scheduled rather than dropped', () => {
  // Holding a message by discarding it would be worse than sending it at 3am.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'check-in-reply.js'), 'utf8'
  );
  assert.match(source, /scheduleSMS\(/, 'a held offer must go on the schedule queue');
  const held = source.slice(source.indexOf('const timing = whenToSendOffer'));
  assert.match(held.slice(0, 900), /scheduled: true/, 'and say so to its caller');
});
