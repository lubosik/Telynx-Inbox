'use strict';
/**
 * lib/campaigns/audience-builder.js — turn a recipe into reviewable drafts.
 *
 * This is what made the app self-serve. Everything after "draft" already
 * happened in the app: preview, edit, review, approve, schedule. Everything
 * BEFORE it happened in a terminal, so creating a campaign meant running
 * scripts/stage-winback-campaigns.js by hand. This does the same work behind
 * an endpoint.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DEDUPE IS THE MOST IMPORTANT THING HERE
 *
 *   Cohorts do not know who has been messaged. `one_time_lapsed` hands back
 *   the same 278 people next month minus whoever ordered, so running a
 *   win-back twice sends the same personal offer to the same person twice.
 *
 *   Every build therefore subtracts anybody this recipe already reached inside
 *   its own dedupe window, and the count of who was subtracted is RETURNED
 *   rather than hidden, because "we built you a campaign of 12 people" needs
 *   the explanation "because 364 of them already had this one".
 *
 *   Scoped to the recipe, deliberately. Somebody who received a check-in three
 *   weeks ago may be exactly right for a win-back today, and blocking that
 *   would be over-correcting. How close together two DIFFERENT campaigns may
 *   land is a separate question, already answered by the send gate's rolling
 *   frequency caps in SQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY IT CAN PRODUCE TWO DRAFTS
 *
 *   Copy that names a product renders through the approved product code, and
 *   combination products have none. On the live win-back that was 155 of 376
 *   people whose message would have rendered with a hole in it and who would
 *   have been dropped. So the audience is split by whether the naming variant
 *   actually renders, decided by running the real renderer rather than
 *   guessing, and the rest get the variant that names nothing.
 *
 * IT CREATES DRAFTS AND NOTHING ELSE. No submit, no approve, no schedule, no
 * coupon. Minting happens at approval, by a person, in the app.
 */

const { recipe } = require('./recipes');
const { personaliseCampaign, skuToParentName } = require('./personalise');
const { dueForCheckIn } = require('./check-in');
const { normalisePhone } = require('./../phone');

const DAY_MS = 24 * 60 * 60 * 1000;

class AudienceBuildError extends Error {
  constructor(message, code = 'AUDIENCE_BUILD_FAILED', status = 400) {
    super(message);
    this.name = 'AudienceBuildError';
    this.code = code;
    this.status = status;
  }
}

/** Every member of the named segments, deduplicated across them. */
async function fromSegments({ client, segmentKeys, workspaceID }) {
  const { data: segments, error } = await client
    .from('sms_campaign_segments')
    .select('id, segment_key, member_count')
    // bounded: the key list comes from a frozen recipe, not from user input.
    .in('segment_key', segmentKeys)
    .eq('workspace_id', workspaceID)
    .is('archived_at', null);
  if (error) throw new AudienceBuildError(`Reading segments failed: ${error.message}`, 'SEGMENT_READ_FAILED', 500);
  if (!segments?.length) {
    throw new AudienceBuildError(
      `None of these segments exist yet: ${segmentKeys.join(', ')}. They are built by the daily cycle.`,
      'SEGMENTS_NOT_COMPUTED', 409
    );
  }

  const phones = new Set();
  for (const segment of segments) {
    for (let from = 0; ; from += 1000) {
      const { data, error: memberError } = await client
        .from('sms_campaign_segment_members')
        .select('contact_phone')
        .eq('segment_id', segment.id)
        .range(from, from + 999);
      if (memberError) throw new AudienceBuildError(`Reading members failed: ${memberError.message}`, 'MEMBER_READ_FAILED', 500);
      for (const row of data || []) {
        const phone = normalisePhone(row.contact_phone);
        if (phone) phones.add(phone);
      }
      if (!data || data.length < 1000) break;
    }
  }
  return { phones: [...phones], segments };
}

/**
 * Anybody this recipe already reached inside its dedupe window.
 *
 * Reads campaigns of the recipe's own workflow_category, then their
 * recipients. Counts a DRAFT as reached: it is about to be approved, and two
 * drafts aimed at the same people is the failure this exists to prevent. A
 * cancelled campaign does not count, since nothing was sent.
 */
async function alreadyReached({ client, workflowCategory, dedupeDays, workspaceID, now }) {
  const since = new Date(now.getTime() - dedupeDays * DAY_MS).toISOString();

  const { data: campaigns, error } = await client
    .from('sms_campaigns')
    .select('id, status, created_at')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', workflowCategory)
    .gte('created_at', since);
  if (error) throw new AudienceBuildError(`Reading campaign history failed: ${error.message}`, 'HISTORY_READ_FAILED', 500);

  const relevant = (campaigns || []).filter(row => row.status !== 'cancelled');
  const reached = new Set();
  for (const campaign of relevant) {
    for (let from = 0; ; from += 1000) {
      const { data } = await client
        .from('sms_campaign_recipients')
        .select('contact_phone')
        .eq('campaign_id', campaign.id)
        .range(from, from + 999);
      for (const row of data || []) reached.add(row.contact_phone);
      if (!data || data.length < 1000) break;
    }
  }
  return { reached, campaigns: relevant.length };
}

