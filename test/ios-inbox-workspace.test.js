'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Main/VIP selection persists consistently across inbox, contacts and shell', () => {
  for (const file of ['UI/InboxViews.swift', 'UI/WorkspaceViews.swift', 'UI/RootView.swift']) {
    assert.match(read(`ios/ViciInbox/${file}`), /@AppStorage\(InboxWorkspace\.storageKey\)/);
  }
  assert.match(read('ios/ViciInbox/UI/WorkspaceViews.swift'), /workspace\.includes\(\$0\)/);
});

test('selected inbox badge is scoped while the application badge remains global', () => {
  const root = read('ios/ViciInbox/UI/RootView.swift');
  assert.match(root, /\.badge\(tabBadge\(for: tab\)\)/);
  assert.match(root, /case \.inbox: return workspace\.unreadCount\(in: inboxModel\.conversations\)/);
  assert.match(read('ios/ViciInbox/App/FeatureModels.swift'), /setUnreadMessages\(unreadTotal\)/);
});

test('notification destinations follow authoritative customer membership without replacing history or resetting paths', () => {
  const view = read('ios/ViciInbox/UI/InboxViews.swift');
  const destination = view.slice(view.indexOf('private struct ConversationDestinationView'), view.indexOf('private struct ConversationRow'));
  assert.match(destination, /\.task\(id: conversation\?\.customerTier\)/);
  assert.match(destination, /InboxWorkspace\.destination\(for: conversation\)/);
  assert.doesNotMatch(destination, /inboxPath\s*=|messages\s*=|filter\(.*direction/);
  assert.match(read('ios/ViciInbox/App/FeatureModels.swift'), /fetchThread\(phone: phone\)/);
});

test('message line provenance is nullable and never inferred from current VIP membership', () => {
  assert.match(read('ios/ViciInbox/Core/MobileModels.swift'), /let businessPhone: String\?/);
  assert.match(read('ios/ViciInbox/Core/MobileModels.swift'), /case businessPhone = "business_phone"/);
  const view = read('ios/ViciInbox/UI/InboxViews.swift');
  assert.match(view, /if let line = message\.businessPhone, !line\.isEmpty/);
  assert.match(view, /SMS replies from/);
  assert.doesNotMatch(view, /message\.businessPhone\s*\?\?\s*conversation\.replyFromNumber/);
});
