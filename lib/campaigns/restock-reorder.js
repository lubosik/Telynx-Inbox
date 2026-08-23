'use strict';
/**
 * lib/campaigns/restock-reorder.js — the two-signal pairing behind the
 * "Back in stock, and nearly due to reorder" segment.
 *
 * WHY THIS SEGMENT EXISTS IN THIS SHAPE
 *
 *   cadence alone, at the bottom of the bar   the timing is a guess about
 *                                             somebody's consumption. Unsafe.
 *   restock alone                             the timing is a fact, but it is
 *                                             pointed at everybody who ever
 *                                             bought the thing.
 *   restock AND nearly due                    the timing is a fact, AND it is
 *                                             pointed at the people for whom
 *                                             it is worth saying today.
 *
 * THE COMPLIANCE POINT THAT DRIVES THE WHOLE DESIGN
 *
 *   This is a peptide business. A message may never state or imply a rate of
 *   consumption, because that is a dosing claim, and under 21 CFR 201.128 the
 *   firm's own written statements are evidence of intended human use.
 *   docs/campaigns/REPEAT-PURCHASE-RESEARCH.md rules out replenishment and
 *   "running low" reminders outright and names the substitute in one line:
 *   "a restock notice about OUR stock, which moves the trigger from their
 *   usage to our supply".
 *
 *   So the two halves have different jobs and they are not interchangeable:
 *
 *     THE RESTOCK IS THE REASON THE MESSAGE EXISTS. It is a fact about our
 *     inventory, it is the only thing a message from this segment may say, and
 *     it is true of every single person in the list.
 *
 *     THE REORDER TIMING ONLY DECIDES WHO RECEIVES IT. It is never stated,
 *     never implied and never referenced in copy, because "you are probably
 *     running low" is a claim about a person's body rather than about our
 *     shelves.
 *
 *   "The thing you bought is back in stock" is fine. "You are probably running
 *   low" ends the business. Nothing in this file, in the segment copy, or in
 *   any message built from it may blur those two.
 *
 * WHERE THE BAR SITS, AND WHY IT DID NOT MOVE
 *
 *   Nothing here has a threshold of its own. It calls calculateReorderCadence()
 *   with exactly the arguments the `reorder_approaching` definition uses and
 *   accepts exactly the state that definition accepts. There is no widened
 *   window, no relaxed variability limit and no new constant, so this segment
 *   is a strict subset of "Nearly due to reorder" and cannot become a back door
 *   to thresholds that were considered and declined.
 *
 *   The restock justifies the MESSAGE. It does not justify a looser read of
 *   somebody's timing, because a product returning to our shelves tells us
 *   nothing at all about how fast that person gets through what they bought.
 *
 * A FIRST SIGHTING OF STOCK IS NOT A RESTOCK
 *
 *   The transition test below is the existing one. It reuses
 *   isDefinitelyUnavailable, isDefinitelyAvailable and sameInventoryItem from
 *   back-in-stock.js rather than forming a second opinion, so a product that
 *   has simply always been in stock produces nothing, and an event with no
 *   readable previous state produces nothing. It deliberately does NOT include
 *   the authoritative re-fetch, the debounce or the delivery-dedupe arms of
 *   qualifyBackInStockTransition(): those exist to make a SEND safe and are
 *   performed on the send path, which this is not. What is asserted here is the
 *   narrower claim a segment needs, that a genuine out-to-in transition was
 *   observed on a signed event, plus the separate live check that the item is
 *   in stock right now.
 *
 * IDENTITY: PARENT FOR TIMING, EXACT VARIATION FOR STOCK
 *
 *   "Your BPC-157 is back" is a claim about one vial size, so the stock half is
 *   matched on the exact item that returned. buildGenerationInput() already
 *   indexes buyers under both the parent and the exact variation and looks the
 *   event up by its own key, so a variation-level event only ever reaches the
 *   buyers of that vial. The timing half is matched on the PARENT, because
 *   somebody moving from 10mg to 30mg is one reorder series. Read
 *   docs/campaigns/SEGMENTATION-METHODOLOGY.md before changing either.
 */

