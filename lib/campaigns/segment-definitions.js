'use strict';
/**
 * lib/campaigns/segment-definitions.js — the catalogue of AUTOMATIC segments.
 *
 * These are views onto the deterministic engine that already exists. Nothing
 * here re-implements the arithmetic: every definition delegates to
 * lib/campaigns/reorder-cadence.js and lib/campaigns/winback.js, which are the
 * only place median/MAD/cooldown logic lives.
 *
 * WHY A CATALOGUE RATHER THAN FREE-FORM FILTERS
 *   A saved segment must be reproducible. If an operator could type an
 *   arbitrary predicate, "why is this person in this segment" would have as
 *   many answers as there have been edits. A closed catalogue keyed by a
 *   stable string means the answer is always "definition X at rule version Y
 *   said so, and here is the evidence row that proves it".
 *
 * ADDING ONE
 *   Add an entry here, give it a new `key`, and leave existing keys alone. The
 *   key is stored on the segment row and is how a recompute finds its
 *   definition, so renaming one orphans a live segment.
 *
 * MEMBERSHIP IS BEHAVIOUR, NEVER PERMISSION
 *   Every predicate below reads purchase history, cadence, product identity
 *   and recency. Not one of them reads consent, STOP state, DND freshness,
 *   quiet hours or support clearance, and none of them ever should. A person
 *   who may not be messaged today is still a person whose purchase history
 *   matches the pattern, and hiding them makes the screen lie.
 *
 *   Whether that person is CONTACTABLE travels alongside as
 *   `member.commercialClearance`, and is filled in more fully by
 *   lib/campaigns/segment-contactability.js. It is information on the row. It
 *   is not a filter, it is not stored, and it is never authority to send.
 *
 * HOW THE NAMES AND DESCRIPTIONS READ
 *   The `key` is for the database. The `name` and `description` are for a
 *   person who has never read this file and never will. So they say who is in
 *   the group, how sure the timing is, and when you would use it, in the words
 *   an operator already uses. They do not say median, MAD, interval or
 *   confidence, because knowing those terms is not part of anybody's job here.
 *
 *   Plain is not the same as vague. A description may name a real number a
 *   person can picture, days, weeks, counts, and it may not claim more
 *   certainty than the arithmetic supports.
 *
 *   No em dashes, and no wording that could read as health or medical advice.
 *   These strings are copied onto the segment row when it is saved and travel
 *   to the iPhone, so they are customer-facing infrastructure copy.
 *
 * THE TWO "DUE TO REORDER" SEGMENTS
 *   They are not duplicates and they are not independent. `reorder_due` is
 *   every person the engine calls due. `reorder_due_high_confidence` is the
 *   subset of those whose cadence also came back `high`, meaning the spacing it
 *   was measured from barely moves and holds no outlying gap. Strictly a subset
 *   in both directions of the code, which `test/campaign-segment-definitions.test.js`
 *   asserts. The names now carry that: one is "everyone due", the other is
 *   "best timing".
 *
 *   One thing the old copy got wrong and the new copy avoids: `high` describes
 *   whichever cadence was used, so a person whose personal history was too thin
 *   can still be in the high-confidence segment on a very even PRODUCT-level
 *   cadence. Do not write "their own purchase history" into that description.
 */

const {
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  computeBuyerCohortMembers
} = require('./buyer-cohorts');
const { calculateReorderCadence } = require('./reorder-cadence');
const {
  RESTOCK_REORDER_COPY_BASIS,
  describeRestockReorderMember,
  restockReorderPairs
} = require('./restock-reorder');
const { qualifyWinback } = require('./winback');

/**
 * Bumped when a definition's meaning changes. Stored on every member row, so
 * an old row is always readable as "this is what the rules said at the time".
 */
const SEGMENT_RULE_VERSION = 'segments-2026-08-23';

/**
 * The input a definition is computed from. Absent means buildSegmentationInput(),
 * which is what every reorder and win-back definition has always used.
 */
const BUYER_COHORT_SOURCE = 'buyer_cohorts';

