'use strict';
/**
 * Face ID sits between an intention and an outcome, on the actions that cannot
 * be taken back: putting somebody back into every future campaign, approving
 * the message that will be sent, and giving that message a time to go out.
 *
 * It is NOT authentication. The person is signed in and the server has already
 * decided what they may do. These assert the two properties that make it useful
 * rather than decorative, and the one that stops it becoming a locked door.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HELPER = read('ios/ViciInbox/Core/AssistantSpeechModels.swift');
const DNC = read('ios/ViciInbox/UI/SegmentsView.swift');
const CAMPAIGNS = read('ios/ViciInbox/UI/CampaignsView.swift');
const PLIST = read('ios/ViciInbox/Resources/Info.plist');

test('the Face ID purpose string exists, or the prompt crashes the app', () => {
  // iOS terminates an app that evaluates a biometric policy without this key.
  assert.match(PLIST, /NSFaceIDUsageDescription/);
  // Says what it is for and what does not happen, because it is read at the
  // moment somebody is deciding whether to trust it.
  assert.match(PLIST, /cannot be undone/);
  assert.match(PLIST, /never leaves your iPhone/);
});

test('a declined confirmation stops the action', () => {
  for (const [label, source, call] of [
    ['unblock', DNC, 'confirmThenRemove'],
    ['approve', CAMPAIGNS, 'confirmThenApprove'],
    ['schedule', CAMPAIGNS, 'confirmThenSchedule']
  ]) {
    const start = source.indexOf(`private func ${call}`);
    assert.ok(start > 0, `${call} must exist`);
    const body = source.slice(start, start + 900);
    assert.match(body, /BiometricConfirmation\.confirm/, `${label} must ask`);
    assert.match(body, /\.declined/, `${label} must handle a refusal explicitly`);
  }
});

test('an unavailable prompt PROCEEDS rather than blocking the business', () => {
  // deviceOwnerAuthentication already falls back to the passcode. `.unavailable`
  // means the device has no passcode at all, and that is not a reason somebody
  // cannot run their business from their own phone. The ordinary confirmation
  // dialog has already been answered by that point.
  assert.match(HELPER, /case unavailable/);
  assert.match(DNC, /case \.confirmed, \.unavailable:/);
  for (const call of ['confirmThenApprove', 'confirmThenSchedule']) {
    const start = CAMPAIGNS.indexOf(`private func ${call}`);
    assert.match(CAMPAIGNS.slice(start, start + 500), /guard outcome != \.declined else \{ return \}/,
      `${call} must proceed unless it was actually declined`);
  }
});

test('a recent unlock cannot satisfy the next confirmation', () => {
  // Without this, approving one campaign would silently approve the next few
  // minutes of taps, which turns a deliberate act into a formality.
  assert.match(HELPER, /touchIDAuthenticationAllowableReuseDuration = 0/);
});

test('the prompt names the action, not the app', () => {
  // The system reason string is the only thing on screen at the moment of
  // deciding. "Vici Inbox" tells somebody nothing about what they are agreeing
  // to; the consequence does.
  assert.match(DNC, /Confirm that campaigns may reach .* again/);
  assert.match(CAMPAIGNS, /Confirm approval of this campaign message and audience/);
  assert.match(CAMPAIGNS, /Confirm scheduling this campaign to go out to customers/);
});
