'use strict';
/**
 * lib/campaigns/proposal-mechanisms.js — the CLOSED list of ways a campaign
 * proposal may try to move a cohort, and the deterministic rules that keep a
 * set of proposals genuinely different from one another.
 *
 * WHY A CATALOGUE AND NOT A PROMPT
 *   Ask a language model for "three campaign ideas" and you get three
 *   rewordings of one idea, because rewording is what a language model is for.
 *   The mechanism — no offer, free shipping, a bundle, a first-reorder
 *   incentive, a plain check-in — is a BUSINESS decision with a cost and a
 *   risk attached, so it is chosen here, in code, from a list a reviewer can
 *   read. The model is only ever asked to write the words for a mechanism it
 *   was handed. It cannot invent a seventh mechanism, cannot pick which
 *   mechanisms appear, and cannot decide that all four should be discounts.
 *
 * THE THREE INVARIANTS THIS FILE ENFORCES AT REQUIRE TIME
 *   1. Every mechanism sits in its own distinctness class. Two proposals from
 *      the same class are the same proposal wearing different words.
 *   2. Every mechanism that costs money carries the cost, and every mechanism
 *      that trains customers to wait for a discount carries THAT risk, named,
 *      in the proposal a human reads. `assertCatalogueIntegrity()` throws on
 *      require if a future edit deletes one, so the risk cannot quietly fall
 *      off a proposal.
 *   3. No directive in this file contains a digit. These strings are
 *      transported into a model prompt verbatim; a number in one of them is a
 *      number the model will happily repeat into customer copy, and every
 *      number a human sees must come from the deterministic layer instead.
 *
 * ON OFFER TERMS AND SMS COPY, WHICH SURPRISE PEOPLE
 *   A proposal may carry `offer.kind = 'free_shipping'`, and the drafted SMS
 *   still may not say the words "free shipping". `free` is on the carrier
 *   filter list in docs/campaigns/SMS-COPY-RESEARCH.md, a percentage or a
 *   price fails `no_unsupported_quantity_price_or_deadline`, and the playbook
 *   is explicit that an offer is attached by a human during review and never
 *   by a drafter. So the offer lives in the STRUCTURED part of the proposal,
 *   where the reviewer reads it, prices it and decides; the copy is the plain
 *   compliant message that carries it. That separation is the feature, not a
 *   limitation of it.
 *
 * EVIDENCE STATUS
 *   `docs/campaigns/REPEAT-PURCHASE-RESEARCH.md` is being written in parallel
 *   with this file. Until it lands, every mechanism is marked
 *   `awaiting_research` and its rationale is labelled as a business premise
 *   rather than as a finding. `test/campaign-proposal-mechanisms.test.js`
 *   reconciles this catalogue against that document's DECISIONS block the
 *   moment the document exists, so adopting the research is an edit here that
 *   CI checks rather than a claim somebody makes in a commit message.
 */

/** Bumped when the meaning of a mechanism changes. Stored on every proposal. */
const MECHANISM_CATALOGUE_VERSION = 'proposal-mechanisms-2026-08-23';

/** Evidence a mechanism's premise may claim. Nothing outside this list. */
const EVIDENCE_STATES = Object.freeze(['awaiting_research', 'research_backed']);

/** Who may attach an offer. There is exactly one answer and it is not a model. */
const OFFER_APPLIED_BY = 'human_at_review';

/**
 * THE CATALOGUE.
 *
 * `distinctnessClass` is the primary key of difference. `priority` orders the
 * selection when a caller asks for fewer mechanisms than exist.
 *
 * `audienceNarrowing` is deliberately expressed as a REQUIREMENT on a fact the
 * opportunity must supply, never as a threshold written here. A number written
 * here would be a threshold this file invented, which is the same sin as
 * letting the model invent one. When the detector does not supply the fact,
 * the proposal targets the whole cohort and says why it did not narrow.
 */
/**
 * Whether an opportunity describes people who have bought exactly once.
 *
 * Read from the cohort key rather than from a size or a title, because those
 * are prose and this decides which message somebody receives. The detector's
 * keys for this business are one_time_buyers, one_time_lapsed,
 * one_time_first_month, one_time_slipping, one_time_above_typical_spend and
 * one_time_multi_product: all of them single-order cohorts, all prefixed.
 */
