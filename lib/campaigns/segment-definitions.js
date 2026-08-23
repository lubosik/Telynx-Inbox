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

const { calculateReorderCadence } = require('./reorder-cadence');
const { qualifyWinback } = require('./winback');

/**
 * Bumped when a definition's meaning changes. Stored on every member row, so
 * an old row is always readable as "this is what the rules said at the time".
 */
const SEGMENT_RULE_VERSION = 'segments-2026-08-23';

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
    inclusionEvidence: reorderEvidence(result, productIdentity(candidate))
  };
}

const SEGMENT_DEFINITIONS = Object.freeze({
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
          inclusionEvidence: { ...winbackEvidence(candidate, result), ...productIdentity(candidate) }
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
  SEGMENT_DEFINITIONS,
  SEGMENT_DEFINITION_KEYS,
  SEGMENT_RULE_VERSION,
  computeSegmentMembers,
  reorderEvidence,
  segmentCatalogue,
  segmentDefinition,
  winbackEvidence
};
