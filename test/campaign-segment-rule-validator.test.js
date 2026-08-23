'use strict';
/**
 * The rule validator, which is the safety component of the described-segment
 * feature and matters more than the translator that feeds it.
 *
 * WHAT THESE TESTS ARE FOR
 *   A language model will, eventually, emit a field that does not exist, a
 *   table name, an operator nobody implemented, a string that reads like SQL,
 *   or an object where a number belongs. None of that may reach anything. The
 *   cases below are deliberate attempts to get something past the whitelist,
 *   and every one of them must come back `ok: false` with a reason.
 *
 * NO NETWORK. No model is called from this file and none can be: nothing here
 *   requires lib/openrouter-private.js.
 *
 * MUTATION EVIDENCE. This suite is written so that weakening any single branch
 *   of the validator fails a named assertion rather than passing quietly. The
 *   mutations run against it, and the failures they produced, are recorded in
 *   the handover for this change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIMENSIONS,
  DIMENSION_IDS,
  MAX_CONDITIONS,
  RULE_SCHEMA_VERSION,
  describeRuleSet,
  schemaForPrompt
} = require('../lib/campaigns/segment-rule-schema');
const { validateRuleSet } = require('../lib/campaigns/segment-rule-validator');

const CATALOGUE = [
  { productID: 41, variationID: 0, name: 'BPC-157' },
  { productID: 42, variationID: 0, name: 'TB-500' },
  { productID: 43, variationID: 7, name: 'Retatrutide 10mg' }
];

const SEGMENTS = [
  { key: 'reorder_due', name: 'Reorder due' },
  { key: 'rules:vips:abc', name: 'VIPs' }
];

const CONTEXT = { products: CATALOGUE, segments: SEGMENTS };

function validate(rules, context = CONTEXT) {
  return validateRuleSet(rules, context);
}

/** The owner's own sentence, as rules. */
function ownersRuleSet() {
  return {
    match: 'all',
    conditions: [
      { dimension: 'product_order_count', operator: 'at_least', value: 3, product: 'BPC-157' },
      { dimension: 'last_order_date', operator: 'before', value: '2026-06-01' }
    ]
  };
}

function codes(result) {
  return result.errors.map(entry => entry.code).sort();
}

// ── The happy path, so the rejections below mean something ─────────────────

test('the owner\'s sentence survives as rules and renders as a readable definition', () => {
  const result = validate(ownersRuleSet());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.ruleSet.match, 'all');
  assert.equal(result.ruleSet.schemaVersion, RULE_SCHEMA_VERSION);
  assert.equal(result.ruleSet.conditions.length, 2);

  // The product name resolved to a stable key, and the human label came back
  // from the catalogue rather than from whatever was typed.
  assert.equal(result.ruleSet.conditions[0].product, '41:0');
  assert.equal(result.ruleSet.conditions[0].label, 'BPC-157');

  assert.equal(
    result.description.sentence,
    'A customer is in this segment when all of these are true: they have ordered BPC-157 at least 3 times and their last order was before 1 June 2026.'
  );
});

test('validation is idempotent, so a rule set can be round-tripped through draft, preview and save', () => {
  const first = validate(ownersRuleSet());
  const second = validate(first.ruleSet);
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(second.ruleSet, first.ruleSet);
  assert.deepEqual(second.description, first.description);
});

test('a product may be named or keyed, and both resolve to the same canonical rule', () => {
  const byName = validate({
    match: 'all',
    conditions: [{ dimension: 'product_purchased', operator: 'any_of', value: ['bpc-157'] }]
  });
  const byKey = validate({
    match: 'all',
    conditions: [{ dimension: 'product_purchased', operator: 'any_of', value: ['41:0'] }]
  });
  assert.equal(byName.ok, true);
  assert.deepEqual(byName.ruleSet.conditions, byKey.ruleSet.conditions);
  assert.deepEqual(byName.ruleSet.conditions[0].label, ['BPC-157']);
});

test('a segment may be referred to by the name the operator sees', () => {
  const result = validate({
    match: 'all',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 2 },
      { dimension: 'segment_membership', operator: 'not_in_segment', value: 'VIPs' }
    ]
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.ruleSet.conditions[1].value, 'rules:vips:abc');
  assert.equal(result.ruleSet.conditions[1].label, 'VIPs');
  assert.match(result.description.sentence, /they are not in VIPs/);
});