/**
 * Evidence carried on every reorder-derived member row. The operator taps a
 * person and sees exactly this.
 */
function reorderEvidence(result, extra = {}) {
  return {
    detector: 'reorder',
    cadenceSource: result.source,
    confidence: result.cadence?.confidence || 'none',
    medianIntervalDays: result.cadence?.medianDays ?? null,
    intervalsObserved: result.cadence?.intervalCount ?? null,
    madDays: result.cadence?.madDays ?? null,
    relativeMAD: result.cadence?.relativeMAD ?? null,
    purchaseCount: result.purchaseCount ?? null,
    lastOrderAt: result.lastPurchaseAt ?? null,
    expectedAt: result.expectedAt ?? null,
    expectedRange: result.expectedRange ?? null,
    state: result.state,
    cycleKey: result.cycleKey ?? null,
    ...extra
  };
}

/**
 * Evidence for the restock pairing, carrying BOTH halves and keeping them
 * visibly apart.
 *
 * The two halves are not equal and the row says so. `statedReason` is the only
 * thing a message may be about, and everything under the timing half is marked
 * `selection_only`: it decided who is here and it may not appear in a sentence
 * anybody sends. That separation is the kind that erodes silently, so it is
 * written on every single row rather than left in a document.
 */
function restockReorderEvidence(pair) {
  const productName = pair.restock.productName || pair.timing.productName || null;
  const restockObservedAt = new Date(pair.observedTime).toISOString();
  const cadence = {
    ...reorderEvidence(pair.result, {
      productID: pair.productID,
      variationID: pair.variationID,
      productName
    })
  };
  return {
    ...cadence,
    // Overrides the 'reorder' stamp reorderEvidence() applies. The reorder
    // arithmetic produced these numbers, but the rule that put this person
    // here is the pairing, and an evidence row has to name the rule it came
    // from or it is unreadable in a year.
    detector: 'back_in_stock',

    // ---- the half the message is allowed to be about ----------------------
    statedReason: 'product_back_in_stock',
    restockObservedAt,
    restockedProductID: pair.productID,
    restockedVariationID: pair.variationID || null,
    // An item can go out and come back more than once inside the window. The
    // date above is the most recent return; this is how many earlier ones were
    // seen and collapsed into it.
    earlierReturnsSeen: pair.earlierReturnsSeen,

    // ---- the half that only chose the audience -----------------------------
    // Named rather than merely present, because somebody writing copy from
    // this screen has to be able to see at a glance which numbers are for
    // them and which are not.
    timingUse: 'selection_only',
    // The vial this person bought most recently, when it is not the vial that
    // came back. The timing is measured across every vial of the molecule; the
    // stock claim is about one of them.
    mostRecentVariationID: pair.timing.variationID && pair.timing.variationID !== pair.variationID
      ? pair.timing.variationID
      : null,

    copyBasis: RESTOCK_REORDER_COPY_BASIS,
    summary: describeRestockReorderMember({
      productName,
      restockObservedAt,
      lastOrderAt: pair.result.lastPurchaseAt,
      medianIntervalDays: pair.result.cadence?.medianDays ?? null,
      cadenceSource: pair.result.source,
      earlierReturnsSeen: pair.earlierReturnsSeen
    })
  };
}

function winbackEvidence(candidate, result) {
  return {
    detector: 'winback',
    confidence: candidate.cadence?.confidence || 'none',
    medianIntervalDays: candidate.cadence?.medianDays ?? null,
    intervalsObserved: candidate.cadence?.intervalCount ?? null,
    lifetimePurchaseCount: Number(candidate.lifetimePurchaseCount) || 0,
    lastOrderAt: candidate.lastPurchaseAt ?? null,
    daysSinceLastOrder: result.daysSincePurchase === null || result.daysSincePurchase === undefined
      ? null
      : Math.round(result.daysSincePurchase * 100) / 100,
    eligibleAt: result.eligibleAt ?? null,
    cooldownEndsAt: result.cooldownEndsAt ?? null,
    expiresAt: result.expiresAt ?? null
  };
}

