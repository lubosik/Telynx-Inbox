'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Growth and Calls send the selected customer space to their server reads', () => {
  const api = read('ios/ViciInbox/Core/APIClient.swift');
  const growth = read('ios/ViciInbox/UI/GrowthView.swift');
  const screens = read('ios/ViciInbox/UI/WorkspaceViews.swift');
  const models = read('ios/ViciInbox/App/FeatureModels.swift');
  for (const endpoint of ['/api/activity/stats', '/api/activity/overview', '/api/activity/queue',
    '/api/activity/recent', '/api/cart-recovery', '/api/cart-recovery/journeys',
    '/api/campaigns/automations/check-in', '/api/campaigns/automations/vip-welcome']) {
    assert.ok(api.includes(endpoint), `${endpoint} remains available`);
  }
  assert.match(growth, /AutomationQueueView\(workspace: workspace\)/);
  assert.match(screens, /CartRecoveryJourneyListView\(workspace: workspace\)/);
  assert.match(screens, /fetchAutomationOverview\(audience: workspace\)/);
  assert.match(screens, /fetchCheckInAutomation\(audience: requestedWorkspace\)/);
  assert.match(screens, /fetchVIPWelcomeAutomation\(audience: requestedWorkspace\)/);
  assert.match(models, /fetchCartRecoveryJourneys\(status: status,[\s\S]*?audience: audience\)/);
  assert.match(models, /fetchActivityQueue\(flow: requestedFlow,[\s\S]*?audience: audience\)/);
  assert.match(models, /markMissedCallsSeen\([\s\S]*?audience: audience,[\s\S]*?ids: logs\.filter/);
});

test('The VIP Calls screen identifies the VIP calling line only when configured', () => {
  const screens = read('ios/ViciInbox/UI/WorkspaceViews.swift');
  const dialer = read('ios/ViciInbox/UI/DialerView.swift');
  const voice = read('ios/ViciInbox/Voice/TelnyxVoiceManager.swift');
  assert.match(screens, /Outgoing calls here show the VIP number when it is ready/);
  assert.match(dialer, /VIP calling line unavailable/);
  assert.match(voice, /VIP outbound aborted.*verified VIP caller number unavailable/);
});
