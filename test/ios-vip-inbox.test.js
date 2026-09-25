'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const models = fs.readFileSync(path.join(root, 'ios/ViciInbox/Core/MobileModels.swift'), 'utf8');
const view = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/InboxViews.swift'), 'utf8');
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

test('VIP status is plain English, actionable, and the VIP campaign path is a draft', () => {
  assert.match(models, /Past usual reorder timing/);
  assert.match(models, /days beyond their usual/);
  assert.doesNotMatch(models, /case "needs_attention": return "Needs attention"/);
  assert.match(view, /Work priority list/);
  assert.match(view, /Draft all VIPs/);
  assert.match(view, /VIP offers/);
  assert.match(view, /CampaignEditorView\(\s*initialContacts: vipConversations/);
  assert.match(view, /No message is sent from this VIP screen/);
});

test('each live VIP timing group can seed a personalized campaign draft', () => {
  for (const group of ['pastTiming', 'atTiming', 'withinTiming', 'noTiming']) {
    assert.ok(view.includes(`case .${group}:`), `missing VIP group ${group}`);
  }
  assert.match(view, /vipConversations\.filter\(focus\.includes\)/);
  assert.match(view, /initialTitle: focus\.campaignTitle/);
  assert.match(view, /initialMessage: focus\.campaignMessage/);
  assert.match(view, /initialBrief: focus\.campaignBrief/);
  assert.match(view, /\{\{first_name\}\}/);
  assert.match(view, /Reply STOP to opt out\./);
  assert.match(view, /Never mention tracking, cadence, being overdue or running low/);
  assert.match(view, /Draft this group/);
});
