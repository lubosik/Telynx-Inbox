'use strict';
/**
 * test/user-facing-errors.test.js — what a person is allowed to be shown.
 *
 * The test that matters is the last one: it takes the actual error thrown by
 * the actual coupon module, the one that reached the owner's phone, and
 * asserts it can never reach a screen again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isUserFacing, newReference, presentError } = require('../lib/user-facing-errors');

/** A logger that records instead of printing. */
const recorder = () => {
  const lines = [];
  return { lines, error: (...args) => lines.push(args.join(' ')) };
};

test('an allowlisted code keeps its message, because that message helps', () => {
  const error = Object.assign(new Error('Only 3 people are eligible, and a campaign needs at least 25.'), {
    code: 'AUDIENCE_BELOW_MINIMUM', status: 409
  });
  const { status, body } = presentError(error, { action: 'building this campaign', logger: recorder() });
  assert.equal(status, 409);
  assert.equal(body.error, error.message);
  assert.equal(body.code, 'AUDIENCE_BELOW_MINIMUM');
  assert.equal(body.reference, undefined, 'an actionable message needs no reference');
});

test('anything else is hidden behind one sentence and a reference', () => {
  const log = recorder();
  const error = Object.assign(new Error('column sms_sent_log.created_at does not exist'), {
    code: 'CAMPAIGN_LOAD_FAILED', status: 400
  });
  const { status, body } = presentError(error, { action: 'approving this campaign', logger: log });
  assert.equal(status, 500, 'an internal fault is a 500 whatever status it carried');
  assert.doesNotMatch(body.error, /column|sms_sent_log|PGRST/);
  assert.match(body.error, /approving this campaign/);
  assert.match(body.error, /Lubosi/);
  assert.match(body.error, /VIC-[A-Z2-9]{6}/);
  assert.equal(body.code, 'INTERNAL_ERROR');
  // Hidden is not lost. The full text has to be findable by the reference.
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], new RegExp(body.reference));
  assert.match(log.lines[0], /column sms_sent_log\.created_at does not exist/);
});

test('a pending migration says so, instead of reading as a mystery', () => {
  // The owner switched on the automatic check-in and got "Something went wrong
  // ... send this reference to Lubosi", which was true and useless. The real
  // error was PGRST204: the column did not exist because the migration had not
  // been run. That is a KNOWN, temporary, one-fix condition, and saying so is
  // the difference between "the app is broken" and "the app is waiting".
  const log = recorder();
  const error = Object.assign(
    new Error("Could not find the 'checkin_automation_enabled' column of 'sms_campaign_settings' in the schema cache"),
    { code: 'PGRST204', status: 400 }
  );
  const { body } = presentError(error, { action: 'changing the check-in automation', logger: log });
  assert.equal(body.code, 'PENDING_DATABASE_UPDATE');
  assert.match(body.error, /database update that has not been applied/);
  assert.match(body.error, /changing the check-in automation/);
  assert.match(body.error, /VIC-[A-Z2-9]{6}/, 'the reference survives translation');
  // Still no internals on the screen.
  assert.doesNotMatch(body.error, /PGRST|schema cache|checkin_automation_enabled|column/);
  // Still logged in full.
  assert.match(log.lines[0], /checkin_automation_enabled/);
});

test('a translated fault may claim nothing changed, because nothing did', () => {
  // The generic message deliberately never says "nothing was changed" — a
  // failure during approval may have minted coupons before it threw. A
  // rejected write is different: PGRST204 means the statement never ran, so
  // the reassurance is true and worth giving.
  const { body } = presentError(
    Object.assign(new Error('Could not find the x column of y'), { code: 'PGRST204' }),
    { action: 'saving this', logger: recorder() }
  );
  assert.match(body.error, /Nothing was changed/);
});

