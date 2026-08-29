#!/usr/bin/env node
'use strict';
/**
 * scripts/stage-winback-campaigns.js — put the win-back drafts in the app.
 *
 * WHAT IT DOES, AND EMPHATICALLY WHAT IT DOES NOT
 *
 *   Creates campaign DRAFTS and attaches their audiences. That is all. It does
 *   not submit for review, does not approve, does not schedule, does not mint
 *   a coupon and does not send a message. Everything after "draft" happens in
 *   the app, by a person, on purpose.
 *
 *   Run it as many times as you like: existing drafts with the same title are
 *   reported and skipped rather than duplicated.
 *
 * WHY TWO CAMPAIGNS AND NOT ONE
 *
 *   The copy the owner asked for names the product somebody bought. Measured
 *   against the live audience, only 232 of 376 one-time buyers have a product
 *   that can be named inside the copy rules: the rest bought combination
 *   products with no single approved code. A single campaign with that copy
 *   would silently drop 144 people.
 *
 *   So the audience is split by whether it can carry the personal version.
 *   Everybody gets a message; the 221 who can be addressed by product get the
 *   warmer one, and nobody is dropped for the sake of one template.
 *
 * WHO IS IN, AND WHO IS DELIBERATELY OUT
 *
 *   In:  one_time_slipping (31-90 days) and one_time_lapsed (91-365 days).
 *   Out: one_time_first_month. docs/campaigns/BUYER-COHORTS.md is explicit
 *        that around half of all second orders arrive inside the first 30 days,
 *        so discounting that group pays people who were coming back anyway.
 *        It is the wrong audience for an offer and it is left alone.
 */

require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { personaliseCampaign, skuToParentName } = require('../lib/campaigns/personalise');

const WORKSPACE = 'vici';
const SEGMENTS = ['one_time_slipping', 'one_time_lapsed'];
const DISCOUNT_PERCENT = 15;

/**
 * The copy.
 *
 * Both versions are inside the rules that keep this business out of Telnyx's
 * prohibited categories: no compound name, none of the carrier-filtered words
 * (discount, coupon, promo code, sale, free, save, order now, shop now), no
 * dosing language, no manufactured urgency, and STOP on the end. `{{last_product}}`
 * renders the APPROVED CODE for what they bought and never the compound.
 *
 * PERSONAL is the owner's own brief: name, what they took, when. NEUTRAL is the
 * same message for somebody whose purchase cannot be named safely.
 */
const PERSONAL = 'Vin from Vici. Hi {{first_name}}, you took {{last_product}} back in '
  + '{{last_order_date}}. Here is {{code}} for 15% off your next order. Reply STOP to opt out.';

const NEUTRAL = 'Vin from Vici. Hi {{first_name}}, it has been since {{last_order_date}} '
  + 'and I wanted to check in. Here is {{code}} for 15% off your next order. Reply STOP to opt out.';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  return createClient(url, key);
}

/** Every member of the named segments, deduplicated across them. */
async function audienceFor(db, segmentKeys) {
  const { data: segments, error } = await db
    .from('sms_campaign_segments')
    .select('id, segment_key, member_count')
    // bounded: SEGMENTS is a two-element module constant, not user input or a
    // query result, so this list cannot grow at runtime and cannot overflow
    // the request URL. Every list below that CAN grow is paged instead.
    .in('segment_key', segmentKeys)
    .is('archived_at', null);
  if (error) throw new Error(`Reading segments failed: ${error.message}`);

  const phones = new Set();
  for (const segment of segments || []) {
    for (let from = 0; ; from += 1000) {
      const { data, error: memberError } = await db
        .from('sms_campaign_segment_members')
        .select('contact_phone')
        .eq('segment_id', segment.id)
        .range(from, from + 999);
      if (memberError) throw new Error(`Reading members failed: ${memberError.message}`);
      for (const row of data || []) phones.add(row.contact_phone);
      if (!data || data.length < 1000) break;
    }
  }
  return { phones: [...phones], segments: segments || [] };
}

/**
 * Split the audience by whether the personal copy renders for them.
 *
 * Uses the real renderer in dry-run, so the split is decided by exactly the
 * code that will run at approval rather than by a separate guess about it.
 */
async function split(db, phones, skuMap) {
  const outcome = await personaliseCampaign({
    client: db,
    campaignID: 'staging-probe',
    template: PERSONAL,
    phones,
    percentOff: DISCOUNT_PERCENT,
    dryRun: true,
    skuMap
  });
  const personal = new Set(outcome.rendered.map(row => row.phone));
  return {
    personal: phones.filter(phone => personal.has(phone)),
    neutral: phones.filter(phone => !personal.has(phone)),
    reasons: outcome.reasons
  };
}

async function existingDraft(db, title) {
  const { data } = await db.from('sms_campaigns')
    .select('id, status, title')
    .eq('workspace_id', WORKSPACE).eq('title', title).is('archived_at', null)
    .maybeSingle();
  return data || null;
}

async function createDraft(db, { title, message, phones, actorID }) {
  const found = await existingDraft(db, title);
  if (found) return { campaign: found, created: false };

  const { data, error } = await db.rpc('create_sms_campaign_draft', {
    p_workspace_id: WORKSPACE,
    p_campaign_type: 'manual',
    p_workflow_category: 'winback_one_time_buyer',
    p_title: title,
    p_message: message,
    p_audience_definition: {
      kind: 'segment',
      segments: SEGMENTS,
      requested_count: phones.length,
      discount_percent: DISCOUNT_PERCENT,
      staged_by: 'scripts/stage-winback-campaigns.js'
    },
    p_recipients: phones.map(phone => ({
      contact_phone: phone,
      contact_id: null,
      contact_name_snapshot: null,
      inclusion_reason: { source: 'segment', segments: SEGMENTS }
    })),
    p_actor_user_id: actorID
  });
  if (error) throw new Error(`Creating "${title}" failed: ${error.message}`);
  const campaign = Array.isArray(data) ? data[0] : data;
  return { campaign, created: true };
}

async function main() {
  const db = client();
  const actorID = Number(process.env.STAGE_ACTOR_USER_ID || 4);

  const skuMap = await skuToParentName();
  const { phones, segments } = await audienceFor(db, SEGMENTS);
  console.log('Segments:');
  for (const segment of segments) console.log(`  ${segment.segment_key.padEnd(22)} ${segment.member_count}`);
  console.log(`Audience, deduplicated: ${phones.length}\n`);

  const parts = await split(db, phones, skuMap);
  console.log(`Can be addressed by product : ${parts.personal.length}`);
  console.log(`Cannot, so gets the neutral : ${parts.neutral.length}`);
  console.log(`Split reasons: ${JSON.stringify(parts.reasons)}\n`);

  const plan = [
    { title: 'Win-back: bought once, by product', message: PERSONAL, phones: parts.personal },
    { title: 'Win-back: bought once', message: NEUTRAL, phones: parts.neutral }
  ];

  for (const entry of plan) {
    if (!entry.phones.length) { console.log(`SKIP  ${entry.title} (nobody in it)`); continue; }
    const { campaign, created } = await createDraft(db, { ...entry, actorID });
    console.log(`${created ? 'DRAFT' : 'EXISTS'} ${entry.title}`);
    console.log(`      id=${campaign.id} status=${campaign.status} recipients=${entry.phones.length}`);
  }

  console.log('\nNothing was submitted, approved, scheduled or sent. No coupon was minted.');
  console.log('Open Campaigns in the app to review, edit the copy, and approve.');
}

main().catch(error => { console.error(error.message); process.exit(1); });
