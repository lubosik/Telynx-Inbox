'use strict';
/**
 * "Back in stock, and nearly due to reorder".
 *
 * Two signals that are weak on their own and strong together. These tests care
 * about three things and in this order:
 *
 *   1. BOTH halves are required, and neither one is allowed to soften the
 *      other. In particular the restock must not become a reason to read
 *      somebody's timing more generously, because that is exactly the
 *      loosening the owner declined.
 *   2. A first sighting of stock is still not a restock. The existing
 *      assertion in back-in-stock.js is reused rather than re-stated, and
 *      these fail if somebody weakens it.
 *   3. The evidence carries both halves and keeps them apart: the stock is the
 *      stated reason, the timing is only the audience, and every row says so.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSegmentationInput } = require('../lib/campaigns/generation-service');
const { catalogueEntries, catalogueInventoryRows } = require('../lib/campaigns/product-catalogue');
const { calculateReorderCadence } = require('../lib/campaigns/reorder-cadence');
const {
  RESTOCK_REORDER_COPY_BASIS,
  describeRestockReorderEmptiness,
  gapText,
  restockReorderPairs
} = require('../lib/campaigns/restock-reorder');
const {
  computeSegmentMembers,
  segmentDefinition
} = require('../lib/campaigns/segment-definitions');

const DAY = 86400000;
const NOW = new Date('2026-08-26T12:00:00.000Z');
const PHONE = '+15555550123';
const OTHER = '+15555550999';

/** `count` orders `gap` days apart, the most recent one `sinceDays` ago. */
function purchases(count, gap, sinceDays) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const back = sinceDays + (count - 1 - index) * gap;
    rows.push({ status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - back * DAY).toISOString() });
  }
  return rows;
}

/** 54 days since the last of four orders 56 days apart: nearly due, not due. */
function nearlyDue(phone, options = {}) {
  return {
    phone,
    contactID: 11,
    productID: 900,
    variationID: 0,
    productName: 'GHK-Cu',
    productAvailable: true,
    alreadyContactedForLastPurchase: false,
    productCadence: { intervals: [], uniqueCustomers: 0 },
    purchases: purchases(4, 56, 54),
    ...options
  };
}

function returned(phone, options = {}) {
  return {
    id: 77,
    phone,
    contactID: 11,
    productID: 900,
    variationID: 0,
    productName: 'GHK-Cu',
    deliveryID: 'woo-77',
    previous: { productID: 900, variationID: 0, stockStatus: 'outofstock', stockQuantity: 0 },
    observed: { productID: 900, variationID: 0, stockStatus: 'instock', stockQuantity: 40 },
    observedAt: '2026-08-22T09:00:00.000Z',
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    currentlyInStock: true,
    repeatBuyer: true,
    ...options
  };
}

function members(input, now = NOW) {
  return computeSegmentMembers('back_in_stock_nearly_due', input, { now });
}

// ── both halves, and neither one on its own ─────────────────────────────────

test('one signal is not enough, and the two together are', () => {
  const timing = nearlyDue(PHONE);
  const stock = returned(PHONE);

  assert.deepEqual(members({ reorderCandidates: [timing] }), [],
    'nearly due on its own is a guess about consumption and is not this segment');
  assert.deepEqual(members({ backInStockCandidates: [stock] }), [],
    'a restock on its own is untargeted and is not this segment');

  const both = members({ reorderCandidates: [timing], backInStockCandidates: [stock] });
  assert.deepEqual(both.map(row => row.contactPhone), [PHONE]);
});

test('a first sighting of stock is not a restock, and no pairing rescues it', () => {
  const timing = nearlyDue(PHONE);
  const firstSighting = returned(PHONE, {
    // Nothing is known about what came before, which is what an unseeded
    // inventory looks like. It is not evidence that anything came back.
    previous: { productID: 900, variationID: 0, stockStatus: null, stockQuantity: null }
  });
  assert.deepEqual(
    members({ reorderCandidates: [timing], backInStockCandidates: [firstSighting] }), []
  );

  const neverLeft = returned(PHONE, {
    previous: { productID: 900, variationID: 0, stockStatus: 'instock', stockQuantity: 12 }
  });
  assert.deepEqual(
    members({ reorderCandidates: [timing], backInStockCandidates: [neverLeft] }), []
  );

  const unsigned = returned(PHONE, { webhookTrusted: false });
  assert.deepEqual(
    members({ reorderCandidates: [timing], backInStockCandidates: [unsigned] }), []
  );
});

