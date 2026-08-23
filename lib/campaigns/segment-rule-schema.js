'use strict';
/**
 * lib/campaigns/segment-rule-schema.js — the CLOSED grammar a described
 * segment may be expressed in, and the plain-English rendering of it.
 *
 * WHY THIS FILE MATTERS MORE THAN THE TRANSLATOR
 *   The translator in lib/campaigns/segment-rule-writer.js asks a language
 *   model to turn a sentence into rules. A language model will, given enough
 *   attempts, emit a field that does not exist, a table name, a comparison
 *   operator nobody implemented, a nested object where a number belongs, or a
 *   string that reads like SQL. None of that is a problem here, because
 *   nothing a model writes is ever executed. What a model writes is DATA that
 *   has to survive `validateRuleSet()` before anything looks at it, and
 *   validation is a whitelist: a dimension not named in DIMENSIONS below has
 *   no code path at all, so there is nothing for an invented field to reach.
 *
 *   The evaluator (lib/campaigns/segment-rule-evaluator.js) reads facts that
 *   this repository computed, in memory, with a `switch` over the same closed
 *   list. There is no query builder downstream, no string interpolation into a
 *   query, and no `.filter()` string handed to Supabase. That is deliberate:
 *   the safest way to stop a model reaching a query unchecked is for there to
 *   be no query for it to reach.
 *
 * REJECT, NEVER DROP
 *   A validator that silently ignores what it does not understand turns
 *   "customers who bought BPC-157 more than twice" into "customers", which is
 *   the single most dangerous failure this feature has. Every unknown key,
 *   unknown dimension, unknown operator, wrong type and out-of-range value is
 *   an ERROR WITH A REASON. Nothing is coerced, nothing is trimmed away.
 *
 * THE RENDERING IS DERIVED, NOT DICTATED
 *   `describeRuleSet()` renders the plain English shown to the operator FROM
 *   THE VALIDATED RULES. The model is never asked for a description of its own
 *   work, because a model's prose and a model's rules can disagree and the
 *   operator would have no way to tell which one runs. What is on the screen
 *   is a rendering of what will execute.
 */

/** Bumped when the grammar changes meaning. Stored on every saved rule set. */
const RULE_SCHEMA_VERSION = 'segment-rules-2026-08-23';

const MAX_CONDITIONS = 10;
const MAX_LIST_VALUES = 20;
const MAX_LABEL_LENGTH = 120;

const MATCH_MODES = Object.freeze(['all', 'any']);
const CONSENT_STATES = Object.freeze(['clear', 'blocked', 'unknown']);
const CADENCE_CONFIDENCES = Object.freeze(['high', 'moderate', 'none']);

/** A calendar date, not a timestamp. Segments are described in days. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `productID:variationID`, both non-negative integers. */
const PRODUCT_KEY_PATTERN = /^\d{1,12}:\d{1,12}$/;

/**
 * Value kinds. Each one is a total function from a raw value to either a
 * canonical value or a reason it is not acceptable.
 */
const VALUE_KIND = Object.freeze({
  integer: 'integer',
  decimal: 'decimal',
  date: 'date',
  enumeration: 'enumeration',
  enumerationList: 'enumerationList',
  productList: 'productList',
  segmentReference: 'segmentReference'
});

/**
 * THE WHITELIST.
 *
 * Every queryable dimension of a segment, and nothing else. A dimension that
 * is not in this object cannot be named, cannot be validated, cannot be
 * rendered and cannot be evaluated.
 *
 * `fact` is the key on the per-customer fact record built by
 * lib/campaigns/segment-facts.js. It is a property name on an object this
 * repository built from its own database reads. It is NOT a column name, it is
 * never interpolated into a query, and a model cannot introduce a new one:
 * this table is the only source of them.
 */
