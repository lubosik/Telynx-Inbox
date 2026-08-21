'use strict';
/**
 * lib/release-targets.js — decides which registered iPhones should be told
 * that a new build exists.
 *
 * Kept pure and separate from `lib/apns-notify.js` so the decision can be
 * tested offline. The I/O around it (loading devices, opening the APNs
 * connection) stays thin, matching `lib/unread-count.js`.
 *
 * TWO WAYS TO NARROW A SEND, and the difference matters:
 *
 *   userId      — "this person's iPhones". Correct once a device has been
 *                 registered by a signed-in user. Never guess it.
 *   belowBuild  — "iPhones not already running this build". This is the right
 *                 filter for a release announcement regardless of identity: it
 *                 is self-correcting (a device stops matching the moment it
 *                 updates and re-registers) and idempotent (re-running after
 *                 everyone has updated sends to nobody).
 *
 * FAIL OPEN ON AN UNKNOWN BUILD. A device whose build we cannot determine is
 * included, not skipped. Telling someone twice is a nuisance; silently failing
 * to tell the one person who needed the message is the failure that matters.
 */

/**
 * `Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0` → 21.
 *
 * Deliberately anchored to OUR product token, not to any `name/version` pair.
 * A User-Agent carries several of them, and an unanchored match against
 * `CFNetwork/3860 Darwin/25.6.0` yields 3860 — which would read as "already on
 * a newer build" and quietly exclude the one device that needed telling. The
 * product name decodes to `Vici Inbox` (a space in it), so the pattern allows
 * spaces and matches both this app and the Shore fork.
 */
const USER_AGENT_BUILD = /^[\w .-]*inbox\/(\d{1,9})(?=\s|$)/i;

/**
 * The build a device is running, or null when it cannot be determined.
 * `app_build` is the explicit field sent by newer clients; the User-Agent is
 * the fallback for clients that predate it.
 */
function deviceBuild(row) {
  const explicit = String(row?.app_build ?? '').trim();
  if (/^\d{1,9}$/.test(explicit)) return Number(explicit);

  const agent = row?.user_agent;
  if (typeof agent !== 'string' || !agent) return null;
  let decoded = agent;
  try { decoded = decodeURIComponent(agent); } catch { /* keep the raw value */ }
  const match = USER_AGENT_BUILD.exec(decoded);
  return match ? Number(match[1]) : null;
}

/**
 * @param {Array} devices  normalised device rows, from either storage
 * @param {object} filters
 * @param {string|null} filters.userId      only this user's devices
 * @param {number|null} filters.belowBuild  only devices not already on this build
 * @returns {Array} the subset to notify — never the whole set by accident
 */
function selectReleaseTargets(devices, { userId = null, belowBuild = null } = {}) {
  const rows = Array.isArray(devices) ? devices.filter(Boolean) : [];

  const wantsUser = typeof userId === 'string' && userId.length > 0;
  // Not `Number(belowBuild)`: Number(null) is 0, which is finite, so an absent
  // filter would read as "exclude anything built after the dawn of time" and
  // silently return nobody.
  const floor = belowBuild === null || belowBuild === undefined || belowBuild === ''
    ? NaN
    : Number(belowBuild);
  const wantsBuild = Number.isFinite(floor);

  return rows.filter(row => {
    if (!row.device_token) return false;

    // A device with no owner is never returned by an owner-scoped send. A
    // release note reaching the wrong person is harmless; an admin action
    // reaching the wrong person is not, and this function serves both.
    if (wantsUser && row.user_id !== userId) return false;

    if (wantsBuild) {
      const build = deviceBuild(row);
      if (build !== null && build >= floor) return false;
    }

    return true;
  });
}

module.exports = { selectReleaseTargets, deviceBuild };
