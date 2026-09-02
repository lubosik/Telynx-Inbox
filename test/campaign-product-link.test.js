'use strict';
/**
 * test/campaign-product-link.test.js — a link to what they actually bought.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 *
 *   The call to action is a link to the product page for the item that person
 *   last bought, taken from WooCommerce so it cannot drift from where the
 *   product really lives. No coupon is auto-applied; the code is typed at
 *   checkout as before.
 *
 *   Two things had to be true for it to be safe, and both are tested here:
 *   the link may only ever point at the shop, and a link that cannot be sent
 *   must cost that person the LINK rather than the message.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { approvedStoreLink, FIELDS, render } = require('../lib/campaigns/merge-fields');
const { validateCopy, septetLength } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');
const { recipe } = require('../lib/campaigns/recipes');

const OPT = RULES.optOut.exactSuffix;
const BRAND = RULES.brand.defaultName;
const codes = [...RULES.defaultApprovedProductCodes, 'vin-2mxyurpcwx'];

test('a link may only ever point at the shop', () => {
  // The destination is the whole rule. A link is the one part of a message
  // that takes somebody somewhere else, and only these hosts were approved.
  assert.equal(approvedStoreLink('https://vicipeptides.com/?p=551'),
    'https://vicipeptides.com/?p=551');
  for (const hostile of [
    'https://evil.com/product/rt/',
    'https://vicipeptides.com.evil.com/x',
    'http://vicipeptides.com/product/rt/',      // not https
    'javascript:alert(1)',
    '//vicipeptides.com/product/rt/',           // scheme-relative
    'not a url at all', '', null, undefined
  ]) {
    assert.equal(approvedStoreLink(hostile), '', `should refuse: ${String(hostile)}`);
  }
});

test('only the product-id query survives; every other one is dropped', () => {
  // `?p=<digits>` is a public WordPress post id, identical for everyone who
  // bought that product, and it is the only reason the shop's own links fit in
  // a message. Anything else can carry a customer identifier or tracking
  // nobody here decided to add.
  assert.equal(approvedStoreLink('https://vicipeptides.com/?p=551'),
    'https://vicipeptides.com/?p=551');
  // A readable permalink is now allowed — the catalogue serves them and the
  // limit is 58 — so this asserts the guarantee that actually matters rather
  // than the one length was providing by accident: the tracking and the
  // fragment are stripped and a clean link comes back.
  //
  // It previously expected '' here, which passed because the cleaned URL was
  // 36 characters against a 33 ceiling. That is a side effect standing in for
  // a property, and it stopped being true the moment the ceiling moved.
  assert.equal(approvedStoreLink('https://vicipeptides.com/product/rt/?utm_source=x#top'),
    'https://vicipeptides.com/product/rt/');
  assert.equal(approvedStoreLink('https://vicipeptides.com/?p=551#top'),
    'https://vicipeptides.com/?p=551');
});

test('a product page whose slug carries a banned name is refused', () => {
  // /product/tesamorelin/ puts a banned compound name in front of the customer
  // and the carrier just as surely as a sentence would. Seven people in the
  // live audience hit exactly this, and correctly lost the link rather than
  // the rule.
  const message = `It's ${BRAND}. Michael, vin-2mxyurpcwx takes 15% off more TSM10: `
    + `https://vicipeptides.com/product/tesamorelin/ ${OPT}`;
  const verdict = validateCopy(message, { brandName: BRAND, approvedProductCodes: codes });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some(f => f.check === 'no_banned_terms'));
});

test('a product URL is not read as character substitution', () => {
  // THE BUG THIS FIXED. Every product page on this store carries a dose
  // number, so /product/cjc-1295-without-dac-ipa/ was reported as leet-speak
  // and almost every legitimate link was refused. bpc-157 passed only because
  // that slug happens to be an approved product code, which is luck.
  for (const url of [
    'https://vicipeptides.com/product/cjc-1295-without-dac-ipa/',
    'https://vicipeptides.com/product/ghk-bpc-tb-kpv-blend/',
    'https://vicipeptides.com/product/rt/'
  ]) {
    const verdict = validateCopy(`It's ${BRAND}. 15% off your next order: ${url} ${OPT}`,
      { brandName: BRAND, approvedProductCodes: RULES.defaultApprovedProductCodes });
    assert.equal(verdict.ok, true, `${url}: ${verdict.failures.map(f => f.check).join(',')}`);
  }
});

test('substitution outside a link is still caught', () => {
  // Excluding the link must not have opened a hole in the rest of the message.
  for (const bad of ['Fr33 shipping', 'S@ve big', 'get it f0r less']) {
    const verdict = validateCopy(`It's ${BRAND}. ${bad}. ${OPT}`,
      { brandName: BRAND, approvedProductCodes: RULES.defaultApprovedProductCodes });
    assert.equal(verdict.ok, false, `missed: ${bad}`);
  }
});

test('an unlinkable product renders empty, which moves that person to the plain copy', () => {
  // It does NOT render a gap. merge-fields treats an empty variable as
  // "this person cannot receive this message", and buildFromRecipe then puts
  // them in the variant that does not use it.
  const outcome = render(recipe('winback_one_time').copy.named, {
    contactName: 'Michael', couponCode: 'vin-2mxyurpcwx',
    lastProductName: 'TSM10', lastProductLink: null
  });
  assert.ok(outcome.missing.includes('product_link'));
});

test('the worst case the live store can produce still fits the two-segment ceiling', () => {
  // The longest shortlink the store can produce. Permalinks are no longer
  // used: they run to 58 characters and grow with the product name, so the
  // longest names produced the longest URLs and nothing else fitted beside
  // them.
  const longest = 'https://vicipeptides.com/?p=99999';   // five digits, the ceiling
  assert.ok(longest.length <= FIELDS.product_link.maxLength,
    `maxLength ${FIELDS.product_link.maxLength} is under the real longest permalink`);

  const rendered = render(recipe('winback_one_time').copy.named, {
    contactName: 'Christopher', couponCode: 'vin-2mxyurpcwx',
    lastProductName: 'BPC-157 + TB-500', lastProductLink: longest,
    lastOrderAt: '2026-09-01T00:00:00Z'
  });
  assert.deepEqual(rendered.missing, []);
  // 306 is two concatenated GSM-7 segments at 153 each. The owner chose two
  // segments deliberately so the message could carry a greeting, their name,
  // the product, the month, "here's a code for 15% off your next order", the
  // code, "order here" and a link — 207 septets, which one segment cannot
  // hold and no phrasing could get under.
  assert.ok(septetLength(rendered.text) <= RULES.length.maxSeptets,
    `worst case is ${septetLength(rendered.text)} septets: ${rendered.text}`);
  assert.equal(
    validateCopy(rendered.text, { brandName: BRAND, approvedProductCodes: codes }).ok, true
  );
});

test('the plain copy uses neither the product nor the link', () => {
  // It has to work for somebody who has neither, which is the whole reason it
  // exists. A stray variable here would empty the fallback of its purpose.
  const plain = recipe('winback_one_time').copy.plain;
  assert.doesNotMatch(plain, /\{\{last_product\}\}/);
  assert.doesNotMatch(plain, /\{\{product_link\}\}/);
  const outcome = render(plain, {
    contactName: 'Valentina', couponCode: 'vin-2mxyurpcwx', lastOrderAt: '2026-02-01T00:00:00Z'
  });
  assert.deepEqual(outcome.missing, []);
});

test('only one link, so the message cannot grow a second', () => {
  const named = recipe('winback_one_time').copy.named;
  assert.equal((named.match(/\{\{product_link\}\}/g) || []).length, 1);
  assert.equal(RULES.links.maxPerMessage, 1);
});

// ── Readable names, and the budget they have to live in ────────────────────

test('no approved product name can overflow the message budget', () => {
  // The whole message is exactly 160 septets at worst case, so this is not a
  // style rule: an approved name of 17 characters would silently push some
  // recipient over one segment. maxLength does not save it — a truncated
  // product name is nonsense.
  const { FIELDS } = require('../lib/campaigns/merge-fields');
  const tooLong = RULES.defaultApprovedProductCodes
    .filter(name => name.length > FIELDS.last_product.maxLength);
  assert.deepEqual(tooLong, [],
    `these approved names exceed last_product.maxLength (${FIELDS.last_product.maxLength}) `
    + 'and would be truncated into nonsense: ' + tooLong.join(', '));
});

test('a customer never reads an internal SKU', () => {
  // "15% off P-WA10" was the actual output for somebody who bought BAC water.
  // The SKU fallback is gone: a product that cannot be named in words the
  // customer would recognise is not named at all.
  const { displayNameFor } = require('../lib/campaigns/personalise');
  const { approvedProductLabel } = require('../lib/campaigns/merge-fields');
  for (const sku of ['P-WA10', 'TSM10', 'IP10', 'CP10', 'BBG70', 'ML10']) {
    const asLabel = approvedProductLabel(displayNameFor(sku)) || '';
    assert.equal(asLabel, '', `${sku} must never be a customer-facing label`);
  }
  // And the readable names are available.
  for (const name of ['BAC Water', 'Melanotan II', 'Glutathione', 'BPC-157 + TB-500']) {
    assert.equal(approvedProductLabel(name), name, `${name} should be writeable`);
  }
});

test('the preview code is the same length as a real one', () => {
  // The dry-run placeholder was one character LONGER than a minted code, so
  // every preview measured a message that could not occur. Invisible until
  // code.maxLength was tightened to the true 14, at which point every preview
  // rendered empty and an entire rebuild produced zero recipients.
  const { generateCode } = require('../lib/woocommerce-coupons');
  const { FIELDS } = require('../lib/campaigns/merge-fields');
  const real = generateCode({ prefix: 'vin', seed: 'anything' });
  assert.equal(real.length, FIELDS.code.maxLength,
    'code.maxLength must equal the length generateCode actually produces');

  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'campaigns', 'personalise.js'), 'utf8'
  );
  const placeholder = source.match(/`\$\{COUPON_PREFIX\}-(preview\d+)`/);
  assert.ok(placeholder, 'the dry-run placeholder should still exist');
  assert.equal(`vin-${placeholder[1]}`.length, real.length,
    'the preview placeholder must be exactly as long as a minted code');
});

test('the shortlink form is what the catalogue stores', () => {
  // Readable permalinks run to 58 characters and grow with the product name,
  // so the longest names produced the longest URLs and nothing else fitted.
  // Shortlinks are a fixed 31 or 32 whatever the product.
  const { FIELDS, approvedStoreLink } = require('../lib/campaigns/merge-fields');
  assert.equal(approvedStoreLink('https://vicipeptides.com/?p=4861'),
    'https://vicipeptides.com/?p=4861');
  assert.ok('https://vicipeptides.com/?p=99999'.length <= FIELDS.product_link.maxLength);
});