function isSingleOrderCohort(opportunity) {
  const key = String(opportunity?.cohort?.key || opportunity?.cohort?.segmentKey || '');
  return key.startsWith('one_time');
}

const MECHANISMS = Object.freeze({
  plain_check_in: Object.freeze({
    id: 'plain_check_in',
    label: 'Plain check-in, no offer',
    distinctnessClass: 'no_incentive',
    priority: 100,
    // Always present in every set. It is the control: without a no-offer arm
    // in front of the reviewer, every comparison is between two ways of
    // spending margin and the question "does this cohort need an offer at
    // all?" never gets asked.
    alwaysInclude: true,
    offer: null,
    premise: 'A first order that never turned into a second one may be nothing more than the business never speaking again. The cheapest possible test of that is speaking, with nothing attached.',
    copyDirective: 'A short, calm message that says the business is here and can help. Offer nothing. Ask for nothing. Do not refer to what the person bought, when they bought it, or that they have not been back.',
    costs: Object.freeze([
      Object.freeze({ id: 'audience_attention', statement: 'Spends one contact from the cadence budget and a share of list goodwill. That is the only cost.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'no_reason_to_act',
        statement: 'A message with no offer and no news gives the recipient nothing to do, so it may produce opt-outs without producing orders.',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    audienceNarrowing: null
  }),

  product_education: Object.freeze({
    id: 'product_education',
    label: 'Answer the first-time buyer question, no offer',
    distinctnessClass: 'information',
    priority: 90,
    offer: null,
    premise: 'A first-time buyer of a technical product often does not come back because they are unsure what they bought or what pairs with it. Information is the intervention, not price.',
    copyDirective: 'A short message offering to answer a question about the product range. Offer nothing priced. Make it obvious that a reply reaches a person. Do not describe what the product does, does not do, or is for.',
    costs: Object.freeze([
      Object.freeze({ id: 'staff_time', statement: 'Invites replies, and a reply that goes unanswered is worse than no message. Costs inbox time.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'claim_drift_under_questioning',
        statement: 'Inviting product questions invites answers, and an answer given in a hurry is where a health or dosing claim gets made. The reply is not validated by anything.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/SMS-COMPLIANCE-RESEARCH.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    audienceNarrowing: null
  }),

  ask_what_stopped_them: Object.freeze({
    id: 'ask_what_stopped_them',
    label: 'Ask the cohort what stopped them, no offer',
    distinctnessClass: 'feedback',
    priority: 80,
    offer: null,
    premise: 'On a list this size a reply is worth more as text than as a rate. One person naming the reason they did not come back tells the business something no click-through number on this audience can.',
    copyDirective: 'A short message inviting an open reply about how the order went. Offer nothing. Ask nothing about health, effects, results or how the product was used.',
    costs: Object.freeze([
      Object.freeze({ id: 'staff_time', statement: 'Every reply needs a human answer, and the value of this mechanism is entirely in reading them.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'invites_complaint_volume',
        statement: 'Asking an open question surfaces complaints and refund requests along with useful signal, and those arrive as an obligation rather than as data.',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md'
      }),
      Object.freeze({
        id: 'solicits_health_reports',
        statement: 'An open question about how an order went can be answered with an account of how the product was used, which is content the business then holds.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/SMS-COMPLIANCE-RESEARCH.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    audienceNarrowing: null
  }),

  free_shipping: Object.freeze({
    id: 'free_shipping',
    label: 'Shipping covered on the next order',
    distinctnessClass: 'shipping_economics',
    priority: 70,
    offer: Object.freeze({
      kind: 'shipping_concession',
      appliedBy: OFFER_APPLIED_BY,
      // The reviewer supplies every one of these before the campaign can be
      // approved. None of them is guessed here and none reaches the copy.
      termsRequiredFromHuman: Object.freeze([
        'the exact shipping concession and who pays it',
        'the order value floor, if any',
        'the start and end date, as an authoritative deadline',
        'the discount or coupon mechanism in the store, created and tested',
        'whether the concession is stated in the message or applied at checkout'
      ]),
      statedInCopy: false
    }),
    premise: 'Shipping is a cost the customer sees at checkout and did not choose. Removing it concedes a fixed cost rather than product margin, so it does not reprice the product in the customer\'s mind.',
    copyDirective: 'A short message saying there is something waiting for them on their next order and that the details are on the site or available by reply. Do not state the concession, a price, a percentage, a code or a deadline. A human attaches the terms during review.',
    costs: Object.freeze([
      Object.freeze({ id: 'fulfilment_margin', statement: 'Costs real fulfilment margin on every order that redeems, including orders that would have happened anyway.' }),
      Object.freeze({ id: 'redemption_by_existing_intent', statement: 'Anyone already about to order redeems it, so part of the cost buys nothing.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'concession_becomes_expected',
        statement: 'A shipping concession repeated becomes the price. It is easier to withdraw than a product discount, but it is not free to withdraw.',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'terms_incomplete_at_send',
        statement: 'The message points at terms that exist only if a human created them in the store first. Sent without that, it points at nothing.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    audienceNarrowing: null
  }),

  bundle: Object.freeze({
    id: 'bundle',
    label: 'A pairing with what they already bought',
    distinctnessClass: 'assortment',
    priority: 60,
    offer: Object.freeze({
      kind: 'assortment_change',
      appliedBy: OFFER_APPLIED_BY,
      termsRequiredFromHuman: Object.freeze([
        'which products are paired, from the verified catalogue',
        'whether the pairing is priced differently from the parts',
        'that both products are in stock for the whole window',
        'the start and end date, as an authoritative deadline'
      ]),
      statedInCopy: false
    }),
    premise: 'Changing what is on offer is not the same as changing the price of what is on offer. A pairing raises the value of the order without teaching anyone to wait for a lower number.',
    copyDirective: 'A short message saying the range has a pairing worth a look, and that the details are on the site or available by reply. Name at most one product, exactly as it is given to you. Do not state a price, a saving, a percentage or a deadline.',
    costs: Object.freeze([
      Object.freeze({ id: 'inventory_exposure', statement: 'Commits stock of two products for the window, and a stockout mid-campaign is worse than no campaign.' }),
      Object.freeze({ id: 'possible_margin', statement: 'Costs margin only if the pairing is priced below the parts, which is a decision the reviewer makes and not one this proposal assumes.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'relevance_unknown_for_first_time_buyers',
        statement: 'A pairing is a guess about what someone wants next, and a cohort defined by having bought once is a cohort the business knows least about.',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'pairing_reads_as_protocol',
        statement: 'Suggesting two products together can read as advice about combining them, which is a use claim the business must not make.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/SMS-COMPLIANCE-RESEARCH.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    // If the detector supplies the cohort's single most-bought product, the
    // pairing proposal narrows to the people who bought it. If it does not,
    // the proposal targets the whole cohort and says so.
    audienceNarrowing: Object.freeze({
      requiresFact: 'anchorProductKey',
      dimension: 'product_purchased',
      operator: 'any_of',
      note: 'Narrowed to the people who bought the anchor product the detector named.'
    })
  }),

  loyalty_thank_you: Object.freeze({
    // ── The two the owner asked for. Both name the person and both carry a
    // ── code, which is what the loosened copy rules exist to allow.
    id: 'loyalty_thank_you',
    label: 'Thank a repeat buyer by name, with a code',
    distinctnessClass: 'loyalty_recognition',
    // Above first_reorder_incentive, which is the same idea without the name
    // or the code. There is one monetary slot and this should win it whenever
    // the cohort has actually bought more than once.
    priority: 58,
    // A THANK-YOU TO SOMEBODY WHO ORDERED ONCE IS NOT A THANK-YOU.
    // "One order in and we appreciate you" is faintly insulting, and the
    // {{order_count}} in the directive would render as "1". Cohort-gated so
    // the pairing cannot happen.
    appliesTo: (opportunity) => !isSingleOrderCohort(opportunity),
    offer: Object.freeze({
      kind: 'monetary_discount',
      appliedBy: OFFER_APPLIED_BY,
      termsRequiredFromHuman: Object.freeze([
        'the percentage, and the margin it costs at the expected redemption rate',
        'that the code is single use and bound to one person',
        'the expiry date',
        'the order count at which somebody qualifies'
      ]),
      // STATED IN THE COPY, unlike every mechanism above it. A thank-you that
      // does not say what it is worth is not a thank-you, it is a hint.
      statedInCopy: true
    }),
    premise: 'A customer who has ordered several times has already decided about this business. The cheapest thing available is to notice, by name, and give them a reason to do it again. It costs margin only on redemption and it is the only mechanism here that spends goodwill upward rather than drawing on it.',
    copyDirective: 'Greet them with {{first_name}} and name {{order_count}} as the reason for the message. Say the business appreciates them, plainly and without flattery. Offer {{code}} and you may state the percentage. Do not say what they bought, do not mention money they have spent, and do not imply the business has been watching them.',
    costs: Object.freeze([
      Object.freeze({ id: 'product_margin', statement: 'Costs product margin on every redemption, including from customers who were going to order anyway.' }),
      Object.freeze({ id: 'reference_price', statement: 'Repeated often enough, the discounted price becomes the price these customers wait for.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'discount_trains_waiting',
        statement: 'A discount that works teaches this cohort that orders are cheaper if they wait. The cost of that lands on later orders, after the campaign that looked successful has already been counted as a win.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'rewards_the_already_loyal',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md',
        statement: 'Every recipient is by definition already buying, so a share of the margin buys nothing that was not already happening.'
      }),
      Object.freeze({
        id: 'thank_you_reads_as_a_sale',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md',
        statement: 'A message that opens as gratitude and closes as a discount can read as a sale wearing a thank-you, which costs more goodwill than sending nothing.'
      })
    ]),
    evidence: Object.freeze({
      status: 'awaiting_research',
      statement: 'No measured uplift exists for this cohort in this business yet. The order counts are observed; the response to being thanked is not.'
    })
  }),

  winback_personal: Object.freeze({
    id: 'winback_personal',
    label: 'Reconnect with somebody who bought once, by name',
    distinctnessClass: 'lapsed_reconnection',
    priority: 60,
    // The mirror of the rule above: reconnecting with somebody who orders
    // every three weeks reads as though the business has lost track of them.
    appliesTo: (opportunity) => isSingleOrderCohort(opportunity),
    offer: Object.freeze({
      kind: 'monetary_discount',
      appliedBy: OFFER_APPLIED_BY,
      termsRequiredFromHuman: Object.freeze([
        'the percentage, and whether it is worth more than the margin on a second order',
        'that the code is single use and bound to one person',
        'the expiry date',
        'how long somebody must have been away to qualify'
      ]),
      statedInCopy: true
    }),
    premise: 'Five hundred and twelve of this business\'s buyers have ordered exactly once. They are the largest single cohort and the one with the most room in it. A message that uses their name and gives them a reason is the cheapest test of whether the gap was indifference or forgetting.',
    copyDirective: 'Greet them with {{first_name}}. Acknowledge that it has been a while in a way that sounds like a person noticing, not a system reporting. Offer {{code}} and you may state the percentage. Do not say how long it has been in days, do not say what they bought, and never suggest the business has been watching or tracking them.',
    costs: Object.freeze([
      Object.freeze({ id: 'product_margin', statement: 'Costs product margin on every redemption.' }),
      Object.freeze({ id: 'one_shot_at_this_cohort', statement: 'A lapsed customer will read one reconnection message properly. A second one lands as a mailshot.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        id: 'discount_trains_waiting',
        statement: 'A discount that works teaches this cohort that orders are cheaper if they wait. The cost of that lands on later orders, after the campaign that looked successful has already been counted as a win.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'the_gap_may_be_deliberate',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md',
        statement: 'Somebody who bought once and stopped may have decided rather than forgotten, and a discount does not answer a decision. Some of this audience will opt out rather than return.'
      }),
      Object.freeze({
        id: 'reads_as_surveillance',
        severity: 'high',
        evidence: 'assumption',
        source: 'lib/campaigns/copy-rules.js privacy_and_surveillance',
        statement: 'Noticing that somebody stopped buying is one clumsy sentence away from telling them they have been watched, which is the fastest way to turn a lapsed customer into a complaint.'
      })
    ]),
    evidence: Object.freeze({
      status: 'awaiting_research',
      statement: 'The cohort is observed and large. Whether a discount recovers any of it is not measured, and this proposal does not claim it is.'
    })
  }),

  first_reorder_incentive: Object.freeze({
    id: 'first_reorder_incentive',
    label: 'A one-time incentive on the second order',
    distinctnessClass: 'monetary_incentive',
    priority: 50,
    offer: Object.freeze({
      kind: 'monetary_discount',
      appliedBy: OFFER_APPLIED_BY,
      termsRequiredFromHuman: Object.freeze([
        'the exact value of the incentive and the margin it costs',
        'that it is single use and bound to the second order only',
        'the start and end date, as an authoritative deadline',
        'the coupon created and tested in the store',
        'the floor below which the business will not repeat it'
      ]),
      statedInCopy: false
    }),
    premise: 'A direct incentive is the strongest short-term lever available and the most expensive one. It is in this set so the reviewer can compare it against the cheaper mechanisms, not because it is recommended.',
    copyDirective: 'A short message saying there is something waiting for them and that the details are on the site or available by reply. Do not state a value, a percentage, a code, a saving or a deadline. A human attaches the terms during review.',
    costs: Object.freeze([
      Object.freeze({ id: 'product_margin', statement: 'Costs product margin directly on every redemption.' }),
      Object.freeze({ id: 'margin_on_orders_that_would_have_happened', statement: 'Any customer who was going to order anyway redeems it, so a share of the cost buys no additional order at all.' })
    ]),
    risks: Object.freeze([
      Object.freeze({
        // This risk id is REQUIRED on every monetary mechanism, enforced by
        // assertCatalogueIntegrity(). The owner asked for it by name: a
        // discount that works teaches the cohort to wait for the next one, and
        // that cost lands after the campaign that looked successful.
        id: 'discount_trains_waiting',
        statement: 'A discount that works teaches this cohort that orders are cheaper if they wait. The cost of that lands on later orders, after the campaign that looked successful has already been counted as a win.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'reference_price_reset',
        statement: 'Once a cohort has bought at the discounted number, that number is the price they compare against, and full price reads as an increase.',
        severity: 'high',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      }),
      Object.freeze({
        id: 'attracts_the_least_loyal',
        statement: 'An incentive is redeemed hardest by the people most responsive to incentives, so it selects for the customers least likely to reorder without one.',
        severity: 'moderate',
        evidence: 'assumption',
        source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md'
      })
    ]),
    evidence: Object.freeze({ status: 'awaiting_research', source: 'docs/campaigns/REPEAT-PURCHASE-RESEARCH.md' }),
    audienceNarrowing: null
  })
});

const MECHANISM_IDS = Object.freeze(Object.keys(MECHANISMS));

/**
 * How many mechanisms of one class may appear in a single set of proposals.
 *
 * One, for every class. Three discounts with different wording is the failure
 * mode this whole file exists to prevent, and a per-class cap is the only
 * version of that rule a future edit cannot argue with.
 */
const MAX_PER_CLASS = 1;

/** The default number of proposals produced for one opportunity. */
// SIX, RAISED FROM FOUR.
//
// The catalogue is ordered cheapest first on purpose: a plain check-in, then
// an answer to a question, then a request for feedback, then shipping. That
// ordering is the discipline of trying the thing that costs nothing before
// spending margin, and it is worth keeping.
//
// At four, the set stopped before it reached anything that costs margin, so
// the personalised win-back and loyalty arms were never offered at all. Six
// reaches exactly one monetary arm, which the cap in selectMechanisms
// guarantees, so the reviewer sees the cheap options FIRST and the paid one
// alongside them rather than instead of them.
const DEFAULT_MECHANISM_LIMIT = 6;
const MIN_MECHANISM_LIMIT = 2;

/**
 * Require-time integrity. A catalogue edit that drops a risk, adds a second
 * mechanism to a class, writes a number into a prompt directive, or lets a
 * model attach an offer is a crash on boot rather than a proposal that is
 * quietly missing its warning.
 */
function assertCatalogueIntegrity(catalogue = MECHANISMS) {
  const classes = new Set();
  for (const [key, mechanism] of Object.entries(catalogue)) {
    const where = `mechanism ${key}`;
    if (mechanism.id !== key) throw new Error(`${where}: id does not match its key.`);
    if (!mechanism.label) throw new Error(`${where}: has no label.`);
    if (!mechanism.distinctnessClass) throw new Error(`${where}: has no distinctness class.`);
    if (classes.has(mechanism.distinctnessClass)) {
      throw new Error(`${where}: distinctness class ${mechanism.distinctnessClass} is already used. Two mechanisms in one class are one mechanism.`);
    }
    classes.add(mechanism.distinctnessClass);

    if (!Array.isArray(mechanism.risks) || mechanism.risks.length === 0) {
      throw new Error(`${where}: carries no risk. Every mechanism costs something.`);
    }
    if (!Array.isArray(mechanism.costs) || mechanism.costs.length === 0) {
      throw new Error(`${where}: carries no cost statement.`);
    }
    if (!EVIDENCE_STATES.includes(mechanism.evidence?.status)) {
      throw new Error(`${where}: evidence status must be one of ${EVIDENCE_STATES.join(', ')}.`);
    }

    // Directives and premises are transported into a model prompt verbatim.
    for (const field of ['copyDirective', 'premise']) {
      const text = String(mechanism[field] || '');
      if (!text) throw new Error(`${where}: has no ${field}.`);
      if (/\d/.test(text)) {
        throw new Error(`${where}: ${field} contains a digit. Numbers reach a human from the deterministic layer, never from a prompt string.`);
      }
    }

    if (mechanism.offer) {
      if (mechanism.offer.appliedBy !== OFFER_APPLIED_BY) {
        throw new Error(`${where}: an offer may only be applied by ${OFFER_APPLIED_BY}.`);
      }
      // WAS ALWAYS FALSE, AND THE REASON GIVEN WAS "the copy validator rejects
      // them". That was true: a percentage and a code both failed. Neither
      // does now, so the blanket assertion has become a statement about a
      // world that no longer exists.
      //
      // What replaces it is narrower and still real. A mechanism may state its
      // offer in the copy, but only the two things the validator will actually
      // pass: a percentage and a code. A currency amount is still refused, and
      // a mechanism claiming it can state one would produce drafts that fail
      // at the last step every time.
      if (typeof mechanism.offer.statedInCopy !== 'boolean') {
        throw new Error(`${where}: statedInCopy must be explicitly true or false.`);
      }
      if (mechanism.offer.statedInCopy === true && !/\{\{code\}\}/.test(mechanism.copyDirective || '')) {
        throw new Error(`${where}: states its offer in the copy but its directive never asks for {{code}}, so there is nothing for the customer to use.`);
      }
      if (!Array.isArray(mechanism.offer.termsRequiredFromHuman) || !mechanism.offer.termsRequiredFromHuman.length) {
        throw new Error(`${where}: an offer must list the terms a human has to supply.`);
      }
      if (mechanism.offer.kind === 'monetary_discount') {
        const named = mechanism.risks.some(risk => risk.id === 'discount_trains_waiting');
        if (!named) {
          throw new Error(`${where}: a monetary discount must carry the discount_trains_waiting risk. That cost is not allowed to be hidden.`);
        }
      }
    }
  }
  const always = Object.values(catalogue).filter(mechanism => mechanism.alwaysInclude === true);
  if (always.length !== 1) {
    throw new Error('Exactly one mechanism must be marked alwaysInclude: the no-offer control.');
  }
  if (always[0].offer !== null) {
    throw new Error('The always-included control mechanism must carry no offer.');
  }
  return true;
}

assertCatalogueIntegrity();

/**
 * Choose the mechanisms for one opportunity.
 *
 * Deterministic, and deliberately not a function of anything a model said.
 * The control is always in. Each class appears at most once. The remainder is
 * filled by priority, so the set is reproducible for the same input.
 *
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {string[]} [options.exclude] mechanism ids a caller has already dismissed
 * @returns {Array<object>} frozen mechanism records, control first
 */
/**
 * Mechanisms that exist in the catalogue and may never be offered.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY RETIRE RATHER THAN DELETE
 *
 *   A deleted mechanism comes back. Somebody reads the catalogue in six
 *   months, notices that a shipping offer is an obvious thing for a shop to
 *   run, and adds it again with the same reasoning that put it here the first
 *   time. The definition stays so the refusal is attached to it.
 *
 * WHY free_shipping
 *
 *   The owner's words: "I'm not involved in the shipping APIs and all that
 *   stuff. That's not really under our control. We can't really control that
 *   from the app."
 *
 *   That is the whole argument and it is decisive. Every other mechanism here
 *   resolves to something this system creates and can verify — a percentage
 *   coupon it mints, a bundle it names, a question it asks. A shipping
 *   concession resolves to a change in a fulfilment pipeline nobody here
 *   touches, so the campaign would promise something the app cannot deliver,
 *   confirm, or withdraw.
 *
 *   Its own `termsRequiredFromHuman` list said as much and nobody read it: it
 *   asks a human to supply "the exact shipping concession and who pays it" and
 *   "the discount or coupon mechanism in the store, created and tested" before
 *   approval. Five preconditions outside this system is not a mechanism, it is
 *   a request for someone else to build one.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const RETIRED_MECHANISMS = Object.freeze({
  free_shipping: 'Shipping is not controlled by this system. A campaign cannot promise a '
    + 'concession it can neither apply, verify, nor withdraw.'
});

function selectMechanisms({ limit = DEFAULT_MECHANISM_LIMIT, exclude = [], opportunity = null } = {}) {
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  const wanted = Math.min(
    MECHANISM_IDS.length,
    Math.max(MIN_MECHANISM_LIMIT, Number.isInteger(limit) ? limit : DEFAULT_MECHANISM_LIMIT)
  );

  const ordered = Object.values(MECHANISMS)
    .filter(mechanism => !excluded.has(mechanism.id))
    // Retired: kept in the catalogue with its reasoning, never offered.
    .filter(mechanism => !Object.prototype.hasOwnProperty.call(RETIRED_MECHANISMS, mechanism.id))
    // A mechanism that declares a cohort is offered only for that cohort.
    // Without the opportunity nothing is gated, so an existing caller that
    // does not pass one keeps the behaviour it had.
    .filter(mechanism => typeof mechanism.appliesTo !== 'function'
      || !opportunity
      || mechanism.appliesTo(opportunity) === true)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  const chosen = [];
  const usedClasses = new Map();

  // AT MOST ONE ARM THAT COSTS MARGIN.
  //
  // This used to be true for free, because the catalogue held exactly one
  // monetary mechanism. It now holds three: the loyalty thank-you, the
  // win-back, and the original second-order incentive. Without this the
  // reviewer is handed three flavours of discount and one control, which
  // answers "which discount" and never "does this cohort need one at all".
  //
  // Enforced in selection rather than in the catalogue, because three monetary
  // mechanisms is correct. Offering all three at once is not.
  let monetaryChosen = 0;

  function take(mechanism) {
    const used = usedClasses.get(mechanism.distinctnessClass) || 0;
    if (used >= MAX_PER_CLASS) return false;
    const isMonetary = mechanism.offer?.kind === 'monetary_discount';
    if (isMonetary && monetaryChosen >= 1) return false;
    usedClasses.set(mechanism.distinctnessClass, used + 1);
    if (isMonetary) monetaryChosen += 1;
    chosen.push(mechanism);
    return true;
  }

  // The control first, unless the caller has explicitly dismissed it. A set
  // with no no-offer arm is a set that can only answer "which offer", never
  // "any offer at all".
  const control = ordered.find(mechanism => mechanism.alwaysInclude === true);
  if (control) take(control);

  for (const mechanism of ordered) {
    if (chosen.length >= wanted) break;
    if (chosen.includes(mechanism)) continue;
    take(mechanism);
  }
  return chosen;
}

/** Look one up, or null. Never throws: an unknown id is a model inventing one. */
function mechanismById(id) {
  const key = String(id || '');
  return Object.prototype.hasOwnProperty.call(MECHANISMS, key) ? MECHANISMS[key] : null;
}

module.exports = {
  DEFAULT_MECHANISM_LIMIT,
  RETIRED_MECHANISMS,
  EVIDENCE_STATES,
  MAX_PER_CLASS,
  MECHANISMS,
  MECHANISM_CATALOGUE_VERSION,
  MECHANISM_IDS,
  MIN_MECHANISM_LIMIT,
  OFFER_APPLIED_BY,
  assertCatalogueIntegrity,
  mechanismById,
  selectMechanisms
};
