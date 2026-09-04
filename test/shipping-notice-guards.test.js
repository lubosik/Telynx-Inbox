'use strict';
/**
 * test/shipping-notice-guards.test.js — never announce a shipment that is not
 * happening.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 *
 *   A customer cancelled her pending order at 17:36:20. Sixty-eight seconds
 *   later somebody in WooCommerce touched a DIFFERENT order of hers — one
 *   completed and shipped on 26 May, four months earlier. That edit fired
 *   order.updated, handleOrderShipped saw `completed` with a tracking number,
 *   and texted her "your order is officially on its way" about a parcel she
 *   had received in May. A human sent an apology two minutes afterwards.
 *
 *   The order was genuinely completed, so no status check would have caught
 *   it. What was wrong was the AGE, and `date_completed` was sitting right
 *   there unread.
 *
 *   The cancellation machinery itself worked correctly: hold-msg3 was
 *   cancelled as it should have been. The bug was never that cancellation is
 *   ignored — it was that a shipping notice has no idea when the shipment
 *   happened.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONFIRMED = fs.readFileSync(path.join(__dirname, '..', 'flows', 'confirmed.js'), 'utf8');
const SHIPPED = fs.readFileSync(path.join(__dirname, '..', 'flows', 'shipped.js'), 'utf8');

test('a shipping notice is refused for an order completed long ago', () => {
  // The guard that would have stopped the message that was actually sent.
  assert.match(CONFIRMED, /const SHIPPED_NOTICE_MAX_AGE_DAYS = 3;/);

  const fn = CONFIRMED.slice(CONFIRMED.indexOf('async function handleOrderShipped'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /date_completed_gmt \|\| order\.date_completed/,
    'the completion date must actually be read');
  assert.match(body, /ageDays > SHIPPED_NOTICE_MAX_AGE_DAYS/);
});

test('the window allows a late webhook but not a stale order', () => {
  // Three days rather than one: a webhook can be delayed or retried, and a
  // real notification arriving late is better than one suppressed. Four months
  // is not a delay.
  const days = Number(CONFIRMED.match(/SHIPPED_NOTICE_MAX_AGE_DAYS = (\d+)/)[1]);
  assert.ok(days >= 2, 'a same-day-only window would suppress genuine retries');
  assert.ok(days <= 14, 'a fortnight is not news');

  const MAY = Date.parse('2026-05-26T20:13:36Z');
  const SEPT = Date.parse('2026-09-04T17:38:00Z');
  const actualAge = (SEPT - MAY) / 86400000;
  assert.ok(actualAge > days,
    `the real incident was ${Math.round(actualAge)} days old and must be refused`);
});

test('a cancelled order never gets a shipping notice', () => {
  // Not the cause of this incident, but a real hole found while chasing it:
  // the shipped path had no reference to cancellation anywhere.
  assert.match(CONFIRMED, /const NOT_SHIPPABLE = new Set\(\[/);
  for (const status of ['cancelled', 'refunded', 'failed', 'trash']) {
    assert.match(CONFIRMED, new RegExp(`'${status}'`), `${status} must be refused`);
  }
  const fn = CONFIRMED.slice(CONFIRMED.indexOf('async function handleOrderShipped'));
  assert.match(fn.slice(0, 2500), /NOT_SHIPPABLE\.has\(status\)/);
});

test('the ShipStation poll also refuses a cancelled order', () => {
  // A voided LABEL and a cancelled ORDER are different acts in different
  // systems. Cancelling in WooCommerce does not void the label, so the
  // existing `voided` check covered only half of it.
  assert.match(SHIPPED, /Order \$\{orderId\} is \$\{orderStatus\} — no shipping notice/);
  assert.match(SHIPPED, /\['cancelled', 'refunded', 'failed', 'trash'\]\.includes\(orderStatus\)/);
});

test('the poll reads the mirror, not WooCommerce, and fails open', () => {
  // It runs every 30 minutes over up to 50 shipments; 50 API calls would be a
  // worse problem than the one being fixed. And an order we have no row for is
  // allowed through, because absence of evidence is not cancellation.
  const block = SHIPPED.slice(SHIPPED.indexOf('DO NOT ANNOUNCE A SHIPMENT FOR A CANCELLED ORDER'));
  assert.match(block.slice(0, 1800), /from\('sms_orders'\)/);
  assert.match(block.slice(0, 1800), /if \(orderId\) \{/,
    'no order id means no check, not a refusal');
});

test('a suppressed stale notice is reported, not silently dropped', () => {
  // It means somebody edited an old order, and the only reason anybody learned
  // that the first time was a customer receiving the message.
  assert.match(CONFIRMED, /emitOperationalAlert\(ALERT_STALE_SHIPPING_NOTICE/);
  const utils = fs.readFileSync(path.join(__dirname, '..', 'flows', 'utils.js'), 'utf8');
  assert.match(utils, /ALERT_STALE_SHIPPING_NOTICE = 'SMS_STALE_SHIPPING_NOTICE'/);
});
