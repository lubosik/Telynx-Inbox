'use strict';
/**
 * lib/campaigns/segment-rule-validator.js — the gate.
 *
 * Nothing produced by a language model, and nothing posted by a client,
 * becomes a segment rule without passing through here first. This is the
 * safety component of the described-segment feature and it is deliberately
 * paranoid.
 *
 * WHAT IT GUARANTEES
 *   1. Every key is known. An unrecognised key on the rule set or on any
 *      condition is an error, not something to ignore. A model that invents
 *      `"table": "sms_orders"` or `"sql": "..."` is rejected by name, and the
 *      rejection says which key was not accepted.
 *   2. Every dimension is on the whitelist in segment-rule-schema.js. There is
 *      no path from a dimension string to a column name, a table name or a
 *      query. The evaluator switches over the same closed list and reads
 *      properties of an object this repository built.
 *   3. Every operator is on that dimension's own list. `at_least` on a date is
 *      an error even though `at_least` is a real operator elsewhere.
 *   4. Every value is the right JavaScript type, in range, and — for a range —
 *      the right way round. Numbers must be numbers: the string "2" is
 *      REFUSED rather than coerced, because a validator that coerces is a
 *      validator that will one day coerce something it should have refused.
 *   5. Every product and segment reference resolves against a caller-supplied
 *      catalogue of things that actually exist. An unknown product name is an
 *      error with the reason "that product is not in the catalogue", never a
 *      quietly dropped condition.
 *   6. A condition that matches every customer is refused. "order_count at
 *      least 0" is not a filter, it is a rule set that has lost a clause, and
 *      the failure mode of losing a clause is a segment containing the entire
 *      customer base.
 *   7. Contradictory bounds under `all` are refused. They are always a
 *      translation mistake and they always produce a segment of nobody.
 *
 * WHAT IT DOES NOT DO
 *   It does not repair. There is no "best effort" branch, no partial accept,
 *   and no path that returns a rule set alongside errors. `ok: false` means
 *   `ruleSet: null`.
 *
 * ON `label`
 *   `label` is the human-readable name of a resolved product or segment. It is
 *   SERVER-DERIVED. A caller may send it back (the iOS builder round-trips the
 *   whole rule set between drafting, preview and save) but it is never trusted:
 *   whatever arrives is discarded and the label is written again from the
 *   resolved catalogue entry. It is refused outright on any dimension that has
 *   nothing to resolve, so it cannot be used as a free-text field.
 */

const {
  CONDITION_KEYS,
  DIMENSIONS,
  DIMENSION_IDS,
  DATE_PATTERN,
  MATCH_MODES,
  MAX_CONDITIONS,
  MAX_LABEL_LENGTH,
  MAX_LIST_VALUES,
  PRODUCT_KEY_PATTERN,
  RULE_SCHEMA_VERSION,
  RULE_SET_KEYS,
  RULE_SET_VERSION,
  VALUE_KIND,
  describeRuleSet
} = require('./segment-rule-schema');

/** Dimensions whose value is a plain scalar or scalar range. */
const SCALAR_KINDS = new Set([VALUE_KIND.integer, VALUE_KIND.decimal]);

/**
 * Dimensions that actually narrow a population on their own. A rule set made
 * only of the others is legal but suspiciously broad, and says so.
 */
const NARROWING_DIMENSIONS = new Set([
  'order_count', 'days_since_last_order', 'last_order_date', 'product_purchased',
  'product_order_count', 'lifetime_spend', 'average_order_value', 'order_cadence_days'
]);

function problem(path, code, reason) {
  return { path, code, reason };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A real calendar date, not merely a string shaped like one. */
function parseCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { value, time };
}

/**
 * Normalise a catalogue entry list into lookup maps.
 *
 * Both a key and a lower-cased name resolve, because the model is given names
 * and a returning client sends back keys.
 */
function productIndex(products = []) {
  const byKey = new Map();
  const byName = new Map();
  for (const entry of products) {
    if (!isPlainObject(entry)) continue;
    const productID = Number(entry.productID ?? entry.product_id);
    const variationID = Number(entry.variationID ?? entry.variation_id ?? 0);
    if (!Number.isSafeInteger(productID) || productID <= 0) continue;
    if (!Number.isSafeInteger(variationID) || variationID < 0) continue;
    const key = `${productID}:${variationID}`;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const record = { productKey: key, productID, variationID, name: name.slice(0, MAX_LABEL_LENGTH) };
    byKey.set(key, record);
    const lower = name.toLowerCase();
    // First entry wins, so a duplicate display name cannot make a resolution
    // depend on catalogue ordering in a way that changes between reads.
    if (!byName.has(lower)) byName.set(lower, record);
  }
  return { byKey, byName };
}

