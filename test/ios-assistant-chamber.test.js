'use strict';
/**
 * test/ios-assistant-chamber.test.js
 *
 * The chamber, the one-time chooser, and the send prompt.
 *
 * These are source assertions, which are weaker than running the app, and they
 * are aimed accordingly: at the handful of properties where getting it wrong is
 * silent. A screen that looks slightly off is caught the first time somebody
 * opens it. A send that skips Face ID, a chooser that reappears forever, or a
 * confirmation that hides the suppressed count are all things that look fine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CHAMBER = read('ios/ViciInbox/UI/AssistantVoiceChamberView.swift');
const PICKER = read('ios/ViciInbox/UI/AssistantVoicePickerView.swift');
const CONFIRM = read('ios/ViciInbox/UI/AssistantSendConfirmationView.swift');
const VIEW = read('ios/ViciInbox/UI/AssistantView.swift');
const MODEL = read('ios/ViciInbox/App/AssistantModel.swift');
const REASONER = read('ios/ViciInbox/App/OnDeviceAssistantReasoner.swift');

// ── The send prompt ──────────────────────────────────────────────────────────

test('SENDING GOES THROUGH FACE ID, and the check cannot be skipped by falling through', () => {
  // The whole point. A confirmation button on its own is one mis-tap from a
  // campaign, and a voice interface makes mis-taps likelier, not rarer.
  assert.match(CONFIRM, /BiometricConfirmation\.confirm\(/);
  const send = CONFIRM.slice(CONFIRM.indexOf('private func confirmThenSend'));
  const confirmAt = send.indexOf('BiometricConfirmation.confirm(');
  const guardAt = send.indexOf('guard outcome != .declined else { return }');
  const approveAt = send.indexOf('approveCampaign');
  assert.ok(confirmAt >= 0 && guardAt >= 0 && approveAt >= 0);
  // Order is the assertion. Asking after approving would be theatre.
  assert.ok(confirmAt < guardAt, 'the outcome must be asked for before it is checked');
  assert.ok(guardAt < approveAt, 'nothing may be approved before the face answers');
});

test('a declined face stops the send, and an absent one does not lock the phone out', () => {
  const send = CONFIRM.slice(CONFIRM.indexOf('private func confirmThenSend'));
  // Only `.declined` returns. `.unavailable` proceeds, because a device with
  // no passcode at all is not a reason somebody cannot run their business, and
  // the ordinary confirmation was already answered by pressing the button.
  assert.match(send, /guard outcome != \.declined else \{ return \}/);
  assert.doesNotMatch(send, /outcome == \.confirmed else/,
    'requiring .confirmed would lock out a device that cannot ask');
});

test('the confirmation shows the SUPPRESSED count as prominently as the sendable one', () => {
  // A send to 41 of 900 is almost always a broken audience. A screen that
  // shows 41 and hides 859 is how somebody sends the wrong thing twice.
  assert.match(CONFIRM, /confirmation\.suppressed/);
  assert.match(CONFIRM, /Why the rest are excluded/);
  assert.match(CONFIRM, /topReasons/);
  // Both are drawn by the same tile, so one cannot be quietly demoted to a
  // footnote by a later styling change without the other going with it.
  assert.match(CONFIRM, /countTile\(value: confirmation\.recipients/);
  assert.match(CONFIRM, /countTile\(value: confirmation\.suppressed/);
});

test('the exact message is shown, not a summary of it', () => {
  // The last moment anybody can read what is about to go out. A paraphrase
  // would make the thing confirmed and the thing sent different objects.
  assert.match(CONFIRM, /confirmation\.message/);
  assert.match(CONFIRM, /The message/);
});

test('the master brake is disclosed before the face, not discovered after it', () => {
  assert.match(CONFIRM, /liveSendEnabled == false/);
  assert.match(CONFIRM, /Live sending is switched off/);
});

test('a failed send says nothing went out', () => {
  // "Something went wrong" after pressing send is the worst possible message,
  // because the honest question it leaves is "did it send or not".
  assert.match(CONFIRM, /Nothing has gone out/);
});

// ── The one-time chooser ─────────────────────────────────────────────────────

test('THE VOICE CHOOSER IS SHOWN ONCE, and the flag is what makes it once', () => {
  assert.match(MODEL, /@Published var hasChosenVoice: Bool/);
  assert.match(VIEW, /if !preferences\.hasChosenVoice \{ isChoosingVoiceForFirstTime = true \}/);
  assert.match(PICKER, /preferences\.hasChosenVoice = true/);
  // Somebody who had already pinned a voice before this screen existed has
  // chosen one, and must not be marched through a first run they finished by
  // another route months ago.
  assert.match(MODEL, /\?\? \(defaults\.string\(forKey: Keys\.pinnedVoice\) != nil\)/);
});

test('the chooser works with no network rather than showing a dead end', () => {
  // The first thing the product ever does must not be fail. A built-in voice
  // is always on the carousel, so a failed fetch still reaches a conversation.
  assert.match(PICKER, /builtIn = AssistantVoiceOption\(/);
  assert.match(PICKER, /voices\.isEmpty \? \[Self\.builtIn\] : voices/);
  assert.match(PICKER, /try\? await APIClient\.shared\.assistantVoices/);
});

test('choosing the built-in voice stores nil, not an empty identifier', () => {
  // "" would pin a voice that does not exist and every reply would silently
  // fall back to the robotic system voice, which is the exact bug this whole
  // feature was built to fix.
  assert.match(PICKER, /voice\.id\.isEmpty \? nil : voice\.id/);
});

// ── The chamber ──────────────────────────────────────────────────────────────

test('the chamber is the orb and the edges, with no transcript pushed at anybody', () => {
  assert.doesNotMatch(CHAMBER, /transcript\.map|ForEach\(transcript/,
    'the transcript belongs behind a deliberate tap, not under the orb');
  assert.match(CHAMBER, /Read the transcript/);
  assert.match(VIEW, /isShowingTranscript/);
});

test('the orb tells the truth about listening, from the coordinator and not from the phase', () => {
  // An orb that breathes while the microphone is shut leaves somebody talking
  // to a phone that is not hearing them, and blaming themselves for it.
  assert.match(CHAMBER, /speechPhase == \.listening \|\| speechPhase == \.finalizing/);
  assert.match(CHAMBER, /isListening: isListening/);
});

test('the chamber owns no state that could disagree with the coordinator', () => {
  // Every action is a closure from AssistantView. A second copy of the
  // dictation and thread bookkeeping in here would drift within a release.
  assert.match(CHAMBER, /let onOrbTap: \(\) -> Void/);
  assert.match(CHAMBER, /let onSubmit: \(\) -> Void/);
  assert.doesNotMatch(CHAMBER, /APIClient\.shared/,
    'the chamber is presentational and must not call the network');
  assert.doesNotMatch(CHAMBER, /@StateObject/);
});

// ── The two ends of the same wire ────────────────────────────────────────────

test('a send confirmation is read once and cleared, so no prompt can replay', () => {
  // A replayed navigation is an annoyance. A replayed send prompt is somebody
  // being asked to authorise the same campaign twice and not knowing whether
  // the first one went.
  assert.match(REASONER, /func takePendingSendConfirmation\(\) -> AssistantSendConfirmation\? \{\s*defer \{ pendingSendConfirmation = nil \}/);
});

test('navigation and the send confirmation are actually ASSIGNED from the reply', () => {
  // Both were declared and read and never assigned, which is why "take me to
  // the inbox" answered in words and never moved. Reading a field nothing
  // writes compiles, runs, and does nothing, forever.
  assert.match(REASONER, /pendingNavigation = answer\.navigate/);
  assert.match(REASONER, /pendingSendConfirmation = answer\.confirmSend/);
});