const DIMENSIONS = Object.freeze({
  order_count: Object.freeze({
    id: 'order_count',
    label: 'number of orders',
    fact: 'orderCount',
    kind: VALUE_KIND.integer,
    min: 0,
    max: 10000,
    operators: Object.freeze(['at_least', 'at_most', 'equals', 'between']),
    describes: 'How many paid orders the customer has on record.',
    unit: 'orders'
  }),
  days_since_last_order: Object.freeze({
    id: 'days_since_last_order',
    label: 'days since the last order',
    fact: 'daysSinceLastOrder',
    kind: VALUE_KIND.integer,
    min: 0,
    max: 3650,
    operators: Object.freeze(['at_least', 'at_most', 'between']),
    describes: 'How long it has been since the customer last ordered. A customer who has never ordered matches nothing on this dimension.',
    unit: 'days'
  }),
  last_order_date: Object.freeze({
    id: 'last_order_date',
    label: 'date of the last order',
    fact: 'lastOrderAt',
    kind: VALUE_KIND.date,
    operators: Object.freeze(['before', 'after', 'between']),
    describes: 'The calendar date of the customer\'s most recent paid order. Use this for "has not ordered since June", which is a fixed date rather than a rolling window.'
  }),
  product_purchased: Object.freeze({
    id: 'product_purchased',
    label: 'products bought',
    fact: 'productKeys',
    kind: VALUE_KIND.productList,
    operators: Object.freeze(['any_of', 'none_of']),
    describes: 'Which products the customer has bought at least once. Products must be named exactly as they appear in the catalogue.'
  }),
  product_order_count: Object.freeze({
    id: 'product_order_count',
    label: 'number of orders containing one product',
    fact: 'productOrderCounts',
    kind: VALUE_KIND.integer,
    min: 0,
    max: 10000,
    operators: Object.freeze(['at_least', 'at_most', 'equals', 'between']),
    requiresProduct: true,
    describes: 'How many separate paid orders contained one named product. This is the dimension for "bought X more than twice".',
    unit: 'orders'
  }),
  lifetime_spend: Object.freeze({
    id: 'lifetime_spend',
    label: 'lifetime spend',
    fact: 'lifetimeSpend',
    kind: VALUE_KIND.decimal,
    min: 0,
    max: 10000000,
    operators: Object.freeze(['at_least', 'at_most', 'between']),
    describes: 'The total value of the customer\'s paid orders.',
    unit: 'currency'
  }),
  average_order_value: Object.freeze({
    id: 'average_order_value',
    label: 'average order value',
    fact: 'averageOrderValue',
    kind: VALUE_KIND.decimal,
    min: 0,
    max: 1000000,
    operators: Object.freeze(['at_least', 'at_most', 'between']),
    describes: 'Lifetime spend divided by the number of paid orders.',
    unit: 'currency'
  }),
  order_cadence_days: Object.freeze({
    id: 'order_cadence_days',
    label: 'typical gap between orders',
    fact: 'cadenceMedianDays',
    kind: VALUE_KIND.decimal,
    min: 1,
    max: 730,
    operators: Object.freeze(['at_least', 'at_most', 'between']),
    describes: 'The customer\'s own median interval between orders, as computed by the existing cadence engine. A customer without enough history has no value here and matches nothing on this dimension.',
    unit: 'days'
  }),
  cadence_confidence: Object.freeze({
    id: 'cadence_confidence',
    label: 'how steady the ordering pattern is',
    fact: 'cadenceConfidence',
    kind: VALUE_KIND.enumerationList,
    values: CADENCE_CONFIDENCES,
    operators: Object.freeze(['any_of', 'none_of']),
    describes: 'high, moderate or none, from the same cadence engine the reorder detector uses.'
  }),
  segment_membership: Object.freeze({
    id: 'segment_membership',
    label: 'membership of another segment',
    fact: 'segmentKeys',
    kind: VALUE_KIND.segmentReference,
    operators: Object.freeze(['in_segment', 'not_in_segment']),
    describes: 'Whether the customer is currently in another saved segment. The other segment must already exist.'
  }),
  consent_state: Object.freeze({
    id: 'consent_state',
    label: 'commercial eligibility',
    fact: 'consentState',
    kind: VALUE_KIND.enumeration,
    values: CONSENT_STATES,
    operators: Object.freeze(['is', 'is_not']),
    describes: 'clear, blocked or unknown, read from the same commercial eligibility record the campaign engine reads. This is NOT permission to send: a segment of people whose state is clear is still subject to every consent, provider and quiet-hours check at send time.'
  })
});

const DIMENSION_IDS = Object.freeze(Object.keys(DIMENSIONS).sort());

/** Every key a condition object may carry. Anything else is rejected. */
const CONDITION_KEYS = Object.freeze(['dimension', 'operator', 'value', 'product', 'label']);
/**
 * Every key a rule set object may carry.
 *
 * `schemaVersion` is here so that validation is IDEMPOTENT: the iOS builder
 * round-trips a validated rule set through draft, preview and save, and a
 * validator that refused its own output would break on the second hop.
 * `validateRuleSet(validateRuleSet(x).ruleSet)` must equal
 * `validateRuleSet(x)`, and there is a test that says so.
 */
