'use strict';
/**
 * lib/notifications/daily-digest.js — what is worth interrupting somebody for,
 * and the wording of the one push that does it.
 *
 * Pure. No database, no devices, no Apple credential, no clock of its own. It
 * takes the outcome of a cycle plus a short history and returns either a
 * notification preparation or a stated reason for silence, which is why every
 * rule below is testable offline against a fixture.
 *
 * This implements the DECISIONS block of
 * docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md: D2 (cadence), D4 (the
 * four gates and the two edge cases), D7 (content). Where this file departs
 * from that document it says so at the point of departure, and there are
 * exactly two such places, both marked DEPARTURE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR GATES. ALL FOUR MUST PASS. (D4, research S5.2)
 *
 * GATE 1 — ACTIONABLE. There is a specific thing the recipient can do today.
 *   "Segments recomputed" describes our own job running and is a log line. This
 *   file only ever reports SEGMENT MOVEMENT and PROPOSALS WAITING, both of
 *   which have a screen to open and a decision at the end of it, so the gate is
 *   enforced by what is allowed into the body at all rather than by a predicate
 *   over free text. Recompute completion, refresh counts and timings never
 *   reach the copy. The one exception is a FAILURE, which is actionable in the
 *   other direction: somebody has to go and look.
 *
 * GATE 2 — MATERIAL. Large enough on BOTH an absolute and a relative measure:
 *
 *     delta >= 3  AND  delta >= 10% of the segment's prior size
 *
 *   Conjoined, because each alone fails in the opposite direction. Three out of
 *   five hundred is noise and passes an absolute-only test; one out of three is
 *   thirty-three per cent and passes a relative-only test while still being one
 *   person. `one_time_buyers` holds about five hundred people, so ten per cent
 *   asks for fifty and that cohort will almost never fire, which is correct:
 *   "504 became 507" is not news about a business.
 *
 *   REVENUE-CRITICAL SEGMENTS drop to `delta >= 1`. The same-product reorder
 *   engine finds about nine people out of 781 buyers; those nine are the most
 *   actionable list in the product and a single arrival is worth saying. The
 *   set is named in `DEFAULT_CRITICAL_SEGMENTS` and is configurable. The
 *   research pairs this with a lifetime-value floor; this file does not apply
 *   one, and that omission is stated in DEPARTURE 2 below rather than left as a
 *   silent gap.
 *
 * GATE 3 — NOVEL. Not substantially the same message as recent days.
 *
 *   The headline claim is hashed as SEGMENT PLUS DIRECTION and never the exact
 *   count, so "due to reorder, up" firing again tomorrow with a different
 *   number is recognised as the same news. Without this a slow trend sends an
 *   identical push every morning for a fortnight, which is exactly the pattern
 *   that trains somebody to ignore and then disable. Two exceptions re-open the
 *   gate, both from the research: the trend REVERSES direction, or the segment
 *   CROSSES a round threshold (10, 25, 50, 100) it had not crossed before.
 *
 * GATE 4 — ATTRIBUTABLE. The change can be named, in the body, in plain words.
 *
 *   If the body would have to say "several segments changed" it is too diffuse
 *   to interrupt for. Enforced as a hard cap on how many segments the body may
 *   name (`MAX_NAMED_SEGMENTS`): past that the digest is suppressed with
 *   `too_diffuse` rather than being papered over with vague copy. This gate is
 *   a forcing function, not a formatting rule.
 *
 * TWO EDGE CASES THAT WOULD FIRE ON DAY ONE (D4, research S5.4)
 *
 *   COLD START. The first recompute of a segment has no prior state, so every
 *     member "joins". Without a guard the owner's first digest is "487 people
 *     moved into 12 segments" and his first impression is that it is broken. A
 *     segment marked `baseline` is excluded from materiality entirely, and a
 *     run marked `coldStart` suppresses the whole digest and records the
 *     baseline silently.
 *
 *   BULK IMPORT. If the customer base moved more than 15% since the previous
 *     run, every segment changes at once and none of it is customer behaviour.
 *     The digest is suppressed with `bulk_change_detected`. Never let an import
 *     masquerade as organic movement: reporting behaviour is the entire value
 *     of the feature.
 *
 * THE CIRCUIT BREAKER (research S5.5)
 *   More than half the segments reporting material change in one run is a bug
 *   or a data event, not twelve simultaneous business developments. Suppressed
 *   and logged. Caps bound how bad it can get when the gates are wrong.
 *
 * AND SILENCE IS MANDATORY. If nothing passes, NOTHING is sent. Not an "all
 * quiet" push. A daily notification that fires whether or not anything happened
 * is 100% noise by construction, and the day it matters is the day it gets
 * swiped away. `test/daily-digest.test.js` asserts the quiet day produces no
 * preparation at all.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DEPARTURE 1 — NO BADGE ON THE DIGEST.
 *   D7 asks for `badge = count of pending proposals`. This file omits the badge
 *   deliberately. iOS gives the app ONE badge number and it already means
 *   "unread customer messages plus missed calls nobody has looked at", written
 *   in two places on the client and reconciled on every message push. A digest
 *   carrying a proposal count would overwrite a live operational count with an
 *   unrelated number, and lib/apns-notify.js already documents that rule for
 *   the release notification for the same reason. Making the badge mean
 *   proposals as well needs a decision about what the badge IS, which is a
 *   bigger change than this one.
 *
 * DEPARTURE 2 — NO LIFETIME-VALUE FLOOR ON THE CRITICAL-SEGMENT EXCEPTION.
 *   D4 pairs `delta >= 1` for revenue-critical segments with "notify on a
 *   single customer only if their LTV exceeds a threshold". A recompute summary
 *   carries counts, not people, and reaching for per-member lifetime value here
 *   would mean this pure module reading customer records. It is also the wrong
 *   place: `lib/campaigns/opportunity-sizing.js` is the honesty boundary for
 *   any claim about customer value and it refuses several of them by
 *   construction. The exception is therefore limited to a short, named list of
 *   segments that are small and high-intent BY DEFINITION, which is a
 *   structural proxy for the same idea and needs no per-person read.
 *
 * COPY RULES
 *   No em dashes, matching lib/campaigns/segment-notifications.js, asserted
 *   here rather than described so it survives a future edit. No customer names
 *   and no phone numbers: counts and our own segment names only, per HIG and
 *   App Review 4.5.4. Sentence case, matching every other push in this
 *   application; D7 asks for title case and that is DEPARTURE 3, taken because
 *   one push in a different case from the other four reads as a mistake.
 */

