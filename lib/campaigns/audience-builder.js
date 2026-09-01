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
const { dueForSecondOrder } = require('./second-order');
const { normalisePhone } = require('./../phone');
const { assessAudience } = require('./audience-health');
const { loadCampaignSettings } = require('./eligibility');

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
  // Phone to the evidence recorded when the segment was computed: order count,
  // when their only order was and what it was worth, whether what they bought
  // is still on sale. Read here so it can ride into the campaign's
  // inclusion_reason and answer "why is this person here" on the campaign
  // itself, rather than only on the segment screen.
  //
  // First segment wins for anybody in two of them. The evidence describes the
  // person, not the segment, so the second copy says the same thing.
  const evidenceByPhone = new Map();
  for (const segment of segments) {
    for (let from = 0; ; from += 1000) {
      const { data, error: memberError } = await client
        .from('sms_campaign_segment_members')
        .select('contact_phone, inclusion_evidence')
        .eq('segment_id', segment.id)
        .range(from, from + 999);
      if (memberError) throw new AudienceBuildError(`Reading members failed: ${memberError.message}`, 'MEMBER_READ_FAILED', 500);
      for (const row of data || []) {
        const phone = normalisePhone(row.contact_phone);
        if (!phone) continue;
        phones.add(phone);
        if (row.inclusion_evidence && !evidenceByPhone.has(phone)) {
          evidenceByPhone.set(phone, row.inclusion_evidence);
        }
      }
      if (!data || data.length < 1000) break;
    }
  }
  return { phones: [...phones], segments, evidenceByPhone };
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
/**
 * Group an audience by which of the recipe's variants each person should get.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS RETURNS NULL RATHER THAN THROWING
 *
 *   Profiles are an enhancement to a campaign that has been sending fine
 *   without them. If the columns are not migrated yet, or the backfill has not
 *   run, or the read simply fails, the correct outcome is the wording the
 *   check-in has always used — not a build that refuses to produce a campaign.
 *   Every failure here returns null and the caller falls back.
 *
 *   The one thing it will NOT do is invent a profile. A person with no profile
 *   row is not given a guessed one; they fall back with everybody else, and
 *   they get a real one on the next sweep.
 */