function segmentIndex(segments = []) {
  const byKey = new Map();
  const byName = new Map();
  for (const entry of segments) {
    if (!isPlainObject(entry)) continue;
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!key) continue;
    const record = { key, name: (name || key).slice(0, MAX_LABEL_LENGTH) };
    byKey.set(key, record);
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), record);
  }
  return { byKey, byName };
}

function resolveProduct(raw, index) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (PRODUCT_KEY_PATTERN.test(text) && index.byKey.has(text)) return index.byKey.get(text);
  return index.byName.get(text.toLowerCase()) || null;
}

function resolveSegment(raw, index) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  return index.byKey.get(text) || index.byName.get(text.toLowerCase()) || null;
}

/**
 * A scalar or a two-element range, checked against the dimension's own bounds.
 *
 * @returns {{ value: number|number[] }|{ error: object }}
 */
function scalarValue(dimension, operator, raw, path) {
  const wholeNumbers = dimension.kind === VALUE_KIND.integer;
  const check = candidate => {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      return problem(path, 'VALUE_TYPE_INVALID',
        `${dimension.label} needs a number. Text, null and true/false are not accepted.`);
    }
    if (wholeNumbers && !Number.isSafeInteger(candidate)) {
      return problem(path, 'VALUE_TYPE_INVALID', `${dimension.label} needs a whole number.`);
    }
    if (candidate < dimension.min || candidate > dimension.max) {
      return problem(path, 'VALUE_OUT_OF_RANGE',
        `${dimension.label} must be between ${dimension.min} and ${dimension.max}.`);
    }
    return null;
  };

  if (operator === 'between') {
    if (!Array.isArray(raw) || raw.length !== 2) {
      return { error: problem(path, 'VALUE_TYPE_INVALID', 'between needs exactly two numbers, [low, high].') };
    }
    for (const candidate of raw) {
      const failure = check(candidate);
      if (failure) return { error: failure };
    }
    if (raw[0] > raw[1]) {
      return { error: problem(path, 'VALUE_RANGE_INVERTED', 'The low end of the range is above the high end.') };
    }
    return { value: [raw[0], raw[1]] };
  }

  if (Array.isArray(raw)) {
    return { error: problem(path, 'VALUE_TYPE_INVALID', `${operator} needs a single number, not a list.`) };
  }
  const failure = check(raw);
  if (failure) return { error: failure };
  return { value: raw };
}

function dateValue(operator, raw, path) {
  if (operator === 'between') {
    if (!Array.isArray(raw) || raw.length !== 2) {
      return { error: problem(path, 'VALUE_TYPE_INVALID', 'between needs exactly two dates, [from, to].') };
    }
    const from = parseCalendarDate(raw[0]);
    const to = parseCalendarDate(raw[1]);
    if (!from || !to) {
      return { error: problem(path, 'VALUE_TYPE_INVALID', 'Dates must be written as YYYY-MM-DD and must be real calendar dates.') };
    }
    if (from.time > to.time) {
      return { error: problem(path, 'VALUE_RANGE_INVERTED', 'The start of the date range is after the end.') };
    }
    return { value: [from.value, to.value] };
  }
  if (Array.isArray(raw)) {
    return { error: problem(path, 'VALUE_TYPE_INVALID', `${operator} needs a single date, not a list.`) };
  }
  const parsed = parseCalendarDate(raw);
  if (!parsed) {
    return { error: problem(path, 'VALUE_TYPE_INVALID', 'Dates must be written as YYYY-MM-DD and must be real calendar dates.') };
  }
  return { value: parsed.value };
}

function enumerationValue(dimension, raw, path) {
  if (typeof raw !== 'string' || !dimension.values.includes(raw)) {
    return {
      error: problem(path, 'ENUM_UNKNOWN',
        `${dimension.label} must be exactly one of ${dimension.values.join(', ')}.`)
    };
  }
  return { value: raw };
}

function enumerationListValue(dimension, raw, path) {
  if (!Array.isArray(raw)) {
    return { error: problem(path, 'VALUE_TYPE_INVALID', `${dimension.label} needs a list of values.`) };
  }
  if (!raw.length) return { error: problem(path, 'LIST_EMPTY', `${dimension.label} needs at least one value.`) };
  if (raw.length > MAX_LIST_VALUES) {
    return { error: problem(path, 'LIST_TOO_LONG', `At most ${MAX_LIST_VALUES} values are accepted.`) };
  }
  const seen = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !dimension.values.includes(item)) {
      return {
        error: problem(path, 'ENUM_UNKNOWN',
          `${dimension.label} accepts only ${dimension.values.join(', ')}.`)
      };
    }
    if (!seen.includes(item)) seen.push(item);
  }
  return { value: seen };
}

