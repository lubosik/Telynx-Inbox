'use strict';
/**
 * lib/campaigns/restock-only.js — "Back in stock, everyone else who bought it".
 *
 * THE ARGUMENT FOR THIS SEGMENT EXISTING AT ALL
 *
 *   restock-reorder.js declined to sweep people with no readable buying pattern
 *   into "Back in stock, and nearly due to reorder", and it was right to:
 *   calling somebody nearly due when we cannot measure when they are due is a
 *   false label on a member row. Its own words were that the alternative "is
 *   restock alone, which is an untargeted campaign, and if the owner wants it
 *   he should get it under its own name". This is that name.
 *
 *   The reason a restock list needs no timing at all is the same reason the
 *   pairing was safe in the first place. "The thing you bought is back in
 *   stock" is a fact about OUR WAREHOUSE. It is true on the day it is observed
 *   whatever the recipient's buying looks like, and it stays true if we can
 *   read nothing about them. Nothing has to be inferred about a person for it
 *   to be worth saying, which is precisely why it is the one message this
 *   business is allowed to send about repeat purchase at all.
 *
 *   docs/campaigns/REPEAT-PURCHASE-RESEARCH.md rules out every replenishment
 *   and "running low" reminder, because the mechanism is a consumption-rate
 *   assumption and that is a dosing claim under 21 CFR 201.128. It names one
 *   substitute: "a restock notice about OUR stock, which moves the trigger from
 *   their usage to our supply". This segment is that substitute with nothing
 *   else attached, and it is therefore the SAFEST list in the catalogue rather
 *   than the loosest one. There is genuinely nothing to say here except that
 *   the thing is available again, which is why RESTOCK_REORDER_COPY_BASIS is
 *   reused verbatim rather than softened.
 *
 * WHY IT IS DISJOINT FROM THE PAIRING AND NOT A SUPERSET OF IT
 *
 *   `reorder_due` and `reorder_due_high_confidence` are nested on purpose: each
 *   description names the other and an operator picks one. That works because
 *   the two lists answer the SAME question at two levels of certainty.
 *
 *   These two do not. They answer the same question about the same event, so a
 *   person in both would receive two messages about ONE restock, and the
 *   nearly-due one is strictly better timed. Nesting them would leave that
 *   outcome resting on an operator noticing an overlap that is invisible on a
 *   screen. So the split is structural:
 *
 *     restockOnlyRows() CALLS restockReorderPairs() and subtracts every phone
 *     it returns.
 *
 *   Not a re-implementation of the pairing's rule, and not a parallel filter
 *   that happens to agree today. The sibling decides its own membership and
 *   this file removes exactly whoever that was, so the two cannot drift apart
 *   and re-overlap: any future change to the pairing propagates here for free.
 *   test/campaign-segment-restock-only.test.js asserts emptiness of the
 *   intersection against a fixture that deliberately contains people in both
 *   states.
 *
 *   The subtraction is PERSON level, not person-and-product level. Somebody who
 *   is nearly due on one returned product and unreadable on another returned
 *   product is held by the pairing alone. Two true facts, but still two texts
 *   about restocks in one recompute, and the owner's constraint was that a
 *   person should not be in both lists. The pairing is the better timed of the
 *   two, so it wins the person outright.
 *
 * WHAT HAPPENS TO THE PEOPLE WHO ARE DUE OR OVERDUE
 *
 *   Excluded, at the person-and-product level, exactly as the pairing excludes
 *   them and for the identical stated reason: they are already in "Due to
 *   reorder, everyone due" and two lists means two messages.
 *
 *   Left at the product level rather than the person level, again exactly as
 *   the pairing does it, because "Due to reorder, everyone due" is a different
 *   message about a different product and is not another notice about this
 *   return. Both back-in-stock segments therefore treat the reorder lists
 *   identically, and only the relationship BETWEEN the two back-in-stock
 *   segments is tightened to the person.
 *
 * WHY SOMEBODY WHO IS SIMPLY NOT NEAR THEIR NEXT ORDER IS STILL IN THIS LIST
 *
 *   State `not_due` means we can read their buying and they are a long way off.
 *   The temptation is to drop them too, on the grounds that this segment is
 *   "the people we cannot time". Do not.
 *
 *   Excluding `approaching`, `due` and `overdue` is a DE-DUPLICATION rule: each
 *   of those states has a list that already holds the person. `not_due` has no
 *   list. Dropping them would be a TIMING rule, and a timing rule inside a
 *   segment whose entire justification is that a restock needs no timing is
 *   incoherent. It would also quietly re-import the consumption-rate reasoning
 *   through the back door: "they bought recently so they do not need to hear
 *   this" is a claim about their supply, which is the exact sentence this
 *   business may not think, let alone send.
 *
 *   So the rule is: subtract the lists that exist, never the states we can
 *   read. What the member row owes the reader instead is an honest sentence
 *   about which of those it is, and every row carries one.
 *
 * WHAT IS STILL REFUSED, AND WHY NONE OF IT SOFTENED
 *
 *   A FIRST SIGHTING OF STOCK IS STILL NOT A RESTOCK. qualifyRestockForSegment()
 *   is imported from restock-reorder.js and called unchanged, so the signed
 *   event, the definitely-out previous state, the definitely-in observed state
 *   and the still-in-stock-right-now check all apply here identically. This
 *   segment is broader in WHO it holds and not one notch looser in WHAT counts
 *   as the fact it rests on. If anything the bar matters more here, because
 *   there is no second signal to make a wrong claim merely mistimed.
 *
 *   SOMEBODY WHO HAS BOUGHT THE RETURNED ITEM SINCE IT RETURNED IS OUT. The
 *   news is not news to them. Note this is checked against THE EXACT ITEM that
 *   came back, from `lastPurchaseAt` on the restock candidate, rather than
 *   against the parent-level reorder series the pairing uses. That is
 *   deliberate and it is the more precise question here: somebody who bought a
 *   different vial of the same molecule has not bought the vial that came back,
 *   and telling them it is available is still a true and useful thing to say.
 *
 * IDENTITY: EXACT VARIATION FOR STOCK, PARENT ONLY FOR THE EXCLUSIONS
 *
 *   Unchanged from the pairing and for the same reason. The stock claim is
 *   about one vial, so membership is keyed on the exact item the event named.
 *   The timing states that hand somebody to another list are read on the
 *   PARENT, because that is the key those other lists are computed on and an
 *   exclusion has to be evaluated in the other list's own terms or it does not
 *   exclude anybody. Read docs/campaigns/SEGMENTATION-METHODOLOGY.md before
 *   changing either.
 */

