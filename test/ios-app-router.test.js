'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
const ROOT_VIEW = read('ios/ViciInbox/UI/RootView.swift');
const GROWTH = read('ios/ViciInbox/UI/GrowthView.swift');
const INBOX = read('ios/ViciInbox/UI/InboxViews.swift');
const NOTIFICATIONS = read('ios/ViciInbox/App/MessageNotificationManager.swift');

test('one app router owns tab and per-tab typed paths above MainTabView', () => {
  assert.match(ROUTER, /final class AppRouter: ObservableObject/);
  assert.match(ROUTER, /@Published var selectedTab: AppTab/);
  for (const pathName of ['inboxPath', 'contactsPath', 'growthPath', 'callsPath', 'analyticsPath']) {
    assert.match(ROUTER, new RegExp(`@Published var ${pathName}: \\[AppRoute\\]`));
  }
  assert.match(ROOT_VIEW, /TabView\(selection: \$router\.selectedTab\)/);
  assert.doesNotMatch(ROOT_VIEW, /@State private var selection:/);
});

test('programmatic conversation and Growth destinations use the shared typed route', () => {
  assert.match(INBOX, /NavigationStack\(path: \$router\.inboxPath\)/);
  assert.match(INBOX, /AppRoute\.conversation\(phone: conversation\.phone\)/);
  assert.match(GROWTH, /NavigationStack\(path: \$router\.growthPath\)/);
  assert.match(GROWTH, /navigationDestination\(for: AppRoute\.self\)/);
  assert.doesNotMatch(GROWTH, /private enum Route/);
  assert.doesNotMatch(GROWTH, /NavigationPath\(\)/);
});

test('segment notification routing is centralized and selects Audiences', () => {
  assert.match(ROUTER, /case "segments", "audiences": return \.growth\(\.audiences\)/);
  assert.match(ROUTER, /return \.segment\(id: segmentID, name: nil\)/);
  assert.doesNotMatch(ROOT_VIEW, /switch screen\.lowercased\(\)/);
  assert.doesNotMatch(GROWTH, /pendingSegmentID|pendingScreen/);
  assert.match(NOTIFICATIONS, /AppRouter\.shared\.queue\(route\)/);
});

test('every named foreground destination is excluded from the message badge', () => {
  assert.match(ROUTER, /if screen != nil \{ return \.navigation \}/);
  assert.match(NOTIFICATIONS, /case \.navigation:[\s\S]*?break/);
  assert.doesNotMatch(
    NOTIFICATIONS,
    /switch screen\?\.lowercased\(\)[\s\S]*?default:[\s\S]*?noteIncomingMessage\(\)/
  );
});

test('routes carry scalar identity and never credential or content fields', () => {
  for (const forbidden of ['token:', 'messageBody:', 'internalNote:', 'AttributionRecord', 'ConversationSummary']) {
    assert.equal(ROUTER.includes(forbidden), false, `route contains forbidden state: ${forbidden}`);
  }
  assert.match(ROUTER, /case conversation\(phone: String\)/);
  assert.match(ROUTER, /case campaign\(id: String\)/);
  assert.match(ROUTER, /case segment\(id: String, name: String\?\)/);
});

test('explicit sign out clears every path and queued customer destination', () => {
  const reset = ROUTER.slice(
    ROUTER.indexOf('func resetForSignOut()'),
    ROUTER.indexOf('func sanitize(access:')
  );
  for (const pathName of ['inboxPath', 'contactsPath', 'growthPath', 'callsPath',
    'analyticsPath', 'accountPath']) {
    assert.match(reset, new RegExp(`${pathName} = \\[]`), `${pathName} survives sign out`);
  }
  assert.match(reset, /pendingRoute = nil/);
  assert.match(ROOT_VIEW, /router\.resetForSignOut\(\)/);
});

test('revoking campaigns removes the read-only opportunity evidence route', () => {
  const sanitize = ROUTER.slice(
    ROUTER.indexOf('func sanitize(access:'),
    ROUTER.indexOf('private func replacePath')
  );
  assert.match(sanitize, /case \.opportunities, \.campaign, \.segment, \.segmentPeople,[\s\S]*?\.campaignAttributions/);
  assert.match(sanitize, /if !access\.campaignsManage[\s\S]*?\.campaignProposals/);
});
