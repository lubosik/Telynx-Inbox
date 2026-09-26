'use strict';
/**
 * lib/campaigns/check-in-automation.js — the 21-day check-in, running itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
 *
 *   The check-in used to be a recipe somebody pressed a button on: build the
 *   drafts, read them, approve, schedule. The owner asked for it to work like
 *   the order and payment-reminder messages instead — nobody presses anything,
 *   it just happens.
 *
 *   So this module presses the buttons. What it does NOT do is take a shortcut
 *   around them. It calls the same buildFromRecipe, the same approve, the same
 *   finalizeApproval and the same schedule that the app calls, in the same
 *   order, and the send itself still goes through the SQL claim function in
 *   scripts/campaigns-migration.sql like every other campaign.
 *
 *   That is the whole design. A second, quieter path to somebody's phone is
 *   how a business ends up messaging a person who opted out three months ago,
 *   and it looks like a working feature right up until it doesn't. There is
 *   one gate. This walks through it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE AUDIT LOG SAYS THE SYSTEM DID IT, BECAUSE THE SYSTEM DID IT
 *
 *   Approving a campaign writes a consent-bearing audit row naming who
 *   authorised messaging those people. The tempting move is to keep writing
 *   the owner's name so the records look uniform. That would be a false
 *   record of human review, and the audit log is the one place in this system
 *   whose entire value is being true.
 *
 *   These rows use the SYSTEM actor. If anybody ever asks who approved a
 *   given check-in, the honest answer — an automation the owner switched on,
 *   under a standing instruction — is the one the log gives.
 *
 * WHERE THE STANDING AUTHORISATION LIVES
 *
 *   In `sms_campaign_settings.checkin_automation_enabled`, one boolean the
 *   owner controls from the app. Off by default. Turning it off stops the
 *   next sweep; it does not recall a campaign already scheduled, which is
 *   what `cancel` is for.
 *
 * WHY IT CANNOT DOUBLE-SEND
 *
 *   Three independent reasons, which is the right number for this:
 *
 *     1. The recipe's own dedupe. `alreadyReached` subtracts anybody who has
 *        been in a `checkin_21d` campaign in the last 21 days, counting drafts,
 *        so a second sweep in the same week builds an EMPTY audience and stops.
 *     2. The sweep ledger below, which refuses to run twice in one daily window even
 *        if the dedupe were wrong.
 *     3. The claim function's per-phone advisory lock and frequency
 *        reservation, which is the backstop for every campaign, not just this.
 *
 * WHAT IT WILL NOT DO ON ITS OWN
 *
 *   Send anything carrying an offer. The check-in asks a question and stops;
 *   the 15% code goes out one-to-one from check-in-reply.js only to people who
 *   actually replied. An automation that hands out discounts unattended is a
 *   different risk with a different answer, and the owner said it plainly:
 *   any offer we want to do needs a real campaign.
 */

const { buildFromRecipe } = require('./audience-builder');
const { recipe } = require('./recipes');
const { loadCampaignSettings } = require('./eligibility');

const RECIPE_KEY = 'checkin_21_day';
const WORKFLOW_CATEGORY = 'checkin_21d';

/**
 * How long a sweep window is. Must match the recipe's one-day look-back: the
 * six-hour tick retries safely inside it, and a successful sweep stops further
 * work until the next day.
 */
const SWEEP_WINDOW_DAYS = 1;

/**
 * The hour the messages go out, in the business time zone.
 *
 * 6 PM local. Comfortably inside the 09:00–20:00 window the settings define,
 * and late enough to reach customers after the working day without drifting
 * into quiet hours. The business timezone, not the operator's phone timezone,
 * decides what “6 PM” means.
 */
const SEND_HOUR_LOCAL = 18;

/**
 * The smallest gap between deciding to send and sending.
 *
 * Not a technical requirement — the queue would cope with five minutes. Two
 * hours preserves a cancellation window while allowing the daily sweep to
 * send at 6 PM on the customer's 21-day date.
 */
const MINIMUM_LEAD_HOURS = 2;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Reading a date's wall-clock parts in a named zone, without a date library. */
function partsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const found = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value);
  }
  // Intl renders midnight as hour 24 in some ICU versions. Normalise, or every
  // comparison against SEND_HOUR_LOCAL is wrong once a day.
  if (found.hour === 24) found.hour = 0;
  return found;
}

/**
 * The instant at which a given wall-clock time occurs in a named zone.
 *
 * Two passes. The first guesses by treating the wall time as UTC; the second
 * measures how far that guess landed from the target in the zone and corrects.
 * That converges for every fixed offset and for both sides of a DST boundary,
 * which a single pass does not.
 */
