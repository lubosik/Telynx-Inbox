'use strict';
/**
 * "Back in stock, everyone else who bought it".
 *
 * The restock with no timing attached. These tests care about four things and
 * in this order:
 *
 *   1. THE TWO BACK-IN-STOCK SEGMENTS ARE DISJOINT. That was the owner's actual
 *      requirement and it is the first test in the file. It runs against a
 *      fixture that deliberately contains people in every state, including
 *      people who are in the pairing, so nesting the two would fail loudly
 *      rather than quietly producing two texts about one restock.
 *   2. A restock needs NO cadence, and the people with none are the point of
 *      the list rather than an accident in it.
 *   3. Not one of the restock assertions softened. A first sighting of stock is
 *      still not a restock, and it matters more here than in the pairing,
 *      because there is no second signal to reduce a wrong claim to a mistimed
 *      one.
 *   4. Every row says WHY this person is not in the better timed list, so a
 *      reader is never left wondering whether they were missed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSegmentationInput } = require('../lib/campaigns/generation-service');
const { catalogueEntries, catalogueInventoryRows } = require('../lib/campaigns/product-catalogue');
const { calculateReorderCadence } = require('../lib/campaigns/reorder-cadence');
const {
  describeRestockOnlyEmptiness,
  restockOnlyRows,
  timingReadFor
} = require('../lib/campaigns/restock-only');
const {
  RESTOCK_REORDER_COPY_BASIS,
  restockReorderPairs
} = require('../lib/campaigns/restock-reorder');
const {
  computeSegmentMembers,
  segmentDefinition
} = require('../lib/campaigns/segment-definitions');

const DAY = 86400000;
const NOW = new Date('2026-08-26T12:00:00.000Z');
const RETURNED_AT = '2026-08-22T09:00:00.000Z';

const NEARLY = '+15555550001';
const DUE = '+15555550002';
const UNREADABLE = '+15555550003';
const EARLY = '+15555550004';
const ONE_PURCHASE = '+15555550005';

/** `count` orders `gap` days apart, the most recent one `sinceDays` ago. */
function purchases(count, gap, sinceDays) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const back = sinceDays + (count - 1 - index) * gap;
    rows.push({ status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - back * DAY).toISOString() });
  }
  return rows;
}

function reorder(phone, options = {}) {
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

/**
 * A genuine return of product 900, with the buying facts the restock candidate
 * now carries. `lastPurchaseAt` is about THE ITEM THAT CAME BACK, which is a
 * different question from the parent-level reorder series.
 */
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
    observedAt: RETURNED_AT,
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    currentlyInStock: true,
    purchaseCount: 4,
    lastPurchaseAt: new Date(NOW.getTime() - 54 * DAY).toISOString(),
    repeatBuyer: true,
    ...options
  };
}

function members(input, now = NOW) {
  return computeSegmentMembers('back_in_stock_other_buyers', input, { now });
}

function paired(input, now = NOW) {
  return computeSegmentMembers('back_in_stock_nearly_due', input, { now });
}

/**
 * Four people, one returned product, and one of every timing state that
 * matters:
 *
 *   NEARLY      54 days into a 56 day rhythm: `approaching`, so the pairing
 *               holds them and this list must not.
 *   DUE         90 days into a 56 day rhythm: `overdue`, so "Due to reorder,
 *               everyone due" holds them and this list must not.
 *   UNREADABLE  gaps of 56, 10, 96 and 40 days: `no_reliable_cadence`. Nothing
 *               holds them, and they are what this list is for.
 *   EARLY       5 days into a 56 day rhythm: `not_due`. Nothing holds them
 *               either, and they stay, which is the argument the module header
 *               makes at length.
 *   ONE_PURCHASE bought it once and has no reorder candidate at all. Most of
 *               this customer base looks like this.
 */
