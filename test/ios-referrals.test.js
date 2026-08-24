'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
const MANAGER = read('ios/ViciInbox/App/MessageNotificationManager.swift');
const MODELS = read('ios/ViciInbox/Core/ReferralModels.swift');
const API = read('ios/ViciInbox/Core/APIClient.swift');
const VIEWS = read('ios/ViciInbox/UI/ReferralViews.swift');
const INBOX = read('ios/ViciInbox/UI/InboxViews.swift');
const APNS = read('lib/apns-notify.js');

test('referral notification identity is atomic and never becomes unread SMS', () => {
  assert.match(ROUTER, /case referral\(id: String, phone: String\)/);
  assert.match(ROUTER, /return \.referral\(id: referralID, phone: phone\)/);
  assert.match(ROUTER, /if clean\(rawReferralID\) != nil \{ return \.navigation \}/);
  assert.match(MANAGER, /referralID: referralID/);
  const tapped = MANAGER.slice(MANAGER.indexOf('switch route {'), MANAGER.indexOf('AppRouter.shared.queue(route)'));
  assert.doesNotMatch(tapped, /case \.referral[\s\S]*noteIncomingMessage/);
});

test('the registered category matches the referral APNs payload and has a private placeholder', () => {
  assert.match(APNS, /category: 'REFERRAL'/);
  assert.match(MANAGER, /referralCategory = "REFERRAL"/);
  assert.match(MANAGER, /hiddenPreviewsBodyPlaceholder: "Conversation referral"/);
});

test('referral notes stay in a dedicated composer with no outbound message dependency', () => {
  assert.match(MODELS, /struct ReferralComposerDraft/);
  assert.match(VIEWS, /@StateObject private var model = ReferralComposerModel\(\)/);
  assert.match(VIEWS, /never sent to the customer and does not change the message draft/);
  for (const source of [MODELS, VIEWS]) {
    assert.doesNotMatch(source, /sendMessage|\.send\(text:|sms_messages|mediaURLs/);
  }
  assert.match(INBOX, /@State private var draft = ""/);
  assert.match(INBOX, /ReferralComposerView\(conversation: conversation\)/);
});

test('the iOS client covers the complete server referral lifecycle', () => {
  for (const pathPart of [
    '/api/referrals/recipients', '/api/referrals', '/claim', '/reassign', '/hand-back', '/resolve'
  ]) assert.ok(API.includes(pathPart), `missing API contract ${pathPart}`);
  for (const action of ['Claim referral', 'Reassign', 'Hand back', 'Resolve']) {
    assert.ok(VIEWS.includes(action), `missing UI action ${action}`);
  }
});

test('legacy shared identity cannot see or create referrals', () => {
  assert.match(VIEWS, /isSharedTeamLogin != false/);
  assert.match(INBOX, /currentUser\?\.isSharedTeamLogin == false/);
  assert.match(VIEWS, /Named account required/);
});