const crypto = require('crypto');

const ELIGIBLE_ROLES = new Set(['owner', 'admin']);
const MAX_TITLE = 120;
const MAX_BODY = 500;

/**
 * GATE 4. Past this many material segments the body cannot name them all, so
 * the change set is too diffuse to interrupt for and the digest is suppressed.
 */
const MAX_NAMED_SEGMENTS = 3;

/** GATE 2. Conjoined, per D4. */
const DEFAULT_ABSOLUTE_FLOOR = 3;
const DEFAULT_RELATIVE_FLOOR = 0.10;
/** GATE 2, the revenue-critical exception. */
const CRITICAL_ABSOLUTE_FLOOR = 1;

/**
 * The small, high-intent lists where one arrival is worth saying.
 *
 * All three are "this specific person is ready to hear from you right now"
 * rather than "this person is in a category". The same-product reorder engine
 * finds single digits out of 781 buyers, and a restock paired with a person who
 * is nearly due is the narrowest and best-timed list in the product.
 */
const DEFAULT_CRITICAL_SEGMENTS = Object.freeze([
  'reorder_due_high_confidence',
  'reorder_due',
  'back_in_stock_nearly_due'
]);

/** GATE 3. Round numbers a segment crossing is news again even if repeated. */
const ROUND_THRESHOLDS = Object.freeze([10, 25, 50, 100]);

