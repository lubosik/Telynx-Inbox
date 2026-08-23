'use strict';
/**
 * lib/campaigns/segment-rule-evaluator.js — run a validated rule set over the
 * fact records, in memory, and produce member rows with a per-condition trace.
 *
 * THERE IS NO QUERY HERE, AND THAT IS THE POINT
 *   Every comparison below reads a property of an object this repository built
 *   in lib/campaigns/segment-facts.js. Nothing is interpolated into SQL, no
 *   string reaches a Supabase filter, and the `switch` is over the same closed
 *   dimension list the validator enforces. A dimension the validator did not
 *   accept has no case, and the default branch throws rather than passing
 *   somebody through.
 *
 * FAIL CLOSED ON REVALIDATION
 *   `evaluateRuleSet()` re-checks its input against the validator before it
 *   evaluates anything, even though every caller in this repository has
 *   validated already. Double validation costs microseconds and removes the
 *   entire class of "somebody added a caller that forgot".
 *
 * THE TRACE
 *   Every member row carries, as `inclusionEvidence`, the rule set version,
 *   the plain-English rendering, and one line per condition saying whether it
 *   held and what the customer's value was. That is the per-person rule trace
 *   TRACKING-AND-LEARNING-RESEARCH.md describes and nobody in the market
 *   ships. It is also what makes "why is this person here" answerable months
 *   later from the stored row alone.
 */

const { describeCondition, describeRuleSet } = require('./segment-rule-schema');
const { validateRuleSet } = require('./segment-rule-validator');

const DAY_MS = 86400000;

class SegmentRuleEvaluationError extends Error {
  constructor(message, code = 'SEGMENT_RULES_INVALID') {
    super(message);
    this.name = 'SegmentRuleEvaluationError';
    this.code = code;
  }
}

/** Midnight UTC of a YYYY-MM-DD, so a date bound is a whole day. */
function dayStart(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function dayEnd(date) {
  return dayStart(date) + DAY_MS;
}

function compareScalar(operator, actual, value) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  switch (operator) {
    case 'at_least': return actual >= value;
    case 'at_most': return actual <= value;
    case 'equals': return actual === value;
    case 'between': return actual >= value[0] && actual <= value[1];
    default: return false;
  }
}

/**
 * The customer's own value for one condition, as a number, string or null.
 * Used for the trace as well as the comparison, so the two can never disagree.
 */
function observedValue(condition, facts, segmentMembership) {
  switch (condition.dimension) {
    case 'order_count': return facts.orderCount ?? null;
    case 'days_since_last_order': return facts.daysSinceLastOrder ?? null;
    case 'last_order_date': return facts.lastOrderAt ?? null;
    case 'product_purchased': return Array.isArray(facts.productKeys) ? facts.productKeys.length : 0;
    case 'product_order_count': return Number(facts.productOrderCounts?.[condition.product] || 0);
    case 'lifetime_spend': return facts.lifetimeSpend ?? null;
    case 'average_order_value': return facts.averageOrderValue ?? null;
    case 'order_cadence_days': return facts.cadenceMedianDays ?? null;
    case 'cadence_confidence': return facts.cadenceConfidence ?? 'none';
    case 'segment_membership':
      return segmentMembership.get(condition.value)?.has(facts.contactPhone) === true ? 'in' : 'out';
    case 'consent_state': return facts.consentState ?? 'unknown';
    default: return null;
  }
}

/**
 * Does one condition hold for one customer?
 *
 * A null fact never matches. A customer who has never ordered has no last
 * order date, and "their last order was before 1 June" is false for them
 * rather than true-by-absence.
 */
function conditionHolds(condition, facts, segmentMembership) {
  switch (condition.dimension) {
    case 'order_count':
      return compareScalar(condition.operator, facts.orderCount, condition.value);
    case 'days_since_last_order':
      return compareScalar(condition.operator, facts.daysSinceLastOrder, condition.value);
    case 'lifetime_spend':
      return compareScalar(condition.operator, facts.lifetimeSpend, condition.value);
    case 'average_order_value':
      return compareScalar(condition.operator, facts.averageOrderValue, condition.value);
    case 'order_cadence_days':
      return compareScalar(condition.operator, facts.cadenceMedianDays, condition.value);
    case 'product_order_count':
      return compareScalar(condition.operator, Number(facts.productOrderCounts?.[condition.product] || 0), condition.value);
    case 'last_order_date': {
      const time = Date.parse(facts.lastOrderAt);
      if (!Number.isFinite(time)) return false;
      if (condition.operator === 'before') return time < dayStart(condition.value);
      if (condition.operator === 'after') return time >= dayStart(condition.value);
      if (condition.operator === 'between') {
        return time >= dayStart(condition.value[0]) && time < dayEnd(condition.value[1]);
      }
      return false;
    }
    case 'product_purchased': {
      const owned = new Set(facts.productKeys || []);
      const hit = condition.value.some(key => owned.has(key));
      return condition.operator === 'any_of' ? hit : !hit;
    }
    case 'cadence_confidence': {
      const actual = facts.cadenceConfidence || 'none';
      const hit = condition.value.includes(actual);
      return condition.operator === 'any_of' ? hit : !hit;
    }
    case 'segment_membership': {
      const inIt = segmentMembership.get(condition.value)?.has(facts.contactPhone) === true;
      return condition.operator === 'in_segment' ? inIt : !inIt;
    }
    case 'consent_state': {
      const actual = facts.consentState || 'unknown';
      return condition.operator === 'is' ? actual === condition.value : actual !== condition.value;
    }
    default:
      // Unreachable for a validated rule set. Throwing rather than returning
      // false means a future dimension added to the schema and forgotten here
      // fails loudly instead of quietly excluding everybody.
      throw new SegmentRuleEvaluationError(
        `No evaluation exists for dimension "${condition.dimension}".`, 'SEGMENT_RULE_DIMENSION_UNIMPLEMENTED'
      );
  }
}