function everyState() {
  const unreadablePurchases = [200, 144, 134, 38].map(back => ({
    status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - back * DAY).toISOString()
  }));
  return {
    reorderCandidates: [
      reorder(NEARLY),
      reorder(DUE, { purchases: purchases(4, 56, 90) }),
      reorder(UNREADABLE, { purchases: unreadablePurchases }),
      reorder(EARLY, { purchases: purchases(4, 56, 5) })
    ],
    backInStockCandidates: [
      returned(NEARLY),
      returned(DUE, { lastPurchaseAt: new Date(NOW.getTime() - 90 * DAY).toISOString() }),
      returned(UNREADABLE, { lastPurchaseAt: new Date(NOW.getTime() - 38 * DAY).toISOString() }),
      returned(EARLY, { lastPurchaseAt: new Date(NOW.getTime() - 5 * DAY).toISOString() }),
      returned(ONE_PURCHASE, {
        purchaseCount: 1,
        lastPurchaseAt: new Date(NOW.getTime() - 300 * DAY).toISOString()
      })
    ]
  };
}

// ── the owner's requirement, first ──────────────────────────────────────────

/**
 * THE TEST THE SEGMENT EXISTS TO SATISFY.
 *
 * "These should be actively different segments that people can be a part of.
 * If we're repeating any of the ones, then yeah, there's no point."
 *
 * A future edit that nests one inside the other fails here rather than in
 * somebody's inbox.
 */
test('the two back-in-stock segments never hold the same person', () => {
  const input = everyState();

  const untimed = members(input).map(row => row.contactPhone);
  const timed = paired(input).map(row => row.contactPhone);

  // The fixture has to actually exercise the overlap it is guarding against.
  // A disjointness test against two empty lists proves nothing.
  assert.ok(timed.length > 0, 'the fixture must put somebody in the nearly due list');
  assert.ok(untimed.length > 0, 'the fixture must put somebody in the untimed list');
  assert.deepEqual(timed, [NEARLY]);

  const overlap = untimed.filter(phone => timed.includes(phone));
  assert.deepEqual(overlap, [], `${overlap.join(', ')} is in both back-in-stock lists`);

  // And the person the better timed list holds is genuinely gone from here,
  // rather than merely sorted to the end of it.
  assert.ok(!untimed.includes(NEARLY));
});

/**
 * Disjointness at the PERSON level, not the person-and-product level.
 *
 * Somebody nearly due on one returned product and unreadable on another
 * returned product is two true facts and still two texts about restocks in one
 * recompute. The pairing is the better timed list, so it wins the person
 * outright and this one lets them go.
 */
test('being in the pairing on one product removes the person from this list entirely', () => {
  const input = {
    reorderCandidates: [
      reorder(NEARLY),
      reorder(NEARLY, { productID: 901, productName: 'BPC-157', purchases: purchases(4, 56, 5) })
    ],
    backInStockCandidates: [
      returned(NEARLY),
      returned(NEARLY, {
        id: 78, productID: 901, productName: 'BPC-157',
        previous: { productID: 901, variationID: 0, stockStatus: 'outofstock', stockQuantity: 0 },
        observed: { productID: 901, variationID: 0, stockStatus: 'instock', stockQuantity: 9 },
        lastPurchaseAt: new Date(NOW.getTime() - 5 * DAY).toISOString()
      })
    ]
  };
  assert.deepEqual(paired(input).map(row => row.contactPhone), [NEARLY]);
  assert.deepEqual(members(input), [], 'one person, one list, even across two returned products');

  const { diagnostics } = restockOnlyRows(input, { now: NOW });
  assert.equal(diagnostics.heldByNearlyDue, 2);
});

/**
 * The subtraction is done by CALLING the pairing, not by re-stating its rule.
 * That is what stops the two drifting apart and re-overlapping later, so it is
 * worth asserting directly rather than only through membership.
 */
test('whoever the pairing returns is exactly who is removed', () => {
  const input = everyState();
  const pairingPhones = restockReorderPairs(input, { now: NOW }).pairs.map(pair => pair.phone);
  const untimed = members(input).map(row => row.contactPhone);
  for (const phone of pairingPhones) {
    assert.ok(!untimed.includes(phone), `${phone} came back from the pairing and was not removed`);
  }
});

// ── a restock needs no timing, and that is the whole point ──────────────────

test('a restock on its own is enough here, and a pattern is not required', () => {
  const input = everyState();
  assert.deepEqual(members(input).map(row => row.contactPhone),
    [UNREADABLE, EARLY, ONE_PURCHASE].sort());
});