/**
 * Build the drafts for one recipe.
 *
 * Returns everything a reviewer needs to understand the numbers, including who
 * was excluded and why, because a campaign that came back smaller than
 * expected has to explain itself.
 */
async function buildFromRecipe({
  client,
  recipeKey,
  actorID = null,
  now = new Date(),
  workspaceID = 'vici',
  dryRun = false
}) {
  const found = recipe(recipeKey);
  if (!found) throw new AudienceBuildError(`Unknown campaign recipe: ${String(recipeKey)}`, 'UNKNOWN_RECIPE', 404);

  // ── Who could be in it ─────────────────────────────────────────────────
  let candidates = [];
  let segmentInfo = [];
  if (found.audience === 'check_in_window') {
    const { due } = await dueForCheckIn({ client, now, workspaceID });
    candidates = due.map(entry => entry.phone);
  } else {
    const result = await fromSegments({ client, segmentKeys: found.segments, workspaceID });
    candidates = result.phones;
    segmentInfo = result.segments.map(row => ({ key: row.segment_key, members: row.member_count }));
  }

  // ── Minus anybody this recipe already reached ──────────────────────────
  const { reached, campaigns: priorCampaigns } = await alreadyReached({
    client, workflowCategory: found.workflowCategory, dedupeDays: found.dedupeDays, workspaceID, now
  });
  const phones = candidates.filter(phone => !reached.has(phone));
  const suppressedAsDuplicate = candidates.length - phones.length;

  const summary = {
    recipe: found.key,
    name: found.name,
    candidates: candidates.length,
    suppressedAsDuplicate,
    dedupeDays: found.dedupeDays,
    priorCampaigns,
    segments: segmentInfo,
    audience: phones.length
  };

  if (!phones.length) {
    return {
      ...summary,
      created: [],
      // The single most useful thing to say when a build returns nothing.
      note: suppressedAsDuplicate
        ? `Everybody who qualifies has already had this campaign in the last ${found.dedupeDays} days.`
        : 'Nobody currently qualifies for this campaign.'
    };
  }

  // ── Split by whether the naming variant actually renders ───────────────
  const skuMap = await skuToParentName();
  const probe = await personaliseCampaign({
    client, campaignID: `recipe-probe-${found.key}`, template: found.copy.named,
    phones, percentOff: found.discountPercent || 15, dryRun: true, skuMap
  });
  const nameable = new Set(probe.rendered.map(row => row.phone));
  const groups = [
    { variant: 'named', message: found.copy.named, phones: phones.filter(p => nameable.has(p)) },
    { variant: 'plain', message: found.copy.plain, phones: phones.filter(p => !nameable.has(p)) }
  ].filter(group => group.phones.length > 0);

  if (dryRun) {
    return { ...summary, dryRun: true, created: groups.map(g => ({ variant: g.variant, recipients: g.phones.length })) };
  }

  // ── Create the drafts ──────────────────────────────────────────────────
  const stamp = now.toISOString().slice(0, 10);
  const created = [];
  for (const group of groups) {
    const title = group.variant === 'named'
      ? `${found.name}, by product, ${stamp}`
      : `${found.name}, ${stamp}`;

    const { data, error } = await client.rpc('create_sms_campaign_draft', {
      p_workspace_id: workspaceID,
      p_campaign_type: 'manual',
      p_workflow_category: found.workflowCategory,
      p_title: title.slice(0, 160),
      p_message: group.message,
      p_audience_definition: {
        kind: 'recipe',
        recipe: found.key,
        variant: group.variant,
        segments: found.segments ? [...found.segments] : null,
        discount_percent: found.discountPercent,
        dedupe_days: found.dedupeDays,
        suppressed_as_duplicate: suppressedAsDuplicate,
        requested_count: group.phones.length
      },
      p_recipients: group.phones.map(phone => ({
        contact_phone: phone,
        contact_id: null,
        contact_name_snapshot: null,
        inclusion_reason: { source: 'recipe', recipe: found.key, variant: group.variant }
      })),
      p_actor_user_id: actorID
    });
    if (error) throw new AudienceBuildError(`Creating "${title}" failed: ${error.message}`, 'DRAFT_CREATE_FAILED', 500);
    const campaign = Array.isArray(data) ? data[0] : data;
    created.push({
      id: String(campaign.id),
      title: campaign.title,
      variant: group.variant,
      recipients: group.phones.length
    });
  }

  return { ...summary, created };
}

module.exports = { AudienceBuildError, alreadyReached, buildFromRecipe, fromSegments };