const RULE_SET_KEYS = Object.freeze(['version', 'schemaVersion', 'match', 'conditions']);

const RULE_SET_VERSION = 1;

/**
 * The description of the grammar handed to the model. Contains no customer,
 * no phone number, no order and no name: only dimension ids, operators and
 * limits, all of which are constants in this file.
 */
function schemaForPrompt() {
  const lines = [];
  for (const id of DIMENSION_IDS) {
    const dimension = DIMENSIONS[id];
    const parts = [`- ${id}: ${dimension.describes}`];
    parts.push(`  operators: ${dimension.operators.join(', ')}`);
    switch (dimension.kind) {
      case VALUE_KIND.integer:
        parts.push(`  value: a whole number from ${dimension.min} to ${dimension.max}, or [low, high] for between`);
        break;
      case VALUE_KIND.decimal:
        parts.push(`  value: a number from ${dimension.min} to ${dimension.max}, or [low, high] for between`);
        break;
      case VALUE_KIND.date:
        parts.push('  value: a date as YYYY-MM-DD, or [from, to] for between');
        break;
      case VALUE_KIND.enumeration:
        parts.push(`  value: exactly one of ${dimension.values.join(', ')}`);
        break;
      case VALUE_KIND.enumerationList:
        parts.push(`  value: a list of ${dimension.values.join(', ')}`);
        break;
      case VALUE_KIND.productList:
        parts.push('  value: a list of product names, each copied exactly from the catalogue below');
        break;
      case VALUE_KIND.segmentReference:
        parts.push('  value: the name of an existing segment, copied exactly from the list below');
        break;
      default:
        break;
    }
    if (dimension.requiresProduct) {
      parts.push('  also required: "product", a product name copied exactly from the catalogue below');
    }
    lines.push(parts.join('\n'));
  }
  return lines.join('\n');
}

// ── Rendering ──────────────────────────────────────────────────────────────

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function pluralise(count, singular, plural) {
  return Math.abs(Number(count)) === 1 ? singular : plural;
}

function formatMoney(value) {
  return `$${formatNumber(value)}`;
}

function formatDate(value) {
  // Rendered from the stored YYYY-MM-DD, never re-parsed through a time zone.
  const [year, month, day] = String(value).split('-');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const name = monthNames[Number(month) - 1];
  if (!name) return String(value);
  return `${Number(day)} ${name} ${year}`;
}

function productLabels(condition) {
  const labels = Array.isArray(condition.label) ? condition.label : [condition.label];
  return labels.filter(Boolean);
}