/**
 * Research S5.5. More than half the catalogue moving in one run is a bug or a
 * data event, not that many simultaneous business developments.
 *
 * The minimum matters as much as the fraction. "More than half" is meaningless
 * over a handful of segments: one material change out of one considered is
 * 100 per cent and is a perfectly ordinary quiet-catalogue day. The research
 * states the rule as "more than 6 of 12", so the breaker only engages once
 * there are enough segments for the ratio to say anything, and below that the
 * ATTRIBUTABLE gate is what bounds how many can be reported at once.
 */
const CIRCUIT_BREAKER_FRACTION = 0.5;
const CIRCUIT_BREAKER_MIN_SEGMENTS = 6;

/** Research S5.4. */
const DEFAULT_BULK_CHANGE_FRACTION = 0.15;

/** GATE 3. How many previous days of headlines suppress a repeat. */
const DEFAULT_NOVELTY_DAYS = 3;

function wholeNumber(value, fallback, { min = 0, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function fraction(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function csv(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  return parts.length ? Object.freeze(parts) : fallback;
}

/**
 * Resolve every threshold from configuration.
 *
 * `SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA` already existed and governs the
 * per-segment push somebody gets after pressing Recompute. It participates here
 * as a LOWER BOUND on the absolute floor rather than being replaced, so raising
 * the old setting raises both and the two can never contradict each other in a
 * way that makes the daily digest louder than the interactive push it
 * summarises.
 */
function materialityThresholds(env = process.env) {
  const existing = wholeNumber(env?.SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA, 1, { min: 1 });
  const digest = wholeNumber(env?.DAILY_DIGEST_MIN_DELTA, DEFAULT_ABSOLUTE_FLOOR, { min: 1 });
  return {
    absoluteFloor: Math.max(existing, digest),
    relativeFloor: fraction(env?.DAILY_DIGEST_MIN_RELATIVE_DELTA, DEFAULT_RELATIVE_FLOOR),
    criticalFloor: Math.max(
      1, wholeNumber(env?.DAILY_DIGEST_CRITICAL_MIN_DELTA, CRITICAL_ABSOLUTE_FLOOR, { min: 1 })),
    criticalSegments: csv(env?.DAILY_DIGEST_CRITICAL_SEGMENTS, DEFAULT_CRITICAL_SEGMENTS),
    bulkChangeFraction: fraction(env?.DAILY_DIGEST_BULK_CHANGE_FRACTION, DEFAULT_BULK_CHANGE_FRACTION),
    noveltyDays: wholeNumber(env?.DAILY_DIGEST_NOVELTY_DAYS, DEFAULT_NOVELTY_DAYS, { min: 0, max: 30 })
  };
}

/** `up`, `down` or `mixed`. The direction a headline claim is hashed on. */
function directionOf(joined, left) {
  if (joined > 0 && left > 0) return 'mixed';
  if (joined > 0) return 'up';
  if (left > 0) return 'down';
  return 'flat';
}

/**
 * GATE 3's key. SEGMENT PLUS DIRECTION, never the count.
 *
 * Hashing the count would make every day novel and the gate would do nothing,
 * which is the whole failure it exists to prevent.
 */
function headlineHash(material) {
  const claim = material
    .map(entry => `${entry.key}:${entry.direction}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(claim).digest('hex').slice(0, 32);
}

/** Did the segment cross one of the round numbers in this move? */
function crossedRoundThreshold(previousCount, memberCount) {
  const low = Math.min(previousCount, memberCount);
  const high = Math.max(previousCount, memberCount);
  return ROUND_THRESHOLDS.some(mark => low < mark && high >= mark);
}

/**
 * GATE 2 for one segment.
 *
 * @param {object} change  { key, joinedCount, leftCount, memberCount,
 *                           previousCount, baseline }
 * @param {object} thresholds  from materialityThresholds()
 */
function segmentMateriality(change = {}, thresholds = {}) {
  const joined = Math.max(0, Number(change.joinedCount) || 0);
  const left = Math.max(0, Number(change.leftCount) || 0);
  const memberCount = Math.max(0, Number(change.memberCount) || 0);
  const previousCount = Math.max(0, Number(change.previousCount) || 0);
  const delta = joined + left;
  const key = String(change.key || '');
  const direction = directionOf(joined, left);

  const critical = (thresholds.criticalSegments || DEFAULT_CRITICAL_SEGMENTS).includes(key);
  const absoluteFloor = critical
    ? Math.max(1, Number(thresholds.criticalFloor) || CRITICAL_ABSOLUTE_FLOOR)
    : Math.max(1, Number(thresholds.absoluteFloor) || DEFAULT_ABSOLUTE_FLOOR);
  const relativeFloor = Number.isFinite(thresholds.relativeFloor)
    ? thresholds.relativeFloor
    : DEFAULT_RELATIVE_FLOOR;
  // CONJOINED, per D4: both tests, which is what `max` computes.
  const required = Math.max(absoluteFloor, Math.ceil(relativeFloor * previousCount));
  const base = { delta, required, direction, critical, key };

  // COLD START. This segment has never been computed, so everyone in it
  // "joined". Recorded, never reported. See research S5.4.
  if (change.baseline === true) return { material: false, reason: 'baseline', ...base };
  if (delta === 0) return { material: false, reason: 'no_movement', ...base };
  // Net-zero churn is interesting in the app and is not push worthy: three in
  // and three out of the same list is the same list. Research S5.3.
  if (joined > 0 && left > 0 && memberCount === previousCount) {
    return { material: false, reason: 'net_zero_churn', ...base };
  }
  if (previousCount === 0 && memberCount > 0) {
    return { material: true, reason: 'became_populated', ...base };
  }
  if (previousCount > 0 && memberCount === 0) {
    return { material: true, reason: 'became_empty', ...base };
  }
  if (delta >= required) return { material: true, reason: 'threshold', ...base };
  return { material: false, reason: 'below_threshold', ...base };
}

/**
 * GATE 3 over the whole digest.
 *
 * @param {object} options
 * @param {Array}  options.material    the segments that passed gate 2
 * @param {Array}  options.recentHashes headline hashes from the last N days
 * @returns {{novel: boolean, hash: string, reason: string}}
 */
function noveltyVerdict({ material = [], recentHashes = [] } = {}) {
  const hash = headlineHash(material);
  if (!recentHashes.includes(hash)) return { novel: true, hash, reason: 'new_claim' };
  // Two documented exceptions re-open the gate.
  const reversed = material.some(entry => entry.reversedDirection === true);
  if (reversed) return { novel: true, hash, reason: 'direction_reversed' };
  const crossed = material.some(entry =>
    crossedRoundThreshold(entry.previousCount, entry.memberCount));
  if (crossed) return { novel: true, hash, reason: 'crossed_round_threshold' };
  return { novel: false, hash, reason: 'same_claim_as_recent_day' };
}

function plural(count, singular, pluralForm) {
  return Number(count) === 1 ? singular : pluralForm;
}

/**
 * GATE 4's copy. Every material segment is named. There is no "and N others"
 * branch, deliberately: the moment the list is too long to name, the digest is
 * suppressed instead of being made vague.
 */
function movementSentence(material) {
  const names = material.map(entry => entry.name);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const people = material.reduce((total, entry) => total + entry.delta, 0);
  return `${people} ${plural(people, 'person', 'people')} moved in ${list}.`;
}

function silence(reason, extra = {}) {
  return {
    send: false,
    reason,
    material: [],
    considered: [],
    notifications: [],
    title: null,
    body: null,
    headlineHash: null,
    ...extra
  };
}

/**
 * Build the digest, or state why there is nothing to send.
 *
 * @param {object} options
 * @param {Array}  options.users     [{ id, role, isActive, canManageCampaigns }]
 * @param {Array}  options.segments  [{ key, name, joinedCount, leftCount,
 *                                      memberCount, previousCount, baseline }]
 * @param {number} [options.proposalsDrafted]
 * @param {Array}  [options.failures] [{ key, name, code }]
 * @param {boolean}[options.coldStart]        no completed cycle before this one
 * @param {number} [options.customerCount]        this run
 * @param {number} [options.previousCustomerCount] the run before
 * @param {Array}  [options.recentHashes]     headline hashes, recent days first
 * @param {Array}  [options.recentDirections] [{key, direction}] from yesterday
 * @param {string} [options.localDay]         `YYYY-MM-DD` in the RECIPIENT's zone
 * @param {object} [options.env]
 * @param {Date|string} [options.generatedAt]
 */
function prepareDailyDigest({
  users = [],
  segments = [],
  proposalsDrafted = 0,
  failures = [],
  coldStart = false,
  customerCount = null,
  previousCustomerCount = null,
  recentHashes = [],
  recentDirections = [],
  localDay = null,
  env = process.env,
  generatedAt = new Date()
} = {}) {
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid date.');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(localDay || ''))
    ? String(localDay)
    : generated.toISOString().slice(0, 10);

  const thresholds = materialityThresholds(env);

  // COLD START. The first ever pass has no prior state to compare against, so
  // every membership looks like an arrival. Baseline recorded, nothing sent.
  if (coldStart === true) return silence('cold_start');

  // BULK IMPORT. Not customer behaviour, so not the digest's subject.
  if (Number.isFinite(customerCount) && Number.isFinite(previousCustomerCount)
      && previousCustomerCount > 0) {
    const moved = Math.abs(customerCount - previousCustomerCount) / previousCustomerCount;
    if (moved > thresholds.bulkChangeFraction) {
      return silence('bulk_change_detected', { customerCount, previousCustomerCount });
    }
  }

  const yesterday = new Map((recentDirections || [])
    .map(entry => [String(entry?.key || ''), String(entry?.direction || '')]));

  const considered = (segments || []).map(segment => {
    const verdict = segmentMateriality(segment, thresholds);
    const previousDirection = yesterday.get(verdict.key) || null;
    return {
      key: verdict.key,
      name: String(segment.name || segment.key || 'a segment'),
      joinedCount: Math.max(0, Number(segment.joinedCount) || 0),
      leftCount: Math.max(0, Number(segment.leftCount) || 0),
      memberCount: Math.max(0, Number(segment.memberCount) || 0),
      previousCount: Math.max(0, Number(segment.previousCount) || 0),
      previousDirection,
      reversedDirection: Boolean(previousDirection)
        && previousDirection !== verdict.direction
        && ['up', 'down'].includes(previousDirection)
        && ['up', 'down'].includes(verdict.direction),
      ...verdict
    };
  });

  // Biggest movement first, so the body names the segments that moved most.
  // Ties break on key, so a given day's wording is reproducible and the
  // headline hash is stable.
  const material = considered
    .filter(entry => entry.material)
    .sort((left, right) => right.delta - left.delta || left.key.localeCompare(right.key));

  const drafted = Math.max(0, Number(proposalsDrafted) || 0);
  const failed = (failures || []).map(entry => ({
    key: String(entry?.key || ''),
    name: String(entry?.name || entry?.key || 'a segment'),
    code: String(entry?.code || 'unknown')
  }));

  // THE CIRCUIT BREAKER. Research S5.5. Logged by the caller, not sent.
  if (considered.length >= CIRCUIT_BREAKER_MIN_SEGMENTS
      && material.length > considered.length * CIRCUIT_BREAKER_FRACTION) {
    return silence('circuit_breaker', {
      materialCount: material.length, consideredCount: considered.length
    });
  }

  if (!material.length && !drafted && !failed.length) return silence('nothing_material');

  // GATE 4 — ATTRIBUTABLE. Too many to name is too diffuse to send.
  if (material.length > MAX_NAMED_SEGMENTS) {
    return silence('too_diffuse', { materialCount: material.length });
  }

  // GATE 3 — NOVEL. Only applied when segment movement is the story: a new
  // proposal or a failed recompute is news on its own however familiar the
  // segment movement beside it is.
  const novelty = noveltyVerdict({ material, recentHashes });
  if (material.length && !drafted && !failed.length && !novelty.novel) {
    return silence('not_novel', { headlineHash: novelty.hash });
  }

  const recipients = (users || [])
    .filter(user => user?.isActive === true && ELIGIBLE_ROLES.has(String(user.role || '').toLowerCase()))
    .filter(user => user.canManageCampaigns === true);
  if (!recipients.length) return silence('no_eligible_recipients');

  const sentences = [];
  if (material.length) sentences.push(movementSentence(material));
  if (drafted > 0) {
    sentences.push(`${drafted} campaign ${plural(drafted, 'proposal is', 'proposals are')} waiting for review.`);
  }
  if (failed.length) {
    // Never rounded down to "all quiet". A digest reporting success on a day a
    // recompute threw would be worse than no digest at all.
    sentences.push(
      `${failed.length} ${plural(failed.length, 'segment', 'segments')} could not be rechecked.`
    );
  }

  const headline = material.length
    ? `Audiences moved in ${material.length} ${plural(material.length, 'segment', 'segments')}`
    : (drafted > 0 ? 'Campaign proposals ready' : 'Some segments could not be rechecked');
  const title = headline.slice(0, MAX_TITLE);
  const body = sentences.join(' ').slice(0, MAX_BODY);

  if (title.includes('—') || body.includes('—')) {
    // Defensive, matching lib/campaigns/segment-notifications.js. A rule that
    // lives only in a comment lasts one release.
    throw new Error('Notification copy must not contain an em dash.');
  }

  const notifications = recipients.map(user => ({
    userID: String(user.id),
    channel: 'native_push_preparation',
    eventType: 'notifications.daily_digest',
    // D6, defence in depth: `digest-{userId}-{localDate}`. If a bug ever
    // double-sends, APNs merges the two rather than stacking them, and two
    // people never share a banner.
    collapseID: `digest-${user.id}-${day}`,
    payload: {
      aps: {
        alert: { title, body },
        sound: 'default',
        // D7.
        'thread-id': 'segment-digest',
        category: 'SEGMENT_DIGEST',
        // D1. `active`, never `time-sensitive`: a summary of yesterday's
        // arithmetic must not break through a Focus the person set
        // deliberately. That is how an app earns a global mute.
        'interruption-level': 'active',
        // D1. High, so that if it lands in a Scheduled Summary it leads it.
        'relevance-score': 0.9
        // No badge. See DEPARTURE 1 in the header.
      },
      screen: 'segments',
      digestDay: day,
      materialSegmentCount: material.length,
      proposalCount: drafted,
      failedSegmentCount: failed.length
    },
    metadata: {
      segments: material.map(entry => ({
        key: entry.key, delta: entry.delta, direction: entry.direction, reason: entry.reason
      })),
      failures: failed,
      thresholds,
      novelty,
      generatedAt: generated.toISOString()
    }
  }));

  return {
    send: true,
    reason: null,
    material,
    considered,
    notifications,
    title,
    body,
    headlineHash: novelty.hash,
    directions: material.map(entry => ({ key: entry.key, direction: entry.direction }))
  };
}

module.exports = {
  CIRCUIT_BREAKER_FRACTION,
  CIRCUIT_BREAKER_MIN_SEGMENTS,
  CRITICAL_ABSOLUTE_FLOOR,
  DEFAULT_ABSOLUTE_FLOOR,
  DEFAULT_BULK_CHANGE_FRACTION,
  DEFAULT_CRITICAL_SEGMENTS,
  DEFAULT_NOVELTY_DAYS,
  DEFAULT_RELATIVE_FLOOR,
  MAX_NAMED_SEGMENTS,
  ROUND_THRESHOLDS,
  crossedRoundThreshold,
  directionOf,
  headlineHash,
  materialityThresholds,
  movementSentence,
  noveltyVerdict,
  prepareDailyDigest,
  segmentMateriality
};
