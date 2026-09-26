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
  assert.match(campaigns, /Never mention tracking, cadence, being overdue or running low/);
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