test('an error with no code at all is hidden too', () => {
  // Default deny. A new internal error written next month is quiet by
  // default rather than leaking until somebody notices.
  const { body } = presentError(new Error('kaboom'), { logger: recorder() });
  assert.equal(body.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(body.error, /kaboom/);
});

test('the message never claims what did or did not happen', () => {
  // A failure during approval may have minted coupons before it threw, and a
  // reassuring "nothing was changed" that turns out false is worse than
  // saying less.
  const { body } = presentError(new Error('x'), { action: 'approving this', logger: recorder() });
  assert.doesNotMatch(body.error, /nothing was (sent|changed|created)/i);
});

test('a reference is readable down a phone', () => {
  for (let i = 0; i < 200; i += 1) {
    const reference = newReference();
    assert.match(reference, /^VIC-[A-Z2-9]{6}$/);
    // No O/0 or I/1: they are the characters people mishear and mistype.
    assert.doesNotMatch(reference.slice(4), /[O0I1]/);
  }
});

test('references differ, or two faults look like one', () => {
  const seen = new Set(Array.from({ length: 500 }, () => newReference()));
  assert.ok(seen.size > 490, `expected near-unique references, got ${seen.size} of 500`);
});

test('feedback is shown and faults are hidden, across the real codes', () => {
  // Sampled from the codes actually thrown in lib/campaigns and routes. A
  // first version of this module listed thirty codes by hand and hid the other
  // hundred and sixty, turning "this segment matches nobody" into "something
  // went wrong", which is not safety but a worse app.
  const shown = [
    'AUDIENCE_BELOW_MINIMUM', 'SEGMENT_MATCHES_NOBODY', 'SEGMENT_NOT_FOUND',
    'RULE_SET_TOO_MANY_CONDITIONS', 'CONDITION_CONTRADICTORY', 'VALUE_OUT_OF_RANGE',
    'DIMENSION_UNKNOWN', 'PRODUCT_NOT_ALLOWED', 'PROPOSAL_NOT_OPEN',
    'CAMPAIGN_LIVE_SEND_DISABLED', 'CAMPAIGN_NOT_EDITABLE', 'MESSAGE_TOO_LONG',
    'ALL_DRAFTS_REJECTED', 'CAMPAIGN_APPROVAL_AUDIT_REQUIRED'
  ];
  const hidden = [
    'COUPON_SPECS_INVALID', 'COUPON_CODE_INVALID', 'PERSONALISATION_READ_FAILED',
    'CAMPAIGN_DATABASE_ERROR', 'CAMPAIGN_LOAD_FAILED', 'SEGMENT_CREATE_FAILED',
    'PGRST204', 'MODEL_OUTPUT_UNPARSEABLE', 'OPPORTUNITY_PORTFOLIO_UNAVAILABLE',
    'CAMPAIGN_EVENTS_TRUNCATED', null, undefined, 'kaboom'
  ];
  for (const code of shown) {
    assert.equal(isUserFacing(code), true, `${code} tells somebody what to do and should be shown`);
  }
  for (const code of hidden) {
    assert.equal(isUserFacing(code), false, `${code} is a fault and must never be shown`);
  }
});

test('the exact error that reached the phone can never reach it again', async () => {
  // Not a reconstruction. This is the real module, called the wrong way, which
  // is what approving a campaign did:
  //
  //   Campaign error
  //   createCoupons requires an array of coupon specs.
  const { createCoupons } = require('../lib/woocommerce-coupons');
  const thrown = await createCoupons({ coupons: [] }).catch(error => error);
  assert.match(thrown.message, /requires an array of coupon specs/);
  assert.equal(thrown.status, 400, 'it carries a status, which is why it slipped through');

  const { body } = presentError(thrown, { action: 'approving this campaign', logger: recorder() });
  assert.doesNotMatch(body.error, /createCoupons|coupon specs|array/);
  assert.match(body.error, /Something went wrong while approving this campaign/);
});

test('both campaign and segment routes go through the presenter', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['campaigns.js', 'segments.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
    assert.match(source, /presentError\(/, `${file} must present its errors`);
    // The old shape passed error.message through for anything with a status.
    assert.doesNotMatch(source, /json\(\{\s*error: error\.message/,
      `${file} must not return a raw error message`);
  }
});