function productIdentity(candidate) {
  return {
    productID: candidate.productID ?? null,
    variationID: candidate.variationID ?? null,
    productName: candidate.productName ?? null
  };
}

/**
 * The commercial-clearance observation for one candidate, carried as a
 * SEPARATE FIELD on the member and deliberately NOT folded into
 * inclusionEvidence.
 *
 * Two reasons, and both matter.
 *
 *   1. Membership is behaviour. inclusionEvidence answers "why is this person
 *      in this segment", and permission is not part of that answer. Mixing it
 *      in would make the evidence row lie about what the rule did.
 *   2. computedSetDigest() hashes inclusionEvidence. Clearance changes on its
 *      own schedule: a DND sync ages out after 24 hours, a support observation
 *      expires, quiet hours pass. Folding it into the digest would make every
 *      recompute a different run, destroying idempotence and waking an Admin
 *      with a notification every time nothing behavioural had changed.
 *
 * Absent on a candidate built in gate mode, because a gated candidate is
 * cleared by construction.
 */
function commercialClearanceOf(candidate) {
  const observed = candidate?.commercialClearance;
  if (!observed || typeof observed !== 'object') return null;
  return {
    clear: observed.clear === true,
    reason: observed.clear === true ? null : (observed.reason || 'commercial_clearance_unknown')
  };
}

/**
 * Evaluate one reorder candidate. Returns null when it is not in the segment.
 *
 * @param {object} candidate one entry of buildGenerationInput().reorderCandidates
 * @param {Date} now
 * @param {(result: object) => boolean} accept
 */
function reorderMember(candidate, now, accept) {
  const result = calculateReorderCadence({
    purchases: candidate.purchases,
    productCadence: candidate.productCadence,
    now,
    productAvailable: candidate.productAvailable !== false,
    alreadyContactedForLastPurchase: candidate.alreadyContactedForLastPurchase === true
  });
  if (!accept(result)) return null;
  return {
    contactPhone: candidate.phone,
    contactID: candidate.contactID ?? null,
    contactName: candidate.contactName ?? null,
    inclusionEvidence: reorderEvidence(result, productIdentity(candidate)),
    commercialClearance: commercialClearanceOf(candidate)
  };
}

/**
 * The buyer cohorts, as catalogue definitions.
 *
 * WHY THEY LIVE IN THE SAME CATALOGUE
 *   A cohort is an automatic segment in every way that matters: it is computed
 *   by rule, it produces member rows with inclusion evidence, and it must be
 *   savable, recomputable, overridable and visible on the iPhone. Giving it a
 *   parallel catalogue would mean a parallel create path, a parallel recompute,
 *   a parallel reconciliation and a parallel notification, and four chances for
 *   one of them to drift.
 *
 * WHY THEY CARRY `source`
 *   The four reorder and win-back definitions are computed from
 *   buildSegmentationInput(), which is organised around one person and one
 *   product. A cohort is a statement about a PERSON, so it is computed from
 *   buildBuyerCohortFacts() instead. `source` is how computeSegmentMembers()
 *   and segment-service know which input to hand over; it is the only
 *   difference between a cohort and any other automatic segment.
 */
function buyerCohortDefinitions() {
  const definitions = {};
  for (const key of BUYER_COHORT_KEYS) {
    const cohort = BUYER_COHORTS[key];
    definitions[key] = Object.freeze({
      key: cohort.key,
      detector: 'buyer_cohort',
      source: BUYER_COHORT_SOURCE,
      name: cohort.name,
      description: cohort.description,
      compute(input, now) {
        return computeBuyerCohortMembers(cohort.key, input?.buyerCohorts, { now });
      }
    });
  }
  return definitions;
}

