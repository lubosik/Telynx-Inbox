'use strict';

/**
 * The Automations screen must state WHEN, exactly.
 *
 * The owner's instruction of 27 Sep 2026: "in the automation section, we should
 * see the exact date and time that these messages are going to be sent, not
 * just the VIP welcome messages, but also any check-in messages and any payment
 * reminders that are part of the cadence or sequence."
 *
 * Three queues feed that screen and they come from two different subsystems:
 * check-ins and VIP welcomes are campaigns with recipient rows, while payment
 * reminders are flow jobs in sms_scheduled. This file holds all three to the
 * same contract so a future change to one cannot quietly regress the others.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const workspace = read('ios/ViciInbox/UI/WorkspaceViews.swift');
const activityRoute = read('routes/activity.js');
const mobileModels = read('ios/ViciInbox/Core/MobileModels.swift');
const featureModels = read('ios/ViciInbox/App/FeatureModels.swift');

test('the queued rows print an exact instant, never a relative string', () => {
  const start = workspace.indexOf('private struct ActivityRow: View');
  assert.ok(start > 0, 'ActivityRow not found');
  const row = workspace.slice(start, workspace.indexOf('struct CallsView', start));

  // An exact, zone-labelled format, matching the check-in and VIP welcome rows.
  assert.match(row, /dateFormat = "MMM d, h:mm a zzz"/);
  // "in 3 days" is the thing being removed; it must not come back here.
  assert.doesNotMatch(row, /style: \.relative/);
  // The store's zone, not the device's, with New York as the documented fallback.
  assert.match(row, /timeZoneID/);
  assert.match(row, /America\/New_York/);
});

test('both queue lists are given the store time zone', () => {
  // Queued sends and recent sends both render through ActivityRow, so both have
  // to be handed the zone or one of them silently formats in the wrong one.
  assert.match(workspace, /ActivityRow\(item: item, date: item\.sendAt, timeZoneID: model\.timeZoneID\)/);
  assert.match(workspace, /ActivityRow\(item: item, date: item\.sentAt, timeZoneID: model\.timeZoneID\)/);
});

test('the server sends the business time zone with the queue', () => {
  const start = activityRoute.indexOf("router.get('/queue'");
  assert.ok(start > 0, 'queue route not found');
  const handler = activityRoute.slice(start, activityRoute.indexOf("router.get('/recent'", start));
  assert.match(handler, /timeZone: settings\?\.business_timezone \|\| 'America\/New_York'/);
  // A settings read failure must not take the queue down with it: knowing what
  // is about to send matters more than labelling its zone.
  assert.match(handler, /loadCampaignSettings\(supabase\)\.catch\(\(\) => null\)/);
});

test('the app can decode a server that omits the zone', () => {
  // Field binaries talk to whichever server is deployed, so the new field is
  // optional rather than required, and the model falls back rather than failing.
  assert.match(mobileModels, /struct ActivityPage: Codable \{[\s\S]*let timeZone: String\?/);
  assert.match(featureModels, /timeZoneID = values\.1\.timeZone \?\? values\.2\.timeZone/);
});

test('the campaign-backed queues still carry their own send time', () => {
  // These two already reported a time; assert it so removing the field from
  // either reader fails here rather than on somebody's phone.
  const checkIn = read('lib/campaigns/check-in-automation.js');
  const vipWelcome = read('lib/campaigns/vip-welcome-automation.js');
  for (const [name, source] of [['check-in', checkIn], ['VIP welcome', vipWelcome]]) {
    assert.match(source, /sendAt: row\.planned_send_at/, `${name} queue must expose a send time`);
  }
  assert.match(workspace, /func checkInSendTime\(_ date: Date, timeZoneID: String\?\)/);
  assert.match(workspace, /func vipWelcomeSendTime\(_ date: Date, timeZoneID: String\?\)/);
});