test('somebody with one purchase and no reorder candidate is a member', () => {
  const input = {
    reorderCandidates: [],
    backInStockCandidates: [returned(ONE_PURCHASE, {
      purchaseCount: 1, lastPurchaseAt: new Date(NOW.getTime() - 300 * DAY).toISOString()
    })]
  };
  const [member] = members(input);
  assert.equal(member.contactPhone, ONE_PURCHASE);
  assert.equal(member.inclusionEvidence.timingRead, 'none');
  assert.equal(member.inclusionEvidence.timingState, null);
});

test('an unreadable history is held here rather than refused', () => {
  const input = everyState();
  const unreadable = calculateReorderCadence({
    purchases: input.reorderCandidates[2].purchases,
    productCadence: input.reorderCandidates[2].productCadence,
    now: NOW
  });
  assert.equal(unreadable.state, 'no_reliable_cadence', 'the fixture must actually be unreadable');
  assert.ok(members(input).some(row => row.contactPhone === UNREADABLE));
});

/**
 * The argument in the module header, as a test. Excluding `approaching`, `due`
 * and `overdue` is de-duplication against lists that exist. Excluding `not_due`
 * would be a timing rule inside a segment whose justification is that a restock
 * needs no timing, and it would smuggle "they bought recently so they do not
 * need to hear this" back in, which is a claim about their supply.
 */
test('somebody who is simply a long way from buying again stays in', () => {
  const input = everyState();
  const early = calculateReorderCadence({
    purchases: input.reorderCandidates[3].purchases,
    productCadence: input.reorderCandidates[3].productCadence,
    now: NOW
  });
  assert.equal(early.state, 'not_due', 'the fixture must actually be readable and far off');

  const [member] = members(input).filter(row => row.contactPhone === EARLY);
  assert.equal(member.inclusionEvidence.timingRead, 'not_near');
  assert.equal(member.inclusionEvidence.timingState, 'not_due');
});

// ── the people other lists already hold ─────────────────────────────────────

test('due and overdue are left to "Due to reorder, everyone due"', () => {
  const input = everyState();
  const overdue = calculateReorderCadence({
    purchases: input.reorderCandidates[1].purchases,
    productCadence: input.reorderCandidates[1].productCadence,
    now: NOW
  });
  assert.equal(overdue.state, 'overdue');
  assert.ok(computeSegmentMembers('reorder_due', input, { now: NOW })
    .some(row => row.contactPhone === DUE), 'the other list must actually hold them');
  assert.ok(!members(input).some(row => row.contactPhone === DUE));

  const { diagnostics } = restockOnlyRows(input, { now: NOW });
  assert.equal(diagnostics.heldByDueToReorder, 1);
});

/**
 * `approaching` is excluded on the state as well as by the person-level
 * subtraction, and the two are not the same rule. The pairing applies filters
 * after the state test, so somebody can be `approaching` and still not come
 * back from it. They must not land here either: this list's evidence row would
 * then claim we cannot time a person we plainly can.
 */
test('approaching is refused on the state, not only by subtracting the pairing', () => {
  // Nearly due on the parent, and they have already re-bought the parent's
  // other vial since the return, which is a filter the pairing applies after
  // its own state test.
  // A weekly rhythm whose most recent order landed one hour AFTER the return
  // was observed. Still `approaching` today, and still nothing to tell them.
  const timing = reorder(NEARLY, {
    purchases: [
      '2026-08-01T10:00:00.000Z', '2026-08-08T10:00:00.000Z',
      '2026-08-15T10:00:00.000Z', '2026-08-22T10:00:00.000Z'
    ].map(createdAt => ({ status: 'completed', total: 100, createdAt }))
  });
  const state = calculateReorderCadence({
    purchases: timing.purchases, productCadence: timing.productCadence, now: NOW
  });
  assert.equal(state.state, 'approaching', 'the fixture must still read as approaching');
  assert.ok(Date.parse(state.lastPurchaseAt) > Date.parse(RETURNED_AT));

  const input = {
    reorderCandidates: [timing],
    // They never re-bought the vial that came back, so the item-level guard
    // below does not remove them. Only the state test does.
    backInStockCandidates: [returned(NEARLY, {
      lastPurchaseAt: new Date(NOW.getTime() - 100 * DAY).toISOString()
    })]
  };
  assert.deepEqual(paired(input), [], 'the pairing drops them for its own reason');
  assert.deepEqual(members(input), [], 'and they still do not fall through to here');
});

