'use strict';
/**
 * lib/campaigns/segment-membership.js — the reconciliation rule for an
 * automatic segment, as a pure function.
 *
 * THE RULE THIS FILE EXISTS FOR
 *   A manual exclusion survives recompute. If an operator says "never put this
 *   person in Due to reorder again", the engine must not quietly reinstate them
 *   on the next run, and the exclusion must stay in force until somebody
 *   revokes it explicitly.
 *
 *   That rule is easy to state and easy to lose. It is lost the moment
 *   exclusions live on the member rows, because recompute rewrites member
 *   rows. So exclusions live in their own table, this function reads them as
 *   an input, and the database ALSO refuses an excluded insert through a
 *   trigger. Two independent enforcements, because one of them will eventually
 *   be edited by somebody who has not read this comment.
 *
 * THE OTHER RULES
 *   - A force-included person stays a member whether or not the engine matched
 *     them, and keeps their human reason as inclusion_evidence. What the engine
 *     thought is recorded separately as engineMatched/engineEvidence, so the UI
 *     can say "kept by a person, the engine no longer agrees".
 *   - Recompute is idempotent. Running it twice on the same computed set
 *     produces an identical membership and reports zero joined and zero left
 *     the second time.
 *   - An exclusion beats a force-include. They cannot both be active on one
 *     person (the database has a partial unique index), but if a caller ever
 *     supplies both, refusing to include is the safe direction.
 *
 * This function reads no database and returns plain data. Persistence is
 * lib/campaigns/segment-service.js plus the RPC in
 * scripts/campaign-segments-migration.sql.
 */

const crypto = require('node:crypto');

/** An override row is in force only while it has not been revoked. */
function activeOverrides(overrides = []) {
  const include = new Set();
  const exclude = new Set();
  for (const row of overrides) {
    if (!row || row.revokedAt || row.revoked_at) continue;
    const phone = String(row.contactPhone || row.contact_phone || '');
    if (!phone) continue;
    const type = String(row.overrideType || row.override_type || '');
    if (type === 'exclude') exclude.add(phone);
    else if (type === 'include') include.add(phone);
  }
  // An exclusion wins. See the header.
  for (const phone of exclude) include.delete(phone);
  return { include, exclude };
}

function normaliseExisting(rows = []) {
  const byPhone = new Map();
  for (const row of rows) {
    const phone = String(row?.contactPhone || row?.contact_phone || '');
    if (!phone) continue;
    byPhone.set(phone, {
      contactPhone: phone,
      membershipSource: String(row.membershipSource || row.membership_source || 'computed'),
      inclusionEvidence: row.inclusionEvidence || row.inclusion_evidence || {},
      engineMatched: (row.engineMatched ?? row.engine_matched) === true
    });
  }
  return byPhone;
}

function normaliseComputed(rows = []) {
  const byPhone = new Map();
  for (const row of rows) {
    const phone = String(row?.contactPhone || row?.contact_phone || '');
    if (!phone) continue;
    // First occurrence wins; computeSegmentMembers already deduplicates, and a
    // second source of truth for "which duplicate" would make the run digest
    // depend on input order.
    if (byPhone.has(phone)) continue;
    byPhone.set(phone, {
      contactPhone: phone,
      contactID: row.contactID ?? row.contact_id ?? null,
      contactName: row.contactName ?? row.contact_name ?? null,
      inclusionEvidence: row.inclusionEvidence || row.inclusion_evidence || {}
    });
  }
  return byPhone;
}

/**
 * A stable digest of the computed set. Two recomputes that see identical facts
 * produce the same digest, which is what makes a replayed run recognisable.
 *
 * @param {Array} computed
 * @returns {string} sha256 hex
 */
function computedSetDigest(computed = []) {
  const stable = [...normaliseComputed(computed).values()]
    .map(row => [row.contactPhone, JSON.stringify(sortedKeys(row.inclusionEvidence))])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedKeys(v)])
  );
}

