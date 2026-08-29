'use strict';
/**
 * lib/campaigns/recipes.js — the named campaigns the app can build on its own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A RECIPE IS, AND WHY THEY EXIST
 *
 *   A recipe answers all four questions a campaign needs before anybody can
 *   review it: WHO is in it, WHAT it says, WHAT it offers, and WHO IT MUST NOT
 *   REACH AGAIN. Until now those answers lived in two scripts that had to be
 *   run from a terminal, which meant the owner could review and approve a
 *   campaign in the app but could not create one there.
 *
 *   Making them data rather than scripts is what makes the app self-serve. It
 *   also puts the two rules that actually protect customers, the dedupe window
 *   and the copy, in one reviewable place instead of duplicated per script.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO COPY VARIANTS, ALWAYS, AND WHY
 *
 *   Copy that names what somebody bought renders through the APPROVED CODE for
 *   the product, never the compound name. Not every product has one: combination
 *   products have no single code, so `{{last_product}}` renders empty and that
 *   recipient would be silently dropped.
 *
 *   Measured on the live win-back audience that was 155 people out of 376,
 *   which is not a rounding error, it is 41% of the campaign. So every recipe
 *   carries a `named` variant and a `plain` one, the builder splits the
 *   audience by which actually renders, and nobody is dropped for the sake of
 *   one template.
 *
 * THE DEDUPE WINDOW IS THE POINT OF THIS FILE
 *
 *   Cohorts do not exclude people who have already been messaged.
 *   `one_time_lapsed` will hand back the same 278 people next month, minus
 *   whoever ordered. Re-running a win-back against it without a dedupe window
 *   sends the same offer to the same person twice, which reads as a business
 *   that is not paying attention and which burns the audience it is trying to
 *   recover.
 *
 *   `dedupeDays` is therefore mandatory on every recipe and is checked against
 *   the recipe's OWN history rather than all campaigns: somebody who got a
 *   check-in three weeks ago may still be right for a win-back, and blocking
 *   that would be over-correcting. Cross-campaign spacing is a separate
 *   concern and already enforced by the send gate's frequency caps.
 */

/**
 * Win-back copy.
 *
 * Both variants sized against the WORST case: a 12-character first name, a
 * 12-character product code, a 9-character month and a 16-character coupon
 * code. A template that merely fits today's audience passes review and then
 * fails the moment somebody edits it or a longer name joins the cohort.
 */
const WINBACK_NAMED = 'Vin from Vici. Hi {{first_name}}, thanks for the {{last_product}} order back in '
  + '{{last_order_date}}. {{code}} is 15% off. Reply STOP to opt out.';

const WINBACK_PLAIN = 'Vin from Vici. Hi {{first_name}}, thanks for your order back in '
  + '{{last_order_date}}. {{code}} is 15% off your next. Reply STOP to opt out.';

const CHECKIN_NAMED = 'Vin from Vici. Hi {{first_name}}, you picked up {{last_product}} a few weeks '
  + 'back. All good with it? Reply STOP to opt out.';

const CHECKIN_PLAIN = 'Vin from Vici. Hi {{first_name}}, you ordered from us a few weeks '
  + 'back. All good with it? Reply here any time. Reply STOP to opt out.';

const SECOND_ORDER_NAMED = 'Vin from Vici. Hi {{first_name}}, been a while since your {{last_product}} order. '
  + 'Want more sent out? Just say the word. Reply STOP to opt out.';

const SECOND_ORDER_PLAIN = 'Vin from Vici. Hi {{first_name}}, been a while since your last order. Want more '
  + 'sent out? Just say the word. Reply STOP to opt out.';

const RECIPES = Object.freeze({
  winback_one_time: Object.freeze({
    key: 'winback_one_time',
    name: 'Win back the people who bought once',
    /**
     * Said in the app, so it has to be true and it has to be useful. It names
     * who is in, who is deliberately out, and what the offer costs.
     */
    description:
      'Everybody whose only order was between one and twelve months ago. They are past the point '
      + 'where most second orders arrive, so on the evidence they are not coming back unaided. '
      + 'Each one gets a personal code worth 15% that works once and belongs only to them. '
      + 'People who bought within the last month are deliberately left out: about half of all '
      + 'second orders arrive inside that window, so discounting them pays for orders that were '
      + 'coming anyway.',
    workflowCategory: 'winback_one_time_buyer',
    segments: Object.freeze(['one_time_slipping', 'one_time_lapsed']),
    discountPercent: 15,
    // Six months. A win-back is a one-shot: somebody who ignored a personal
    // discount is not persuaded by the same discount in April. Long enough
    // that the second attempt is a genuinely different moment.
    dedupeDays: 180,
    copy: Object.freeze({ named: WINBACK_NAMED, plain: WINBACK_PLAIN })
  }),

  second_order_nudge: Object.freeze({
    key: 'second_order_nudge',
    name: 'Nudge the people who came back once',
    description:
      'Customers with exactly two orders who have now gone longer than their own gap between '
      + 'those two. Until now they were in no group at all: the one-order lists exclude them and '
      + 'the reorder lists need three orders before they will state a rhythm. There are 161 of '
      + 'them and they are worth more per person than anyone except the regulars. It offers '
      + 'nothing, on purpose. They came back once without being paid to, so a code here spends '
      + 'margin on the people least likely to need it.',
    workflowCategory: 'second_order_nudge',
    // Computed from order dates rather than a saved segment, for the same
    // reason as the check-in: it is a rolling window, not a standing group.
    segments: null,
    audience: 'second_order_window',
    discountPercent: null,
    // Six weeks. Long enough that a second nudge is a genuinely different
    // moment, short enough to catch somebody before they lapse entirely.
    dedupeDays: 42,
    copy: Object.freeze({ named: SECOND_ORDER_NAMED, plain: SECOND_ORDER_PLAIN })
  }),

  checkin_21_day: Object.freeze({
    key: 'checkin_21_day',
    name: 'Check in three weeks after an order',
    description:
      'Everybody whose order passed the three-week mark in the last seven days. It asks whether '
      + 'the order was alright and offers nothing at all. The 15% code is sent afterwards, one to '
      + 'one, only to people who actually reply, so the discount is spent on the customers who '
      + 'answered rather than on everybody who was messaged.',
    workflowCategory: 'checkin_21d',
    // Not a saved segment: the audience is computed from order dates by
    // lib/campaigns/check-in.js, because it is a rolling window rather than a
    // standing group.
    segments: null,
    audience: 'check_in_window',
    // No offer in the broadcast half. See lib/campaigns/check-in.js.
    discountPercent: null,
    // One check-in per person per cycle. Somebody who ordered again inside
    // three weeks should not be asked twice about two different orders.
    dedupeDays: 21,
    copy: Object.freeze({ named: CHECKIN_NAMED, plain: CHECKIN_PLAIN })
  })
});

const RECIPE_KEYS = Object.freeze(Object.keys(RECIPES).sort());

function recipe(key) {
  return RECIPES[String(key || '')] || null;
}

/** The catalogue as plain data, safe to return from an API. */
function recipeCatalogue() {
  return RECIPE_KEYS.map(key => {
    const found = RECIPES[key];
    return {
      key: found.key,
      name: found.name,
      description: found.description,
      workflowCategory: found.workflowCategory,
      discountPercent: found.discountPercent,
      dedupeDays: found.dedupeDays,
      segments: found.segments ? [...found.segments] : null,
      audience: found.audience || 'segments'
    };
  });
}

module.exports = { RECIPES, RECIPE_KEYS, recipe, recipeCatalogue };