// ── nothing about a restock was softened ────────────────────────────────────

test('a first sighting of stock is still not a restock', () => {
  const timing = { reorderCandidates: [] };
  const firstSighting = returned(ONE_PURCHASE, {
    previous: { productID: 900, variationID: 0, stockStatus: null, stockQuantity: null }
  });
  assert.deepEqual(members({ ...timing, backInStockCandidates: [firstSighting] }), []);

  const neverLeft = returned(ONE_PURCHASE, {
    previous: { productID: 900, variationID: 0, stockStatus: 'instock', stockQuantity: 12 }
  });
  assert.deepEqual(members({ ...timing, backInStockCandidates: [neverLeft] }), []);

  const unsigned = returned(ONE_PURCHASE, { webhookTrusted: false });
  assert.deepEqual(members({ ...timing, backInStockCandidates: [unsigned] }), []);
});

test('the stated reason has to still be true when the list is read', () => {
  assert.deepEqual(
    members({ backInStockCandidates: [returned(ONE_PURCHASE, { currentlyInStock: false })] }), [],
    'it came back and went out again, so there is nothing to say');

  const { diagnostics } = restockOnlyRows({
    backInStockCandidates: [returned(ONE_PURCHASE, { currentlyInStock: undefined })]
  }, { now: NOW });
  assert.equal(diagnostics.transitionRejections.current_stock_unknown, 1,
    'unknown is refused rather than assumed to be good news');
});

/**
 * Checked against the EXACT item that came back, from the restock candidate,
 * rather than against the parent reorder series. Somebody who bought a
 * different vial of the same molecule has not bought the vial that returned.
 */
test('somebody who has re-bought the returned item since it returned is left out', () => {
  const boughtSince = returned(ONE_PURCHASE, {
    purchaseCount: 2, lastPurchaseAt: '2026-08-24T09:00:00.000Z'
  });
  const input = { backInStockCandidates: [boughtSince] };
  assert.deepEqual(members(input), [], 'the news is not news to somebody who has already acted');

  const { diagnostics } = restockOnlyRows(input, { now: NOW });
  assert.equal(diagnostics.orderedSinceTheReturn, 1);
  assert.equal(describeRestockOnlyEmptiness(diagnostics).code, 'already_ordered_again');
});

test('buying a different vial of the same product does not remove them', () => {
  // The 30mg came back. They have since bought the 10mg, which moves the
  // parent series past the return but says nothing about the 30mg.
  const timing = reorder(ONE_PURCHASE, {
    purchases: [...purchases(3, 56, 120), { status: 'completed', total: 100, createdAt: '2026-08-24T09:00:00.000Z' }]
  });
  const input = {
    reorderCandidates: [timing],
    backInStockCandidates: [returned(ONE_PURCHASE, {
      variationID: 568,
      previous: { productID: 900, variationID: 568, stockStatus: 'outofstock', stockQuantity: 0 },
      observed: { productID: 900, variationID: 568, stockStatus: 'instock', stockQuantity: 40 },
      purchaseCount: 1,
      lastPurchaseAt: new Date(NOW.getTime() - 120 * DAY).toISOString()
    })]
  };
  const found = members(input);
  assert.deepEqual(found.map(row => row.contactPhone), [ONE_PURCHASE]);
  assert.equal(found[0].inclusionEvidence.restockedVariationID, 568);
});

// ── the evidence ────────────────────────────────────────────────────────────