// ── Deliberate attempts to reach something the schema does not name ────────

test('an invented top-level key is refused by name and nothing is returned', () => {
  const result = validate({
    match: 'all',
    table: 'sms_orders',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.ruleSet, null, 'a rejected rule set is never returned alongside its errors');
  assert.deepEqual(codes(result), ['RULE_SET_UNKNOWN_KEY']);
  assert.match(result.errors[0].reason, /table/);
});

test('an invented key on a condition is refused rather than ignored', () => {
  for (const key of ['sql', 'raw', 'column', 'table', 'filter', 'where', '$gt', 'limit']) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, [key]: 'anything' }]
    });
    assert.equal(result.ok, false, `"${key}" must be refused`);
    assert.deepEqual(codes(result), ['CONDITION_UNKNOWN_KEY']);
    assert.match(result.errors[0].reason, new RegExp(key.replace('$', '\\$')));
  }
});

test('an invented dimension is refused, and the reason lists the ones that exist', () => {
  const attempts = [
    'sms_orders',
    'orders.total',
    "order_count'; DROP TABLE sms_orders; --",
    'email_opened',
    'browsed_product',
    'likes_product',
    'predicted_ltv',
    ''
  ];
  for (const dimension of attempts) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension, operator: 'at_least', value: 2 }]
    });
    assert.equal(result.ok, false, `"${dimension}" must be refused`);
    assert.deepEqual(codes(result), ['DIMENSION_UNKNOWN']);
    // The reason enumerates the whitelist, so the caller is told what IS
    // possible rather than only what is not.
    for (const id of DIMENSION_IDS) assert.match(result.errors[0].reason, new RegExp(id));
  }
});

test('a prototype key cannot be smuggled in as a dimension', () => {
  // `DIMENSIONS['__proto__']` and `DIMENSIONS['constructor']` are both truthy
  // through the prototype chain. The lookup is guarded with hasOwnProperty for
  // exactly this reason, and this is the test that says so.
  for (const dimension of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension, operator: 'at_least', value: 2 }]
    });
    assert.equal(result.ok, false, `"${dimension}" must be refused`);
    assert.deepEqual(codes(result), ['DIMENSION_UNKNOWN']);
  }
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false,
    'nothing above may have written to Object.prototype');
});

test('a dimension is not a string at all', () => {
  for (const dimension of [null, 7, true, {}, [], undefined]) {
    const result = validate({ match: 'all', conditions: [{ dimension, operator: 'at_least', value: 1 }] });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['DIMENSION_UNKNOWN']);
  }
});

test('an operator that exists on another dimension is still refused on this one', () => {
  // `at_least` is a real operator. It is not a real operator on a date, and a
  // per-dimension list is the only thing that catches that.
  const result = validate({
    match: 'all',
    conditions: [{ dimension: 'last_order_date', operator: 'at_least', value: '2026-06-01' }]
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['OPERATOR_UNKNOWN']);
  assert.match(result.errors[0].reason, /before, after, between/);
});

test('an invented operator is refused', () => {
  for (const operator of ['regex', 'like', 'contains', 'in', '$gte', 'not', '', null, 7]) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'order_count', operator, value: 2 }]
    });
    assert.equal(result.ok, false, `"${operator}" must be refused`);
    assert.deepEqual(codes(result), ['OPERATOR_UNKNOWN']);
  }
});

// ── Values ─────────────────────────────────────────────────────────────────

test('a number is required to be a number, and a numeric string is refused rather than coerced', () => {
  for (const value of ['2', '2.5', ' 2 ', true, false, null, {}, [2], () => 2]) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'order_count', operator: 'at_least', value }]
    });
    assert.equal(result.ok, false, `${JSON.stringify(String(value))} must be refused`);
    assert.deepEqual(codes(result), ['VALUE_TYPE_INVALID']);
  }
});

test('NaN and infinity are refused', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'lifetime_spend', operator: 'at_most', value }]
    });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['VALUE_TYPE_INVALID']);
  }
});

test('a whole-number dimension refuses a fraction', () => {
  const result = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2.5 }]
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['VALUE_TYPE_INVALID']);
  assert.match(result.errors[0].reason, /whole number/);
});

