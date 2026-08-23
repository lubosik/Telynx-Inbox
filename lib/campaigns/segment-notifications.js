'use strict';
/**
 * lib/campaigns/segment-notifications.js — prepare, but never dispatch, the
 * push that tells Owners and Admins a segment moved.
 *
 * Same shape and same discipline as
 * lib/campaigns/campaign-ready-notifications.js: this module returns plain
 * data, resolves no devices, holds no Apple credential, and is safe to call in
 * a unit test. Delivery is lib/apns-notify.js, behind its own feature flag.
 *
 * HOUSE COPY RULE
 *   No em dashes in any notification text. Two short sentences instead. The
 *   test file asserts it, because a rule that lives only in a comment is a
 *   rule that lasts one release.
 */

const ELIGIBLE_ROLES = new Set(['owner', 'admin']);
const MAX_TITLE = 120;
const MAX_BODY = 500;

function plural(count, singular, pluralForm) {
  return Number(count) === 1 ? singular : pluralForm;
}

/**
 * The body text. Deliberately factual: a count, then what moved.
 */
function changeBody({ reason, memberCount, joinedCount, leftCount }) {
  const people = `${memberCount} ${plural(memberCount, 'person', 'people')}`;
  if (reason === 'created') {
    return `It starts with ${people}. Open Segments to see who is in it and why.`;
  }
  if (joinedCount > 0 && leftCount > 0) {
    return `${joinedCount} joined and ${leftCount} left. It now holds ${people}.`;
  }
  if (joinedCount > 0) {
    return `${joinedCount} ${plural(joinedCount, 'person', 'people')} joined. It now holds ${people}.`;
  }
  if (leftCount > 0) {
    return `${leftCount} ${plural(leftCount, 'person', 'people')} left. It now holds ${people}.`;
  }
  return `Membership was rechecked. It still holds ${people}.`;
}

/**
 * @param {object} options
 * @param {Array}  options.users     [{ id, role, isActive, canManageCampaigns }]
 * @param {object} options.segment   { id, key, name, kind }
 * @param {object} options.change    { reason: 'created'|'recomputed', memberCount,
 *                                     joinedCount, leftCount }
 * @param {Date|string} [options.generatedAt]
 * @returns {Array} notification preparations, one per eligible user
 */
function prepareSegmentChangeNotifications({
  users = [],
  segment = {},
  change = {},
  generatedAt = new Date()
} = {}) {
  const segmentID = String(segment.id || '').trim();
  const segmentName = String(segment.name || '').trim();
  if (!segmentID || !segmentName) return [];

  const reason = change.reason === 'created' ? 'created' : 'recomputed';
  const memberCount = Math.max(0, Number.parseInt(change.memberCount, 10) || 0);
  const joinedCount = Math.max(0, Number.parseInt(change.joinedCount, 10) || 0);
  const leftCount = Math.max(0, Number.parseInt(change.leftCount, 10) || 0);

  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid date.');

  const title = (reason === 'created'
    ? `New segment: ${segmentName}`
    : `Segment updated: ${segmentName}`).slice(0, MAX_TITLE);
  const body = changeBody({ reason, memberCount, joinedCount, leftCount }).slice(0, MAX_BODY);

  if (title.includes('—') || body.includes('—')) {
    // Defensive: a future edit that reintroduces an em dash fails loudly here
    // rather than shipping to a customer-facing device.
    throw new Error('Notification copy must not contain an em dash.');
  }

  return users
    .filter(user => user?.isActive === true && ELIGIBLE_ROLES.has(String(user.role || '').toLowerCase()))
    .filter(user => user.canManageCampaigns === true)
    .map(user => ({
      userID: String(user.id),
      channel: 'native_push_preparation',
      eventType: 'campaigns.segment_changed',
      collapseID: `vici-segment-${segmentID}`,
      payload: {
        aps: {
          alert: { title, body },
          sound: 'default',
          'thread-id': 'vici-campaign-segments'
        },
        screen: 'segments',
        segmentID,
        memberCount
      },
      metadata: {
        segmentKey: String(segment.key || ''),
        segmentKind: String(segment.kind || ''),
        reason,
        joinedCount,
        leftCount,
        generatedAt: generated.toISOString()
      }
    }));
}

module.exports = { changeBody, prepareSegmentChangeNotifications };