function instantForLocalTime({ year, month, day, hour }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = partsInZone(new Date(guess), timeZone);
    const seenUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const wantedUTC = Date.UTC(year, month - 1, day, hour, 0, 0);
    const drift = seenUTC - wantedUTC;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/**
 * The next SEND_HOUR_LOCAL in the business zone that is at least
 * MINIMUM_LEAD_HOURS away.
 *
 * The lead comes first and the evening hour is chosen around it. A sweep that
 * starts too close to 6 PM moves to the following business-local day rather
 * than silently shortening the cancellation window.
 */
function nextSendTime(now, timeZone, { sendHour = SEND_HOUR_LOCAL, leadHours = MINIMUM_LEAD_HOURS } = {}) {
  const earliest = new Date(now.getTime() + leadHours * HOUR_MS);
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const on = partsInZone(new Date(earliest.getTime() + dayOffset * DAY_MS), timeZone);
    const candidate = instantForLocalTime({ ...on, hour: sendHour }, timeZone);
    if (candidate.getTime() >= earliest.getTime()) return candidate;
  }
  // Unreachable for any real zone; returning the floor beats returning null and
  // having the caller schedule at an hour nobody chose.
  return earliest;
}

/**
 * Has a sweep already covered this window?
 *
 * Reads the campaigns the sweep itself creates rather than a separate ledger
 * table. One less thing to keep in step, and it stays correct if somebody
 * builds the recipe by hand in the same week — which should also stop the
 * automation, and with a separate ledger would not have.
 */
async function sweptRecently({
  client,
  // Defaulted, like every other workspace argument in this codebase. Without
  // it, routes/campaigns.js called this with no workspaceID at all, which
  // became `.eq('workspace_id', undefined)` — a query that matches nothing and
  // reports it as "no check-in has run", rather than failing. The screen
  // therefore never showed the last check-in even while one was scheduled.
  workspaceID = 'vici',
  now,
  windowDays = SWEEP_WINDOW_DAYS
}) {
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const { data, error } = await client
    .from('sms_campaigns')
    .select('id, title, status, created_at')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY)
    .neq('status', 'cancelled')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  // Fail CLOSED. If we cannot tell whether this window was already swept, not
  // sweeping costs a week's check-ins; sweeping again costs a duplicate
  // message to forty customers.
  if (error) {
    throw Object.assign(new Error(`Reading check-in history failed: ${error.message}`), {
      code: 'CHECKIN_HISTORY_READ_FAILED'
    });
  }
  return (data || [])[0] || null;
}

/**
 * Every individual check-in that is still waiting to send.
 *
 * Campaign rows remain the audit/delivery mechanism, but the owner manages
 * this workflow from Automations. Returning the recipient rows here is what
 * lets that screen show the actual people queued, rather than only a batch
 * title that hides eleven individual sends behind one link.
 */
async function queuedCheckInRecipients({
  client,
  workspaceID = 'vici',
  pageSize = 500,
  maxRows = 5000
} = {}) {
  const { data: campaigns, error: campaignError } = await client
    .from('sms_campaigns')
    .select('id,title,scheduled_for,status')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY)
    .in('status', ['scheduled', 'sending'])
    .order('scheduled_for', { ascending: true });
  if (campaignError) {
    throw Object.assign(new Error(`Reading queued check-in campaigns failed: ${campaignError.message}`), {
      code: 'CHECKIN_QUEUE_READ_FAILED'
    });
  }

  const campaignByID = new Map((campaigns || []).map(row => [String(row.id), row]));
  const campaignIDs = [...campaignByID.keys()];
  if (!campaignIDs.length) return [];

  const rows = [];
  // Query each scheduled campaign separately. A computed campaignIDs array in
  // `.in()` grows into the request URL and eventually exceeds the HTTP header
  // limit; paging one UUID at a time is both bounded and complete.
  for (const campaignID of campaignIDs) {
    for (let from = 0; rows.length < maxRows; from += pageSize) {
      const remaining = maxRows - rows.length;
      const pageLimit = Math.min(pageSize, remaining);
      const { data, error } = await client
        .from('sms_campaign_recipients')
        .select('id,campaign_id,contact_phone,contact_name_snapshot,rendered_message,planned_send_at,state,created_at')
        .eq('workspace_id', workspaceID)
        .eq('campaign_id', campaignID)
        .eq('selected', true)
        .in('state', ['pending', 'deferred'])
        .order('planned_send_at', { ascending: true })
        .range(from, from + pageLimit - 1);
      if (error) {
        throw Object.assign(new Error(`Reading queued check-in recipients failed: ${error.message}`), {
          code: 'CHECKIN_QUEUE_READ_FAILED'
        });
      }
      rows.push(...(data || []));
      if (!data || data.length < pageLimit) break;
    }
    if (rows.length >= maxRows) break;
  }

  rows.sort((left, right) => String(left.planned_send_at || '')
    .localeCompare(String(right.planned_send_at || '')));

  return rows.map(row => {
    const campaign = campaignByID.get(String(row.campaign_id));
    return {
      id: String(row.id),
      campaignID: String(row.campaign_id),
      campaignTitle: campaign?.title || 'Automatic check-in',
      contactName: row.contact_name_snapshot || null,
      phone: row.contact_phone || null,
      message: row.rendered_message || null,
      sendAt: row.planned_send_at || campaign?.scheduled_for || null,
      state: row.state
    };
  });
}