test('out-of-range values are refused at both ends of every numeric dimension', () => {
  for (const id of DIMENSION_IDS) {
    const dimension = DIMENSIONS[id];
    if (!['integer', 'decimal'].includes(dimension.kind)) continue;
    if (!dimension.operators.includes('at_most')) continue;
    const tooHigh = validate({
      match: 'all',
      conditions: [{
        dimension: id,
        operator: 'at_most',
        value: dimension.max + 1,
        ...(dimension.requiresProduct ? { product: 'BPC-157' } : {})
      }]
    });
    assert.equal(tooHigh.ok, false, `${id} must refuse ${dimension.max + 1}`);
    assert.ok(codes(tooHigh).includes('VALUE_OUT_OF_RANGE'), `${id} above its maximum`);

    const tooLow = validate({
      match: 'all',
      conditions: [{
        dimension: id,
        operator: 'at_most',
        value: dimension.min - 1,
        ...(dimension.requiresProduct ? { product: 'BPC-157' } : {})
      }]
    });
    assert.equal(tooLow.ok, false, `${id} must refuse ${dimension.min - 1}`);
    assert.ok(codes(tooLow).includes('VALUE_OUT_OF_RANGE'), `${id} below its minimum`);
  }
});

test('a range must have two ends and they must be the right way round', () => {
  const short = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'between', value: [2] }]
  });
  assert.deepEqual(codes(short), ['VALUE_TYPE_INVALID']);

  const long = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'between', value: [1, 2, 3] }]
  });
  assert.deepEqual(codes(long), ['VALUE_TYPE_INVALID']);

  const inverted = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'between', value: [9, 2] }]
  });
  assert.deepEqual(codes(inverted), ['VALUE_RANGE_INVERTED']);

  const scalarWhereRangeGoes = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: [2, 3] }]
  });
  assert.deepEqual(codes(scalarWhereRangeGoes), ['VALUE_TYPE_INVALID']);
});

test('a date must be a real calendar date written the one accepted way', () => {
  for (const value of ['2026-02-30', '2026-13-01', '1 June 2026', '06/01/2026', '2026-6-1',
    '2026-06-01T00:00:00Z', 1780000000000, null, '1899-01-01', '2200-01-01']) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'last_order_date', operator: 'before', value }]
    });
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be refused`);
    assert.deepEqual(codes(result), ['VALUE_TYPE_INVALID']);
  }
  assert.equal(validate({
    match: 'all',
    conditions: [{ dimension: 'last_order_date', operator: 'before', value: '2026-02-28' }]
  }).ok, true);
});

test('an enumeration accepts exactly its own values and nothing adjacent', () => {
  for (const value of ['CLEAR', 'clear ', 'opted_in', 'yes', true, null, ['clear']]) {
    const result = validate({
      match: 'all',
      conditions: [{ dimension: 'consent_state', operator: 'is', value }]
    });
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be refused`);
    assert.deepEqual(codes(result), ['ENUM_UNKNOWN']);
  }
});

test('a list dimension refuses an empty list, an over-long list and a foreign member', () => {
  const empty = validate({
    match: 'all',
    conditions: [{ dimension: 'cadence_confidence', operator: 'any_of', value: [] }]
  });
  assert.deepEqual(codes(empty), ['LIST_EMPTY']);

  const foreign = validate({
    match: 'all',
    conditions: [{ dimension: 'cadence_confidence', operator: 'any_of', value: ['high', 'excellent'] }]
  });
  assert.deepEqual(codes(foreign), ['ENUM_UNKNOWN']);

  const long = validate({
    match: 'all',
    conditions: [{
      dimension: 'product_purchased',
      operator: 'any_of',
      value: Array.from({ length: 21 }, () => 'BPC-157')
    }]
  });
  assert.deepEqual(codes(long), ['LIST_TOO_LONG']);
});

// ── References must resolve against things that exist ──────────────────────

