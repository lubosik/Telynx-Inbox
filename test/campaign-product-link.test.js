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
  assert.equal(approvedStoreLink('https://vicipeptides.com/product/rt/'),
    'https://vicipeptides.com/product/rt/');
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

test('query strings and fragments are dropped', () => {
  // They cost characters the 160-septet budget does not have, and can carry
  // tracking nobody here decided to add.
  assert.equal(
    approvedStoreLink('https://vicipeptides.com/product/rt/?utm_source=x&ref=y#top'),
    'https://vicipeptides.com/product/rt/'
  );
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

test('the worst case the live store can produce still fits one segment', () => {
  // 58 characters is the longest permalink on the store today, and
  // FIELDS.product_link.maxLength must leave room for it.
  const longest = 'https://vicipeptides.com/product/cjc-1295-without-dac-ipa/';
  assert.ok(longest.length <= FIELDS.product_link.maxLength,
    `maxLength ${FIELDS.product_link.maxLength} is under the real longest permalink`);

  const rendered = render(recipe('winback_one_time').copy.named, {
    contactName: 'Christopher', couponCode: 'vin-2mxyurpcwx',
    lastProductName: 'CJC-1295', lastProductLink: longest
  });
  assert.deepEqual(rendered.missing, []);
  assert.ok(septetLength(rendered.text) <= 160,
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