/**
 * Run one sweep.
 *
 * Never throws for an ordinary outcome. "Nobody is due" and "the automation is
 * off" are results, not errors, and a background job that throws for them
 * fills the log with alarm about nothing happening correctly.
 */
async function runCheckInSweep({
  client,
  service,
  audit,
  // Injected for the same reason `service` and `audit` are: this function's
  // job is the ORDER of the steps, and that is only testable if the steps can
  // be observed without a database behind them.
  build = buildFromRecipe,
  now = new Date(),
  workspaceID = 'vici',
  logger = console
} = {}) {
  const settings = await loadCampaignSettings(client, workspaceID);
  if (!settings) return { ran: false, reason: 'settings_unavailable' };
  if (settings.checkin_automation_enabled !== true) {
    return { ran: false, reason: 'automation_disabled' };
  }

  const already = await sweptRecently({ client, workspaceID, now });
  if (already) {
    return {
      ran: false, reason: 'already_swept',
      campaignID: already.id, sweptAt: already.created_at
    };
  }

  // Identical to what the app's own recipe button does, including the dedupe.
  const built = await build({
    client, recipeKey: RECIPE_KEY, actorID: null, now, workspaceID
  });

  if (!built.created.length) {
    return { ran: true, reason: 'nobody_due', candidates: built.candidates, scheduled: [] };
  }

  const timeZone = settings.business_timezone || 'America/New_York';
  const sendAt = nextSendTime(now, timeZone);
  const scheduled = [];
  const failures = [];

  for (const draft of built.created) {
    try {
      // The same four steps, in the same order, as the app: submit, approve,
      // audit, schedule.
      //
      // The submit is not a formality. buildFromRecipe leaves a draft in
      // `draft`, and prepareApproval refuses anything that is not
      // `review_required` — so an automation that went straight to approve
      // would throw CAMPAIGN_NOT_REVIEWABLE on every sweep forever. It is also
      // the step that copies proposed_message into final_message, which is the
      // text approval then freezes and personalises.
      await service.submitReview(draft.id, null);

      // The audit row between the two approval phases is not decoration:
      // finalizeApproval refuses without its fingerprint.
      const prepared = await service.approve(draft.id, null);
      const proof = await audit({
        campaign: prepared.campaign,
        recipientCount: prepared.recipientCount,
        audienceHash: prepared.audienceHash,
        messageHash: prepared.messageHash
      });
      await service.finalizeApproval(draft.id, prepared.campaign.revision, proof);
      const campaign = await service.schedule(draft.id, sendAt.toISOString(), null);
      scheduled.push({
        id: draft.id, title: draft.title,
        recipients: prepared.recipientCount, sendAt: campaign.scheduled_for
      });
    } catch (error) {
      // One draft failing must not strand the others. The check-in splits into
      // a named and a plain variant, and the plain one going out while the
      // named one is stuck is far better than neither.
      failures.push({ id: draft.id, title: draft.title, message: error.message, code: error.code || null });
      logger.error(`[CHECK-IN] Draft ${draft.id} could not be scheduled: ${error.message}`);
    }
  }

  return {
    ran: true,
    reason: scheduled.length ? 'scheduled' : 'all_drafts_failed',
    candidates: built.candidates,
    suppressedAsDuplicate: built.suppressedAsDuplicate,
    sendAt: sendAt.toISOString(),
    timeZone,
    scheduled,
    failures
  };
}

module.exports = {
  MINIMUM_LEAD_HOURS,
  RECIPE_KEY,
  SEND_HOUR_LOCAL,
  SWEEP_WINDOW_DAYS,
  WORKFLOW_CATEGORY,
  instantForLocalTime,
  nextSendTime,
  partsInZone,
  queuedCheckInRecipients,
  runCheckInSweep,
  sweptRecently
};