const SEGMENT_DEFINITIONS = Object.freeze({
  ...buyerCohortDefinitions(),

  reorder_due_high_confidence: Object.freeze({
    key: 'reorder_due_high_confidence',
    detector: 'reorder',
    name: 'Due to reorder, best timing',
    description:
      'The people whose timing we can call most closely. They have reached the ' +
      'point where they normally buy again, and the ordering pattern behind that ' +
      'date is very even, with no odd gaps in it, so the date is rarely far out. ' +
      'Everyone here is also in "Due to reorder, everyone due". This is the ' +
      'smaller, surer part of it. Reach for this list when you are only going to ' +
      'send one message and you want it to land on the right day.',
    /** @param {object} input buildGenerationInput() output */
    compute(input, now) {
      return (input.reorderCandidates || [])
        .map(candidate => reorderMember(candidate, now, result =>
          result.eligible === true && result.cadence?.confidence === 'high'))
        .filter(Boolean);
    }
  }),

  reorder_due: Object.freeze({
    key: 'reorder_due',
    detector: 'reorder',
    name: 'Due to reorder, everyone due',
    description:
      'Everyone who has reached the point where they normally buy again, or has ' +
      'gone past it. Most are judged on their own order history. Where somebody ' +
      'has not ordered often enough to judge on their own, we fall back on how ' +
      'often other customers reorder the same product, so their date is a ' +
      'reasonable estimate rather than a close one. This is the bigger list and ' +
      'the looser timing. Everyone in "Due to reorder, best timing" is in here too.',
    compute(input, now) {
      return (input.reorderCandidates || [])
        .map(candidate => reorderMember(candidate, now, result => result.eligible === true))
        .filter(Boolean);
    }
  }),

  reorder_approaching: Object.freeze({
    key: 'reorder_approaching',
    detector: 'reorder',
    name: 'Nearly due to reorder',
    description:
      'Customers who are close to the point where they normally buy again, but ' +
      'not there yet. For most it is a matter of days. For somebody with a looser ' +
      'pattern it can be a couple of weeks. There is nothing to send here yet. Use ' +
      'this list to get ready: check you have the stock, write the message, or ' +
      'decide who is worth a call before their moment arrives. As each date comes ' +
      'round these people move into "Due to reorder, everyone due".',
    compute(input, now) {
      return (input.reorderCandidates || [])
        .map(candidate => reorderMember(candidate, now, result => result.state === 'approaching'))
        .filter(Boolean);
    }
  }),

  /**
   * THE TWO SIGNAL SEGMENT. Read lib/campaigns/restock-reorder.js before
   * touching it, and read the compliance note there before touching the copy.
   *
   * The description below has one job beyond describing the group: it has to
   * hand the next person the rule about what a message from this list may say.
   * The stock is the reason. The timing is only the audience. Anybody who
   * merges those two writes a dosing claim without noticing.
   */
  back_in_stock_nearly_due: Object.freeze({
    key: 'back_in_stock_nearly_due',
    detector: 'back_in_stock',
    name: 'Back in stock, and nearly due to reorder',
    description:
      'People whose exact product went out of stock and has now come back, narrowed to the ones ' +
      'who are also close to the point where they normally buy again. Both things have to be ' +
      'true on the same day. The stock coming back is the reason to write to them and it is the ' +
      'only thing the message may be about, because that is a fact about our shelves and it is ' +
      'true of everybody in this list. How close somebody is to buying again only decides who ' +
      'receives it. Do not put that in the message, and do not hint at it, because a sentence ' +
      'about what they have left is a sentence about them rather than about us. Everyone here is ' +
      'also in "Nearly due to reorder", where there is nothing to send yet. This is the part of ' +
      'that list where there is now something plain and factual to say. It stays empty until a ' +
      'product has actually been recorded going out and coming back, and an empty list is a true ' +
      'answer rather than a fault.',
    compute(input, now) {
      const { pairs } = restockReorderPairs(input, { now });
      return pairs.map(pair => ({
        contactPhone: pair.phone,
        contactID: pair.restock.contactID ?? pair.timing.contactID ?? null,
        contactName: pair.restock.contactName ?? pair.timing.contactName ?? null,
        inclusionEvidence: restockReorderEvidence(pair),
        // Taken from the restock half, which is the stage that names this
        // segment. Both halves observe the same phone through the same rules
        // in the same pass, so they cannot disagree.
        commercialClearance: commercialClearanceOf(pair.restock)
      }));
    }
  }),

  winback_qualified: Object.freeze({
    key: 'winback_qualified',
    detector: 'winback',
    name: 'Good customers who have stopped',
    description:
      'Customers who used to order regularly and have now gone quiet. Every one of ' +
      'them has bought at least three times, kept to a settled rhythm, and is now ' +
      'well past their usual gap, never less than two months. Anyone it would be ' +
      'tactless to approach has already been taken out: an open complaint, a refund ' +
      'still being sorted, a recent unhappy exchange, somebody the team is already ' +
      'dealing with, or nothing in stock to offer them. Once a customer has been ' +
      'contacted this way they are left out of the list for six months.',
    compute(input, now) {
      const members = [];
      for (const candidate of input.winbackCandidates || []) {
        const result = qualifyWinback({
          cadence: candidate.cadence,
          lastPurchaseAt: candidate.lastPurchaseAt,
          lifetimePurchaseCount: candidate.lifetimePurchaseCount,
          now,
          lastWinbackContactAt: candidate.lastWinbackContactAt || null,
          existingOpenOpportunity: candidate.existingOpenOpportunity === true,
          unresolvedComplaint: candidate.unresolvedComplaint === true,
          refundOpen: candidate.refundOpen === true,
          recentNegativeSupport: candidate.recentNegativeSupport === true,
          productAvailable: candidate.productAvailable !== false
        });
        if (!result.qualifies) continue;
        members.push({
          contactPhone: candidate.phone,
          contactID: candidate.contactID ?? null,
          contactName: candidate.contactName ?? null,
          inclusionEvidence: { ...winbackEvidence(candidate, result), ...productIdentity(candidate) },
          commercialClearance: commercialClearanceOf(candidate)
        });
      }
      return members;
    }
  })
});