const {
  isDefinitelyAvailable,
  isDefinitelyUnavailable,
  sameInventoryItem
} = require('./back-in-stock');
const { calculateReorderCadence } = require('./reorder-cadence');

/**
 * The one cadence state this segment accepts. Named rather than inlined so the
 * agreement with `reorder_approaching` is visible in one place.
 *
 * NOT `due` and NOT `overdue`: those people are already in "Due to reorder,
 * everyone due", and a person in two lists gets two messages.
 */
const RESTOCK_REORDER_STATE = 'approaching';

function numericID(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bump(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

/**
 * Is this candidate evidence of a genuine return to stock?
 *
 * Reasons accumulate rather than short-circuit, because a diagnostic that says
 * only the first thing wrong sends the reader round the loop twice.
 */
function qualifyRestockForSegment(candidate) {
  const reasons = [];
  if (candidate?.webhookTrusted !== true) reasons.push('webhook_untrusted');
  if (!candidate?.previous || !candidate?.observed) reasons.push('inventory_snapshot_missing');
  else {
    if (!sameInventoryItem(candidate.previous, candidate.observed)) {
      reasons.push('observed_identity_mismatch');
    }
    // The load-bearing one. An event whose previous state is unknown, or was
    // already in stock, is a first sighting or a metadata edit, not a return.
    if (!isDefinitelyUnavailable(candidate.previous)) {
      reasons.push('previous_state_not_definitely_unavailable');
    }
    if (!isDefinitelyAvailable(candidate.observed)) {
      reasons.push('observed_state_not_definitely_available');
    }
  }
  if (!Number.isFinite(Date.parse(candidate?.observedAt))) reasons.push('observed_at_missing');
  // The stated reason has to still be true when the list is read. A product
  // that came back on Monday and went out again on Wednesday is not something
  // to write to anybody about. `currentlyInStock` is set by
  // buildGenerationInput() from the same merged inventory the reorder half
  // uses; anything else, including a caller that never set it, is unknown and
  // is refused rather than assumed.
  if (candidate?.currentlyInStock !== true) {
    reasons.push(candidate?.currentlyInStock === false
      ? 'out_of_stock_again'
      : 'current_stock_unknown');
  }
  return { genuine: reasons.length === 0, reasons };
}

/**
 * The people who are on both sides of the pairing, with the diagnostics that
 * explain everybody who was considered and left out.
 *
 * Returns pairs rather than member rows on purpose: building the evidence row
 * is the catalogue's job in segment-definitions.js, and keeping it there stops
 * this file needing to know the member shape.
 */
function restockReorderPairs(input, { now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const restocks = Array.isArray(input?.backInStockCandidates) ? input.backInStockCandidates : [];
  const reorders = Array.isArray(input?.reorderCandidates) ? input.reorderCandidates : [];

  const diagnostics = {
    restockCandidatesConsidered: restocks.length,
    reorderCandidatesConsidered: reorders.length,
    genuineTransitionRows: 0,
    itemsThatReturned: 0,
    transitionRejections: {},
    noReorderCandidateForBuyer: 0,
    orderedSinceTheReturn: 0,
    cadenceStates: {},
    repeatReturnsCollapsed: 0,
    people: 0,
    pairs: 0
  };

  // The timing half is looked up on the PARENT product. One entry per person
  // and parent, which is exactly how buildGenerationInput() groups them.
  const timingByPersonAndProduct = new Map();
  for (const candidate of reorders) {
    const phone = typeof candidate?.phone === 'string' ? candidate.phone : null;
    const productID = numericID(candidate?.productID);
    if (!phone || productID === null) continue;
    const key = `${phone} ${productID}`;
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
    const verdict = qualifyRestockForSegment(restock);
    if (!verdict.genuine) {
      for (const reason of verdict.reasons) bump(diagnostics.transitionRejections, reason);
      continue;
    }
    diagnostics.genuineTransitionRows += 1;
    const variationID = numericID(restock.variationID) || 0;
    returnedItems.add(`${productID}:${variationID}`);

    const timing = timingByPersonAndProduct.get(`${phone} ${productID}`);
    if (!timing) {
      // They bought the thing that came back, but the engine built no reorder
      // candidate for them on that parent. That happens when the vial they
      // bought most recently is not currently sellable, or when nothing about
      // their history is readable. Either way we cannot see where they stand,
      // and guessing is the thing this segment exists to avoid.
      diagnostics.noReorderCandidateForBuyer += 1;
      continue;
    }

    // The SAME call the `reorder_approaching` definition makes, argument for
    // argument. Any divergence here would let two segments disagree about one
    // person on one day, which is the failure the catalogue exists to prevent.
    const result = calculateReorderCadence({
      purchases: timing.purchases,
      productCadence: timing.productCadence,
      now: at,
      productAvailable: timing.productAvailable !== false,
      alreadyContactedForLastPurchase: timing.alreadyContactedForLastPurchase === true
    });
    bump(diagnostics.cadenceStates, result.state);
    if (result.state !== RESTOCK_REORDER_STATE) continue;

    const observedTime = Date.parse(restock.observedAt);
    const lastPurchaseTime = Date.parse(result.lastPurchaseAt);
    if (Number.isFinite(lastPurchaseTime) && lastPurchaseTime > observedTime) {
      // They have bought it again since it came back. The news is no longer
      // news to them. Their own next window is a different question and it is
      // not the one this segment answers.
      diagnostics.orderedSinceTheReturn += 1;
      continue;
    }

    const key = `${phone} ${productID}:${variationID}`;
    const existing = byPersonAndItem.get(key);
    if (!existing) {
      byPersonAndItem.set(key, {
        phone,
        productID,
        variationID,
        restock,
        timing,
        result,
        observedTime,
        earlierReturnsSeen: 0
      });
      continue;
    }
    // An item can go out and come back more than once inside the window the
    // input carries. That is one thing to say, not two: the most recent return
    // is the current fact, and the earlier ones are counted so the evidence can
    // admit that it has happened before.
    diagnostics.repeatReturnsCollapsed += 1;
    existing.earlierReturnsSeen += 1;
    const newer = observedTime > existing.observedTime ||
      (observedTime === existing.observedTime &&
        String(restock.id ?? '') > String(existing.restock.id ?? ''));
    if (newer) {
      existing.restock = restock;
      existing.result = result;
      existing.observedTime = observedTime;
    }
  }

  const pairs = [...byPersonAndItem.values()].sort((a, b) =>
    a.phone.localeCompare(b.phone) ||
    a.productID - b.productID ||
    a.variationID - b.variationID);

  diagnostics.itemsThatReturned = returnedItems.size;
  diagnostics.pairs = pairs.length;
  diagnostics.people = new Set(pairs.map(pair => pair.phone)).size;
  return { pairs, diagnostics };
}

/**
 * Why the list is empty, in a sentence, when it is empty.
 *
 * An empty automatic segment and a broken one look identical on a screen, and
 * that confusion has already cost this project a week: four segments read zero
 * because of a consent gate and it was read as a dead engine. This segment will
 * legitimately return nobody until a baseline of current stock exists and
 * something genuinely goes out and comes back, so it says which of those it is
 * waiting for rather than showing a bare nought.
 */
function describeRestockReorderEmptiness(diagnostics) {
  const counts = diagnostics || {};
  if ((counts.pairs || 0) > 0) {
    return {
      code: 'not_empty',
      sentence: 'This list has people in it.'
    };
  }
  if ((counts.restockCandidatesConsidered || 0) === 0) {
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
  if (Object.keys(counts.cadenceStates || {}).length === 0) {
    return (counts.noReorderCandidateForBuyer || 0) > 0
      ? {
        code: 'no_readable_pattern',
        sentence: 'Something did come back and people had bought it, but we cannot read a buying '
          + 'pattern for any of them, so there is no way to tell who this would be well timed for.'
      }
      : {
        code: 'nobody_bought_what_returned',
        sentence: 'A product came back, but nobody in the order history had bought that exact one.'
      };
  }
  if ((counts.orderedSinceTheReturn || 0) > 0) {
    return {
      code: 'already_ordered_again',
      sentence: 'The people who were close enough to their next order have already bought the '
        + 'product again since it came back, so the news would not be news to them, and nobody '
        + 'else is close enough to be worth the message.'
    };
  }
  return {
    code: 'nobody_near_their_next_order',
    sentence: 'A product came back and we know who bought it, but none of them is close to the '
      + 'point where they normally buy again. Everybody who is close enough bought something '
      + 'else this time.'
  };
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric'
});

/** "22 August 2026". Fixed to UTC so the same facts always render the same. */
function dayText(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return MONTH_FORMAT.format(new Date(time));
}

/**
 * "every 8 weeks". Weeks once the gap is long enough for weeks to be the unit a
 * person would actually use, days below that. Never a decimal: this is a
 * sentence, not a measurement.
 */
function gapText(medianDays) {
  const days = Number(medianDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days < 14) {
    const whole = Math.max(1, Math.round(days));
    return whole === 1 ? 'every day' : `every ${whole} days`;
  }
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'every week' : `every ${weeks} weeks`;
}

/**
 * The evidence row read out loud, for whoever taps a name.
 *
 * Two facts and nothing else: what came back and when, and where this person
 * sits in their own ordering. Absolute dates rather than "three days ago", so
 * the sentence a recompute writes today is the same sentence it wrote
 * yesterday and the run digest does not churn.
 *
 * A product-level pattern is somebody else's number and is never described as
 * this person's, for the same reason the iPhone's evidence checklist relabels
 * it: a reader has no way to catch that lie.
 */
function describeRestockReorderMember({
  productName = null,
  restockObservedAt = null,
  lastOrderAt = null,
  medianIntervalDays = null,
  cadenceSource = 'personal',
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
  const gap = gapText(medianIntervalDays);
  if (orderedOn && gap && cadenceSource === 'product') {
    sentences.push(`They last ordered it on ${orderedOn}. They have not ordered it often enough `
      + `to read a pattern of their own, so we go by other customers, who buy it again around `
      + `${gap}.`);
  } else if (orderedOn && gap) {
    sentences.push(`They last ordered it on ${orderedOn}, and they usually reorder around ${gap}.`);
  } else if (orderedOn) {
    sentences.push(`They last ordered it on ${orderedOn}.`);
  }

  if (Number(earlierReturnsSeen) > 0) {
    sentences.push('It has come back more than once recently, and the date above is the most '
      + 'recent time.');
  }

  if (!sentences.length) {
    return 'The engine paired a return to stock with this person, but the dates behind it were '
      + 'not recorded.';
  }
  return sentences.join(' ');
}

/**
 * The line that goes next to the segment wherever somebody is about to write a
 * message from it. Constant, deliberately: it is a rule, not an observation.
 */
const RESTOCK_REORDER_COPY_BASIS =
  'Say only that the product is back in stock. That is a fact about our shelves and it is true '
  + 'for everybody in this list. Do not say, hint, or build a sentence around the idea that they '
  + 'are running low, are due, or need more, because that is a claim about them and we are not '
  + 'allowed to make it.';

module.exports = {
  RESTOCK_REORDER_COPY_BASIS,
  RESTOCK_REORDER_STATE,
  describeRestockReorderEmptiness,
  describeRestockReorderMember,
  gapText,
  qualifyRestockForSegment,
  restockReorderPairs
};
