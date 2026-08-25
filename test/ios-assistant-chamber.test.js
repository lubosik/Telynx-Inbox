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
const { spawnSync } = require('node:child_process');

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

// ── End of speech, which is what made every turn cost two taps ──────────────

test('END OF SPEECH IS HEARD, not inferred from the transcript standing still', () => {
  const COORD = read('ios/ViciInbox/App/AssistantSpeechCoordinator.swift');
  // The old detector restarted a countdown on every new piece of recognised
  // text. That only detects end-of-speech if text arrives WHILE somebody is
  // talking; when the recogniser reports once at the end, the countdown is
  // never armed, capture runs to its thirty second timeout, and the only thing
  // that ever ends a turn is the person tapping the orb.
  assert.match(COORD, /AssistantVoiceActivityDetector\.level\(/,
    'loudness must be measured from the audio buffers');
  assert.match(COORD, /case \.speechEnded:[\s\S]{0,200}endPushToTalk\(\)/,
    'hearing speech end must end capture');
  // Both signals are kept. They fail in different directions: the detector
  // cannot see a recogniser that stopped producing text, and the countdown
  // cannot see a person who stopped making noise.
  assert.match(COORD, /armSilenceTimer\(\)/, 'the transcript countdown stays as a second signal');
});

test('the room is measured once and kept between sentences', () => {
  const COORD = read('ios/ViciInbox/App/AssistantSpeechCoordinator.swift');
  // beginTurn forgets what was said and keeps the measured floor. Re-learning
  // the room every sentence would make the first third of a second of every
  // turn behave differently from the rest of it.
  assert.match(COORD, /voiceActivity\.beginTurn\(\)/);
  const VAD = read('ios/ViciInbox/Core/AssistantVoiceActivity.swift');
  assert.match(VAD, /Calibration is NOT redone/);
});

test('THE CONVERSATION CONTINUES BY ITSELF once an answer finishes', () => {
  // Without this every turn cost two taps: one to speak, one to be heard again
  // after the reply. Nobody talks to a person that way.
  assert.match(VIEW, /resumeListeningIfStillHere\(\)/);
  const resume = VIEW.slice(VIEW.indexOf('private func resumeListeningIfStillHere'));
  // Each guard is a real way this becomes obnoxious rather than helpful.
  for (const guard of [
    /preferences\.continuousConversation/,
    /scenePhase == \.active/,
    /!callIsActive/,
    /model\.isConversationOpen/,
    /model\.draft\.trimmingCharacters/
  ]) {
    assert.match(resume, guard, 'a microphone that reopens itself needs every one of these');
  }
});

// ── Being taken somewhere must not end the conversation ────────────────────

test('NAVIGATION NO LONGER DUMPS THE OPERATOR IN SETTINGS', () => {
  // The assistant is a destination inside the account sheet. Dismissing it
  // alone revealed the settings screen it had been sitting on top of, so one
  // request produced three surprises: the app moved, the assistant vanished,
  // and Settings appeared.
  const move = VIEW.slice(VIEW.indexOf('.onChange(of: model.pendingNavigation)'));
  const block = move.slice(0, move.indexOf('.onAppear'));
  assert.match(block, /router\.dismissAccount\(\)/,
    'the whole account sheet must go, not just the assistant on top of it');
  assert.match(block, /AssistantPresence\.shared\.continueElsewhere/);
  assert.doesNotMatch(block, /speech\.stopAll\(\)/,
    'it is usually mid-sentence saying where it has taken you');
});

test('the conversation survives as a floating orb, and can be reached and ended', () => {
  const ROOT = read('ios/ViciInbox/UI/RootView.swift');
  assert.match(ROOT, /AssistantFloatingOrb\(/);
  assert.match(ROOT, /assistantPresence\.isLive/);
  // Read from the observed object, not a static. A static would never redraw,
  // so the orb would show whatever phase it was born with, forever.
  assert.match(ROOT, /phase: assistantPresence\.phase/);
  assert.match(ROOT, /router\.presentAssistant\(\)/);

  const ORB = read('ios/ViciInbox/UI/AssistantFloatingOrb.swift');
  // A Button, so VoiceOver and Switch Control reach it like anything else, and
  // an explicit way out that does not require going back in first.
  assert.match(ORB, /Button\(action: onTap\)/);
  assert.match(ORB, /End the conversation/);
});

test('presentAssistant opens the conversation, not the menu it lives behind', () => {
  const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
  const fn = ROUTER.slice(ROUTER.indexOf('func presentAssistant'));
  assert.match(fn.slice(0, 200), /accountPath = \[\.assistant\]/,
    'landing on an empty account path is landing in Settings');
});


test('the voice activity detector actually runs and gets the decisions right',
  { timeout: 60000 }, (t) => {
  // Not a source scan. This compiles the real detector and runs it against
  // synthetic level streams: an ordinary turn, a 0.7s thinking pause that must
  // NOT end it, ten seconds of silence with nothing said, a cough, a noisy
  // room, noise that starts mid-turn, and RMS on real samples.
  //
  // Ending too late is a pause. Ending too early cuts somebody off, loses what
  // they said, and answers half a question. The tests are weighted accordingly.
  const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('Swift smoke validation runs on the dedicated Xcode workflow');
    return;
  }
  const output = path.join(process.env.TMPDIR || '/tmp', `vici-vad-${process.pid}`);
  const build = spawnSync('xcrun', [
    'swiftc',
    path.join(ROOT, 'ios/ViciInbox/Core/AssistantVoiceActivity.swift'),
    path.join(ROOT, 'ios/Tests/AssistantVoiceActivitySmoke.swift'),
    '-o', output
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const run = spawnSync(output, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Assistant voice activity smoke: OK/);
  fs.rmSync(output, { force: true });
});
