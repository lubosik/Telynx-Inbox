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
    name: 'Reorder due, high confidence',
    description:
      'Customers whose own purchase history has a stable interval and whose next ' +
      'reorder window has arrived. High confidence means relative MAD at or below ' +
      '0.25 with no outlying intervals.',
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
    name: 'Reorder due',
    description:
      'Customers inside or past their expected reorder window on any reliable ' +
      'cadence, personal or product level.',
    compute(input, now) {
      return (input.reorderCandidates || [])
        .map(candidate => reorderMember(candidate, now, result => result.eligible === true))
        .filter(Boolean);
    }
  }),

  reorder_approaching: Object.freeze({
    key: 'reorder_approaching',
    detector: 'reorder',
    name: 'Reorder approaching',
    description:
      'Customers whose reorder window opens soon. Useful for planning, not for ' +
      'contacting yet.',
    compute(input, now) {
      return (input.reorderCandidates || [])
        .map(candidate => reorderMember(candidate, now, result => result.state === 'approaching'))
        .filter(Boolean);
    }
  }),

  winback_qualified: Object.freeze({
    key: 'winback_qualified',
    detector: 'winback',
    name: 'Win-back qualified',
    description:
      'Repeat customers with a reliable cadence who have not ordered for the later ' +
      'of 60 days or 1.75 times their normal interval, with no win-back contact ' +
      'inside the cooldown.',
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
