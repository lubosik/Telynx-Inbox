'use strict';
/**
 * `normalisePhoneStrict` — the normaliser that is allowed nowhere near a guess.
 *
 * This repository has two forgiving normalisers (`lib/phone.js`'s
 * `normalisePhone` and `woocommerce.js`'s `normalizePhone`) that disagree with
 * each other and both fabricate. On a delivery path a fabricated number is a
 * failed send. On a CONSENT record it is manufactured evidence that a real
 * person, who has never heard of us, agreed to be texted — so the consent paths
 * use this function instead.
 *
 * The invariant every test below restates: the output is the input's own
 * digits, in order, with at most a NANP country code added. Anything else is
 * null.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalisePhone, normalisePhoneStrict } = require('../lib/phone');

/** Every input the reviewers executed against the old code, and what it produced. */
const FABRICATIONS = [
  ['3055551234 ext 22', '+305555123422'],
  ['305.555.1234.22', '+305555123422'],
  ['+1 (305) 555-1234x9', '+130555512349'],
  ['13055551234 #5', '+130555512345'],
  ['0412345678', '+10412345678']
];

test('the proven fabrications are refused, and the forgiving normaliser still commits them', () => {
  for (const [input, fabricated] of FABRICATIONS) {
    assert.equal(
      normalisePhoneStrict(input), null,
      `${JSON.stringify(input)} must be refused rather than turned into ${fabricated}`
    );

    // Not a wish: the lenient normaliser really does still return the invented
    // number. It is left alone because the delivery paths depend on it, which
    // is exactly why the consent paths must not share it.
    assert.equal(
      normalisePhone(input), fabricated,
      `the lenient normaliser is expected to still produce ${fabricated}`
    );
  }
});

test('a genuine number survives byte-for-byte', () => {
  const cases = [
    ['+13055551234', '+13055551234'],
    ['13055551234', '+13055551234'],
    ['3055551234', '+13055551234'],
    ['(305) 555-1234', '+13055551234'],
    ['305-555-1234', '+13055551234'],
    ['  +1 (305) 555-1234  ', '+13055551234'],
    ['+447506440284', '+447506440284'],
    ['+44 7506 440284', '+447506440284'],
    ['+61 412 345 678', '+61412345678'],
    [3055551234, '+13055551234'],
    [13055551234, '+13055551234']
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalisePhoneStrict(input), expected, JSON.stringify(input));
  }
});

test('the output is always the input digits, plus at most a NANP country code', () => {
  const inputs = [
    '+13055551234', '13055551234', '3055551234', '(305) 555-1234', '+447506440284',
    '+44 7506 440284', '+61412345678', '+34 911 22 33 44', '+81 3 1234 5678'
  ];

  for (const input of inputs) {
    const digits = String(input).replace(/\D/g, '');
    const out = normalisePhoneStrict(input);
    assert.ok(out, `${input} should normalise`);
    assert.ok(
      out === `+${digits}` || out === `+1${digits}`,
      `${input} -> ${out}: a digit was added, dropped or reordered`
    );
  }
});

test('a letter anywhere is a refusal, never a truncation', () => {
  for (const input of [
    '3055551234 ext 22', '305 555 1234 ext. 100', '(305) 555-1234 x9', '3055551234x',
    '1 800 FLOWERS', 'not a phone', 'tel:+13055551234', '+44 7506 440284 ext 3',
    '3055551234 (mobile)', 'n/a'
  ]) {
    assert.equal(normalisePhoneStrict(input), null, JSON.stringify(input));
  }
});

test('a # extension marker is a refusal even though it carries no letter', () => {
  for (const input of ['13055551234 #5', '3055551234#22', '+13055551234 # 7']) {
    assert.equal(normalisePhoneStrict(input), null, JSON.stringify(input));
  }
});

test("a '+' that does not lead is malformed input, not a number to repair", () => {
  for (const input of ['1+3055551234', '++13055551234', '3055551234+', '+1+3055551234']) {
    assert.equal(normalisePhoneStrict(input), null, JSON.stringify(input));
  }
});