test('the stated reason has to still be true when the list is read', () => {
  const timing = nearlyDue(PHONE);
  assert.deepEqual(
    members({
      reorderCandidates: [timing],
      backInStockCandidates: [returned(PHONE, { currentlyInStock: false })]
    }), [], 'it came back and went out again, so there is nothing to say');

  const { diagnostics } = restockReorderPairs({
    reorderCandidates: [timing],
    backInStockCandidates: [returned(PHONE, { currentlyInStock: undefined })]
  }, { now: NOW });
  assert.equal(diagnostics.transitionRejections.current_stock_unknown, 1,
    'unknown is refused rather than assumed to be good news');
});

// ── the bar did not move ────────────────────────────────────────────────────

/**
 * The whole argument for this segment is that the restock carries the reason
 * for the message. It does NOT carry a reason to read somebody's timing more
 * generously, and these are the tests that stop it quietly doing so.
 */
test('the timing half is exactly the timing half of "Nearly due to reorder"', () => {
  const notDue = nearlyDue('+15550000002', { purchases: purchases(4, 56, 5) });
  const due = nearlyDue('+15550000003', { purchases: purchases(4, 56, 58) });
  const approaching = nearlyDue('+15550000004');
  const reorderCandidates = [notDue, due, approaching];
  const backInStockCandidates = reorderCandidates.map(candidate => returned(candidate.phone));

  const paired = members({ reorderCandidates, backInStockCandidates })
    .map(row => row.contactPhone);
  const nearly = computeSegmentMembers('reorder_approaching', { reorderCandidates }, { now: NOW })
    .map(row => row.contactPhone);

  assert.deepEqual(paired, ['+15550000004']);
  for (const phone of paired) {
    assert.ok(nearly.includes(phone), `${phone} is in the pairing but not in "Nearly due to reorder"`);
  }
  assert.ok(paired.length <= nearly.length, 'the pairing is a subset, never a widening');
});

test('a history too uneven to read stays unreadable when the product comes back', () => {
  // Four orders at 56, 10, 96 and 40 days apart: reliably nothing.
  const jumpy = nearlyDue(PHONE, {
    purchases: [
      { status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString() },
      { status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - 144 * DAY).toISOString() },
      { status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - 134 * DAY).toISOString() },
      { status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - 38 * DAY).toISOString() }
    ]
  });
  const direct = calculateReorderCadence({
    purchases: jumpy.purchases, productCadence: jumpy.productCadence, now: NOW
  });
  assert.equal(direct.state, 'no_reliable_cadence', 'the fixture must actually be unreadable');
  assert.deepEqual(
    members({ reorderCandidates: [jumpy], backInStockCandidates: [returned(PHONE)] }), [],
    'the restock is a reason to write, never a reason to guess at timing'
  );
});

test('somebody already due is left to the list that already holds them', () => {
  const overdue = nearlyDue(PHONE, { purchases: purchases(4, 56, 90) });
  assert.equal(calculateReorderCadence({
    purchases: overdue.purchases, productCadence: overdue.productCadence, now: NOW
  }).state, 'overdue');
  assert.deepEqual(
    members({ reorderCandidates: [overdue], backInStockCandidates: [returned(PHONE)] }), [],
    'they are in "Due to reorder, everyone due" and two lists means two messages'
  );
});

// ── the evidence ────────────────────────────────────────────────────────────