test('a member row carries what returned, when, when they bought it, and no timing', () => {
  const [member] = members({
    backInStockCandidates: [returned(ONE_PURCHASE, {
      purchaseCount: 1, lastPurchaseAt: '2026-07-03T12:00:00.000Z'
    })]
  });
  const evidence = member.inclusionEvidence;

  assert.equal(evidence.detector, 'back_in_stock');
  assert.equal(evidence.segmentKey, 'back_in_stock_other_buyers');

  // What came back, and when.
  assert.equal(evidence.statedReason, 'product_back_in_stock');
  assert.equal(evidence.restockObservedAt, RETURNED_AT);
  assert.equal(evidence.restockedProductID, 900);
  assert.equal(evidence.productName, 'GHK-Cu');
  assert.equal(evidence.earlierReturnsSeen, 0);

  // When they last bought THAT item, and how often.
  assert.equal(evidence.lastOrderAt, '2026-07-03T12:00:00.000Z');
  assert.equal(evidence.purchaseCount, 1);

  // And the explicit admission, so nobody has to wonder why this person is not
  // in the better timed list.
  assert.equal(evidence.timingUse, 'exclusion_only');
  assert.equal(evidence.timingRead, 'none');
  assert.equal(evidence.notInThisList, 'back_in_stock_nearly_due');

  // The copy rule is the pairing's, verbatim, because there is one permitted
  // message and two constants would be one thing too many to keep in step.
  assert.equal(evidence.copyBasis, RESTOCK_REORDER_COPY_BASIS);
  assert.match(evidence.copyBasis, /back in stock/i);
  assert.match(evidence.copyBasis, /running low/i);
});

test('the evidence reads as a sentence somebody can say out loud', () => {
  const [member] = members({
    backInStockCandidates: [returned(ONE_PURCHASE, {
      purchaseCount: 1, lastPurchaseAt: '2026-07-03T12:00:00.000Z'
    })]
  });
  assert.equal(
    member.inclusionEvidence.summary,
    'Their GHK-Cu came back in stock on 22 August 2026. They bought it once, on 3 July 2026. '
      + 'We cannot tell when they usually buy this again, so there is no way to say whether today '
      + 'is a good day for them. That is why they are here rather than in "Back in stock, and '
      + 'nearly due to reorder".'
  );
});

test('a repeat buyer is counted rather than described as a one off', () => {
  const [member] = members({
    backInStockCandidates: [returned(ONE_PURCHASE, {
      purchaseCount: 3, lastPurchaseAt: '2026-07-03T12:00:00.000Z'
    })]
  });
  assert.match(member.inclusionEvidence.summary,
    /They have bought it 3 times, most recently on 3 July 2026\./);
});

test('the sentence names the right reason for each kind of timing we have', () => {
  const [far] = members(everyState()).filter(row => row.contactPhone === EARLY);
  assert.match(far.inclusionEvidence.summary, /nowhere near it yet/);
  assert.match(far.inclusionEvidence.summary, /Back in stock, and nearly due to reorder/);

  const [none] = members(everyState()).filter(row => row.contactPhone === UNREADABLE);
  assert.match(none.inclusionEvidence.summary, /We cannot tell when they usually buy this again/);

  // Every read has a sentence. A missing branch would leave a member row
  // silently unable to explain itself.
  assert.equal(timingReadFor('not_due'), 'not_near');
  assert.equal(timingReadFor('suppressed'), 'not_computed');
  assert.equal(timingReadFor('contacted'), 'not_computed');
  assert.equal(timingReadFor('no_reliable_cadence'), 'none');
  assert.equal(timingReadFor(null), 'none');
});

/**
 * The compliance line, restated as a test because it is the one thing in this
 * feature that cannot be allowed to erode. Nothing on the row may read as a
 * claim about the person's supply, their body, or what they have left.
 */
test('no member row says anything about the person beyond our own records', () => {
  for (const member of members(everyState())) {
    const text = member.inclusionEvidence.summary;
    for (const banned of [/running low/i, /need(s)? more/i, /due for/i, /should reorder/i, /\bdose/i]) {
      assert.doesNotMatch(text, banned, `the summary must not say ${banned}`);
    }
  }
});

// ── the awkward cases ───────────────────────────────────────────────────────

test('a product that goes out and back twice is one thing to say, not two', () => {
  const first = returned(ONE_PURCHASE, { id: 77, observedAt: '2026-08-19T09:00:00.000Z' });
  const second = returned(ONE_PURCHASE, { id: 78, observedAt: RETURNED_AT });
  const found = members({ backInStockCandidates: [second, first] });
  assert.equal(found.length, 1);
  assert.equal(found[0].inclusionEvidence.restockObservedAt, RETURNED_AT,
    'the most recent return is the current fact');
  assert.equal(found[0].inclusionEvidence.earlierReturnsSeen, 1);
  assert.match(found[0].inclusionEvidence.summary, /come back more than once/);
});