const { calculateReorderCadence } = require('./reorder-cadence');
const {
  dayText,
  qualifyRestockForSegment,
  restockReorderPairs
} = require('./restock-reorder');

/**
 * The cadence states that mean another saved list already holds this person for
 * this product, mapped to the list that holds them. Named as data rather than
 * inlined so that "which list is this person in instead" is answerable without
 * reading the loop, and so the evidence row can say it out loud.
 *
 * `approaching` is here as well as being removed by the person-level
 * subtraction below. That is not redundant. The subtraction removes whoever the
 * pairing actually returned, and the pairing applies filters of its own after
 * the state test; somebody `approaching` whom the pairing dropped for one of
 * those other reasons must still not land here, because this segment's whole
 * evidence row would then say we cannot time a person we plainly can.
 */
const STATES_HELD_BY_ANOTHER_LIST = Object.freeze({
  approaching: 'back_in_stock_nearly_due',
  due: 'reorder_due',
  overdue: 'reorder_due'
});

/**
 * How well we can see this person's own buying, in the terms the member row
 * uses. Three answers and no fourth, because a reader looking at somebody who
 * is not in the better timed list is owed a specific reason rather than a
 * shrug.
 *
 *   none          nothing readable. No reorder candidate at all, or a history
 *                 too uneven or too thin to read.
 *   not_near      readable, and they are a long way from their usual moment.
 *   not_computed  a pattern exists but the window was not worked out, because
 *                 the reorder engine stopped earlier for a reason of its own.
 */
function timingReadFor(state) {
  if (state === 'not_due') return 'not_near';
  if (state === 'suppressed' || state === 'contacted') return 'not_computed';
  return 'none';
}

