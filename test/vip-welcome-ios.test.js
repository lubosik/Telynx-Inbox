'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const models = fs.readFileSync(
  path.join(ROOT, 'ios/ViciInbox/Core/CampaignModels.swift'), 'utf8'
);
const api = fs.readFileSync(
  path.join(ROOT, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8'
);
const views = fs.readFileSync(
  path.join(ROOT, 'ios/ViciInbox/UI/WorkspaceViews.swift'), 'utf8'
);

test('iOS decodes the VIP welcome settings and every queued personal message', () => {
  assert.match(models, /struct VIPWelcomeAutomation: Codable, Hashable/);
  assert.match(models, /let delayHours: Int\?/);
  assert.match(models, /let conversationGuardHours: Int\?/);
  assert.match(models, /let messageTemplate: String/);
  assert.match(models, /let queuedRecipients: \[VIPWelcomeAutomationRecipient\]\?/);
  assert.match(models, /struct VIPWelcomeAutomationRecipient: Codable, Hashable, Identifiable/);
  assert.match(models, /let campaignID: String/);
  assert.match(models, /let message: String\?/);
  assert.match(models, /let sendAt: String\?/);
});

test('iOS reads and updates the VIP welcome automation through its dedicated API', () => {
  assert.match(api, /func fetchVIPWelcomeAutomation\(\) async throws -> VIPWelcomeAutomation/);
  assert.match(api, /decodedGET\("\/api\/campaigns\/automations\/vip-welcome"\)/);
  assert.match(api, /func updateVIPWelcomeAutomation\(enabled: Bool,[\s\S]*messageTemplate: String\)/);
  assert.match(api, /put\("\/api\/campaigns\/automations\/vip-welcome", body:/);
  assert.match(api, /"enabled": enabled/);
  assert.match(api, /"messageTemplate": messageTemplate/);
});

test('VIP welcome is a visible, editable automation with a person-by-person queue', () => {
  const sectionStart = views.indexOf('struct VIPWelcomeAutomationSection');
  const queueStart = views.indexOf('struct AutomationQueueView');
  assert.ok(sectionStart >= 0 && queueStart > sectionStart);
  const section = views.slice(sectionStart, queueStart);

  assert.match(section, /Text\("VIP welcome"\)/);
  assert.match(section, /automation\?\.delayHours \?\? 24/);
  assert.match(section, /automation\?\.conversationGuardHours \?\? 2/);
  assert.match(section, /Label\("Edit message", systemImage: "pencil"\)/);
  assert.match(section, /TextEditor\(text: \$templateDraft\)/);
  assert.match(section, /Editing the template changes future welcomes only/);
  assert.match(section, /LabeledContent\("Pending"/);
  assert.match(section, /ForEach\(Array\(queued\.prefix\(3\)\)\)/);
  assert.match(section, /recipient\.message/);
  assert.match(section, /AutomationRecipientQueueSheet\(/);
  assert.doesNotMatch(section, /AppRoute\.campaign\(id: recipient\.campaignID\)/);
  assert.match(section, /America\/New_York/);
  assert.match(section, /timeZone\.identifier/);

  const queue = views.slice(queueStart);
  assert.ok(
    queue.indexOf('VIPWelcomeAutomationSection()') < queue.indexOf('CheckInAutomationSection()'),
    'the VIP welcome and check-in are adjacent in the compact dashboard'
  );
});

test('VIP welcome edits retain personalisation and stay permission-gated', () => {
  const section = views.slice(
    views.indexOf('struct VIPWelcomeAutomationSection'),
    views.indexOf('struct AutomationQueueView')
  );
  assert.match(section, /session\.can\(Permission\.campaignsApprove\)/);
  assert.match(section, /Include \{\{first_name\}\} so every welcome is personal/);
  assert.match(section, /Keep the welcome message to 500 characters or fewer/);
  assert.match(section, /\.disabled\(!canApprove \|\| isBusy\)/);
});