async function groupByVariant({ client, found, phones, nameable, workspaceID }) {
  const { selectCheckInVariant } = require('./checkin-variants');
  let profiles;
  try {
    const rows = [];
    for (let index = 0; index < phones.length; index += 200) {
      const slice = phones.slice(index, index + 200);
      const { data, error } = await client
        .from('sms_customer_profiles')
        .select('contact_phone, order_count, last_product_name, last_product_sku, engagement_tier, has_replied_ever, last_checkin_variant')
        // bounded: at most 200 entries by the loop step above, so the
        // serialised URL cannot grow with the audience.
        .in('contact_phone', slice);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
    }
    profiles = new Map(rows.map(row => [row.contact_phone, row]));
  } catch (error) {
    console.warn(`[RECIPE] Variant selection unavailable, using the standard copy: ${error.message}`);
    return null;
  }

  // Nobody has a profile yet: the backfill has not run. Fall back rather than
  // give the whole audience variant one.
  if (!profiles.size) return null;

  const byVariant = new Map();
  for (const phone of phones) {
    const profile = profiles.get(phone);
    if (!profile) return null;          // a partial backfill is not a basis to split on
    const chosen = selectCheckInVariant({
      profile: { ...profile, hasNameableProduct: nameable.has(phone) },
      lastVariant: profile.last_checkin_variant || null
    });
    if (!chosen?.key || !chosen?.template) return null;
    if (!byVariant.has(chosen.key)) {
      byVariant.set(chosen.key, { variant: chosen.key, message: chosen.template, phones: [] });
    }
    byVariant.get(chosen.key).phones.push(phone);
  }
  return [...byVariant.values()];
}

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
  // Empty for the rolling windows (check-in, second order), which are computed
  // from order dates rather than from a stored segment and so have no recorded
  // evidence to carry.
  let evidenceByPhone = new Map();
  if (found.audience === 'check_in_window') {
    const { due } = await dueForCheckIn({ client, now, workspaceID });
    candidates = due.map(entry => entry.phone);
  } else if (found.audience === 'second_order_window') {
    const due = await dueForSecondOrder({ client, now });
    candidates = due.map(entry => entry.phone);
  } else {
    const result = await fromSegments({ client, segmentKeys: found.segments, workspaceID });
    candidates = result.phones;
    evidenceByPhone = result.evidenceByPhone;
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

  // ── ONE OF SIX WORDINGS, NOT ONE OF TWO ────────────────────────────────
  //
  // A recipe with a variant bank picks per person, from their profile, and
  // never the wording they had last time. Everything downstream is unchanged:
  // the groups are still "one template, these phones", there are just more of
  // them, so approval, rendering and the frozen rendered_message all behave
  // exactly as before.
  //
  // Falls back to the recipe's own named/plain pair whenever the bank cannot
  // be used — no bank on this recipe, profiles not yet backfilled, or the
  // profile columns not yet migrated. The check-in has been sending for weeks
  // on that pair, so degrading to it is a return to the known-good behaviour
  // rather than a failure. It also means this can ship before the backfill and
  // improve on its own once the profiles land.
  const groups = found.variants
    ? await groupByVariant({ client, found, phones, nameable, workspaceID })
    : null;

  const finalGroups = (groups && groups.length ? groups : [
    { variant: 'named', message: found.copy.named, phones: phones.filter(p => nameable.has(p)) },
    { variant: 'plain', message: found.copy.plain, phones: phones.filter(p => !nameable.has(p)) }
  ]).filter(group => group.phones.length > 0);

  if (dryRun) {
    return { ...summary, dryRun: true, created: finalGroups.map(g => ({ variant: g.variant, recipients: g.phones.length })) };
  }

  // ── Create the drafts ──────────────────────────────────────────────────
  const stamp = now.toISOString().slice(0, 10);
  const created = [];
  for (const group of finalGroups) {
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
        inclusion_reason: {
          source: 'recipe', recipe: found.key, variant: group.variant,
          evidence: evidenceByPhone.get(phone) ?? null
        }
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

/**
 * Build a draft from ANY saved segment, with copy the owner supplies.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LINK THIS CLOSES
 *
 *   Everything needed for an arbitrary campaign already existed and none of it
 *   joined up. A segment can be described in plain words and turned into rules
 *   by a model (segments/rules/draft), previewed for a member count, and
 *   saved. Copy can be drafted by a model and previewed per person. Codes mint
 *   themselves at approval and the code budget applies without being asked.
 *
 *   But a campaign's audience could only be selected contacts, all contacts, or
 *   pasted numbers. There was no way to say "the segment I just built". So
 *   "clearance on RT for people who bought it and went quiet" was three
 *   quarters possible and stopped at the last step.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE MESSAGE, NOT TWO VARIANTS
 *
 *   A recipe carries a named and a plain version because its copy is fixed and
 *   has to cope with whoever turns up. Here the owner wrote the copy for this
 *   audience, so there is one message. Anybody it cannot render for is
 *   reported rather than quietly moved to a second draft they never asked for.
 *
 * THE DEDUPE STILL APPLIES
 *
 *   Against `workflowCategory`, which the caller names. Two clearance
 *   campaigns a fortnight apart should not both reach the same person, and the
 *   only way to know is to record what this campaign IS. A caller that names
 *   nothing gets `custom`, which at least dedupes against other custom sends.
 */
async function buildFromSegment({
  client,
  segmentKeys,
  title,
  message,
  discountPercent = null,
  dedupeDays = 30,
  workflowCategory = 'custom',
  actorID = null,
  now = new Date(),
  workspaceID = 'vici',
  dryRun = false
}) {
  const keys = (Array.isArray(segmentKeys) ? segmentKeys : [segmentKeys]).filter(Boolean);
  if (!keys.length) throw new AudienceBuildError('At least one segment is required.', 'SEGMENT_REQUIRED');
  const copy = String(message || '').trim();
  if (!copy) throw new AudienceBuildError('A message is required.', 'MESSAGE_REQUIRED');
  const name = String(title || '').trim() || `Campaign, ${now.toISOString().slice(0, 10)}`;

  const { phones: candidates, segments, evidenceByPhone } = await fromSegments({ client, segmentKeys: keys, workspaceID });

  const { reached, campaigns: priorCampaigns } = await alreadyReached({
    client, workflowCategory, dedupeDays, workspaceID, now
  });
  const phones = candidates.filter(phone => !reached.has(phone));
  const suppressedAsDuplicate = candidates.length - phones.length;

  // What each person would actually read, using the real renderer, so a
  // template whose variables cannot be filled is caught before a draft exists
  // rather than at approval.
  // ── Who may hear from us at all today ────────────────────────────────
  //
  // Not "who has had THIS campaign", which the dedupe above covers, but who
  // has had ANY campaign too recently. Somebody who got a win-back on Tuesday
  // should not get a clearance on Wednesday, and the spacing and rolling caps
  // that decide it are read from the same settings row the SQL send gate uses.
  //
  // The gate would defer them anyway, one at a time, at send. Doing it here
  // means the number the operator approves is the number that goes out.
  const settings = await loadCampaignSettings(client, workspaceID).catch(() => null);
  const health = await assessAudience({
    client, phones, settings, now, workflowCategory, workspaceID
  });

  const probe = await personaliseCampaign({
    client, campaignID: `segment-probe-${keys.join('-')}`, template: copy,
    phones: health.eligible.length ? health.eligible : ['+10000000000'],
    percentOff: discountPercent || 15, dryRun: true
  }).catch(() => null);

  const renderable = probe
    ? health.eligible.filter(phone => probe.rendered.some(row => row.phone === phone))
    : health.eligible;

  const summary = {
    segments: segments.map(row => ({ key: row.segment_key, members: row.member_count })),
    candidates: candidates.length,
    suppressedAsDuplicate,
    messagedTooRecently: health.removed.length,
    recencyReasons: health.reasons,
    cannotRender: health.eligible.length - renderable.length,
    dedupeDays,
    priorCampaigns,
    warnings: health.warnings,
    audience: renderable.length
  };

  // ── The floor ────────────────────────────────────────────────────────
  //
  // A promotional send to a handful of people is not a campaign. It cannot be
  // measured, and reviewing, approving and minting for it costs more than the
  // outcome. Refused rather than warned, because a warning on a screen full of
  // green ticks is a warning nobody reads.
  //
  // Check-ins are exempt: a service message to whoever ordered three weeks ago
  // is worth sending to one person.
  if (renderable.length > 0 && renderable.length < health.floor && !health.floorExempt) {
    throw new AudienceBuildError(
      `Only ${renderable.length} ${renderable.length === 1 ? 'person is' : 'people are'} `
      + `eligible, and a promotional campaign needs at least ${health.floor}. `
      + `Widen the audience, or message them individually instead.`,
      'AUDIENCE_BELOW_MINIMUM',
      409
    );
  }

  if (!renderable.length) {
    return {
      ...summary,
      created: [],
      note: suppressedAsDuplicate
        ? `Everybody in these segments already had a ${workflowCategory} campaign in the last ${dedupeDays} days.`
        : 'Nobody in these segments can receive this message.'
    };
  }
  if (dryRun) return { ...summary, dryRun: true, created: [] };

  const { data, error } = await client.rpc('create_sms_campaign_draft', {
    p_workspace_id: workspaceID,
    p_campaign_type: 'manual',
    p_workflow_category: String(workflowCategory).slice(0, 64),
    p_title: name.slice(0, 160),
    p_message: copy,
    p_audience_definition: {
      kind: 'segment',
      segments: keys,
      discount_percent: discountPercent,
      dedupe_days: dedupeDays,
      suppressed_as_duplicate: suppressedAsDuplicate,
      requested_count: renderable.length
    },
    p_recipients: renderable.map(phone => ({
      contact_phone: phone,
      contact_id: null,
      contact_name_snapshot: null,
      inclusion_reason: {
        source: 'segment', segments: keys,
        // The per-person "why", carried from the segment that matched them.
        evidence: evidenceByPhone.get(phone) ?? null
      }
    })),
    p_actor_user_id: actorID
  });
  if (error) throw new AudienceBuildError(`Creating "${name}" failed: ${error.message}`, 'DRAFT_CREATE_FAILED', 500);

  const campaign = Array.isArray(data) ? data[0] : data;
  // The discount has to be on the row, or approval mints at the default rather
  // than what was asked for.
  if (discountPercent) {
    await client.from('sms_campaigns')
      .update({ discount_percent: discountPercent })
      .eq('id', campaign.id).eq('status', 'draft');
  }

  return {
    ...summary,
    created: [{ id: String(campaign.id), title: campaign.title, recipients: renderable.length }]
  };
}

module.exports = {
  AudienceBuildError,
  alreadyReached,
  buildFromRecipe,
  buildFromSegment,
  fromSegments
};