function productListValue(raw, index, path) {
  if (!Array.isArray(raw)) {
    return { error: problem(path, 'VALUE_TYPE_INVALID', 'Products must be given as a list of product names.') };
  }
  if (!raw.length) return { error: problem(path, 'LIST_EMPTY', 'Name at least one product.') };
  if (raw.length > MAX_LIST_VALUES) {
    return { error: problem(path, 'LIST_TOO_LONG', `At most ${MAX_LIST_VALUES} products are accepted.`) };
  }
  const keys = [];
  const labels = [];
  for (const item of raw) {
    const resolved = resolveProduct(item, index);
    if (!resolved) {
      return {
        error: problem(path, 'PRODUCT_UNKNOWN',
          `There is no product called "${String(item).slice(0, 60)}" in the catalogue.`)
      };
    }
    if (keys.includes(resolved.productKey)) continue;
    keys.push(resolved.productKey);
    labels.push(resolved.name);
  }
  return { value: keys, label: labels };
}

/**
 * Does this condition include every customer? A condition that cannot exclude
 * anybody is refused: it is what a lost clause looks like.
 *
 * Only dimensions whose fact is defined for EVERY customer can be vacuous. A
 * customer with no orders has no last order date, no cadence and no average
 * order value, so a wide bound on those still filters and is left alone.
 */
function matchesEveryone(condition, dimension) {
  const value = condition.value;
  switch (condition.dimension) {
    case 'order_count':
    case 'product_order_count':
    case 'lifetime_spend':
      if (condition.operator === 'at_least') return value <= dimension.min;
      if (condition.operator === 'at_most') return value >= dimension.max;
      if (condition.operator === 'between') return value[0] <= dimension.min && value[1] >= dimension.max;
      return false;
    case 'cadence_confidence':
      return condition.operator === 'any_of' && dimension.values.every(item => value.includes(item));
    default:
      return false;
  }
}

/** The implied [low, high] a numeric condition allows, for contradiction checks. */
function numericBounds(condition, dimension) {
  if (!SCALAR_KINDS.has(dimension.kind)) return null;
  switch (condition.operator) {
    case 'at_least': return [condition.value, Number.POSITIVE_INFINITY];
    case 'at_most': return [Number.NEGATIVE_INFINITY, condition.value];
    case 'equals': return [condition.value, condition.value];
    case 'between': return [condition.value[0], condition.value[1]];
    default: return null;
  }
}

function conditionSubject(condition) {
  return condition.product ? `${condition.dimension}:${condition.product}` : condition.dimension;
}

/**
 * Validate one candidate condition.
 *
 * @returns {{ condition: object }|{ errors: object[] }}
 */
