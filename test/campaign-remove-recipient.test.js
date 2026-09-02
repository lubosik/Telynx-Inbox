'use strict';
/**
 * test/campaign-remove-recipient.test.js — an instruction needs a remedy.
 *
 * The preview said "1 cannot be personalised and must be removed from the
 * audience before this can be approved" and then offered no way to remove
 * them. The owner's words: he should not have to find their number and go
 * through it, there should be a button.
 *
 * An instruction with no remedy is worse than no instruction — it names a
 * blocker and leaves the reader to work out the mechanics, which is exactly
 * the friction the screen exists to remove.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the audience cannot be edited once a campaign is past approval', () => {
  // Deselecting somebody already sent to would rewrite the record of what
  // happened; deselecting after approval but before sending would mean the
  // audience no longer matches the one that was approved.
  const service = read('lib', 'campaigns', 'service.js');
  const fn = service.slice(service.indexOf('async function deselectRecipient'));
  const body = fn.slice(0, fn.indexOf('async function performance'));

  assert.match(body, /'draft', 'review_required', 'approval_pending', 'rejected'/,
    'only the pre-approval statuses');
  assert.match(body, /CAMPAIGN_AUDIENCE_LOCKED/);
  assert.match(body, /\.is\('sent_at', null\)/,
    'and never a row that has already been sent to');
});

test('a removed recipient is deselected, never deleted', () => {
  // Why somebody was excluded is worth more than the row costs, and a campaign
  // whose audience silently shrinks cannot be audited afterwards.
  const service = read('lib', 'campaigns', 'service.js');
  const fn = service.slice(service.indexOf('async function deselectRecipient'));
  const body = fn.slice(0, fn.indexOf('async function performance'));
  assert.match(body, /update\(\{ selected: false/);
  assert.doesNotMatch(body, /\.delete\(\)/);
});

test('removing somebody is audited', () => {
  const policy = read('lib', 'route-policy.js');
  assert.match(policy,
    /path: '\/api\/campaigns\/:id\/recipients\/:recipientId\/deselect', permission: 'campaigns\.manage', audit: true/);

  const { eventDefinition } = require('../lib/audit/event-types');
  assert.equal(eventDefinition('campaign.recipient_removed').category, 'campaigns');
});

test('the excluded row carries what it needs to be acted on', () => {
  // Without the recipient id the app can only name the problem. Without the
  // rendered text it can only describe it.
  const service = read('lib', 'campaigns', 'service.js');
  assert.match(service, /recipientID: match\?\.id \? String\(match\.id\) : null/);

  const render = read('lib', 'campaigns', 'render-recipients.js');
  assert.match(render, /wouldRead: outcome\.text \|\| null/,
    'the broken message is carried so it can be shown rather than described');
});

test('the app offers the button beside the problem', () => {
  const view = read('ios', 'ViciInbox', 'UI', 'CampaignsView.swift');
  assert.match(view, /Label\("Remove from audience", systemImage: "person\.badge\.minus"\)/);
  assert.match(view, /if let recipientID = row\.recipientID \{/,
    'and hides it rather than guessing an id an older server did not send');
  assert.match(view, /\.disabled\(removing\.contains\(recipientID\)\)/,
    'so a second tap cannot fire the same call');

  const model = read('ios', 'ViciInbox', 'App', 'CampaignViewModels.swift');
  assert.match(model, /await load\(canDryRun: allowsDryRun, canFinancial: allowsFinancial\)/,
    'and the screen reloads, because removing somebody changes the count and the cost');
});