const SEGMENT_DEFINITION_KEYS = Object.freeze(Object.keys(SEGMENT_DEFINITIONS).sort());

function segmentDefinition(key) {
  return SEGMENT_DEFINITIONS[String(key || '')] || null;
}

/** The catalogue as plain data, safe to return from an API. */
function segmentCatalogue() {
  return SEGMENT_DEFINITION_KEYS.map(key => {
    const definition = SEGMENT_DEFINITIONS[key];
    return {
      key: definition.key,
      detector: definition.detector,
      name: definition.name,
      description: definition.description,
      ruleVersion: SEGMENT_RULE_VERSION
    };
  });
}

/**
 * Compute the membership of one automatic definition.
 *
 * Duplicates are collapsed on phone. One person can own several products and
 * therefore appear as several candidates; the segment is a set of people, so
 * the first evidence wins after a deterministic sort and the rest are recorded
 * as additional matches. Deterministic ordering matters because the run digest
 * is hashed from this output.
 */
function computeSegmentMembers(definitionKey, input, { now = new Date() } = {}) {
  const definition = segmentDefinition(definitionKey);
  if (!definition) throw new Error(`Unknown segment definition: ${String(definitionKey)}`);
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const raw = definition.compute(input, at)
    .filter(member => typeof member.contactPhone === 'string' && member.contactPhone)
    .sort((a, b) => a.contactPhone.localeCompare(b.contactPhone) ||
      String(a.inclusionEvidence.productID ?? '').localeCompare(String(b.inclusionEvidence.productID ?? '')));

  const byPhone = new Map();
  for (const member of raw) {
    const existing = byPhone.get(member.contactPhone);
    if (!existing) {
      byPhone.set(member.contactPhone, {
        ...member,
        inclusionEvidence: {
          ...member.inclusionEvidence,
          ruleVersion: SEGMENT_RULE_VERSION,
          segmentKey: definition.key,
          additionalMatches: 0
        }
      });
      continue;
    }
    existing.inclusionEvidence.additionalMatches += 1;
  }
  return [...byPhone.values()];
}

module.exports = {
  BUYER_COHORT_SOURCE,
  SEGMENT_DEFINITIONS,
  SEGMENT_DEFINITION_KEYS,
  SEGMENT_RULE_VERSION,
  computeSegmentMembers,
  reorderEvidence,
  segmentCatalogue,
  segmentDefinition,
  winbackEvidence
};