test('a member row carries both halves and says which one the message is about', () => {
  const [member] = members({
    reorderCandidates: [nearlyDue(PHONE)],
    backInStockCandidates: [returned(PHONE)]
  });
  const evidence = member.inclusionEvidence;

  assert.equal(evidence.detector, 'back_in_stock');
  assert.equal(evidence.segmentKey, 'back_in_stock_nearly_due');

  // The half a message may be about.
  assert.equal(evidence.statedReason, 'product_back_in_stock');
  assert.equal(evidence.restockObservedAt, '2026-08-22T09:00:00.000Z');
  assert.equal(evidence.restockedProductID, 900);
  assert.equal(evidence.earlierReturnsSeen, 0);

  // The half that only chose the audience.
  assert.equal(evidence.timingUse, 'selection_only');
  assert.equal(evidence.state, 'approaching');
  assert.equal(evidence.medianIntervalDays, 56);
  assert.equal(evidence.intervalsObserved, 3);
  assert.equal(evidence.cadenceSource, 'personal');
  assert.equal(evidence.lastOrderAt, new Date(NOW.getTime() - 54 * DAY).toISOString());

  // And the rule that keeps them apart travels on the row itself.
  assert.equal(evidence.copyBasis, RESTOCK_REORDER_COPY_BASIS);
  assert.match(evidence.copyBasis, /back in stock/i);
  assert.match(evidence.copyBasis, /running low/i);
});

test('the evidence reads as a sentence somebody can say out loud', () => {
  const [member] = members({
    reorderCandidates: [nearlyDue(PHONE)],
    backInStockCandidates: [returned(PHONE)]
  });
  assert.equal(
    member.inclusionEvidence.summary,
    'Their GHK-Cu came back in stock on 22 August 2026. They last ordered it on 3 July 2026, '
      + 'and they usually reorder around every 8 weeks.'
  );
});

test('a borrowed pattern is never described as this person is own', () => {
  // Two personal intervals is below the floor, so the product-level pattern is
  // used. It is somebody else's number and the sentence has to admit that.
  const borrowed = nearlyDue(PHONE, {
    purchases: purchases(2, 56, 54),
    productCadence: { intervals: Array(24).fill(56), uniqueCustomers: 14 }
  });
  const [member] = members({
    reorderCandidates: [borrowed],
    backInStockCandidates: [returned(PHONE)]
  });
  assert.equal(member.inclusionEvidence.cadenceSource, 'product');
  assert.match(member.inclusionEvidence.summary, /other customers/);
  assert.doesNotMatch(member.inclusionEvidence.summary, /they usually reorder/);
});

test('the gap is said in the unit a person would use', () => {
  assert.equal(gapText(56), 'every 8 weeks');
  assert.equal(gapText(59), 'every 8 weeks');
  assert.equal(gapText(7), 'every 7 days');
  assert.equal(gapText(0), null);
  assert.equal(gapText(null), null);
});

// ── the awkward cases ───────────────────────────────────────────────────────

test('somebody who has ordered it again since it came back is left out', () => {
  // A weekly pattern with the most recent order four days ago, which is three
  // hours AFTER the return was observed. Still nearly due, and still nothing
  // to tell them.
  const boughtSince = nearlyDue(PHONE, { purchases: purchases(4, 7, 4) });
  const result = calculateReorderCadence({
    purchases: boughtSince.purchases, productCadence: boughtSince.productCadence, now: NOW
  });
  assert.equal(result.state, 'approaching', 'the timing half must actually pass');
  assert.ok(Date.parse(result.lastPurchaseAt) > Date.parse('2026-08-22T09:00:00.000Z'),
    'the fixture must actually order after the return');

  const input = { reorderCandidates: [boughtSince], backInStockCandidates: [returned(PHONE)] };
  assert.deepEqual(members(input), [],
    'the news is not news to somebody who has already acted on it');

  const { diagnostics } = restockReorderPairs(input, { now: NOW });
  assert.equal(diagnostics.orderedSinceTheReturn, 1);
  assert.equal(describeRestockReorderEmptiness(diagnostics).code, 'already_ordered_again');
});

test('a product that goes out and back twice is one thing to say, not two', () => {
  const first = returned(PHONE, { id: 77, observedAt: '2026-08-19T09:00:00.000Z' });
  const second = returned(PHONE, { id: 78, observedAt: '2026-08-22T09:00:00.000Z' });
  const found = members({
    reorderCandidates: [nearlyDue(PHONE)],
    backInStockCandidates: [second, first]
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].inclusionEvidence.restockObservedAt, '2026-08-22T09:00:00.000Z',
    'the most recent return is the current fact');
  assert.equal(found[0].inclusionEvidence.earlierReturnsSeen, 1);
  assert.match(found[0].inclusionEvidence.summary, /come back more than once/);
});