test('a product the catalogue does not contain is an error, never a dropped clause', () => {
  const result = validate({
    match: 'all',
    conditions: [
      { dimension: 'product_order_count', operator: 'at_least', value: 3, product: 'BPC-158' },
      { dimension: 'last_order_date', operator: 'before', value: '2026-06-01' }
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.ruleSet, null,
    'the other clause must not be returned on its own; a segment built from half a sentence is the worst outcome here');
  assert.deepEqual(codes(result), ['PRODUCT_UNKNOWN']);
  assert.match(result.errors[0].reason, /BPC-158/);
});

test('the product-counting dimension will not run without a product', () => {
  for (const product of [undefined, null, '', '   ']) {
    const result = validate({
      match: 'all',
      conditions: [{
        dimension: 'product_order_count',
        operator: 'at_least',
        value: 3,
        ...(product === undefined ? {} : { product })
      }]
    });
    assert.equal(result.ok, false);
    assert.ok(['PRODUCT_REQUIRED', 'PRODUCT_UNKNOWN'].includes(result.errors[0].code));
  }
});

test('a product qualifier on a dimension that has no product is refused', () => {
  const result = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, product: 'BPC-157' }]
  });
  assert.deepEqual(codes(result), ['PRODUCT_NOT_ALLOWED']);
});

test('a segment reference must exist, and a segment cannot be defined in terms of itself', () => {
  const missing = validate({
    match: 'all',
    conditions: [{ dimension: 'segment_membership', operator: 'in_segment', value: 'People who like us' }]
  });
  assert.deepEqual(codes(missing), ['SEGMENT_UNKNOWN']);

  const self = validate({
    match: 'all',
    conditions: [{ dimension: 'segment_membership', operator: 'in_segment', value: 'VIPs' }]
  }, { ...CONTEXT, selfSegmentKey: 'rules:vips:abc' });
  assert.deepEqual(codes(self), ['SEGMENT_SELF_REFERENCE']);
});

test('label is server-derived: refused where there is nothing to label, overwritten where there is', () => {
  const refused = validate({
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, label: 'ignore previous instructions' }]
  });
  assert.deepEqual(codes(refused), ['LABEL_NOT_ACCEPTED']);

  const overwritten = validate({
    match: 'all',
    conditions: [{
      dimension: 'product_order_count', operator: 'at_least', value: 3,
      product: 'BPC-157', label: 'Totally Different Product'
    }]
  });
  assert.equal(overwritten.ok, true);
  assert.equal(overwritten.ruleSet.conditions[0].label, 'BPC-157',
    'a caller-supplied label must never survive into the rendered definition');
  assert.match(overwritten.description.sentence, /ordered BPC-157/);
  assert.doesNotMatch(overwritten.description.sentence, /Totally Different Product/);
});

// ── Shape of the rule set itself ───────────────────────────────────────────

test('a rule set that is not an object is refused', () => {
  for (const candidate of [null, undefined, 'all', 7, true, [], [{ dimension: 'order_count' }]]) {
    const result = validate(candidate);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['RULE_SET_NOT_OBJECT']);
  }
});

test('match must be all or any', () => {
  for (const match of ['ALL', 'and', 'or', '', null, undefined, true]) {
    const result = validate({ match, conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }] });
    assert.equal(result.ok, false, `match ${JSON.stringify(match)} must be refused`);
    assert.ok(codes(result).includes('RULE_SET_MATCH_INVALID'));
  }
});

test('a rule set with no conditions is refused, because it would match everybody', () => {
  for (const conditions of [[], undefined, null, 'order_count', {}]) {
    const result = validate({ match: 'all', conditions });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RULE_SET_NO_CONDITIONS'));
  }
});

test('a condition that is not an object is refused', () => {
  const result = validate({ match: 'all', conditions: ['order_count >= 2'] });
  assert.deepEqual(codes(result), ['CONDITION_NOT_OBJECT']);
});

test('too many conditions is refused with the limit stated', () => {
  const result = validate({
    match: 'all',
    conditions: Array.from({ length: MAX_CONDITIONS + 1 }, (_unused, index) => ({
      dimension: 'order_count', operator: 'equals', value: index + 1
    }))
  });
  assert.deepEqual(codes(result), ['RULE_SET_TOO_MANY_CONDITIONS']);
  assert.match(result.errors[0].reason, new RegExp(String(MAX_CONDITIONS)));
});

test('a rule set written for another grammar version is refused rather than reinterpreted', () => {
  const result = validate({
    schemaVersion: 'segment-rules-1999-01-01',
    match: 'all',
    conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }]
  });
  assert.deepEqual(codes(result), ['RULE_SET_SCHEMA_MISMATCH']);
});

