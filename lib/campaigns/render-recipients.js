'use strict';
/**
 * lib/campaigns/render-recipients.js — one message per person.
 *
 * WHERE THIS SITS, AND WHY IT IS NOT IN THE SEND PATH
 *
 * `sms_campaign_recipients.rendered_message` already existed and was already
 * frozen at approval time by `approve_sms_campaign`, which wrote the SAME
 * campaign string to every row. Everything downstream reads only that column:
 * the delivery worker refuses to construct text at all, on the stated grounds
 * that "an empty one means the snapshot is wrong and a person should look".
 *
 * That is exactly the right seam. Rendering happens ONCE, at approval, and
 * what gets sent is what was approved. Substituting at send time would mean
 * the operator approved a template and the customer received something nobody
 * had read.
 *
 * EVERY RENDERED MESSAGE IS VALIDATED AGAIN, PER PERSON
 *
 * This is the part that cannot be skipped. A template can be perfectly
 * compliant and render into something that is not: a product name carrying a
 * compound, a name that pushes it over one segment, a coupon code that turns
 * out to be empty. The template passing is not the message passing, and the
 * message is what reaches a phone.
 *
 * A recipient whose rendered message fails is EXCLUDED, not fixed and not sent
 * anyway. Silently sending a non-compliant message to one person because the
 * other four hundred were fine is the worst available outcome.
 */

const { render } = require('./merge-fields');
const { validateCopy } = require('./copy-validator');
const { RULES } = require('./copy-rules');

/**
 * Render one campaign message for a list of recipients.
 *
 * @param {object}   options
 * @param {string}   options.template   the approved message, with {{fields}}
 * @param {Array}    options.recipients [{ phone, facts }]
 * @param {string}   [options.brandName]
 * @returns {{rendered: Array, excluded: Array, reasons: object}}
 */
function renderForRecipients({ template, recipients = [], brandName = RULES.brand.defaultName }) {
  const rendered = [];
  const excluded = [];
  const reasons = {};
  const note = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

  const options = {
    brandName,
    approvedProductCodes: RULES.defaultApprovedProductCodes
  };

  for (const recipient of recipients) {
    const outcome = render(template, recipient?.facts || {});

    // A message that lost a variable is not a worse version of the message, it
    // is a different one: "Hi. orders in and we appreciate you" is visibly
    // broken and says the business does not know who it is talking to. Better
    // to leave that person out of this campaign than to send it.
    if (outcome.missing.length) {
      // The broken text is carried, not hidden. The owner asked to be shown
      // what the message would look like rather than only told it cannot be
      // sent, and seeing "Saw your  order never went through" makes the case
      // for removal better than any sentence explaining it would.
      excluded.push({
        phone: recipient.phone,
        reason: 'personalisation_unavailable',
        missing: outcome.missing,
        wouldRead: outcome.text || null
      });
      note('personalisation_unavailable');
      continue;
    }

    // The rendered text, not the template. This is the only check that sees
    // what the customer will actually read.
    //
    // The issued code is passed in as an approved token, the same way product
    // codes are. Without it the substitution-evasion detector reads a code
    // like "thanks-4x" as leet-obfuscated text, which is exactly what that
    // detector is for and exactly wrong here: this code is not a disguised
    // word, it is a string this system minted seconds ago and knows the value
    // of. Only the code actually issued to THIS person is exempt.
    const issuedCode = recipient?.facts?.couponCode
      ? [String(recipient.facts.couponCode)]
      : [];
    const verdict = validateCopy(outcome.text, {
      ...options,
      approvedProductCodes: [...options.approvedProductCodes, ...issuedCode]
    });
    if (!verdict.ok) {
      excluded.push({
        phone: recipient.phone,
        reason: 'rendered_message_not_compliant',
        failedChecks: (verdict.failures || []).map(f => f.check)
      });
      note('rendered_message_not_compliant');
      continue;
    }

    rendered.push({ phone: recipient.phone, message: outcome.text });
  }

  return { rendered, excluded, reasons };
}

/**
 * Customer facts in the shape the merge fields expect.
 *
 * Deliberately narrow. It takes the four things the field table can render and
 * nothing else, so widening what a message may say about somebody is a
 * decision made in merge-fields.js rather than a side effect of another
 * module gaining a column.
 */
function factsFor({ contactName, orderCount, lastProductName, lastProductSku, couponCode } = {}) {
  return {
    contactName: contactName || null,
    orderCount: Number.isFinite(Number(orderCount)) ? Number(orderCount) : null,
    lastProductName: lastProductName || null,
    lastProductSku: lastProductSku || null,
    couponCode: couponCode || null
  };
}

module.exports = { factsFor, renderForRecipients };
