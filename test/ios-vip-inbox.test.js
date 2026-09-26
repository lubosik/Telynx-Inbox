'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const models = fs.readFileSync(path.join(root, 'ios/ViciInbox/Core/MobileModels.swift'), 'utf8');
const view = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/InboxViews.swift'), 'utf8');
const campaigns = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/CampaignsView.swift'), 'utf8');
const analytics = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/AnalyticsView.swift'), 'utf8');
const featureModel = fs.readFileSync(path.join(root, 'ios/ViciInbox/App/FeatureModels.swift'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'scripts/vip-customer-segment-migration.sql'), 'utf8');

test('VIP and All Customers are filters over the same canonical conversation route', () => {
  assert.match(view, /case \.all: return model\.conversations/);
  assert.match(view, /case \.vip: return model\.conversations\.filter\(\\\.isVIP\)/);
  assert.match(view, /AppRoute\.conversation\(phone: conversation\.phone\)/);
  assert.doesNotMatch(view, /VIPConversation|vipMessages|duplicateContact/);
});

test('manual VIP placement uses the existing permissioned audited override API', () => {
  assert.match(view, /session\.can\(Permission\.campaignsManage\)/);
  assert.match(featureModel, /setSegmentOverride\(/);
  assert.match(featureModel, /overrideType: \.include/);
  assert.match(featureModel, /revokeSegmentOverride\(/);
  assert.match(featureModel, /guard conversation\.isManualOnlyVIP/);
});

test('the iOS wire model decodes server-owned VIP facts without making them consent', () => {
  for (const key of [
    'customer_tier', 'vip_state', 'vip_source', 'vip_automatic',
    'vip_manual_override', 'vip_progress', 'vip_segment_id',
    'paid_order_count', 'lifetime_spend_cents'
  ]) assert.ok(models.includes(`"${key}"`), `missing wire key ${key}`);
  assert.doesNotMatch(models, /var smsConsent[^\n]*customerTier|var smsConsent[^\n]*isVIP/);
});

test('the repeatable seed fixes the permanent rule and cannot send or alter consent', () => {
  assert.match(migration, /'best_repeat_customers'/);
  assert.match(migration, /'order_count', 'operator', 'at_least', 'value', 3/);
  assert.match(migration, /'lifetime_spend', 'operator', 'at_least', 'value', 500/);
  assert.match(migration, /ON CONFLICT \(workspace_id, segment_key\) DO NOTHING/);
  assert.doesNotMatch(migration, /sms_messages|send_message|sms_consent|commercial_eligibility/);
});

test('the inbox stays focused on conversations without counts, workspaces or gold row boxes', () => {
  assert.match(models, /Past usual reorder timing/);
  assert.match(models, /days beyond their usual/);
  assert.doesNotMatch(models, /case "needs_attention": return "Needs attention"/);
  assert.match(view, /Text\("VIP"\)\.tag\(InboxAudience\.vip\)/);
  assert.ok(!view.includes('Text("VIP \\(vipCount)")'));
  assert.doesNotMatch(view, /VIPWorkspaceCard/);
  assert.doesNotMatch(view, /Color\.yellow\.opacity\(0\.055\)/);
  assert.doesNotMatch(view, /vipTimingDetail/);
});

test('Growth owns each VIP timing group and seeds a personalized campaign draft', () => {
  for (const group of ['pastTiming', 'atTiming', 'withinTiming', 'noTiming']) {
    assert.ok(campaigns.includes(`case .${group}:`), `missing VIP group ${group}`);
  }
  assert.match(campaigns, /Section\("VIP customers"\)/);
  assert.match(campaigns, /if session\.can\(Permission\.campaignsManage\)[\s\S]*Create a VIP campaign/);
  assert.match(campaigns, /Create a VIP campaign/);
  assert.match(campaigns, /Open VIP audience/);
  assert.match(campaigns, /VIP offer ideas/);
  assert.match(campaigns, /conversations\.filter\(focus\.includes\)/);
  assert.match(campaigns, /initialTitle: focus\.campaignTitle/);
  assert.match(campaigns, /initialMessage: focus\.campaignMessage/);
  assert.match(campaigns, /initialBrief: focus\.campaignBrief/);
  assert.match(campaigns, /workflowCategory: "vip"/);
  assert.match(campaigns, /\{\{first_name\}\}/);
  assert.doesNotMatch(campaigns.slice(0, campaigns.indexOf('struct CampaignsView')), /Reply STOP to opt out\./);
  // The tail of this sentence grew when the quiet-VIP group gained an offer, so
  // assert the surveillance prohibition itself rather than the exact wording.
  assert.match(campaigns, /Never mention tracking, cadence, being overdue/);
});

test('VIP totals live in Analytics and are explicitly lifetime figures', () => {
  assert.match(analytics, /VIPCustomerAnalyticsCard/);
  assert.match(analytics, /Lifetime spend/);
  assert.match(analytics, /Average lifetime value/);
  assert.match(analytics, /These lifetime figures do not change with the date filter above/);
});

test('Analytics owns a clean, date-filtered VIP Top 10 leaderboard', () => {
  assert.match(analytics, /VIPLeaderboardView/);
  assert.match(analytics, /VIP Leaderboard/);
  assert.match(analytics, /Dynamic Top 10 by orders, spend and average order value/);
  assert.match(analytics, /AnalyticsPeriodPicker\(selected: period\)/);
  assert.match(analytics, /Rankings recalculate as orders arrive/);
  assert.match(analytics, /Only paid orders in the selected period affect the score/);
  assert.doesNotMatch(analytics, /Color\.yellow\.opacity/);
});

test('campaign copy assistance uses compact list rows without a divider spacer', () => {
  const section = campaigns.slice(
    campaigns.indexOf('Section("Copy assistant")'),
    campaigns.indexOf('ForEach(model.suggestions)')
  );
  assert.match(section, /Improve this message/);
  assert.match(section, /Describe a different message or change/);
  assert.doesNotMatch(section, /Divider\(\)/);
});

// ── THE QUIET-VIP WIN-BACK OFFER ─────────────────────────────────────────
//
// The owner's instruction on 27 Sep 2026 was that a VIP who has gone quiet
// gets a deeper discount plus the 1:1 coaching VIP already includes. The two
// things worth locking are the ones that cost money or invite a complaint: the
// percentage must travel with `{{code}}` so no coupon can be substituted for a
// different amount, and the copy must never tell the customer that the shop
// noticed they went quiet.
test('the quiet-VIP group carries the verified discount and the included 1:1 support', () => {
  const start = campaigns.indexOf('var campaignMessage: String');
  const end = campaigns.indexOf('var campaignBrief: String');
  assert.ok(start > 0 && end > start, 'campaignMessage block not found');
  const messages = campaigns.slice(start, end);
  const pastTiming = messages.slice(messages.indexOf('case .pastTiming:'));
  const quiet = pastTiming.slice(0, pastTiming.indexOf('case .'), 1) || pastTiming;

  // The offer itself.
  assert.match(quiet, /30% off/);
  // The coupon's real $100 minimum must be visible to the customer, or the code
  // refuses them at checkout. The validator only permits this amount when
  // WooCommerce has verified it, so the two sides cannot drift.
  assert.match(quiet, /orders \$100 or more/);
  assert.match(quiet, /\{\{code\}\}/);
  assert.match(quiet, /1:1 research support/);
  assert.match(quiet, /24\/7/);
  assert.match(quiet, /can cost thousands a month/);
  assert.match(quiet, /included at no extra cost/);
  assert.match(quiet, /VIP/);

  // A percentage with no coupon placeholder would be an unbacked promise.
  assert.ok(quiet.includes('{{code}}'),
    'a stated percentage must travel with {{code}} so the coupon gate can verify it');

  // "free" and "sale" are blocked carrier-risk terms in the shared validator.
  assert.doesNotMatch(quiet, /\bfree\b/i);
  assert.doesNotMatch(quiet, /\bsale\b/i);
  assert.doesNotMatch(quiet, /!/);

  // Never tell the customer they were being watched.
  assert.doesNotMatch(quiet, /gone quiet|quiet|overdue|running low|cadence|due for|haven't ordered/i);

  // The brief must carry the coupon requirement forward to whoever edits it.
  const briefs = campaigns.slice(end);
  const briefStart = briefs.indexOf('case .pastTiming:');
  const brief = briefs.slice(briefStart, briefs.indexOf('case .', briefStart + 10));
  assert.match(brief, /verified 30% coupon/);
  assert.match(brief, /Never say free/);
  assert.match(brief, /gone quiet/);
});