test('every error carries a path, a code and a reason a person can act on', () => {
  const result = validate({
    match: 'all',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 2 },
      { dimension: 'nonsense', operator: 'at_least', value: 2 }
    ]
  });
  assert.equal(result.ok, false);
  for (const entry of result.errors) {
    assert.match(entry.path, /^rules(\.|\[|$)/);
    assert.match(entry.code, /^[A-Z_]+$/);
    assert.ok(entry.reason.length > 15, 'a reason has to say something');
    assert.match(entry.reason, /\.$/, 'reasons are sentences');
  }
  assert.equal(result.errors[0].path, 'rules.conditions[1]',
    'the path points at the condition that failed, not at the rule set');
});

// ── The two rules that exist because of what they prevent ──────────────────

test('a condition that matches every customer is refused, because that is what a lost clause looks like', () => {
  const attempts = [
    { dimension: 'order_count', operator: 'at_least', value: 0 },
    { dimension: 'order_count', operator: 'at_most', value: 10000 },
    { dimension: 'order_count', operator: 'between', value: [0, 10000] },
    { dimension: 'lifetime_spend', operator: 'at_least', value: 0 },
    { dimension: 'product_order_count', operator: 'at_least', value: 0, product: 'BPC-157' },
    { dimension: 'cadence_confidence', operator: 'any_of', value: ['high', 'moderate', 'none'] }
  ];
  for (const condition of attempts) {
    const result = validate({ match: 'all', conditions: [condition] });
    assert.equal(result.ok, false, `${JSON.stringify(condition)} must be refused`);
    assert.deepEqual(codes(result), ['CONDITION_VACUOUS']);
  }
});

test('a wide bound on a dimension that can be absent is NOT vacuous, because absence still filters', () => {
  // A customer who has never ordered has no last order date, no cadence and no
  // average order value, so these still exclude somebody and must be allowed.
  const allowed = [
    { dimension: 'days_since_last_order', operator: 'at_least', value: 0 },
    { dimension: 'order_cadence_days', operator: 'at_least', value: 1 },
    { dimension: 'average_order_value', operator: 'at_least', value: 0 }
  ];
  for (const condition of allowed) {
    const result = validate({ match: 'all', conditions: [condition] });
    assert.equal(result.ok, true, `${JSON.stringify(condition)}: ${JSON.stringify(result.errors)}`);
  }
});

test('bounds that cannot both be true under all are refused, because the segment would always be empty', () => {
  const result = validate({
    match: 'all',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 5 },
      { dimension: 'order_count', operator: 'at_most', value: 2 }
    ]
  });
  assert.deepEqual(codes(result), ['CONDITION_CONTRADICTORY']);
  assert.equal(result.ruleSet, null);

  // The same pair under `any` is legitimate: it means "few orders or many".
  const underAny = validate({
    match: 'any',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 5 },
      { dimension: 'order_count', operator: 'at_most', value: 2 }
    ]
  });
  assert.equal(underAny.ok, true, JSON.stringify(underAny.errors));

  // Two different products do not contradict each other.
  const twoProducts = validate({
    match: 'all',
    conditions: [
      { dimension: 'product_order_count', operator: 'at_least', value: 3, product: 'BPC-157' },
      { dimension: 'product_order_count', operator: 'at_most', value: 1, product: 'TB-500' }
    ]
  });
  assert.equal(twoProducts.ok, true, JSON.stringify(twoProducts.errors));
});

test('an exact duplicate condition is refused', () => {
  const result = validate({
    match: 'all',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 2 },
      { dimension: 'order_count', operator: 'at_least', value: 2 }
    ]
  });
  assert.deepEqual(codes(result), ['CONDITION_DUPLICATE']);
  assert.equal(result.ruleSet, null);
});