function validateCondition(raw, index, path) {
  if (!isPlainObject(raw)) {
    return { errors: [problem(path, 'CONDITION_NOT_OBJECT', 'Each rule must be an object.')] };
  }
  const unknownKeys = Object.keys(raw).filter(key => !CONDITION_KEYS.includes(key));
  if (unknownKeys.length) {
    return {
      errors: [problem(path, 'CONDITION_UNKNOWN_KEY',
        `A rule may only carry ${CONDITION_KEYS.join(', ')}. These were not accepted: ${unknownKeys.join(', ')}.`)]
    };
  }

  const dimensionID = raw.dimension;
  const dimension = typeof dimensionID === 'string'
    ? Object.prototype.hasOwnProperty.call(DIMENSIONS, dimensionID) && DIMENSIONS[dimensionID]
    : null;
  if (!dimension) {
    return {
      errors: [problem(path, 'DIMENSION_UNKNOWN',
        `"${String(dimensionID).slice(0, 60)}" is not something a segment can be built from. The available ones are: ${DIMENSION_IDS.join(', ')}.`)]
    };
  }

  const operator = raw.operator;
  if (typeof operator !== 'string' || !dimension.operators.includes(operator)) {
    return {
      errors: [problem(path, 'OPERATOR_UNKNOWN',
        `"${String(operator).slice(0, 40)}" cannot be used on ${dimension.label}. Allowed: ${dimension.operators.join(', ')}.`)]
    };
  }

  const condition = { dimension: dimension.id, operator };

  // A product qualifier belongs only to the one dimension that needs it.
  if (dimension.requiresProduct) {
    const resolved = resolveProduct(raw.product, index.products);
    if (!resolved) {
      const code = raw.product === undefined || raw.product === null || raw.product === ''
        ? 'PRODUCT_REQUIRED' : 'PRODUCT_UNKNOWN';
      return {
        errors: [problem(path, code, code === 'PRODUCT_REQUIRED'
          ? `${dimension.label} needs a product to count.`
          : `There is no product called "${String(raw.product).slice(0, 60)}" in the catalogue.`)]
      };
    }
    condition.product = resolved.productKey;
    condition.label = resolved.name;
  } else if (raw.product !== undefined) {
    return {
      errors: [problem(path, 'PRODUCT_NOT_ALLOWED',
        `${dimension.label} does not take a product.`)]
    };
  }

  switch (dimension.kind) {
    case VALUE_KIND.integer:
    case VALUE_KIND.decimal: {
      const outcome = scalarValue(dimension, operator, raw.value, path);
      if (outcome.error) return { errors: [outcome.error] };
      condition.value = outcome.value;
      break;
    }
    case VALUE_KIND.date: {
      const outcome = dateValue(operator, raw.value, path);
      if (outcome.error) return { errors: [outcome.error] };
      condition.value = outcome.value;
      break;
    }
    case VALUE_KIND.enumeration: {
      const outcome = enumerationValue(dimension, raw.value, path);
      if (outcome.error) return { errors: [outcome.error] };
      condition.value = outcome.value;
      break;
    }
    case VALUE_KIND.enumerationList: {
      const outcome = enumerationListValue(dimension, raw.value, path);
      if (outcome.error) return { errors: [outcome.error] };
      condition.value = outcome.value;
      break;
    }
    case VALUE_KIND.productList: {
      const outcome = productListValue(raw.value, index.products, path);
      if (outcome.error) return { errors: [outcome.error] };
      condition.value = outcome.value;
      condition.label = outcome.label;
      break;
    }
    case VALUE_KIND.segmentReference: {
      const resolved = resolveSegment(raw.value, index.segments);
      if (!resolved) {
        return {
          errors: [problem(path, 'SEGMENT_UNKNOWN',
            `There is no saved segment called "${String(raw.value).slice(0, 60)}". Create it first, then refer to it.`)]
        };
      }
      if (index.selfKey && resolved.key === index.selfKey) {
        return {
          errors: [problem(path, 'SEGMENT_SELF_REFERENCE',
            'A segment cannot be defined in terms of itself.')]
        };
      }
      condition.value = resolved.key;
      condition.label = resolved.name;
      break;
    }
    default:
      return { errors: [problem(path, 'DIMENSION_UNKNOWN', 'That dimension has no value rule.')] };
  }

  // `label` is server-derived. It was overwritten above where it means
  // something; anywhere else it is refused so it cannot become free text.
  if (raw.label !== undefined && condition.label === undefined) {
    return {
      errors: [problem(path, 'LABEL_NOT_ACCEPTED',
        `${dimension.label} has nothing to label. Remove "label".`)]
    };
  }

  if (matchesEveryone(condition, dimension)) {
    return {
      errors: [problem(path, 'CONDITION_VACUOUS',
        'This rule matches every customer, so it does not narrow anything. Either tighten it or remove it.')]
    };
  }

  return { condition };
}

/**
 * Validate a candidate rule set.
 *
 * @param {unknown} candidate  anything at all: a model's JSON, a request body
 * @param {object} context
 * @param {Array} context.products  verified catalogue: { productID, variationID, name }
 * @param {Array} context.segments  existing saved segments: { key, name }
 * @param {string} [context.selfSegmentKey]  the segment being edited, if any
 * @returns {{ ok: boolean, ruleSet: object|null, errors: object[], warnings: object[],
 *            description: {sentence: string, lines: string[]}|null }}
 */