function numericID(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bump(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

/**
 * The people this segment holds, with the diagnostics that account for
 * everybody who was considered and left out.
 *
 * Returns rows rather than member records, matching restockReorderPairs():
 * building the evidence is the catalogue's job in segment-definitions.js, and
 * keeping it there stops this file needing to know the member shape.
 */
function restockOnlyRows(input, { now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const restocks = Array.isArray(input?.backInStockCandidates) ? input.backInStockCandidates : [];
  const reorders = Array.isArray(input?.reorderCandidates) ? input.reorderCandidates : [];

  // THE DISJOINTNESS. The sibling decides who it holds and we remove exactly
  // those people, so there is no second copy of its rule here to fall out of
  // step with it.
  const pairing = restockReorderPairs(input, { now: at });
  const heldByThePairing = new Set(pairing.pairs.map(pair => pair.phone));

  const diagnostics = {
    restockCandidatesConsidered: restocks.length,
    reorderCandidatesConsidered: reorders.length,
    // How many stock-change events were READ, before anybody was matched to
    // them. Without this, "nothing has come back" and "something came back and
    // nobody had bought it" both look like zero candidates and get the same
    // wrong sentence. Null when the caller handed us an input with no coverage
    // block, which is what a hand-built fixture looks like.
    restockEventsRead: Number.isFinite(Number(input?.sourceCoverage?.restockEvents))
      ? Number(input.sourceCoverage.restockEvents)
      : null,
    genuineTransitionRows: 0,
    itemsThatReturned: 0,
    transitionRejections: {},
    // Every reason somebody was considered and handed to a different list.
    // These count buyer-and-return ROWS rather than people, exactly as
    // genuineTransitionRows does: one person can be a buyer of two items that
    // both came back. `people` at the bottom is the only distinct-person count.
    heldByNearlyDue: 0,
    heldByDueToReorder: 0,
    orderedSinceTheReturn: 0,
    // The shape of what is left, so an operator can see at a glance whether
    // this list is mostly unreadable people or mostly early ones.
    timingReads: {},
    repeatReturnsCollapsed: 0,
    people: 0,
    rows: 0
  };

  // The timing lookup is on the PARENT product, one entry per person and
  // parent, which is how buildGenerationInput() groups reorder candidates and
  // therefore the only key on which an exclusion can be evaluated in the other
  // list's own terms.
  const timingByPersonAndProduct = new Map();
  for (const candidate of reorders) {
    const phone = typeof candidate?.phone === 'string' ? candidate.phone : null;
    const productID = numericID(candidate?.productID);
    if (!phone || productID === null) continue;
    const key = `${phone} ${productID}`;
    if (!timingByPersonAndProduct.has(key)) timingByPersonAndProduct.set(key, candidate);
  }

  const returnedItems = new Set();
  const byPersonAndItem = new Map();

  for (const restock of restocks) {
    const phone = typeof restock?.phone === 'string' ? restock.phone : null;
    const productID = numericID(restock?.productID);
    if (!phone || productID === null) {
      bump(diagnostics.transitionRejections, 'candidate_identity_missing');
      continue;
    }
    // Unchanged, imported, and called with the candidate exactly as the pairing
    // calls it. A first sighting is still not a restock.
    const verdict = qualifyRestockForSegment(restock);
    if (!verdict.genuine) {
      for (const reason of verdict.reasons) bump(diagnostics.transitionRejections, reason);
      continue;
    }
    diagnostics.genuineTransitionRows += 1;
    const variationID = numericID(restock.variationID) || 0;
    returnedItems.add(`${productID}:${variationID}`);

    if (heldByThePairing.has(phone)) {
      diagnostics.heldByNearlyDue += 1;
      continue;
    }

    const observedTime = Date.parse(restock.observedAt);

    // Against the EXACT item that came back, not the parent series. See the
    // header note: a different vial of the same molecule is not this vial.
    const boughtItAt = Date.parse(restock.lastPurchaseAt);
    if (Number.isFinite(boughtItAt) && boughtItAt > observedTime) {
      diagnostics.orderedSinceTheReturn += 1;
      continue;
    }

    const timing = timingByPersonAndProduct.get(`${phone} ${productID}`);
    // No reorder candidate at all is the ordinary case here rather than the
    // exception. It is what somebody with one purchase looks like, and one
    // purchase is most of this customer base. The pairing counted it as a
    // rejection; this segment exists to hold exactly these people.
    let state = null;
    if (timing) {
      // The SAME call every other definition makes, argument for argument, so
      // no two lists can disagree about one person on one day.
      const result = calculateReorderCadence({
        purchases: timing.purchases,
        productCadence: timing.productCadence,
        now: at,
        productAvailable: timing.productAvailable !== false,
        alreadyContactedForLastPurchase: timing.alreadyContactedForLastPurchase === true
      });
      state = result.state;
      const heldBy = STATES_HELD_BY_ANOTHER_LIST[state];
      if (heldBy) {
        if (heldBy === 'back_in_stock_nearly_due') diagnostics.heldByNearlyDue += 1;
        else diagnostics.heldByDueToReorder += 1;
        continue;
      }
    }

    const timingRead = timingReadFor(state);
    const key = `${phone} ${productID}:${variationID}`;
    const existing = byPersonAndItem.get(key);
    if (!existing) {
      bump(diagnostics.timingReads, timingRead);
      byPersonAndItem.set(key, {
        phone,
        productID,
        variationID,
        restock,
        timing: timing || null,
        timingState: state,
        timingRead,
        observedTime,
        earlierReturnsSeen: 0
      });
      continue;
    }
    // One item can go out and come back more than once inside the window the
    // input carries. That is one thing to say, not two: the most recent return
    // is the current fact and the earlier ones are counted so the evidence can
    // admit it has happened before.
    diagnostics.repeatReturnsCollapsed += 1;
    existing.earlierReturnsSeen += 1;
    const newer = observedTime > existing.observedTime ||
      (observedTime === existing.observedTime &&
        String(restock.id ?? '') > String(existing.restock.id ?? ''));
    if (newer) {
      existing.restock = restock;
      existing.observedTime = observedTime;
    }
  }

  const rows = [...byPersonAndItem.values()].sort((a, b) =>
    a.phone.localeCompare(b.phone) ||
    a.productID - b.productID ||
    a.variationID - b.variationID);

  diagnostics.itemsThatReturned = returnedItems.size;
  diagnostics.rows = rows.length;
  diagnostics.people = new Set(rows.map(row => row.phone)).size;
  return { rows, diagnostics };
}

/**
 * Why the list is empty, in a sentence, when it is empty.
 *
 * Same job as describeRestockReorderEmptiness() and same reason for existing:
 * an empty automatic segment and a broken one look identical on a screen, and
 * that confusion has already cost this project a week. The codes are different
 * because the ways this list can be empty are different, and one of them is
 * new and worth saying plainly: everybody who bought the thing went to a better
 * timed list, which means the engine worked rather than failed.
 */
function describeRestockOnlyEmptiness(diagnostics) {
  const counts = diagnostics || {};
  if ((counts.rows || 0) > 0) {
    return {
      code: 'not_empty',
      sentence: 'This list has people in it.'
    };
  }
  if ((counts.restockCandidatesConsidered || 0) === 0) {
    // Something DID come back, and not one person in the order history had
    // bought that exact item. That is a different answer from "nothing has
    // come back", and giving both the same sentence would send somebody
    // looking for a missing inventory baseline that is already there.
    if ((counts.restockEventsRead || 0) > 0) {
      return {
        code: 'nobody_bought_what_returned',
        sentence: 'A product came back, but nobody in the order history had bought that exact '
          + 'one. A message about it would be going to people who have never bought it, and that '
          + 'is a different thing from telling a buyer their product is available again.'
      };
    }
    return {
      code: 'no_stock_change_recorded',
      sentence: 'Nothing has been recorded going out of stock and coming back, so there is '
        + 'nobody to put in this list. Reading what is in stock today is not the same thing: a '
        + 'product that has always been in stock has not returned. The record starts once there '
        + 'is a first snapshot of every product to compare a later change against.'
    };
  }
  if ((counts.genuineTransitionRows || 0) === 0) {
    return {
      code: 'no_genuine_return',
      sentence: 'Stock changes were reported, but none of them was a product going from out of '
        + 'stock to in stock and staying there. Price edits, title edits and first sightings all '
        + 'look like changes and none of them is a return.'
    };
  }
  if ((counts.heldByNearlyDue || 0) > 0 || (counts.heldByDueToReorder || 0) > 0) {
    return {
      code: 'everybody_is_in_a_better_timed_list',
      sentence: 'A product came back and people had bought it, but every one of them is already '
        + 'in a list with better timing, so putting them here as well would only mean writing to '
        + 'the same person twice about the same thing. Look in "Back in stock, and nearly due to '
        + 'reorder" and in "Due to reorder, everyone due".'
    };
  }
  if ((counts.orderedSinceTheReturn || 0) > 0) {
    return {
      code: 'already_ordered_again',
      sentence: 'Everybody who bought the product that came back has bought it again since it '
        + 'came back, so the news would not be news to any of them.'
    };
  }
  return {
    code: 'nobody_bought_what_returned',
    sentence: 'A product came back, but nobody in the order history had bought that exact one. '
      + 'A message about it would be going to people who have never bought it, and that is a '
      + 'different thing from telling a buyer their product is available again.'
  };
}

/**
 * How the sentence names the reason this person is not in the better timed
 * list. Keyed on the read rather than on the raw state, because the operator
 * needs to know how much we can see and not which branch of the engine
 * returned.
 *
 * Every one of them says which list they are NOT in and why, which is the whole
 * requirement: a reader must not be left wondering whether this person was
 * missed by the better list or genuinely does not belong in it.
 */
const TIMING_READ_SENTENCES = Object.freeze({
  none: 'We cannot tell when they usually buy this again, so there is no way to say whether '
    + 'today is a good day for them. That is why they are here rather than in "Back in stock, '
    + 'and nearly due to reorder".',
  not_near: 'We can see roughly when they usually buy this again and they are nowhere near it '
    + 'yet, so they are here rather than in "Back in stock, and nearly due to reorder". The '
    + 'product being available again is still true and is still the only thing to tell them.',
  not_computed: 'We have not worked out where they stand in their own ordering, so there is no '
    + 'timing to go on and they are here rather than in "Back in stock, and nearly due to '
    + 'reorder".'
});

/**
 * The evidence row read out loud, for whoever taps a name.
 *
 * Four things and nothing else: what came back, when it came back, when this
 * person last bought that exact thing, and the plain admission that we have no
 * timing to offer for them. Absolute dates rather than "three days ago", so the
 * sentence a recompute writes today is the sentence it wrote yesterday and the
 * run digest does not churn.
 *
 * Nothing in here is ever a claim about the person. It reports two dates from
 * our own records and one admission of ignorance, and the copy rule that
 * travels beside it forbids turning any of that into a sentence about them.
 */
function describeRestockOnlyMember({
  productName = null,
  restockObservedAt = null,
  lastOrderAt = null,
  purchaseCount = null,
  timingRead = 'none',
  earlierReturnsSeen = 0
} = {}) {
  const sentences = [];
  const returnedOn = dayText(restockObservedAt);
  const product = typeof productName === 'string' && productName.trim()
    ? productName.trim()
    : null;
  if (returnedOn) {
    sentences.push(product
      ? `Their ${product} came back in stock on ${returnedOn}.`
      : `The product they bought came back in stock on ${returnedOn}.`);
  } else if (product) {
    sentences.push(`Their ${product} came back in stock.`);
  }

  const orderedOn = dayText(lastOrderAt);
  const bought = Number(purchaseCount);
  if (orderedOn && bought === 1) {
    sentences.push(`They bought it once, on ${orderedOn}.`);
  } else if (orderedOn && Number.isFinite(bought) && bought > 1) {
    sentences.push(`They have bought it ${bought} times, most recently on ${orderedOn}.`);
  } else if (orderedOn) {
    sentences.push(`They last bought it on ${orderedOn}.`);
  }

  sentences.push(TIMING_READ_SENTENCES[timingRead] || TIMING_READ_SENTENCES.none);

  if (Number(earlierReturnsSeen) > 0) {
    sentences.push('It has come back more than once recently, and the date above is the most '
      + 'recent time.');
  }

  return sentences.join(' ');
}

module.exports = {
  STATES_HELD_BY_ANOTHER_LIST,
  TIMING_READ_SENTENCES,
  describeRestockOnlyEmptiness,
  describeRestockOnlyMember,
  restockOnlyRows,
  timingReadFor
};
