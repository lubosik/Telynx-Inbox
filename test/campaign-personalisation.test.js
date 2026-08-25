'use strict';
/**
 * test/campaign-personalisation.test.js
 *
 * Personalised campaigns, and the three ways they can go wrong quietly.
 *
 * The rules were loosened on purpose: a message may now greet somebody by
 * name, refer to their own order history, and carry a discount code. What was
 * NOT loosened is the part that protects the business, and most of this file
 * is about the difference.
 *
 *   1. A field nothing can fill still reaches the customer as literal
 *      characters, so the allowlist is the whole of the old ban.
 *   2. A template that fits is not a message that fits. "Hi {{first_name}}"
 *      is 16 septets and 25 for a Christopher.
 *   3. A compliant template can render into a non-compliant message, because
 *      product names carry compound names and doses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { RULES } = require('../lib/campaigns/copy-rules');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const merge = require('../lib/campaigns/merge-fields');
const { renderForRecipients, factsFor } = require('../lib/campaigns/render-recipients');

const BRAND = RULES.brand.defaultName;
const OPT_OUT = RULES.optOut.exactSuffix;
const OPTIONS = { brandName: BRAND, approvedProductCodes: RULES.defaultApprovedProductCodes };

// ── What the loosening bought ──────────────────────────────────────────────

test('THE MESSAGE THE OWNER ASKED FOR IS NOW LEGAL', () => {
  const template = `${BRAND}: Hi {{first_name}}, {{order_count}} orders in and we appreciate you. Code {{code}} for 15% off. ${OPT_OUT}`;
  const verdict = validateCopy(template, OPTIONS);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
});

test('and it renders into something a person would actually send', () => {
  const template = `${BRAND}: Hi {{first_name}}, {{order_count}} orders in and we appreciate you. Code {{code}} for 15% off. ${OPT_OUT}`;
  const { rendered } = renderForRecipients({
    template,
    recipients: [{ phone: '+15550000001', facts: factsFor({ contactName: 'chloe carson', orderCount: 4, couponCode: 'thanks-4x' }) }]
  });
  assert.equal(rendered.length, 1);
  assert.equal(
    rendered[0].message,
    `${BRAND}: Hi Chloe, 4 orders in and we appreciate you. Code thanks-4x for 15% off. ${OPT_OUT}`
  );
  // "chloe carson" becomes "Chloe". 69 of this account's names are typed all
  // lower case, and "hi chloe" reads as a bot rather than a person.
  assert.match(rendered[0].message, /Hi Chloe,/);
});

// ── What was deliberately NOT loosened ─────────────────────────────────────

test('a field nothing can fill is still refused, which was the whole point of the old ban', () => {
  for (const unknown of ['{{nickname}}', '{{favourite_colour}}', '{{spend}}', '{{dose}}']) {
    const verdict = validateCopy(`${BRAND}: Hi ${unknown}. ${OPT_OUT}`, OPTIONS);
    assert.equal(verdict.ok, false, `${unknown} must not be sendable`);
    assert.ok(verdict.failures.some(f => f.check === 'no_merge_fields_or_placeholders'));
  }
});

test('every other placeholder shape is still refused, because nothing renders them', () => {
  for (const shape of ['${first_name}', '%%NAME%%', '[name]', '<name>']) {
    assert.equal(validateCopy(`${BRAND}: Hi ${shape}. ${OPT_OUT}`, OPTIONS).ok, false);
  }
});

test('THEIR HISTORY IS ALLOWED. WATCHING THEM IS NOT.', () => {
  // The line the loosening draws, and it is a real distinction rather than a
  // squeamish one: the same fact, told two ways, produces a message somebody
  // replies to and a message somebody reports.
  for (const allowed of [
    'it has been a while since your last order',
    '{{order_count}} orders in and we appreciate you',
    'you have not ordered in a while'
  ]) {
    assert.equal(validateCopy(`${BRAND}: Hi {{first_name}}, ${allowed}. ${OPT_OUT}`, OPTIONS).ok,
      true, `"${allowed}" should be allowed`);
  }
  for (const refused of [
    'we noticed you went quiet', 'we tracked your visits', 'our records show a gap',
    'you spent a lot with us', 'we have been watching'
  ]) {
    assert.equal(validateCopy(`${BRAND}: Hi {{first_name}}, ${refused}. ${OPT_OUT}`, OPTIONS).ok,
      false, `"${refused}" must stay refused`);
  }
});

test('no medical language survived the loosening', () => {
  // The owner asked for personalisation and said no medical terms. These are
  // the categories that were never in scope to relax.
  for (const refused of [
    'your retatrutide is ready', 'take 250 mcg twice daily', 'clinically proven',
    'this will cure it', 'guaranteed to work', 'your next injection'
  ]) {
    assert.equal(validateCopy(`${BRAND}: Hi {{first_name}}, ${refused}. ${OPT_OUT}`, OPTIONS).ok,
      false, `"${refused}" must stay refused`);
  }
});

test('a percentage is allowed and a currency amount is not', () => {
  assert.equal(validateCopy(`${BRAND}: Hi {{first_name}}, 15% off with code {{code}}. ${OPT_OUT}`, OPTIONS).ok, true);
  assert.equal(validateCopy(`${BRAND}: Hi {{first_name}}, $15 off with code {{code}}. ${OPT_OUT}`, OPTIONS).ok, false);
});

// ── Length, measured on the message rather than the template ───────────────

test('LENGTH IS CHECKED AT THE LONGEST THE MESSAGE CAN RENDER TO', () => {
  // Worth knowing: for most fields the PLACEHOLDER is longer than the value it
  // renders to. "{{first_name}}" is 14 characters and yields at most 12, so
  // those templates can only shrink. "{{code}}" is the exception: 8 characters
  // yielding up to 16, so a template that fits can render to eight more than
  // was measured, and it does so for whoever happens to get a long code.
  const fixed = `${BRAND}: {{code}} . ${OPT_OUT}`.length;
  const filler = 'a'.repeat(RULES.length.maxSeptets - fixed - 4);
  const template = `${BRAND}: {{code}} ${filler}. ${OPT_OUT}`;

  assert.ok(template.length <= RULES.length.maxSeptets,
    `template is ${template.length}, which should fit`);
  assert.ok(merge.worstCase(template).length > RULES.length.maxSeptets,
    'and the rendered worst case should not');

  const verdict = validateCopy(template, OPTIONS);
  assert.equal(verdict.ok, false, 'a template that fits is not a message that fits');
  assert.ok(verdict.failures.some(f => f.detail?.worstCase === true));
});

test('the worst case is the longest permitted value, not the longest in the data', () => {
  // A promise the renderer keeps: every field is truncated to its declared
  // maximum, so the number the validator checked is a ceiling and not a hope.
  const expanded = merge.worstCase('{{first_name}}');
  assert.equal(expanded.length, merge.FIELDS.first_name.maxLength);
  const { rendered } = renderForRecipients({
    template: `${BRAND}: Hi {{first_name}}. ${OPT_OUT}`,
    recipients: [{ phone: '+1', facts: factsFor({ contactName: 'Bartholomewlongname Smith' }) }]
  });
  const name = rendered[0].message.match(/Hi (\w+)\./)[1];
  assert.ok(name.length <= merge.FIELDS.first_name.maxLength);
});

// ── The rendered message is validated again, per person ────────────────────

test('A COMPLIANT TEMPLATE CAN RENDER INTO A NON-COMPLIANT MESSAGE', () => {
  // This is why rendering revalidates. The catalogue contains
  // "Retatrutide - 20mg": a compound name and a dose. Rendering it would put
  // both in front of a carrier from a template that passed every check.
  assert.equal(merge.approvedProductLabel('Retatrutide - 20mg'), '',
    'a product with no approved code must render to nothing rather than its name');
  // Approved codes render as themselves.
  for (const code of ['BPC-157', 'TB-500', 'CU100', 'P-WA10', 'TSM10']) {
    assert.equal(merge.approvedProductLabel(code), code);
  }
  // AND THE GLP-1 SKUs BLANK OUT, which is the behaviour that matters most.
  // RT10, RT20 and TR20 are the retatrutide and tirzepatide lines. They are
  // deliberately not in the approved list, so naming somebody's last purchase
  // silently declines to name those, and the recipient is excluded rather than
  // sent a message pointing at a compound. This is not a gap, it is the
  // catalogue's own decision reaching the merge layer intact.
  for (const glp1 of ['RT10', 'RT20', 'TR20']) {
    assert.equal(merge.approvedProductLabel(glp1), '',
      `${glp1} must not be nameable in a message`);
  }
});

test('A NAME CAN BREAK A MESSAGE THAT PASSED EVERY CHECK', () => {
  // The concrete reason rendering revalidates, and it is not hypothetical.
  //
  // GSM-7 carries some accented characters and not others. "Jose" with an
  // acute and "Renee" with an acute are both in the alphabet; "Zoe" with a
  // diaeresis is not. So a template that passes every rule renders, for one
  // customer out of nine hundred, into a message the network cannot carry as
  // one segment. It would be sent as UCS-2, halving the limit and splitting
  // in two, or mangled.
  //
  // Nothing about the template says this. Only the rendered text does.
  const template = `${BRAND}: Hi {{first_name}}, good to have you. ${OPT_OUT}`;
  assert.equal(validateCopy(template, OPTIONS).ok, true, 'the template itself is fine');

  const { rendered, excluded, reasons } = renderForRecipients({
    template,
    recipients: [
      { phone: '+1', facts: factsFor({ contactName: 'Jos\u00e9 Garcia' }) },
      { phone: '+2', facts: factsFor({ contactName: 'Zo\u00eb Smith' }) },
      { phone: '+3', facts: factsFor({ contactName: 'Amy Mehta' }) }
    ]
  });

  assert.equal(rendered.length, 2, 'the two GSM-7 names go out');
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].phone, '+2');
  assert.equal(excluded[0].reason, 'rendered_message_not_compliant');
  assert.ok(excluded[0].failedChecks.includes('gsm7_character_set_only'));
  assert.equal(reasons.rendered_message_not_compliant, 1);
});

test('a name outside the Latin alphabet is dropped before it reaches validation', () => {
  // Cyrillic and Polish crossed-L are not names this can safely shorten into
  // GSM-7, so firstNameFrom declines and the recipient is excluded for a
  // missing field rather than for a broken message. Same outcome, clearer
  // reason on the dry run.
  for (const name of ['\u0141ukasz Nowak', '\u041e\u043b\u044c\u0433\u0430 \u0418\u0432\u0430\u043d\u043e\u0432\u0430']) {
    assert.equal(merge.firstNameFrom(name), '');
  }
});

test('a person the message cannot be personalised for is EXCLUDED, not sent a broken one', () => {
  // "Hi. orders in and we appreciate you" is visibly a failed mail merge and
  // says the business does not know who it is talking to.
  const template = `${BRAND}: Hi {{first_name}}, {{order_count}} orders in. ${OPT_OUT}`;
  const { rendered, excluded, reasons } = renderForRecipients({
    template,
    recipients: [
      { phone: '+1', facts: factsFor({ contactName: 'Amy Mehta', orderCount: 8 }) },
      { phone: '+2', facts: factsFor({ contactName: null, orderCount: 3 }) },
      { phone: '+3', facts: factsFor({ contactName: 'Brenna Peters', orderCount: null }) }
    ]
  });
  assert.equal(rendered.length, 1);
  assert.equal(excluded.length, 2);
  assert.equal(reasons.personalisation_unavailable, 2);
  assert.deepEqual(excluded[0].missing, ['first_name']);
  assert.deepEqual(excluded[1].missing, ['order_count']);
});

test('a name that is not plainly a name is dropped rather than guessed at', () => {
  // The four junk values in this account: "Test", "d", "D", "G". A single
  // letter in a greeting is worse than no greeting.
  for (const junk of ['d', 'D', 'G', '1234', 'x']) {
    assert.equal(merge.firstNameFrom(junk), '', `"${junk}" must not become a greeting`);
  }
  assert.equal(merge.firstNameFrom('chloe carson'), 'Chloe');
  assert.equal(merge.firstNameFrom('AMY MEHTA'), 'Amy');
  assert.equal(merge.firstNameFrom("O'Brien Family"), "O'brien");
});

test('the issued code is exempt from evasion detection, and only that code', () => {
  // "thanks-4x" reads as leet-obfuscated text to the substitution detector,
  // which is exactly what that detector is for and exactly wrong for a string
  // this system minted seconds ago.
  const template = `${BRAND}: Hi {{first_name}}, code {{code}} for 15% off. ${OPT_OUT}`;
  const { rendered } = renderForRecipients({
    template,
    recipients: [{ phone: '+1', facts: factsFor({ contactName: 'Amy Mehta', couponCode: 'thanks-4x' }) }]
  });
  assert.equal(rendered.length, 1, 'a legitimate code must not be read as evasion');

  // But the exemption is per person and per code: the same text with a
  // DIFFERENT code in it is still checked.
  const sneaky = `${BRAND}: Hi Amy, code fr33-stuff for 15% off. ${OPT_OUT}`;
  assert.equal(validateCopy(sneaky, OPTIONS).ok, false);
});

test('a code that is not code-shaped renders to nothing rather than to rubbish', () => {
  for (const bad of ['', null, 'a', 'this-code-is-far-too-long-to-be-real', 'HAS SPACES']) {
    assert.equal(merge.sanitiseCode(bad), '');
  }
  assert.equal(merge.sanitiseCode('THANKS-4X'), 'thanks-4x', 'codes are compared case-insensitively');
});
