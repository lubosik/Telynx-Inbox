'use strict';
/**
 * lib/campaigns/personalise.js — turns an approved TEMPLATE into one message
 * per person, and mints the codes those messages name.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES, WHICH WAS LIVE
 *
 *   `renderForRecipients` and `createCoupons` were both written, both tested,
 *   and both called from NOWHERE except their own tests. The approval RPC did
 *   this, and only this:
 *
 *       rendered_message = v_campaign.final_message
 *
 *   The same string, copied to every recipient row. The delivery worker then
 *   sends `rendered_message` verbatim and refuses to construct text itself,
 *   which is correct and which meant that approving a campaign whose copy
 *   said "Hi {{first_name}}" would have sent the characters
 *
 *       Hi {{first_name}}, ... use {{code}} for 15% off
 *
 *   to every person on the list. Measured against the staged win-back that is
 *   376 customers receiving visibly broken mail-merge from a business asking
 *   them to come back. Nothing in the pipeline would have caught it: the
 *   template is valid copy, the audience is real, the send gate is about
 *   consent and quiet hours, and the worker's one refusal is an EMPTY
 *   rendered_message, which this never was.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHERE IT RUNS, AND WHY THERE
 *
 *   At APPROVAL, before `prepare_sms_campaign_approval`, never at send time.
 *   The rule that must not bend is that a person approves the exact words a
 *   customer receives. Substituting at send time would mean the operator
 *   approved a template and the customer got something nobody read. So this
 *   renders first, writes one frozen message per recipient, and the RPC then
 *   verifies that every selected recipient has one rather than overwriting
 *   them with the template.
 *
 * ORDERING, AND WHAT A HALF-FINISHED RUN LEAVES BEHIND
 *
 *   1. gather facts        (reads: contacts, orders, catalogue)
 *   2. mint coupons        (WRITES to WooCommerce)
 *   3. render + validate   (pure)
 *   4. write rendered rows (WRITES to Supabase)
 *   5. RPC approval        (caller)
 *
 *   Step 2 is the only irreversible one, and it is safe to repeat: codes are
 *   deterministic in `${campaignId}:${phone}`, so a second run regenerates the
 *   SAME code and WooCommerce answers "already exists", which
 *   `createCoupons` reports as a duplicate rather than throwing. A run that
 *   dies between 2 and 5 therefore leaves unused coupons attached to nobody,
 *   and the retry adopts them instead of minting a second set. Unused coupons
 *   cost nothing; a customer holding two live codes would.
 *
 * A RECIPIENT WHO CANNOT BE RENDERED IS DROPPED, NEVER PATCHED
 *
 *   No name, no nameable product, no code, a rendered message that fails the
 *   per-person copy check: that person is deselected and the reason recorded.
 *   The alternative is sending "Hi , it has been a while" to somebody, and a
 *   broken merge in a win-back does more damage than the silence it replaced.
 *   If the drop rate is high the operator sees it BEFORE approving, because
 *   `preview()` runs the identical path without minting anything.
 */

const { couponSpec, createCoupons, generateCode } = require('../woocommerce-coupons');
const { productCatalogue } = require('./product-catalogue');
const { renderForRecipients } = require('./render-recipients');
const { fieldsUsed } = require('./merge-fields');
const { IN_CHUNK_SIZE } = require('../fetch-all-rows');

/** Coupon codes carry this prefix so they are recognisable in WooCommerce. */
const COUPON_PREFIX = 'vin';

/** How long a win-back code stays live. Long enough to think, short enough to matter. */
const DEFAULT_COUPON_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

