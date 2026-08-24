'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MODIFIER = read('ios/ViciInbox/UI/AssistantDraftOwnerModifier.swift');
const COORDINATOR = read('ios/ViciInbox/App/AssistantNavigationCoordinator.swift');

test('draft owner modifier registers once and acts only on the exact active request', () => {
  assert.match(MODIFIER, /guard token == nil else \{ return \}/);
  assert.match(MODIFIER, /request\.tokenIDs\.contains\(token\.id\)/);
  assert.match(MODIFIER, /guard registry\.discardRequest\?\.id == requestID else \{ return \}/);
  assert.match(MODIFIER, /discard\(\)[\s\S]*registry\.acknowledgeDiscard/);
  assert.match(MODIFIER, /registry\.unregister\(token\)/);
  for (const forbidden of ['draftText', 'messageBody', 'Data', 'URL', 'customerID', 'Logger(']) {
    assert.equal(MODIFIER.includes(forbidden), false, `modifier stores or logs ${forbidden}`);
  }
});

test('every mutable owner family participates in the global guard', () => {
  const expected = {
    'ios/ViciInbox/UI/InboxViews.swift': ['draft', 'replyTarget', 'pickerItems', 'imageData', 'pickerLoadID'],
    'ios/ViciInbox/UI/CampaignsView.swift': ['model.hasUnsavedDraftChanges', 'reason', 'scheduledFor'],
    'ios/ViciInbox/UI/SegmentsView.swift': ['name', 'purpose', 'picker.selectedCount'],
    'ios/ViciInbox/UI/SegmentRuleBuilderView.swift': ['model.hasRules', 'editing = nil', 'model.startOver()'],
    'ios/ViciInbox/UI/ReferralViews.swift': ['model.draft.recipient', 'selectedRecipient', 'note'],
    'ios/ViciInbox/UI/SegmentDetailView.swift': ['reason', 'chosen', 'note'],
    'ios/ViciInbox/UI/WorkspaceViews.swift': ['firstName', 'lastName', 'phone', 'email', 'notes'],
    'ios/ViciInbox/UI/ProfileEditorView.swift': ['model.hasUnsavedDraftChanges', 'model.newEmail = ""'],
    'ios/ViciInbox/UI/ChangePasswordView.swift': ['currentPassword', 'newPassword', 'confirmation'],
    'ios/ViciInbox/UI/TeamView.swift': ['name', 'email', 'role', 'selectedRole !=', 'initialRole',
      'savedRole = selectedRole', 'model.newInvitation == nil'],
    'ios/ViciInbox/UI/DialerView.swift': ['number', 'isDirty: !number.isEmpty']
  };
  for (const [file, markers] of Object.entries(expected)) {
    const source = read(file);
    assert.match(source, /\.assistantDraftOwner\(/, `${file} has no owner`);
    for (const marker of markers) assert.ok(source.includes(marker), `${file} misses ${marker}`);
  }
});

test('Assistant draft is manually fenced so consuming its own command is synchronous', () => {
  const assistant = read('ios/ViciInbox/UI/AssistantView.swift');
  const model = read('ios/ViciInbox/App/AssistantModel.swift');
  assert.match(assistant, /drafts\.register\(source: \.assistant\)/);
  assert.match(assistant, /drafts\.setDirty\(false, for: draftToken\)/);
  assert.match(assistant, /discardAssistantDraftIfRequested/);
  assert.match(model, /onDraftConsumed\?\(\)[\s\S]*draft = ""/);
});

test('attachment loading is invalidated before local attachment state is cleared', () => {
  const inbox = read('ios/ViciInbox/UI/InboxViews.swift');
  assert.match(inbox, /let loadID = UUID\(\)[\s\S]*pickerLoadID = loadID/);
  assert.match(inbox, /guard pickerLoadID == loadID else \{ return \}/);
  const discard = inbox.slice(inbox.indexOf('.assistantDraftOwner(', inbox.indexOf('struct MessageThreadView')));
  assert.ok(discard.indexOf('pickerLoadID = UUID()') < discard.indexOf('pickerItems = []'));
});

test('registry retains reusable owner tokens and requires explicit acknowledgements', () => {
  assert.match(COORDINATOR, /entry\.acknowledgedDiscardID = request\.id/);
  assert.match(COORDINATOR, /entry\.acknowledgedDiscardID != request\.id/);
  assert.doesNotMatch(COORDINATOR, /clearAfterConfirmedDiscard/);
});

test('all changed Swift owners pass parser validation', () => {
  const files = [
    'ios/ViciInbox/UI/AssistantDraftOwnerModifier.swift',
    'ios/ViciInbox/UI/InboxViews.swift', 'ios/ViciInbox/UI/CampaignsView.swift',
    'ios/ViciInbox/UI/SegmentsView.swift', 'ios/ViciInbox/UI/SegmentRuleBuilderView.swift',
    'ios/ViciInbox/UI/ReferralViews.swift', 'ios/ViciInbox/UI/SegmentDetailView.swift',
    'ios/ViciInbox/UI/WorkspaceViews.swift', 'ios/ViciInbox/UI/ProfileEditorView.swift',
    'ios/ViciInbox/UI/ChangePasswordView.swift', 'ios/ViciInbox/UI/TeamView.swift',
    'ios/ViciInbox/UI/DialerView.swift', 'ios/ViciInbox/UI/AssistantView.swift',
    'ios/ViciInbox/App/CampaignViewModels.swift', 'ios/ViciInbox/App/SegmentViewModels.swift'
  ].map(file => path.join(ROOT, file));
  const result = spawnSync('xcrun', ['swiftc', '-parse', ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
