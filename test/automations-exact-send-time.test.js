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

  // Formatted through the shared helper, so this screen cannot drift from the
  // campaign screen's wording of the same instant.
  assert.match(row, /AutomationSendTime\.exact\(parsed, inZoneNamed: timeZoneID\)/);
  // "in 3 days" is the thing being removed; it must not come back here.
  assert.doesNotMatch(row, /style: \.relative/);
  assert.match(row, /timeZoneID/);
});

test('one send-time format is shared with the campaign screen', () => {
  const campaigns = read('ios/ViciInbox/UI/CampaignsView.swift');
  // The exact format string the campaign screen uses for a scheduled send. The
  // owner asked to read automation times "just like we can see the campaigns",
  // so a difference here is the defect, not a detail.
  const format = /dateFormat = "EEE, MMM d 'at' h:mm a zzz"/;
  assert.match(campaigns, format, 'campaign screen format changed; update the shared helper');
  assert.match(workspace, format);

  // Exactly one definition of it on the automations screen: the shared helper.
  const occurrences = workspace.match(/dateFormat = "EEE, MMM d 'at' h:mm a zzz"/g) || [];
  assert.equal(occurrences.length, 1, 'the automations screen must format send times in one place');

  // And the three surfaces all go through it rather than rolling their own.
  assert.match(workspace, /enum AutomationSendTime/);
  assert.match(workspace, /private func checkInSendTime[\s\S]{0,160}AutomationSendTime\.exact/);
  assert.match(workspace, /private func vipWelcomeSendTime[\s\S]{0,160}AutomationSendTime\.exact/);
});

test('Eastern Time is expressed as a zone, never as a fixed EST offset', () => {
  // America/New_York IS Eastern Time and prints EDT or EST as appropriate.
  // Hard-coding EST would mislabel every summer send and invites a fixed -5
  // offset that would fire an hour late for eight months of the year.
  assert.match(workspace, /America\/New_York/);
  assert.doesNotMatch(workspace, /TimeZone\(abbreviation: "EST"\)/);
  assert.doesNotMatch(workspace, /secondsFromGMT: -5 \* 3600/);
});

test('the store time and the viewer time are shown together, as on campaigns', () => {
  // The owner reads this from the UK, and the London gap is not even constant:
  // 6 PM New York is 23:00 in London in September, 22:00 on 25 October, then
  // 23:00 again from 1 November. One clock time cannot serve both.
  assert.match(workspace, /struct AutomationSendTimeRows: View/);
  assert.match(workspace, /LabeledContent\("Your time"\)/);
  assert.match(workspace, /store\.identifier != viewerZone\.identifier/);
  // Both campaign-backed automations use it.
  assert.match(workspace, /AutomationSendTimeRows\(label: "Next send"/);
  assert.match(workspace, /AutomationSendTimeRows\(label: "Sends at"/);
  assert.match(workspace, /viewerZone: appearance\.effectiveTimeZone/);
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
