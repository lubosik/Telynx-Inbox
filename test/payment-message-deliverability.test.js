'use strict';
/**
 * test/payment-message-deliverability.test.js — the payment reminders that
 * AT&T was blocking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED
 *
 *   Telnyx error 40002, "blocked as spam", from AT&T. Over three weeks:
 *   messages naming Zelle failed 36.4% (4 of 11); everything else failed 1.2%
 *   (12 of 989). Two customers never received a payment request at all and
 *   their orders sat unpaid, $1,458.88 between them.
 *
 *   The old wording was not near a scam template, it WAS one: payment brand,
 *   plus an email address to send money to, plus a four-figure amount, plus
 *   urgency. A carrier filter cannot tell that from fraud, because the only
 *   difference is that this one is real.
 *
 * WHAT THE EVIDENCE ACTUALLY SUPPORTS
 *
 *   Carriers publish no trigger-word list, and every article claiming one is
 *   vendor marketing. Two levers have real support: the imperative payment
 *   solicitation, and matching the registered campaign. The rest — exclamation
 *   marks, length, line breaks — is folklore, dropped because it costs nothing,
 *   not because it is proven.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOLD = fs.readFileSync(path.join(__dirname, '..', 'flows', 'hold.js'), 'utf8');

/** Every payment message the hold flow can produce, rendered. */
function renderAll() {
  const start = HOLD.indexOf('const OPT_OUT');
  const end = HOLD.indexOf('module.exports');
  const scope = {};
  // eslint-disable-next-line no-new-func
  const load = new Function(`${HOLD.slice(start, end)}
    return { buildMsg1, buildMsg2, buildMsg3,
             buildCombinedMsg1, buildCombinedMsg2, buildCombinedMsg3 };`);
  Object.assign(scope, load());
  const args = ['Lisa', '4542', '1190.48', 'support@vicipeptides.com', 'Zelle'];
  return [
    scope.buildMsg1(...args), scope.buildMsg2(...args), scope.buildMsg3(...args),
    scope.buildCombinedMsg1('Lisa', '#4542 and #4543', '1458.88', args[3], 'Zelle'),
    scope.buildCombinedMsg2('Lisa', '#4542 and #4543', '1458.88', args[3], 'Zelle'),
    scope.buildCombinedMsg3('Lisa', '#4542 and #4543', '1458.88', args[3], 'Zelle')
  ];
}

test('no payment message issues an imperative to send money', () => {
  // "Send $1190.48 to support@vicipeptides.com via Zelle" is the whole
  // fingerprint. The same facts stated rather than demanded are not.
  for (const message of renderAll()) {
    assert.doesNotMatch(message, /\bsend \$/i, message.slice(0, 60));
  }
});

test('every payment message carries the opt-out', () => {
  // Not because a payment reminder is marketing. Because all four REGISTERED
  // sample messages for this campaign end with it, and content deviating from
  // the registered campaign is a documented block cause independent of any
  // keyword.
  for (const message of renderAll()) {
    assert.match(message, /Reply STOP to opt out\.$/, message.slice(0, 60));
  }
});

test('no deadline, no threat of losing the order', () => {
  // The final reminder read "last call on order X. Need to release the stock
  // by end of today." A deadline and a threat of loss in one line, sent to
  // somebody who has already agreed to buy.
  for (const message of renderAll()) {
    for (const phrase of [/last call/i, /end of today/i, /lock it in/i,
                          /straight away/i, /secure (it|them)/i, /hurry/i]) {
      assert.doesNotMatch(message, phrase, `${phrase} in: ${message.slice(0, 60)}`);
    }
  }
});

test('the payment address is named as OURS, never "on file"', () => {
  // Reviewed and rejected: a customer reads "the address on file" as their own
  // email address that we hold, which is worse than unclear.
  const singles = renderAll().slice(0, 3);
  for (const message of singles) {
    assert.match(message, /[Oo]ur Zelle address is/, message.slice(0, 60));
    assert.doesNotMatch(message, /address on file/i);
  }
});

test('the product is not named beside the money', () => {
  // A regulated-adjacent compound sitting next to a four-figure request is a
  // bad pairing, and this campaign already carries a registration failure
  // reason mentioning illegal substances.
  // Checked against the compound codes only. A first pass also matched
  // /peptide/i, which flagged the address support@vicipeptides.com — the
  // domain, not a product. A test that fails on the company's own name is
  // noise, and noise is how a real finding gets ignored later.
  for (const message of renderAll()) {
    const withoutHandle = message.replace(/\S+@\S+/g, '');
    assert.doesNotMatch(withoutHandle, /\bRT\b|\bGHK-?Cu\b|\bTZ\b|\bBPC\b|Retatrutide/i,
      message.slice(0, 60));
  }
});

test('a blocked message alerts, and a blocked PAYMENT message alerts loudly', () => {
  // The failure that cost real money was silence: a failed send was written to
  // the database and nothing told anybody.
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8');
  assert.match(webhook, /ALERT_DELIVERY_BLOCKED/);
  assert.match(webhook, /severity: looksLikePayment \? 'critical' : 'warning'/);

  // Through the shared helper, so the reserved prefix stays reserved.
  assert.match(webhook, /emitOperationalAlert\(ALERT_DELIVERY_BLOCKED/);

  // And the body must actually be fetched, or the payment check silently
  // reads undefined and every alert is a warning.
  const status = fs.readFileSync(path.join(__dirname, '..', 'lib', 'message-status.js'), 'utf8');
  assert.match(status, /\.select\('id, contact_phone, status, body'\)/);
});