test('one person on two returned products is one member with the extra counted', () => {
  const found = members({
    backInStockCandidates: [
      returned(ONE_PURCHASE, { id: 77 }),
      returned(ONE_PURCHASE, {
        id: 78, productID: 901, productName: 'BPC-157',
        previous: { productID: 901, variationID: 0, stockStatus: 'outofstock', stockQuantity: 0 },
        observed: { productID: 901, variationID: 0, stockStatus: 'instock', stockQuantity: 9 }
      })
    ]
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].inclusionEvidence.additionalMatches, 1);
  assert.equal(found[0].inclusionEvidence.restockedProductID, 900,
    'deterministic, not whichever came first');
});

test('the same input at the same instant always produces the same rows', () => {
  const input = everyState();
  assert.deepEqual(members(input), members(input));
  assert.deepEqual(members(input).map(row => row.contactPhone),
    [UNREADABLE, EARLY, ONE_PURCHASE].sort());
});

test('an invalid now is refused rather than producing a segment of everybody', () => {
  assert.throws(
    () => members({ backInStockCandidates: [] }, 'not a date'),
    /now must be a valid date/
  );
});

// ── an empty list is a true answer, not a fault ─────────────────────────────

test('an empty list says which of the reasons it is', () => {
  const nothingRecorded = restockOnlyRows({ reorderCandidates: [reorder(NEARLY)] }, { now: NOW });
  assert.deepEqual(nothingRecorded.rows, []);
  assert.equal(describeRestockOnlyEmptiness(nothingRecorded.diagnostics).code,
    'no_stock_change_recorded');
  assert.match(describeRestockOnlyEmptiness(nothingRecorded.diagnostics).sentence,
    /has always been in stock has not returned/);

  const notAReturn = restockOnlyRows({
    backInStockCandidates: [returned(ONE_PURCHASE, {
      previous: { productID: 900, variationID: 0, stockStatus: 'instock', stockQuantity: 3 }
    })]
  }, { now: NOW });
  assert.equal(describeRestockOnlyEmptiness(notAReturn.diagnostics).code, 'no_genuine_return');

  // The reason that is new here and worth saying plainly: the engine worked,
  // and everybody it found is already in a better timed list.
  const allBetterTimed = restockOnlyRows({
    reorderCandidates: [reorder(NEARLY), reorder(DUE, { purchases: purchases(4, 56, 90) })],
    backInStockCandidates: [returned(NEARLY), returned(DUE)]
  }, { now: NOW });
  assert.deepEqual(allBetterTimed.rows, []);
  assert.equal(describeRestockOnlyEmptiness(allBetterTimed.diagnostics).code,
    'everybody_is_in_a_better_timed_list');
  assert.match(describeRestockOnlyEmptiness(allBetterTimed.diagnostics).sentence,
    /writing to the same person twice/);

  // Nothing came back, versus something came back and nobody had bought it.
  // Both produce zero candidates and they are NOT the same answer: one sends a
  // reader looking for a missing inventory baseline and the other does not.
  const nothingAtAll = restockOnlyRows(
    { backInStockCandidates: [], sourceCoverage: { restockEvents: 0 } }, { now: NOW }
  );
  assert.equal(nothingAtAll.diagnostics.restockEventsRead, 0);
  assert.equal(describeRestockOnlyEmptiness(nothingAtAll.diagnostics).code,
    'no_stock_change_recorded');

  const nobodyBoughtIt = restockOnlyRows(
    { backInStockCandidates: [], sourceCoverage: { restockEvents: 3 } }, { now: NOW }
  );
  assert.equal(nobodyBoughtIt.diagnostics.restockCandidatesConsidered, 0);
  assert.equal(nobodyBoughtIt.diagnostics.restockEventsRead, 3);
  assert.equal(describeRestockOnlyEmptiness(nobodyBoughtIt.diagnostics).code,
    'nobody_bought_what_returned');

  // A fixture with no coverage block at all cannot tell the two apart, so it
  // gets the conservative answer rather than a guess.
  assert.equal(restockOnlyRows({ backInStockCandidates: [] }, { now: NOW })
    .diagnostics.restockEventsRead, null);

  assert.equal(describeRestockOnlyEmptiness({ rows: 1 }).code, 'not_empty');
});