test('ten bare digits are only NANP when they are shaped like NANP', () => {
  // Neither a NANP area code nor a central-office code may begin with 0 or 1,
  // so "0412345678" is an Australian mobile and "1412345678" is not a number at
  // all. Prefixing either with '+1' invents a US subscriber.
  for (const input of ['0412345678', '1412345678', '3050551234', '3051551234']) {
    assert.equal(normalisePhoneStrict(input), null, JSON.stringify(input));
  }
  assert.equal(normalisePhoneStrict('2125551234'), '+12125551234');
  assert.equal(normalisePhoneStrict('9995550000'), '+19995550000');
});

test('a leading 1 does not make a non-NANP number American', () => {
  assert.equal(normalisePhoneStrict('10412345678'), null);
  assert.equal(normalisePhoneStrict('+10412345678'), null);
  assert.equal(normalisePhoneStrict('13055551234'), '+13055551234');
});

test('a bare international-looking string is refused because we cannot see the country code', () => {
  // "447506440284" is a UK number with its country code, or a local number
  // somewhere with twelve digits, or ten digits with an extension welded on.
  // Only a '+' settles it, and the customer did not type one.
  for (const input of ['447506440284', '305555123422', '61412345678', '0044 7506 440284']) {
    assert.equal(normalisePhoneStrict(input), null, JSON.stringify(input));
  }
  assert.equal(normalisePhoneStrict('+447506440284'), '+447506440284');
});

test('a country code the shared normaliser would re-read as NANP is refused', () => {
  for (const input of ['+0123456789', '+012 345 6789']) {
    assert.equal(normalisePhoneStrict(input), null, input);
    assert.equal(normalisePhone(input), '+0123456789', 'the lenient one keeps a leading zero');
  }
});

test('the result always satisfies the consent ledger CHECK constraint', () => {
  const shape = /^\+[1-9][0-9]{7,14}$/;
  for (const input of ['3055551234', '+447506440284', '13055551234', '+61412345678']) {
    assert.match(normalisePhoneStrict(input), shape, input);
  }
  // Too short and too long both fall out rather than being padded or trimmed.
  assert.equal(normalisePhoneStrict('+1234567'), null);
  assert.equal(normalisePhoneStrict('+1234567890123456789'), null);
  assert.equal(normalisePhoneStrict('12345'), null);
  assert.equal(normalisePhoneStrict('555-1234'), null);
});

test('junk input returns null instead of throwing', () => {
  for (const input of [
    null, undefined, '', '   ', '+', '-', '()', {}, [], ['+13055551234'], true, false,
    Number.NaN, Infinity, -Infinity, 0, Symbol.iterator, () => {}, new Date()
  ]) {
    assert.doesNotThrow(() => normalisePhoneStrict(input), String(typeof input));
    assert.equal(normalisePhoneStrict(input), null, String(typeof input));
  }
});

test('it is idempotent, so re-normalising a stored number cannot change it', () => {
  for (const input of ['3055551234', '+447506440284', '(305) 555-1234', '+61 412 345 678']) {
    const once = normalisePhoneStrict(input);
    assert.equal(normalisePhoneStrict(once), once, input);
  }
});

test('the lenient normaliser is still exported and still lenient', () => {
  // Adding the strict one must not have changed the delivery paths under it:
  // `normalisePhone` has thirteen callers across analytics, campaigns, audit and
  // voice, and tightening it silently would drop live message routing.
  assert.equal(typeof normalisePhone, 'function');
  assert.equal(normalisePhone('3055551234'), '+13055551234');
  assert.equal(normalisePhone('13055551234'), '+13055551234');
  assert.equal(normalisePhone('+447506440284'), '+447506440284');
  assert.equal(normalisePhone('447506440284'), '+447506440284');
  assert.equal(normalisePhone(''), null);
});