class PersonalisationError extends Error {
  constructor(message, code = 'PERSONALISATION_FAILED', status = 500) {
    super(message);
    this.name = 'PersonalisationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Every distinct SKU in the catalogue mapped to its PARENT product name.
 *
 * This is the whole reason product naming works at all. Order line items carry
 * the VARIATION sku (`RT20`, `TR30`, `NJ500`); `defaultApprovedProductCodes`
 * holds the PARENT sku (`P-RT10`, `P-TR10`, `P-NJ100`). Matching a line item
 * against the approved list directly therefore misses, and misses hardest on
 * the products that sell most: measured on the staged win-back audience, 248
 * of 376 people had no nameable product, including every RT, TZ and SM buyer.
 * Resolving the variation to its parent first takes that to 144, and the ones
 * still missing are combination products with no single approved code, which
 * is the correct answer rather than a gap.
 */
async function skuToParentName() {
  const catalogue = await productCatalogue();
  const map = new Map();
  for (const entry of catalogue?.entries || []) {
    if (!entry?.sku) continue;
    map.set(String(entry.sku).toUpperCase(), entry.parentName || entry.name || null);
  }
  return map;
}

/**
 * The line item worth naming, which is not necessarily the first one.
 *
 * Orders here routinely lead with BAC water or a syringe pack, so `items[0]`
 * names the accessory and not the product somebody actually came for. Sorting
 * by line total puts the real purchase first, and the caller then walks the
 * list so a top item with no approved code falls through to the next one
 * rather than dropping the recipient.
 */
function itemsByValue(order) {
  return (order?.items || [])
    .slice()
    .sort((a, b) => Number(b?.total || 0) - Number(a?.total || 0));
}

/**
 * Facts for one person, in the shape merge-fields renders from.
 *
 * `lastProductName` is resolved to the PARENT name here rather than passed
 * raw, because merge-fields is synchronous and has no catalogue access, and
 * because the resolution is a fact about the store rather than about the
 * message.
 */
function factsForBuyer({ contact, order, skuMap, couponCode = null }) {
  let lastProductName = null;
  for (const item of itemsByValue(order)) {
    const parent = skuMap.get(String(item?.sku || '').toUpperCase());
    if (parent) { lastProductName = parent; break; }
  }
  return {
    contactName: contact?.name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || null,
    orderCount: Number.isFinite(Number(contact?.orderCount)) ? Number(contact.orderCount) : null,
    lastProductName,
    lastProductSku: null,
    lastOrderAt: order?.created_at || null,
    couponCode
  };
}

/** Chunked `.in()` reads. An unbounded list overflows the URL and fails silently. */
async function readIn(client, table, columns, column, values) {
  const rows = [];
  for (let index = 0; index < values.length; index += IN_CHUNK_SIZE) {
    const slice = values.slice(index, index + IN_CHUNK_SIZE);
    const { data, error } = await client.from(table).select(columns).in(column, slice);
    if (error) throw new PersonalisationError(`Reading ${table} failed: ${error.message}`, 'PERSONALISATION_READ_FAILED');
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * Gather the facts for a list of phone numbers.
 *
 * Reads contacts and their orders, resolves the latest paid order per person,
 * and returns facts WITHOUT a coupon code. The code is added later, and only
 * when the template actually asks for one, so a campaign that offers nothing
 * never touches WooCommerce.
 */
async function gatherFacts({ client, phones, skuMap: injectedSkuMap = null }) {
  const unique = [...new Set((phones || []).filter(Boolean))];
  if (!unique.length) return new Map();

  // The catalogue is a live HTTP read. Injecting it keeps this function
  // testable offline and, more importantly, lets one campaign run resolve the
  // catalogue once instead of once per call.
  const [contacts, orders, skuMap] = await Promise.all([
    readIn(client, 'sms_contacts', 'phone, name, first_name, last_name, email', 'phone', unique),
    readIn(client, 'sms_orders', 'contact_phone, items, created_at, status', 'contact_phone', unique),
    injectedSkuMap ? Promise.resolve(injectedSkuMap) : skuToParentName()
  ]);

  const contactByPhone = new Map(contacts.map(row => [row.phone, row]));

  // Latest order per person, and how many they have. Both come from the same
  // pass so order_count and last_product can never disagree about who this is.
  const latest = new Map();
  const counts = new Map();
  for (const order of orders) {
    const phone = order.contact_phone;
    counts.set(phone, (counts.get(phone) || 0) + 1);
    const held = latest.get(phone);
    if (!held || new Date(order.created_at) > new Date(held.created_at)) latest.set(phone, order);
  }

  const facts = new Map();
  for (const phone of unique) {
    const contact = contactByPhone.get(phone) || null;
    const built = factsForBuyer({
      contact: contact ? { ...contact, orderCount: counts.get(phone) || 0 } : null,
      order: latest.get(phone) || null,
      skuMap
    });
    // Carried beside the merge fields, never as one. The renderer only ever
    // substitutes the five names in merge-fields.js, so this cannot reach a
    // message; it exists so a campaign-wide coupon can be restricted to the
    // people the campaign is actually going to.
    built.email = contact?.email ? String(contact.email).trim().toLowerCase() : null;
    facts.set(phone, built);
  }
  return facts;
}

/**
 * Mint one single-use coupon per person.
 *
 * Deterministic in the campaign and the phone, so a retry adopts the codes the
 * previous attempt created instead of issuing a second set. `createCoupons`
 * reports a duplicate rather than throwing, and a duplicate here means the
 * code already belongs to this person, which is success.
 */
async function issueCodes({ campaignID, phones, percentOff, expiresInDays = DEFAULT_COUPON_DAYS, coupons = { createCoupons, generateCode } }) {
  const pct = Number(percentOff);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
    throw new PersonalisationError(`percentOff must be between 1 and 99, received ${percentOff}.`, 'PERSONALISATION_BAD_DISCOUNT', 400);
  }

  // WooCommerce reads date_expires in the SITE timezone, so it must be
  // ISO8601 with NO timezone designator. A trailing Z is misread or rejected
  // depending on the store version, and a bare date fails the shape check
  // outright, which is what happened here.
  const expiresAt = `${new Date(Date.now() + expiresInDays * DAY_MS)
    .toISOString().slice(0, 10)}T23:59:59`;

  const wanted = phones.map(phone => ({
    phone,
    code: coupons.generateCode({ prefix: COUPON_PREFIX, seed: `${campaignID}:${phone}` })
  }));

  // Specs are built by couponSpec, not by hand. It owns the field names, the
  // string amount WooCommerce insists on, individual_use and the per-user
  // limit, and validates all of them. Hand-built objects were how this shipped
  // with `percentOff` where the module wanted `percent`.
  const specs = wanted.map(entry => (coupons.couponSpec || couponSpec)({
    code: entry.code,
    percent: pct,
    usageLimit: 1,
    expiresAt
  }));

  // POSITIONAL ARRAY, not { coupons }. Approving a campaign failed with
  // "createCoupons requires an array of coupon specs" because this passed an
  // object, and every unit test stubbed createCoupons with the shape this
  // file assumed rather than the one the module exports.
  const result = await coupons.createCoupons(specs);

  // A duplicate is this campaign's own earlier attempt, so it counts as issued.
  const failed = new Map((result?.failed || [])
    .filter(row => row?.duplicate !== true)
    .map(row => [String(row.code), row.error || 'coupon_not_created']));

  const byPhone = new Map();
  for (const entry of wanted) {
    if (failed.has(entry.code)) continue;
    byPhone.set(entry.phone, entry.code);
  }
  return { byPhone, failed };
}

/**
 * Mint ONE code for the whole campaign, usable once by each person in it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS REPLACED A CODE PER PERSON
 *
 *   The original design minted one single-use coupon per recipient: 221
 *   people, 221 coupons. It works, and it has three costs that only show up
 *   once a few campaigns have run.
 *
 *   The store's coupon table grows by the size of every audience. Ten
 *   campaigns of this size is two thousand coupons, each used zero or one
 *   times, and the WooCommerce admin then shows no campaign-level number at
 *   all — no "this offer was redeemed 37 times", just a very long list.
 *
 *   And the per-person codes carry NO email restriction, so each one works for
 *   whoever types it first. A code posted in a forum is spent by a stranger
 *   and the customer it was meant for finds it dead.
 *
 *   One code restricted to the audience fixes all three. It is also the
 *   simpler thing to say out loud, to put in a link, and to answer support
 *   questions about.
 *
 * WHAT IS GIVEN UP, HONESTLY
 *
 *   With per-person codes, a redemption names the person with no further work.
 *   With one code, a redemption is joined back through the billing email. That
 *   join is reliable here precisely BECAUSE of the restriction: nobody outside
 *   the list can redeem it at all. `issued_coupon_code` is still written on
 *   every recipient row, so the campaign-level attribution join is unchanged.
 *
 *   The restriction is matched against the billing email TYPED at checkout,
 *   not a verified account. It is a strong deterrent, not proof of identity.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function issueSharedCode({
  campaignID, phones, facts, percentOff, expiresInDays = DEFAULT_COUPON_DAYS,
  coupons = { createCoupons, generateCode }
}) {
  const pct = Number(percentOff);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
    throw new PersonalisationError(
      `percentOff must be between 1 and 99, received ${percentOff}.`,
      'PERSONALISATION_BAD_DISCOUNT', 400
    );
  }

  const emails = [];
  const withoutEmail = [];
  for (const phone of phones) {
    const email = facts.get(phone)?.email || null;
    if (email) emails.push(email);
    else withoutEmail.push(phone);
  }

  // Fail loudly rather than mint an unrestricted code. A campaign-wide coupon
  // with no restriction is a public discount, which is a different and much
  // more expensive thing than what was asked for.
  if (!emails.length) {
    throw new PersonalisationError(
      'Nobody in this audience has an email on file, so a shared code could not be restricted to them.',
      'PERSONALISATION_NO_EMAILS', 409
    );
  }

  const code = coupons.generateCode({ prefix: COUPON_PREFIX, seed: `${campaignID}:shared` });
  const expiresAt = `${new Date(Date.now() + expiresInDays * DAY_MS)
    .toISOString().slice(0, 10)}T23:59:59`;

  const spec = (coupons.couponSpec || couponSpec)({
    code,
    percent: pct,
    // One per person, and no more redemptions in total than there are people.
    // Both, not either: the per-user limit is the rule and the total is the
    // ceiling that caps the damage if the per-user check is ever bypassed.
    usageLimit: emails.length,
    expiresAt,
    emailRestrictions: emails
  });

  const result = await coupons.createCoupons([spec]);
  const failed = (result?.failed || []).filter(row => row?.duplicate !== true);
  if (failed.length) {
    throw new PersonalisationError(
      `The campaign coupon could not be created: ${failed[0].error || 'unknown'}`,
      'PERSONALISATION_COUPON_FAILED', 502
    );
  }

  // Everybody gets the same code, including anyone with no email on file. They
  // simply will not be able to redeem it, which is why they are reported.
  const byPhone = new Map(phones.map(phone => [phone, code]));
  return { code, byPhone, restrictedTo: emails.length, withoutEmail };
}

/**
 * Render one campaign for its audience.
 *
 * `dryRun` runs the identical path with PLACEHOLDER codes and no WooCommerce
 * write, which is what the app's preview calls. The placeholder is shaped like
 * a real code so length and validation behave identically; a preview that
 * passed and a send that failed on one extra character would be worse than no
 * preview at all.
 */
async function personaliseCampaign({
  client,
  campaignID,
  template,
  phones,
  percentOff = null,
  expiresInDays = DEFAULT_COUPON_DAYS,
  dryRun = false,
  coupons,
  skuMap = null,
  // One code for the whole campaign, restricted to its audience, rather than
  // one code per person. See issueSharedCode.
  sharedCode = false
}) {
  const audience = [...new Set((phones || []).filter(Boolean))];
  if (!audience.length) {
    throw new PersonalisationError('Cannot personalise an empty audience.', 'PERSONALISATION_EMPTY_AUDIENCE', 400);
  }

  const needsCode = fieldsUsed(template).includes('code');
  const facts = await gatherFacts({ client, phones: audience, skuMap });

  let codes = new Map();
  let couponFailures = new Map();
  let sharedOutcome = null;
  if (needsCode) {
    if (dryRun) {
      // Same shape as a minted code, so worst-case length is honest.
      for (const phone of audience) codes.set(phone, `${COUPON_PREFIX}-preview0000`);
    } else {
      if (sharedCode) {
        const issued = await issueSharedCode({
          campaignID, phones: audience, facts, percentOff, expiresInDays,
          ...(coupons ? { coupons } : {})
        });
        codes = issued.byPhone;
        sharedOutcome = issued;
      } else {
        const issued = await issueCodes({ campaignID, phones: audience, percentOff, expiresInDays, ...(coupons ? { coupons } : {}) });
        codes = issued.byPhone;
        couponFailures = issued.failed;
      }
    }
  }

  const recipients = audience.map(phone => ({
    phone,
    facts: { ...facts.get(phone), couponCode: codes.get(phone) || null }
  }));

  const outcome = renderForRecipients({ template, recipients });

  return {
    // Each rendered row carries the code that person was given, so the caller
    // can store it beside the message. Without that stored code a redeemed
    // coupon can never be joined back to the campaign that sent it, and the
    // single strongest attribution signal in the system stays unusable.
    rendered: outcome.rendered.map(row => ({ ...row, couponCode: codes.get(row.phone) || null })),
    excluded: outcome.excluded,
    reasons: outcome.reasons,
    // With a shared code this is 1 coupon covering `codes.size` people, which
    // is a different number from the per-person case and is reported as such
    // rather than quietly meaning something else.
    couponsIssued: sharedOutcome ? 1 : codes.size,
    sharedCode: sharedOutcome
      ? { code: sharedOutcome.code, restrictedTo: sharedOutcome.restrictedTo,
          withoutEmail: sharedOutcome.withoutEmail.length }
      : null,
    couponFailures: [...couponFailures.entries()].map(([code, error]) => ({ code, error })),
    dryRun: dryRun === true
  };
}

module.exports = {
  issueSharedCode,
  COUPON_PREFIX,
  DEFAULT_COUPON_DAYS,
  PersonalisationError,
  factsForBuyer,
  gatherFacts,
  issueCodes,
  itemsByValue,
  personaliseCampaign,
  skuToParentName
};
