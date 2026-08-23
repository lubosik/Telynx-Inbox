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
const DEFAULT_MECHANISM_LIMIT = 4;
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
      if (mechanism.offer.statedInCopy !== false) {
        throw new Error(`${where}: offer terms are never stated in drafted copy; the copy validator rejects them.`);
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
function selectMechanisms({ limit = DEFAULT_MECHANISM_LIMIT, exclude = [] } = {}) {
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  const wanted = Math.min(
    MECHANISM_IDS.length,
    Math.max(MIN_MECHANISM_LIMIT, Number.isInteger(limit) ? limit : DEFAULT_MECHANISM_LIMIT)
  );

  const ordered = Object.values(MECHANISMS)
    .filter(mechanism => !excluded.has(mechanism.id))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  const chosen = [];
  const usedClasses = new Map();

  function take(mechanism) {
    const used = usedClasses.get(mechanism.distinctnessClass) || 0;
    if (used >= MAX_PER_CLASS) return false;
    usedClasses.set(mechanism.distinctnessClass, used + 1);
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