test('the diagnostics describe the shape of the list, not just its size', () => {
  const { diagnostics } = restockOnlyRows(everyState(), { now: NOW });
  assert.equal(diagnostics.people, 3);
  assert.equal(diagnostics.rows, 3);
  assert.equal(diagnostics.genuineTransitionRows, 5);
  assert.equal(diagnostics.itemsThatReturned, 1);
  assert.equal(diagnostics.heldByNearlyDue, 1);
  assert.equal(diagnostics.heldByDueToReorder, 1);
  assert.deepEqual(diagnostics.timingReads, { none: 2, not_near: 1 });
});

// ── the catalogue entry ─────────────────────────────────────────────────────

test('the catalogue entry describes the group and hands over the copy rule', () => {
  const definition = segmentDefinition('back_in_stock_other_buyers');
  assert.equal(definition.detector, 'back_in_stock');
  assert.ok(definition.description.includes('Back in stock, and nearly due to reorder'),
    'it has to name the list it is disjoint from');
  assert.ok(definition.description.includes('Due to reorder, everyone due'),
    'and the list that takes the people who have reached their moment');
  assert.match(definition.description, /only thing the message may be about/);
  assert.match(definition.description, /nothing about it may go in the message/);
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

function engineSources(orders, restockEvents) {
  return {
    orders,
    contacts: [{ id: 5, phone: NEARLY }, { id: 6, phone: ONE_PURCHASE }, { id: 7, phone: EARLY }],
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
  received_at: RETURNED_AT, signature_valid: true
};

test('the real engine input carries the buying facts this segment needs', () => {
  const input = buildSegmentationInput(engineSources([
    // Four RT30 orders 56 days apart, the last 54 days ago: nearly due.
    ...purchases(4, 56, 54).map((row, index) =>
      order(index + 1, NEARLY, row.createdAt, 'RT30', 'Retatrutide - 30mg')),
    // One RT30 order, a long time ago: nothing readable at all.
    order(9, ONE_PURCHASE, new Date(NOW.getTime() - 300 * DAY).toISOString(), 'RT30', 'Retatrutide - 30mg'),
    // The 10mg buyer, who is not a buyer of the vial that returned.
    order(10, EARLY, new Date(NOW.getTime() - 30 * DAY).toISOString(), 'RT10', 'RT - 10mg')
  ], [RT30_RETURNED]), { now: NOW });

  assert.equal(input.backInStockCandidates.length, 2, 'the 10mg buyer is not a buyer of the 30mg');
  const oneOff = input.backInStockCandidates.find(row => row.phone === ONE_PURCHASE);
  assert.equal(oneOff.purchaseCount, 1);
  assert.equal(oneOff.lastPurchaseAt, new Date(NOW.getTime() - 300 * DAY).toISOString());
  assert.equal(oneOff.repeatBuyer, false);

  // The pairing takes the nearly due one, this list takes the other, and the
  // 10mg buyer is in neither.
  assert.deepEqual(paired(input).map(row => row.contactPhone), [NEARLY]);
  const found = members(input);
  assert.deepEqual(found.map(row => row.contactPhone), [ONE_PURCHASE]);
  assert.equal(found[0].inclusionEvidence.restockedVariationID, 568);
  assert.equal(found[0].inclusionEvidence.timingRead, 'none');
  assert.match(found[0].inclusionEvidence.summary, /came back in stock on 22 August 2026/);

  // Membership is behaviour. Nobody here has support clearance on record and
  // that is reported on the row rather than used to hide them.
  assert.equal(found[0].commercialClearance.clear, false);
});

test('current stock alone, with no recorded change, puts nobody in the list', () => {
  const input = buildSegmentationInput(engineSources([
    order(9, ONE_PURCHASE, new Date(NOW.getTime() - 300 * DAY).toISOString(), 'RT30', 'Retatrutide - 30mg')
  ], []), { now: NOW });
  assert.ok(input.sourceCoverage.inventory > 0, 'stock is known');
  assert.equal(input.sourceCoverage.restockEvents, 0, 'but nothing came back');
  assert.deepEqual(members(input), []);

  const { diagnostics } = restockOnlyRows(input, { now: NOW });
  assert.equal(describeRestockOnlyEmptiness(diagnostics).code, 'no_stock_change_recorded');
});