/** The observed value, written the way a person would say it. */
function traceValue(condition, observed) {
  if (observed === null || observed === undefined) return 'not recorded';
  switch (condition.dimension) {
    case 'order_count': return `${observed} on record`;
    case 'days_since_last_order': return `${observed} days`;
    case 'last_order_date': return String(observed).slice(0, 10);
    case 'product_purchased': return `${observed} different products bought`;
    case 'product_order_count': return `${observed} orders contained it`;
    case 'lifetime_spend':
    case 'average_order_value': return `$${observed}`;
    case 'order_cadence_days': return `${observed} days`;
    case 'cadence_confidence': return String(observed);
    case 'segment_membership': return observed === 'in' ? 'a member' : 'not a member';
    case 'consent_state': return String(observed);
    default: return String(observed);
  }
}

/**
 * Evaluate a rule set.
 *
 * @param {object} options
 * @param {object} options.ruleSet    a rule set; revalidated here regardless
 * @param {Array} options.facts       buildCustomerFacts().facts
 * @param {object} [options.context]  validator context: products, segments
 * @param {Map<string, Set<string>>} [options.segmentMembership]
 *        segment key -> member phones, for the segment_membership dimension
 * @param {number} [options.sampleSize] how many matched people to return in full
 * @returns {{ members: Array, matchedCount: number, consideredCount: number,
 *             description: object, ruleSet: object }}
 */
function evaluateRuleSet({
  ruleSet,
  facts = [],
  context = {},
  segmentMembership = new Map(),
  sampleSize = null
} = {}) {
  const verdict = validateRuleSet(ruleSet, context);
  if (!verdict.ok) {
    const error = new SegmentRuleEvaluationError(
      'These rules did not pass validation and were not evaluated.', 'SEGMENT_RULES_INVALID'
    );
    error.errors = verdict.errors;
    throw error;
  }
  const safe = verdict.ruleSet;
  const description = describeRuleSet(safe);
  const wantsAll = safe.match === 'all';

  const members = [];
  for (const record of facts) {
    if (!record || typeof record.contactPhone !== 'string' || !record.contactPhone) continue;
    const trace = [];
    let matched = wantsAll;
    for (const condition of safe.conditions) {
      const held = conditionHolds(condition, record, segmentMembership);
      const observed = observedValue(condition, record, segmentMembership);
      trace.push({
        dimension: condition.dimension,
        operator: condition.operator,
        held,
        rule: describeCondition(condition),
        observed: traceValue(condition, observed)
      });
      matched = wantsAll ? (matched && held) : (matched || held);
    }
    if (!matched) continue;
    members.push({
      contactPhone: record.contactPhone,
      contactID: record.contactID ?? null,
      contactName: record.contactName ?? null,
      inclusionEvidence: {
        detector: 'rules',
        match: safe.match,
        ruleSchemaVersion: safe.schemaVersion,
        definition: description.sentence,
        trace,
        orderCount: record.orderCount ?? null,
        lastOrderAt: record.lastOrderAt ?? null,
        consentState: record.consentState ?? null
      }
    });
  }

  members.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));
  const limit = Number.isSafeInteger(sampleSize) && sampleSize >= 0 ? sampleSize : null;

  return {
    ruleSet: safe,
    description,
    matchedCount: members.length,
    consideredCount: facts.length,
    members: limit === null ? members : members.slice(0, limit)
  };
}

/**
 * The breadth warning.
 *
 * THRESHOLD AND WHY IT IS 60 PERCENT OF AT LEAST 25 PEOPLE
 *   A segment that matches most of the customer base is almost always a rule
 *   set that lost a clause, and the cost of that mistake is the largest one
 *   this feature can make. Sixty percent is chosen because a real audience
 *   built from order history, product and recency lands far below it in
 *   practice, while "everybody who has ever ordered" lands far above it, so
 *   the two do not overlap and the warning does not become noise an operator
 *   learns to click through.
 *
 *   The floor of 25 exists because a ratio over a tiny population is not
 *   evidence of anything: 3 of 4 people is 75 percent and means nothing. Below
 *   the floor the count itself is the whole story and the operator can read it.
 *
 *   It is a warning, not a refusal. There are legitimate wide segments, and a
 *   validator that refuses one would be wrong; the operator sees the number
 *   and decides.
 */
const BROAD_MATCH_RATIO = 0.6;
const BROAD_MATCH_FLOOR = 25;

function breadthWarning(matchedCount, consideredCount) {
  if (consideredCount < BROAD_MATCH_FLOOR) return null;
  const ratio = matchedCount / consideredCount;
  if (ratio < BROAD_MATCH_RATIO) return null;
  const percent = Math.round(ratio * 100);
  return {
    code: 'SEGMENT_MATCHES_ALMOST_EVERYBODY',
    reason: `These rules match ${matchedCount} of ${consideredCount} known customers, which is ${percent} percent of them. That is usually a rule that is missing a condition. Check it before saving.`
  };
}

/** A rule set that matches nobody is not an error, but it is worth saying. */
function emptyWarning(matchedCount) {
  if (matchedCount > 0) return null;
  return {
    code: 'SEGMENT_MATCHES_NOBODY',
    reason: 'These rules match nobody right now. You can still save it, and it will fill up as customers start to qualify.'
  };
}

module.exports = {
  BROAD_MATCH_FLOOR,
  BROAD_MATCH_RATIO,
  SegmentRuleEvaluationError,
  breadthWarning,
  conditionHolds,
  emptyWarning,
  evaluateRuleSet,
  observedValue,
  traceValue
};