test('NOTHING that fails validation is ever returned, whatever the reason', () => {
  // `ok: false` must mean `ruleSet: null` on every single path. A caller that
  // reads `result.ruleSet` without checking `result.ok` is a bug waiting to
  // happen; a validator that hands one back is the bug that makes it happen.
  // The list below is one input per error code the validator can produce.
  const invalid = [
    null,
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }], table: 'x' },
    { version: 9, match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }] },
    { schemaVersion: 'old', match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }] },
    { match: 'sometimes', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }] },
    { match: 'all', conditions: [] },
    { match: 'all', conditions: Array.from({ length: MAX_CONDITIONS + 1 }, (_u, i) => ({ dimension: 'order_count', operator: 'equals', value: i + 1 })) },
    { match: 'all', conditions: ['nope'] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, sql: 'x' }] },
    { match: 'all', conditions: [{ dimension: 'nope', operator: 'at_least', value: 2 }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'nope', value: 2 }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: '2' }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 99999 }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'between', value: [5, 1] }] },
    { match: 'all', conditions: [{ dimension: 'consent_state', operator: 'is', value: 'maybe' }] },
    { match: 'all', conditions: [{ dimension: 'cadence_confidence', operator: 'any_of', value: [] }] },
    { match: 'all', conditions: [{ dimension: 'product_purchased', operator: 'any_of', value: Array.from({ length: 21 }, () => 'BPC-157') }] },
    { match: 'all', conditions: [{ dimension: 'product_order_count', operator: 'at_least', value: 2 }] },
    { match: 'all', conditions: [{ dimension: 'product_order_count', operator: 'at_least', value: 2, product: 'nope' }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, product: 'BPC-157' }] },
    { match: 'all', conditions: [{ dimension: 'segment_membership', operator: 'in_segment', value: 'nope' }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2, label: 'x' }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 0 }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }, { dimension: 'order_count', operator: 'at_least', value: 2 }] },
    { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 5 }, { dimension: 'order_count', operator: 'at_most', value: 2 }] }
  ];

  const seen = new Set();
  // One extra case that needs a context of its own: a segment defined in
  // terms of itself.
  const self = validate(
    { match: 'all', conditions: [{ dimension: 'segment_membership', operator: 'in_segment', value: 'VIPs' }] },
    { ...CONTEXT, selfSegmentKey: 'rules:vips:abc' }
  );
  assert.equal(self.ok, false);
  assert.equal(self.ruleSet, null);
  for (const entry of self.errors) seen.add(entry.code);

  for (const candidate of invalid) {
    const result = validate(candidate);
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.ruleSet, null, `a rule set came back with ok:false for ${JSON.stringify(candidate)}`);
    assert.equal(result.description, null, `a description came back with ok:false for ${JSON.stringify(candidate)}`);
    assert.ok(result.errors.length >= 1);
    for (const entry of result.errors) seen.add(entry.code);
  }

  // Every code the validator can emit is exercised above, so adding a new
  // refusal without a case here fails this assertion rather than shipping
  // untested.
  assert.deepEqual([...seen].sort(), [
    'CONDITION_CONTRADICTORY',
    'CONDITION_DUPLICATE',
    'CONDITION_NOT_OBJECT',
    'CONDITION_UNKNOWN_KEY',
    'CONDITION_VACUOUS',
    'DIMENSION_UNKNOWN',
    'ENUM_UNKNOWN',
    'LABEL_NOT_ACCEPTED',
    'LIST_EMPTY',
    'LIST_TOO_LONG',
    'OPERATOR_UNKNOWN',
    'PRODUCT_NOT_ALLOWED',
    'PRODUCT_REQUIRED',
    'PRODUCT_UNKNOWN',
    'RULE_SET_MATCH_INVALID',
    'RULE_SET_NOT_OBJECT',
    'RULE_SET_NO_CONDITIONS',
    'RULE_SET_SCHEMA_MISMATCH',
    'RULE_SET_TOO_MANY_CONDITIONS',
    'RULE_SET_UNKNOWN_KEY',
    'RULE_SET_VERSION_UNSUPPORTED',
    'SEGMENT_SELF_REFERENCE',
    'SEGMENT_UNKNOWN',
    'VALUE_OUT_OF_RANGE',
    'VALUE_RANGE_INVERTED',
    'VALUE_TYPE_INVALID'
  ]);
});