function validateRuleSet(candidate, context = {}) {
  const index = {
    products: productIndex(context.products),
    segments: segmentIndex(context.segments),
    selfKey: typeof context.selfSegmentKey === 'string' ? context.selfSegmentKey : null
  };
  const errors = [];
  const warnings = [];

  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      ruleSet: null,
      description: null,
      warnings,
      errors: [problem('rules', 'RULE_SET_NOT_OBJECT', 'The rules must be an object with match and conditions.')]
    };
  }

  const unknownKeys = Object.keys(candidate).filter(key => !RULE_SET_KEYS.includes(key));
  if (unknownKeys.length) {
    errors.push(problem('rules', 'RULE_SET_UNKNOWN_KEY',
      `A rule set may only carry ${RULE_SET_KEYS.join(', ')}. These were not accepted: ${unknownKeys.join(', ')}.`));
  }

  if (candidate.version !== undefined && candidate.version !== RULE_SET_VERSION) {
    errors.push(problem('rules.version', 'RULE_SET_VERSION_UNSUPPORTED',
      `Only rule set version ${RULE_SET_VERSION} is understood.`));
  }
  // A rule set written under an older grammar is refused rather than
  // reinterpreted. The meanings of the dimensions are what changes between
  // schema versions, so guessing would silently change who is in a segment.
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== RULE_SCHEMA_VERSION) {
    errors.push(problem('rules.schemaVersion', 'RULE_SET_SCHEMA_MISMATCH',
      `These rules were written for ${String(candidate.schemaVersion).slice(0, 60)}, and this server understands ${RULE_SCHEMA_VERSION}. Draft them again.`));
  }

  if (!MATCH_MODES.includes(candidate.match)) {
    errors.push(problem('rules.match', 'RULE_SET_MATCH_INVALID',
      `match must be ${MATCH_MODES.join(' or ')}.`));
  }

  if (!Array.isArray(candidate.conditions) || !candidate.conditions.length) {
    errors.push(problem('rules.conditions', 'RULE_SET_NO_CONDITIONS',
      'A segment needs at least one rule. A rule set with none would match everybody.'));
    return { ok: false, ruleSet: null, description: null, errors, warnings };
  }
  if (candidate.conditions.length > MAX_CONDITIONS) {
    errors.push(problem('rules.conditions', 'RULE_SET_TOO_MANY_CONDITIONS',
      `At most ${MAX_CONDITIONS} rules are accepted; this had ${candidate.conditions.length}.`));
    return { ok: false, ruleSet: null, description: null, errors, warnings };
  }

  const conditions = [];
  candidate.conditions.forEach((raw, position) => {
    const outcome = validateCondition(raw, index, `rules.conditions[${position}]`);
    if (outcome.errors) {
      errors.push(...outcome.errors);
      return;
    }
    conditions.push(outcome.condition);
  });

  if (errors.length) return { ok: false, ruleSet: null, description: null, errors, warnings };

  // Exact duplicates are always a confused translation and never add meaning.
  const seen = new Map();
  conditions.forEach((condition, position) => {
    const fingerprint = JSON.stringify([condition.dimension, condition.operator, condition.product ?? null, condition.value]);
    if (seen.has(fingerprint)) {
      errors.push(problem(`rules.conditions[${position}]`, 'CONDITION_DUPLICATE',
        'This rule is the same as an earlier one.'));
      return;
    }
    seen.set(fingerprint, position);
  });

  // Contradictory numeric bounds under `all` produce a segment of nobody and
  // are always a mistake. Under `any` they are legitimate.
  if (candidate.match === 'all') {
    const bounds = new Map();
    conditions.forEach((condition, position) => {
      const dimension = DIMENSIONS[condition.dimension];
      const range = numericBounds(condition, dimension);
      if (!range) return;
      const subject = conditionSubject(condition);
      const previous = bounds.get(subject);
      const merged = previous
        ? [Math.max(previous[0], range[0]), Math.min(previous[1], range[1])]
        : range;
      if (merged[0] > merged[1]) {
        errors.push(problem(`rules.conditions[${position}]`, 'CONDITION_CONTRADICTORY',
          `These rules about ${dimension.label} cannot both be true, so this segment would always be empty.`));
        return;
      }
      bounds.set(subject, merged);
    });
  }

  if (errors.length) return { ok: false, ruleSet: null, description: null, errors, warnings };

  if (!conditions.some(condition => NARROWING_DIMENSIONS.has(condition.dimension))) {
    warnings.push(problem('rules.conditions', 'RULE_SET_BROAD',
      'None of these rules is about orders, products, spend or timing, so this may match a very large share of your customers. Check the preview count before saving.'));
  }

  const ruleSet = {
    version: RULE_SET_VERSION,
    schemaVersion: RULE_SCHEMA_VERSION,
    match: candidate.match,
    conditions
  };

  return {
    ok: true,
    ruleSet,
    description: describeRuleSet(ruleSet),
    errors: [],
    warnings
  };
}

module.exports = {
  NARROWING_DIMENSIONS,
  matchesEveryone,
  parseCalendarDate,
  productIndex,
  segmentIndex,
  validateCondition,
  validateRuleSet
};
