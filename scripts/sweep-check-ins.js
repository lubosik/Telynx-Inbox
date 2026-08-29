#!/usr/bin/env node
'use strict';
/**
 * scripts/sweep-check-ins.js — build this week's 21-day check-in draft.
 *
 * WHAT IT DOES, AND WHAT IT DOES NOT
 *
 *   Creates ONE campaign draft holding everybody whose 21-day mark fell in the
 *   last seven days. It does not submit, approve, schedule, mint a coupon or
 *   send. The draft waits in the app exactly like the win-back does.
 *
 *   Safe to run twice: anybody already in a check-in campaign is excluded, so
 *   a second run in the same week produces "nobody due" rather than a second
 *   draft aimed at the same people.
 *
 * RUN IT WEEKLY. The window is seven days wide and matches that cadence. Run
 * it fortnightly and everybody in the missed week is skipped permanently,
 * because the window has moved past them and nothing looks backwards. If the
 * cadence ever changes, BATCH_WINDOW_DAYS in lib/campaigns/check-in.js has to
 * change with it.
 *
 * TWO DRAFTS, NOT ONE, for the same reason the win-back has two: the copy
 * names what somebody bought, and not every product has a name that is safe to
 * put in an SMS. People whose purchase cannot be named get the version that
 * does not name it, rather than being dropped.
 */

require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const {
  BATCH_WINDOW_DAYS,
  CHECK_IN_DAYS,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  WORKFLOW_CATEGORY,
  dueForCheckIn
} = require('../lib/campaigns/check-in');
const { personaliseCampaign, skuToParentName } = require('../lib/campaigns/personalise');

const WORKSPACE = 'vici';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  return createClient(url, key);
}

async function createDraft(db, { title, message, phones, actorID }) {
  const { data: found } = await db.from('sms_campaigns')
    .select('id, status').eq('workspace_id', WORKSPACE).eq('title', title)
    .is('archived_at', null).maybeSingle();
  if (found) return { campaign: found, created: false };

  const { data, error } = await db.rpc('create_sms_campaign_draft', {
    p_workspace_id: WORKSPACE,
    p_campaign_type: 'manual',
    p_workflow_category: WORKFLOW_CATEGORY,
    p_title: title,
    p_message: message,
    p_audience_definition: {
      kind: 'check_in_sweep',
      check_in_days: CHECK_IN_DAYS,
      window_days: BATCH_WINDOW_DAYS,
      requested_count: phones.length,
      staged_by: 'scripts/sweep-check-ins.js'
    },
    p_recipients: phones.map(phone => ({
      contact_phone: phone,
      contact_id: null,
      contact_name_snapshot: null,
      inclusion_reason: { source: 'check_in_sweep', check_in_days: CHECK_IN_DAYS }
    })),
    p_actor_user_id: actorID
  });
  if (error) throw new Error(`Creating "${title}" failed: ${error.message}`);
  return { campaign: Array.isArray(data) ? data[0] : data, created: true };
}

async function main() {
  const db = client();
  const actorID = Number(process.env.STAGE_ACTOR_USER_ID || 4);
  const now = new Date();

  const { due, alreadyAsked, considered } = await dueForCheckIn({ client: db, now });
  console.log(`Came due in the last ${BATCH_WINDOW_DAYS} days: ${considered}`);
  console.log(`Already asked, so skipped        : ${alreadyAsked}`);
  console.log(`To ask this week                 : ${due.length}\n`);
  if (!due.length) { console.log('Nobody due. No draft created.'); return; }

  const phones = due.map(entry => entry.phone);
  const skuMap = await skuToParentName();

  // Split by whether the product-naming version renders, using the real
  // renderer rather than a second guess at what it will do.
  const probe = await personaliseCampaign({
    client: db, campaignID: 'checkin-sweep-probe', template: TEMPLATE,
    phones, dryRun: true, skuMap
  });
  const named = new Set(probe.rendered.map(row => row.phone));
  const withProduct = phones.filter(phone => named.has(phone));
  const withoutProduct = phones.filter(phone => !named.has(phone));

  console.log(`Can be asked about the product : ${withProduct.length}`);
  console.log(`Cannot, so gets the plain ask  : ${withoutProduct.length}\n`);

  const week = now.toISOString().slice(0, 10);
  const plan = [
    { title: `Check-in: 21 days, by product, week of ${week}`, message: TEMPLATE, phones: withProduct },
    { title: `Check-in: 21 days, week of ${week}`, message: TEMPLATE_NO_PRODUCT, phones: withoutProduct }
  ];

  for (const entry of plan) {
    if (!entry.phones.length) { console.log(`SKIP  ${entry.title} (nobody in it)`); continue; }
    const { campaign, created } = await createDraft(db, { ...entry, actorID });
    console.log(`${created ? 'DRAFT' : 'EXISTS'} ${entry.title}`);
    console.log(`      id=${campaign.id} recipients=${entry.phones.length}`);
  }

  console.log('\nNothing submitted, approved, scheduled or sent. No coupon minted.');
  console.log('The code goes out only to people who REPLY, from lib/campaigns/check-in-reply.js.');
}

main().catch(error => { console.error(error.message); process.exit(1); });