test('a rule set with nothing about orders, products, spend or timing warns that it may be broad', () => {
  const result = validate({
    match: 'all',
    conditions: [{ dimension: 'consent_state', operator: 'is', value: 'clear' }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.map(entry => entry.code), ['RULE_SET_BROAD'],
    'a warning, not a refusal: a wide segment can be legitimate and the count decides');
});

// ── The whole surface, in one place ────────────────────────────────────────

test('every whitelisted dimension is renderable, and nothing renders as an unknown rule', () => {
  const samples = {
    order_count: { operator: 'at_least', value: 2 },
    days_since_last_order: { operator: 'at_least', value: 30 },
    last_order_date: { operator: 'before', value: '2026-06-01' },
    product_purchased: { operator: 'any_of', value: ['BPC-157', 'TB-500'] },
    product_order_count: { operator: 'at_least', value: 3, product: 'BPC-157' },
    lifetime_spend: { operator: 'at_least', value: 500 },
    average_order_value: { operator: 'at_most', value: 120.5 },
    order_cadence_days: { operator: 'at_most', value: 45 },
    cadence_confidence: { operator: 'any_of', value: ['high'] },
    segment_membership: { operator: 'not_in_segment', value: 'VIPs' },
    consent_state: { operator: 'is', value: 'clear' }
  };
  assert.deepEqual(Object.keys(samples).sort(), [...DIMENSION_IDS],
    'a dimension added to the schema must be given a sample here, or it ships unrendered');

  for (const [dimension, rest] of Object.entries(samples)) {
    const result = validate({ match: 'all', conditions: [{ dimension, ...rest }] });
    assert.equal(result.ok, true, `${dimension}: ${JSON.stringify(result.errors)}`);
    const [line] = result.description.lines;
    assert.doesNotMatch(line, /unknown rule/, `${dimension} has no rendering`);
    // Every fragment is written from the customer's side, so the sentence
    // reads as prose once the joiner is applied.
    assert.ok(line.startsWith('they ') || line.startsWith('their '),
      `${dimension} renders as "${line}"`);
  }
});

test('every operator on every dimension renders, so no accepted rule can print as an unknown rule', () => {
  const valueFor = (dimension, operator) => {
    switch (dimension.kind) {
      case 'integer':
      case 'decimal':
        return operator === 'between' ? [dimension.min + 1, dimension.min + 2] : dimension.min + 1;
      case 'date':
        return operator === 'between' ? ['2026-01-01', '2026-06-01'] : '2026-06-01';
      case 'enumeration': return dimension.values[0];
      case 'enumerationList': return [dimension.values[0]];
      case 'productList': return ['BPC-157'];
      case 'segmentReference': return 'VIPs';
      default: return null;
    }
  };
  for (const id of DIMENSION_IDS) {
    const dimension = DIMENSIONS[id];
    for (const operator of dimension.operators) {
      const condition = {
        dimension: id,
        operator,
        value: valueFor(dimension, operator),
        ...(dimension.requiresProduct ? { product: 'BPC-157' } : {})
      };
      const result = validate({ match: 'all', conditions: [condition] });
      if (!result.ok) {
        // The only legitimate refusals here are the safety rules, which are
        // tested above by name. Anything else is a hole.
        assert.ok(['CONDITION_VACUOUS'].includes(result.errors[0].code),
          `${id} ${operator} was refused as ${result.errors[0].code}: ${result.errors[0].reason}`);
        continue;
      }
      assert.doesNotMatch(result.description.lines[0], /unknown rule/, `${id} ${operator}`);
    }
  }
});

test('the grammar handed to the model describes every dimension and no customer', () => {
  const prompt = schemaForPrompt();
  for (const id of DIMENSION_IDS) assert.match(prompt, new RegExp(`- ${id}:`));
  // Nothing in the prompt schema may look like identity.
  assert.doesNotMatch(prompt, /@/);
  assert.doesNotMatch(prompt, /\+?\d[\d().\-\s]{7,}\d/);
  assert.doesNotMatch(prompt, /https?:\/\//);
});

test('describeRuleSet joins with and for all and with or for any', () => {
  const both = {
    match: 'any',
    conditions: [
      { dimension: 'order_count', operator: 'at_least', value: 5 },
      { dimension: 'consent_state', operator: 'is', value: 'clear' }
    ]
  };
  assert.match(describeRuleSet(both).sentence, /^A customer is in this segment when any of these is true: /);
  assert.match(describeRuleSet(both).sentence, / or /);
  assert.match(describeRuleSet({ ...both, match: 'all' }).sentence, / and /);
});
