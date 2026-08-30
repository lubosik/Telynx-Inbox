'use strict';
/**
 * lib/campaigns/audience-health.js — is this audience fit to be messaged?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO QUESTIONS NOTHING WAS ASKING AT BUILD TIME
 *
 *   1. HAS THIS PERSON HEARD FROM US TOO RECENTLY? Not from this campaign,
 *      which the recipe dedupe already covers, but from ANY campaign. A
 *      customer who got a win-back on Tuesday and a clearance on Wednesday has
 *      been messaged twice in two days by a business that thinks it is
 *      running two separate careful campaigns.
 *
 *      The SQL claim function does enforce spacing and rolling caps, and it is
 *      the authority. But it enforces them at SEND time, one recipient at a
 *      time, by deferring. So a campaign of 376 could be approved, scheduled,
 *      and then quietly deliver to 200, with the operator discovering the
 *      difference afterwards. Applying the same thresholds at BUILD time does
 *      not replace that gate; it makes the number on screen honest.
 *
 *   2. IS THIS ENOUGH PEOPLE TO BE A CAMPAIGN AT ALL? A promotional send to
 *      four people is not a campaign, it is a mail merge with a coupon budget.
 *      It cannot be measured, it cannot be learned from, and the effort of
 *      reviewing and approving it costs more than the four orders are worth.
 *
 *      A check-in is different and is deliberately exempt: it is a service
 *      message to whoever happened to order three weeks ago, and one person is
 *      a perfectly good reason to ask one person how their order went.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHERE THE NUMBERS COME FROM
 *
 *   The spacing and the caps are read from `sms_campaign_settings`, the same
 *   row the SQL gate reads, so the two cannot drift. They are currently 24
 *   hours, 2 per 7 days and 4 per 30 days.
 *
 *   The audience floor is this file's own, because nothing else had an
 *   opinion. See MINIMUM_MARKETING_AUDIENCE.
 */

const { normalisePhone } = require('../phone');
const { selectIn } = require('../fetch-all-rows');

/**
 * Fewest people a promotional campaign may reach.
 *
 * Twenty-five. Below that a send is not a campaign: at a 5% response you are
 * waiting on one reply, so nothing about it can be measured, and the review,
 * the approval and the coupon minting cost more than the outcome.
 *
 * Deliberately NOT the 100 that buyer-cohorts.js calls `actionableFloorPeople`.
 * That number answers "can I draw a conclusion from how this performed", which
 * is a stricter question than "is this worth sending", and using it here would
 * refuse a perfectly sensible clearance to forty people. Below 100 the result
 * is reported as unmeasurable rather than refused.
 */
const MINIMUM_MARKETING_AUDIENCE = 25;

/** Below this the campaign can be sent but its result means little. */
const MEASURABLE_AUDIENCE = 100;

/**
 * Workflow categories exempt from the floor.
 *
 * A check-in is a service message to whoever ordered three weeks ago, and some
 * weeks that is one person. Refusing to ask them how their order went because
 * there is only one of them would be the floor doing harm.
 */
const FLOOR_EXEMPT_CATEGORIES = new Set(['checkin_21d']);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Everyone who has had a promotional message recently, and how recently.
 *
 * Reads `sms_commercial_contact_ledger`, which the SQL claim function writes on
 * every promotional send. Empty until the first campaign goes out, which is
 * correct rather than broken: nobody has been messaged yet.
 */
async function recentPromotionalContact({ client, phones, now, windowDays, workspaceID = 'vici' }) {
  const rows = await selectIn(
    client,
    'sms_commercial_contact_ledger',
    'contact_phone, accepted_at, classification',
    'contact_phone',
    phones
  ).catch(error => {
    // The table arrives with the campaigns migration. Absent means nothing has
    // been sent, which is true rather than an error.
    if (/does not exist|42P01|PGRST205/.test(error.message)) return [];
    throw error;
  });

  const since = now.getTime() - windowDays * DAY_MS;
  const byPhone = new Map();
  for (const row of rows) {
    if (row.classification !== 'promotional') continue;
    const at = Date.parse(row.accepted_at);
    if (!Number.isFinite(at) || at < since) continue;
    const held = byPhone.get(row.contact_phone) || [];
    held.push(at);
    byPhone.set(row.contact_phone, held);
  }
  return byPhone;
}

/**
 * Filter an audience down to the people who may actually receive a campaign
 * today, and explain who was removed.
 *
 * The reasons are the same ones the SQL gate uses, so a person removed here
 * would have been deferred there. The difference is that here it happens
 * before the operator is asked to approve a number.
 */
async function assessAudience({
  client,
  phones,
  settings,
  now = new Date(),
  workflowCategory = 'custom',
  workspaceID = 'vici'
}) {
  const unique = [...new Set((phones || []).map(normalisePhone).filter(Boolean))];
  const spacingHours = Number(settings?.minimum_promotional_spacing_hours) || 24;
  const per7 = Number(settings?.max_promotional_per_7_days) || 2;
  const per30 = Number(settings?.max_promotional_per_30_days) || 4;

  const history = await recentPromotionalContact({
    client, phones: unique, now, windowDays: 30, workspaceID
  });

  const eligible = [];
  const removed = [];
  for (const phone of unique) {
    const times = history.get(phone) || [];
    const mostRecent = times.length ? Math.max(...times) : null;

    if (mostRecent !== null && now.getTime() - mostRecent < spacingHours * HOUR_MS) {
      removed.push({ phone, reason: 'messaged_too_recently' });
      continue;
    }
    if (times.filter(at => at >= now.getTime() - 7 * DAY_MS).length >= per7) {
      removed.push({ phone, reason: 'weekly_limit_reached' });
      continue;
    }
    if (times.length >= per30) {
      removed.push({ phone, reason: 'monthly_limit_reached' });
      continue;
    }
    eligible.push(phone);
  }

  const exempt = FLOOR_EXEMPT_CATEGORIES.has(workflowCategory);
  const belowFloor = !exempt && eligible.length > 0 && eligible.length < MINIMUM_MARKETING_AUDIENCE;

  const warnings = [];
  if (removed.length) {
    warnings.push({
      code: 'recently_messaged_removed',
      message: `${removed.length} ${removed.length === 1 ? 'person has' : 'people have'} had a campaign too recently and were left out.`
    });
  }
  if (!exempt && eligible.length >= MINIMUM_MARKETING_AUDIENCE && eligible.length < MEASURABLE_AUDIENCE) {
    warnings.push({
      code: 'below_measurable',
      message: `${eligible.length} people is enough to send but too few to learn much from. Treat the result as a signal, not a finding.`
    });
  }

  return {
    eligible,
    removed,
    reasons: removed.reduce((tally, row) => {
      tally[row.reason] = (tally[row.reason] || 0) + 1;
      return tally;
    }, {}),
    belowFloor,
    floor: MINIMUM_MARKETING_AUDIENCE,
    floorExempt: exempt,
    warnings,
    spacingHours,
    limits: { per7, per30 }
  };
}

module.exports = {
  FLOOR_EXEMPT_CATEGORIES,
  MEASURABLE_AUDIENCE,
  MINIMUM_MARKETING_AUDIENCE,
  assessAudience,
  recentPromotionalContact
};