/**
 * Reconcile one recompute.
 *
 * @param {object} options
 * @param {Array} options.existing   current member rows
 * @param {Array} options.computed   what the engine matched this run
 * @param {Array} options.overrides  every override row, revoked ones included
 * @returns {{
 *   members: Array, submit: Array, joined: Array, left: Array, refreshed: Array,
 *   blockedByExclusion: Array, keptByOverride: Array, summary: object
 * }}
 *   `submit` is the set to hand to the recompute RPC. It never contains an
 *   actively excluded phone.
 */
function reconcileSegmentMembership({ existing = [], computed = [], overrides = [] } = {}) {
  const { include, exclude } = activeOverrides(overrides);
  const existingByPhone = normaliseExisting(existing);
  const computedByPhone = normaliseComputed(computed);

  const submit = [];
  const joined = [];
  const refreshed = [];
  const blockedByExclusion = [];

  for (const [phone, row] of computedByPhone) {
    if (exclude.has(phone)) {
      blockedByExclusion.push(phone);
      continue;
    }
    submit.push(row);
    if (existingByPhone.has(phone)) refreshed.push(phone);
    else joined.push(phone);
  }

  const submitted = new Set(submit.map(row => row.contactPhone));
  const left = [];
  const keptByOverride = [];
  for (const [phone, row] of existingByPhone) {
    if (submitted.has(phone)) continue;
    if (row.membershipSource === 'forced_include' && !exclude.has(phone)) {
      keptByOverride.push(phone);
      continue;
    }
    left.push(phone);
  }

  const members = [];
  for (const row of submit) {
    const previous = existingByPhone.get(row.contactPhone);
    const forced = previous?.membershipSource === 'forced_include' || include.has(row.contactPhone);
    members.push({
      contactPhone: row.contactPhone,
      contactID: row.contactID,
      contactName: row.contactName,
      membershipSource: forced ? 'forced_include' : 'computed',
      // A forced include keeps the human reason it was created with.
      inclusionEvidence: forced && previous ? previous.inclusionEvidence : row.inclusionEvidence,
      engineMatched: true,
      engineEvidence: row.inclusionEvidence
    });
  }
  for (const phone of keptByOverride) {
    const previous = existingByPhone.get(phone);
    members.push({
      contactPhone: phone,
      contactID: null,
      contactName: null,
      membershipSource: 'forced_include',
      inclusionEvidence: previous.inclusionEvidence,
      engineMatched: false,
      engineEvidence: null
    });
  }
  members.sort((a, b) => a.contactPhone.localeCompare(b.contactPhone));

  return {
    members,
    submit: submit.slice().sort((a, b) => a.contactPhone.localeCompare(b.contactPhone)),
    joined: joined.sort(),
    left: left.sort(),
    refreshed: refreshed.sort(),
    blockedByExclusion: blockedByExclusion.sort(),
    keptByOverride: keptByOverride.sort(),
    summary: {
      memberCount: members.length,
      joinedCount: joined.length,
      leftCount: left.length,
      refreshedCount: refreshed.length,
      forcedIncludeCount: members.filter(row => row.membershipSource === 'forced_include').length,
      excludedCount: blockedByExclusion.length
    }
  };
}

/**
 * Is this change worth waking an Admin at? Deterministic on purpose: a rule
 * an operator can predict is a rule they will not mute.
 *
 * @param {object} summary  reconcileSegmentMembership().summary
 * @param {object} [options]
 * @param {boolean} [options.created]     the segment did not exist before
 * @param {number} [options.minimumDelta] members joining or leaving before it counts
 */
function isMaterialSegmentChange(summary = {}, { created = false, minimumDelta = 1 } = {}) {
  if (created === true) return true;
  const delta = Number(summary.joinedCount || 0) + Number(summary.leftCount || 0);
  const threshold = Math.max(1, Number.parseInt(minimumDelta, 10) || 1);
  return delta >= threshold;
}

module.exports = {
  activeOverrides,
  computedSetDigest,
  isMaterialSegmentChange,
  reconcileSegmentMembership
};
