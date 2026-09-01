'use strict';
/**
 * lib/campaigns/offer-timing.js — when a reply-triggered offer may actually go
 * out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A REPLY NEEDS QUIET HOURS AT ALL
 *
 *   check-in-reply sends the moment somebody answers, and its justification is
 *   written into that file: it is a reply to an inbound message, seconds after
 *   the customer wrote first. That reasoning is sound for a thank-you and it
 *   thins out as the commercial content grows. At 20% off it is a marketing
 *   message that happens to be prompted by a reply, and a marketing message at
 *   03:00 is a marketing message at 03:00.
 *
 *   The campaign path has enforced quiet hours in SQL since the first
 *   migration. This path never passed through it, so the one send that is
 *   guaranteed to arrive while somebody is awake enough to text back was also
 *   the one with no clock on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES NOT DO
 *
 *   It does not hold the reply. Somebody who texts at 03:00 still gets an
 *   answer at 03:00 — that is a conversation and delaying it would be rude.
 *   Only the OFFER waits for a civil hour.
 */

/** Matches the campaign settings defaults: 20:00 to 09:00 in the shop's zone. */
const DEFAULT_QUIET_START_HOUR = 20;
const DEFAULT_QUIET_END_HOUR = 9;
const DEFAULT_TIMEZONE = 'America/New_York';

/** The hour and minute in a given zone, without pulling in a date library. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type) => Number(parts.find(p => p.type === type)?.value ?? 0);
  // Midnight can format as 24 in some environments; normalise so comparisons
  // against an hour range behave.
  return { hour: get('hour') % 24, minute: get('minute') };
}

/**
 * Is this moment inside quiet hours?
 *
 * The window wraps midnight, which is the case a naive `start <= h < end`
 * comparison gets exactly backwards: with start 20 and end 9 it would call
 * 22:00 fine and 12:00 quiet.
 */
function inQuietHours(now, {
  startHour = DEFAULT_QUIET_START_HOUR,
  endHour = DEFAULT_QUIET_END_HOUR,
  timeZone = DEFAULT_TIMEZONE
} = {}) {
  const { hour } = zonedParts(now, timeZone);
  if (startHour === endHour) return false;
  return startHour > endHour
    ? (hour >= startHour || hour < endHour)   // wraps midnight
    : (hour >= startHour && hour < endHour);
}

/**
 * When the offer should be sent: now, or the next moment quiet hours end.
 *
 * Returns `{ sendNow, sendAt, reason }`. `sendAt` is a Date on the boundary —
 * 09:00 in the shop's zone — computed by stepping forward in whole hours from
 * now rather than by constructing a local datetime, because constructing one
 * requires knowing the zone's offset on that particular date and gets daylight
 * saving wrong twice a year.
 */
function whenToSendOffer(now = new Date(), options = {}) {
  if (!inQuietHours(now, options)) {
    return { sendNow: true, sendAt: null, reason: 'within_business_hours' };
  }

  const step = new Date(now.getTime());
  // At most a full day of hours; the loop cannot run away even if a zone or a
  // setting is nonsense.
  for (let i = 0; i < 24 * 60; i += 1) {
    step.setTime(step.getTime() + 60 * 1000);
    if (!inQuietHours(step, options)) {
      // Land on the minute quiet hours end rather than mid-hour.
      return { sendNow: false, sendAt: step, reason: 'held_for_quiet_hours' };
    }
  }
  // Unreachable unless quiet hours are configured as the whole day, which
  // inQuietHours already refuses by returning false when start === end.
  return { sendNow: true, sendAt: null, reason: 'quiet_hours_unresolvable' };
}

module.exports = {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  DEFAULT_TIMEZONE,
  inQuietHours,
  whenToSendOffer
};