test('one person on two returned products is one member with the extra counted', () => {
  const found = members({
    reorderCandidates: [nearlyDue(PHONE), nearlyDue(PHONE, { productID: 901, productName: 'BPC-157' })],
    backInStockCandidates: [
      returned(PHONE, { id: 77 }),
      returned(PHONE, {
        id: 78, productID: 901, productName: 'BPC-157',
        previous: { productID: 901, variationID: 0, stockStatus: 'outofstock', stockQuantity: 0 },
        observed: { productID: 901, variationID: 0, stockStatus: 'instock', stockQuantity: 9 }
      })
    ]
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].inclusionEvidence.additionalMatches, 1);
  assert.equal(found[0].inclusionEvidence.restockedProductID, 900, 'deterministic, not whichever came first');
});

test('the same input at the same instant always produces the same rows', () => {
  const input = {
    reorderCandidates: [nearlyDue(OTHER), nearlyDue(PHONE)],
    backInStockCandidates: [returned(OTHER), returned(PHONE)]
  };
  assert.deepEqual(members(input), members(input));
  assert.deepEqual(members(input).map(row => row.contactPhone), [PHONE, OTHER].sort());
});

// ── an empty inventory is a true answer, not a fault ────────────────────────

test('an empty inventory yields an empty list and says which thing is missing', () => {
  const timing = [nearlyDue(PHONE)];

  const nothingRecorded = restockReorderPairs({ reorderCandidates: timing }, { now: NOW });
  assert.deepEqual(nothingRecorded.pairs, []);
  assert.equal(describeRestockReorderEmptiness(nothingRecorded.diagnostics).code,
    'no_stock_change_recorded');
  assert.match(describeRestockReorderEmptiness(nothingRecorded.diagnostics).sentence,
    /has always been in stock has not returned/);

  const notAReturn = restockReorderPairs({
    reorderCandidates: timing,
    backInStockCandidates: [returned(PHONE, {
      previous: { productID: 900, variationID: 0, stockStatus: 'instock', stockQuantity: 3 }
    })]
  }, { now: NOW });
  assert.equal(describeRestockReorderEmptiness(notAReturn.diagnostics).code, 'no_genuine_return');

  const noPattern = restockReorderPairs({
    reorderCandidates: [], backInStockCandidates: [returned(PHONE)]
  }, { now: NOW });
  assert.equal(noPattern.diagnostics.noReorderCandidateForBuyer, 1);
  assert.equal(describeRestockReorderEmptiness(noPattern.diagnostics).code, 'no_readable_pattern');

  const tooEarly = restockReorderPairs({
    reorderCandidates: [nearlyDue(PHONE, { purchases: purchases(4, 56, 5) })],
    backInStockCandidates: [returned(PHONE)]
  }, { now: NOW });
  assert.equal(describeRestockReorderEmptiness(tooEarly.diagnostics).code,
    'nobody_near_their_next_order');

  assert.equal(describeRestockReorderEmptiness({ pairs: 1 }).code, 'not_empty');
});

test('an invalid now is refused rather than producing a segment of everybody', () => {
  assert.throws(
    () => members({ reorderCandidates: [], backInStockCandidates: [] }, 'not a date'),
    /now must be a valid date/
  );
});

// ── end to end, through the real engine input ───────────────────────────────

