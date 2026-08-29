'use strict';
/**
 * test/campaign-check-in.test.js — the due-date half of the 21-day check-in.
 *
 * The sending half does not exist yet and is blocked on a design decision
 * recorded in the header of lib/campaigns/check-in.js. These tests cover what
 * IS built: which orders earn a check-in, when it lands, and the cases that
 * would otherwise send a message about a purchase somebody made months ago.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHECK_IN_DAYS,
  FLOW_TYPE,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  checkInDueAt,
  scheduleCheckIn
} = require('../lib/campaigns/check-in');

const { fieldsUsed } = require('../lib/campaigns/merge-fields');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');

function stubClient({ onUpsert = () => ({ error: null }) } = {}) {
  const writes = [];
  return {
    writes,
    from() {
      return {
        upsert(row, options) {
          writes.push({ row, options });
          return Promise.resolve(onUpsert(row));
        }
      };
    }
  };
}

test('a completed order is due exactly 21 days after it was paid', () => {
  const due = checkInDueAt({ status: 'completed', date_paid: '2026-08-01T12:00:00Z' });
  assert.equal(due, '2026-08-22T12:00:00.000Z');
  assert.equal(CHECK_IN_DAYS, 21);
});

test('only completed orders earn one', () => {
  // processing means paid but not shipped. Counting from payment would reach
  // some customers only days after the product actually arrived.
  for (const status of ['processing', 'pending', 'on-hold', 'cancelled', 'refunded', 'failed']) {
    assert.equal(checkInDueAt({ status, date_paid: '2026-08-01T12:00:00Z' }), null, status);
  }
});

test('an order with no usable date earns nothing rather than a date at the epoch', () => {
  assert.equal(checkInDueAt({ status: 'completed' }), null);
  assert.equal(checkInDueAt({ status: 'completed', date_paid: 'not a date' }), null);
  assert.equal(checkInDueAt(null), null);
});

test('a check-in whose date has already passed is refused, not fired immediately', async () => {
  // The case this exists for: backfilling old orders. A six-month-old order
  // would otherwise queue a check-in already "due" and ask somebody how they
  // are getting on with something they bought in February.
  const client = stubClient();
  const result = await scheduleCheckIn({
    client,
    order: { id: 1, status: 'completed', date_paid: '2026-01-01T00:00:00Z', phone: '+15550000001' },
    now: new Date('2026-08-29T00:00:00Z')
  });
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, 'due_date_already_passed');
  assert.equal(client.writes.length, 0, 'nothing may be queued for a lapsed due date');
});

test('a recent completed order queues one pending row with no body', async () => {
  const client = stubClient();
  const result = await scheduleCheckIn({
    client,
    order: { id: 4321, status: 'completed', date_paid: '2026-08-20T09:00:00Z', phone: '+1 (555) 000-0002' },
    now: new Date('2026-08-29T00:00:00Z')
  });
  assert.equal(result.scheduled, true);
  assert.equal(result.sendAt, '2026-09-10T09:00:00.000Z');
  assert.equal(client.writes.length, 1);

  const { row, options } = client.writes[0];
  assert.equal(row.flow_type, FLOW_TYPE);
  assert.equal(row.status, 'pending');
  assert.equal(row.order_id, '4321');
  assert.equal(row.phone, '+15550000002', 'the phone must be normalised before it is stored');
  assert.equal(row.message_body, null, 'the body is rendered at send time, never 21 days early');
  // Redelivered WooCommerce webhooks are routine, and two check-ins for one
  // order is the visible failure.
  assert.equal(options.onConflict, 'order_id,flow_type');
  assert.equal(options.ignoreDuplicates, true);
});

test('an order with no phone or no id is skipped without throwing', async () => {
  const client = stubClient();
  const order = { id: 1, status: 'completed', date_paid: '2026-08-20T09:00:00Z' };
  assert.equal((await scheduleCheckIn({ client, order, now: new Date('2026-08-21T00:00:00Z') })).reason, 'no_phone');
  assert.equal((await scheduleCheckIn({
    client,
    order: { status: 'completed', date_paid: '2026-08-20T09:00:00Z', phone: '+15550000001' },
    now: new Date('2026-08-21T00:00:00Z')
  })).reason, 'no_order_id');
  assert.equal(client.writes.length, 0);
});

test('a database failure is reported, never thrown at a webhook handler', async () => {
  const client = stubClient({ onUpsert: () => ({ error: { message: 'connection reset' } }) });
  const result = await scheduleCheckIn({
    client,
    order: { id: 9, status: 'completed', date_paid: '2026-08-20T09:00:00Z', phone: '+15550000001' },
    now: new Date('2026-08-21T00:00:00Z')
  });
  // WooCommerce retries a webhook that did not return 200, and a retried order
  // webhook re-runs the order flows. A failed check-in must not cause that.
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, 'insert_failed');
});

test('both templates are compliant copy and carry no discount', () => {
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT]) {
    const verdict = validateCopy(template, {
      brandName: RULES.brand.defaultName,
      approvedProductCodes: RULES.defaultApprovedProductCodes
    });
    assert.equal(verdict.ok, true,
      `template failed: ${JSON.stringify((verdict.failures || []).map(f => f.check))}`);
    // The decision recorded in the module header: a check-in is not an advert.
    assert.equal(fieldsUsed(template).includes('code'), false,
      'the check-in must not carry a discount code');
    assert.match(template, /Reply STOP to opt out/);
  }
});

test('the check-in never claims the customer is due for anything', () => {
  // copy-rules bans "you are due" outright, because it is both a dosing
  // implication and a claim that the business has been tracking somebody.
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT]) {
    const lower = template.toLowerCase();
    for (const phrase of ['you are due', "you're due", 'run out', 'running low', 'time to reorder']) {
      assert.equal(lower.includes(phrase), false, `${phrase} must not appear`);
    }
  }
});

test('the transactional queue is wired to skip check-in rows', () => {
  // The guard this pins is the only thing standing between a null message_body
  // and sendSMS. processScheduledQueue selects every pending row whose send_at
  // has passed, with no filter on flow type of its own, and hands
  // message_body straight to sendAndLog. check-in.js writes that column null
  // deliberately, so removing the exclusion turns every due check-in into an
  // attempt to send a null body with no promotional consent check.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'flows', 'utils.js'), 'utf8'
  );
  assert.match(source, /PROMOTIONAL_FLOW_TYPES\s*=\s*new Set\(\[[^\]]*'checkin-21d'/,
    'flows/utils.js must name checkin-21d as promotional');
  assert.match(source, /\.not\('flow_type', 'in'/,
    'processScheduledQueue must exclude promotional flow types from its claim');
});