function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function joinWithOr(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * One condition as a sentence fragment beginning "they ...".
 *
 * Every branch is driven by the dimension id, so a condition that survived
 * validation always has a rendering and an unrenderable condition is a
 * programming error rather than a blank line on somebody's screen.
 */
function describeCondition(condition) {
  const dimension = DIMENSIONS[condition.dimension];
  if (!dimension) return 'they match an unknown rule';
  const value = condition.value;
  switch (condition.dimension) {
    case 'order_count':
      switch (condition.operator) {
        case 'at_least': return `they have placed at least ${value} ${pluralise(value, 'order', 'orders')}`;
        case 'at_most': return `they have placed at most ${value} ${pluralise(value, 'order', 'orders')}`;
        case 'equals': return `they have placed exactly ${value} ${pluralise(value, 'order', 'orders')}`;
        case 'between': return `they have placed between ${value[0]} and ${value[1]} orders`;
        default: return 'they match an unknown rule';
      }
    case 'days_since_last_order':
      switch (condition.operator) {
        case 'at_least': return `their last order was at least ${value} ${pluralise(value, 'day', 'days')} ago`;
        case 'at_most': return `their last order was within the last ${value} ${pluralise(value, 'day', 'days')}`;
        case 'between': return `their last order was between ${value[0]} and ${value[1]} days ago`;
        default: return 'they match an unknown rule';
      }
    case 'last_order_date':
      switch (condition.operator) {
        case 'before': return `their last order was before ${formatDate(value)}`;
        case 'after': return `their last order was on or after ${formatDate(value)}`;
        case 'between': return `their last order was between ${formatDate(value[0])} and ${formatDate(value[1])}`;
        default: return 'they match an unknown rule';
      }
    case 'product_purchased': {
      const names = productLabels(condition);
      return condition.operator === 'any_of'
        ? `they have bought ${joinWithOr(names)}`
        : `they have never bought ${joinWithOr(names)}`;
    }
    case 'product_order_count': {
      const name = productLabels(condition)[0] || 'that product';
      switch (condition.operator) {
        case 'at_least': return `they have ordered ${name} at least ${value} ${pluralise(value, 'time', 'times')}`;
        case 'at_most': return `they have ordered ${name} at most ${value} ${pluralise(value, 'time', 'times')}`;
        case 'equals': return `they have ordered ${name} exactly ${value} ${pluralise(value, 'time', 'times')}`;
        case 'between': return `they have ordered ${name} between ${value[0]} and ${value[1]} times`;
        default: return 'they match an unknown rule';
      }
    }
    case 'lifetime_spend':
      switch (condition.operator) {
        case 'at_least': return `they have spent at least ${formatMoney(value)} in total`;
        case 'at_most': return `they have spent at most ${formatMoney(value)} in total`;
        case 'between': return `they have spent between ${formatMoney(value[0])} and ${formatMoney(value[1])} in total`;
        default: return 'they match an unknown rule';
      }
    case 'average_order_value':
      switch (condition.operator) {
        case 'at_least': return `their average order is at least ${formatMoney(value)}`;
        case 'at_most': return `their average order is at most ${formatMoney(value)}`;
        case 'between': return `their average order is between ${formatMoney(value[0])} and ${formatMoney(value[1])}`;
        default: return 'they match an unknown rule';
      }
    case 'order_cadence_days':
      switch (condition.operator) {
        case 'at_least': return `they normally leave at least ${formatNumber(value)} days between orders`;
        case 'at_most': return `they normally order at least every ${formatNumber(value)} days`;
        case 'between': return `they normally leave between ${formatNumber(value[0])} and ${formatNumber(value[1])} days between orders`;
        default: return 'they match an unknown rule';
      }
    case 'cadence_confidence': {
      const words = value.map(item => (item === 'none' ? 'no steady pattern' : `${item} confidence`));
      return condition.operator === 'any_of'
        ? `their ordering pattern is ${joinWithOr(words)}`
        : `their ordering pattern is not ${joinWithOr(words)}`;
    }
    case 'segment_membership':
      return condition.operator === 'in_segment'
        ? `they are already in ${condition.label || value}`
        : `they are not in ${condition.label || value}`;
    case 'consent_state': {
      const words = {
        clear: 'clear for commercial contact',
        blocked: 'blocked from commercial contact',
        unknown: 'of unknown commercial eligibility'
      };
      return condition.operator === 'is'
        ? `they are ${words[value]}`
        : `they are not ${words[value]}`;
    }
    default:
      return 'they match an unknown rule';
  }
}

/**
 * The whole rule set as one paragraph, plus the per-condition lines.
 *
 * @param {object} ruleSet a VALIDATED rule set
 * @returns {{ sentence: string, lines: string[] }}
 */
function describeRuleSet(ruleSet) {
  const conditions = Array.isArray(ruleSet?.conditions) ? ruleSet.conditions : [];
  const lines = conditions.map(describeCondition);
  if (!lines.length) return { sentence: 'This rule set matches nobody, because it has no conditions.', lines: [] };
  const joiner = ruleSet.match === 'any' ? ' or ' : ' and ';
  const body = lines.length === 1
    ? lines[0]
    : `${lines.slice(0, -1).join(joiner)}${joiner}${lines[lines.length - 1]}`;
  const opening = ruleSet.match === 'any'
    ? 'A customer is in this segment when any of these is true:'
    : 'A customer is in this segment when all of these are true:';
  return {
    sentence: `${opening} ${body}.`,
    lines
  };
}

module.exports = {
  CADENCE_CONFIDENCES,
  CONDITION_KEYS,
  CONSENT_STATES,
  DATE_PATTERN,
  DIMENSIONS,
  DIMENSION_IDS,
  MATCH_MODES,
  MAX_CONDITIONS,
  MAX_LABEL_LENGTH,
  MAX_LIST_VALUES,
  PRODUCT_KEY_PATTERN,
  RULE_SCHEMA_VERSION,
  RULE_SET_KEYS,
  RULE_SET_VERSION,
  VALUE_KIND,
  describeCondition,
  describeRuleSet,
  formatDate,
  formatMoney,
  formatNumber,
  joinWithAnd,
  joinWithOr,
  schemaForPrompt
};