const RT = {
  id: 551, sku: 'P-RT10', name: 'RT', type: 'variable', status: 'publish',
  purchasable: true, stock_status: 'instock', stock_quantity: 251, manage_stock: true
};
const RT_VARIATIONS = [
  { id: 566, sku: 'RT10', name: '10mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 158, manage_stock: true, attributes: [{ option: '10mg' }] },
  { id: 568, sku: 'RT30', name: '30mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 58, manage_stock: true, attributes: [{ option: '30mg' }] }
];
const ENTRIES = catalogueEntries(RT, RT_VARIATIONS);
const INVENTORY = catalogueInventoryRows(
  { fetchedAt: '2026-08-26T11:59:00Z', entries: ENTRIES }, { now: NOW }
);

function order(id, phone, createdAt, sku, name) {
  return {
    id, woo_order_id: id, contact_phone: phone, status: 'completed', created_at: createdAt,
    total: 195, items: [{ sku, name, quantity: 1, total: '195.00' }]
  };
}

/** Four RT purchases 56 days apart, the last of them 54 days ago. */
function rtHistory(phone, sku, name) {
  return purchases(4, 56, 54).map((row, index) =>
    order(index + 1, phone, row.createdAt, sku, name));
}

function engineSources(orders, restockEvents) {
  return {
    orders,
    contacts: [{ id: 5, phone: PHONE }, { id: 6, phone: OTHER }],
    inventory: [],
    catalogueEntries: ENTRIES,
    catalogueInventory: INVENTORY,
    catalogueAvailable: true,
    restockEvents,
    opportunities: [],
    ledger: [],
    suppressions: [],
    support: [],
    supportAvailable: false
  };
}

const RT30_RETURNED = {
  id: 91, product_id: 551, variation_id: 568, name: 'RT', delivery_id: 'woo-91',
  previous_stock_status: 'outofstock', current_stock_status: 'instock',
  previous_quantity: 0, current_quantity: 58,
  received_at: '2026-08-22T09:00:00.000Z', signature_valid: true
};

test('a vial coming back reaches the buyers of that vial and nobody else', () => {
  const input = buildSegmentationInput(engineSources([
    ...rtHistory(PHONE, 'RT30', 'Retatrutide - 30mg'),
    ...rtHistory(OTHER, 'RT10', 'RT - 10mg')
  ], [RT30_RETURNED]), { now: NOW });

  assert.equal(input.backInStockCandidates.length, 1, 'the 10mg buyer is not a buyer of the 30mg');
  assert.equal(input.backInStockCandidates[0].currentlyInStock, true);

  const found = members(input);
  assert.deepEqual(found.map(row => row.contactPhone), [PHONE]);
  assert.equal(found[0].inclusionEvidence.restockedVariationID, 568);
  assert.match(found[0].inclusionEvidence.summary, /came back in stock on 22 August 2026/);

  // Membership is behaviour. Nobody here has support clearance on record and
  // that is reported on the row rather than used to hide them.
  assert.equal(found[0].commercialClearance.clear, false);
});

test('the timing spans the vial sizes even though the stock claim does not', () => {
  // Titration: three 10mg orders and then a 30mg. One reorder series on the
  // parent, and the 30mg is what came back.
  const history = purchases(4, 56, 54).map((row, index) => index === 3
    ? order(4, PHONE, row.createdAt, 'RT30', 'Retatrutide - 30mg')
    : order(index + 1, PHONE, row.createdAt, 'RT10', 'RT - 10mg'));
  const input = buildSegmentationInput(engineSources(history, [RT30_RETURNED]), { now: NOW });

  const [member] = members(input);
  assert.equal(member.inclusionEvidence.intervalsObserved, 3,
    'splitting the series by vial would leave nothing to read');
  assert.equal(member.inclusionEvidence.restockedVariationID, 568);
});

test('current stock alone, with no recorded change, puts nobody in the list', () => {
  const input = buildSegmentationInput(
    engineSources(rtHistory(PHONE, 'RT30', 'Retatrutide - 30mg'), []), { now: NOW }
  );
  assert.ok(input.sourceCoverage.inventory > 0, 'stock is known');
  assert.equal(input.sourceCoverage.restockEvents, 0, 'but nothing came back');
  assert.deepEqual(members(input), []);

  const { diagnostics } = restockReorderPairs(input, { now: NOW });
  assert.equal(describeRestockReorderEmptiness(diagnostics).code, 'no_stock_change_recorded');
});

test('the catalogue entry describes the group and hands over the copy rule', () => {
  const definition = segmentDefinition('back_in_stock_nearly_due');
  assert.equal(definition.detector, 'back_in_stock');
  assert.ok(definition.description.includes('Nearly due to reorder'),
    'it has to name the list it is carved out of');
  assert.match(definition.description, /only thing the message may be about/);
  assert.match(definition.description, /Do not put that in the message/);
});
