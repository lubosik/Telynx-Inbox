'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MODELS = read('ios/ViciInbox/Core/AssistantSpeechModels.swift');
const COORDINATOR = read('ios/ViciInbox/App/AssistantSpeechCoordinator.swift');
const VIEW = read('ios/ViciInbox/UI/AssistantView.swift');
const PLIST = read('ios/ViciInbox/Resources/Info.plist');
const PROJECT = read('ios/project.yml');

test('Phase 5 preserves iOS 16 and gates the stable on-device API to iOS 26', () => {
  assert.match(PROJECT, /iOS: "16\.0"/);
  assert.match(COORDINATOR, /#available\(iOS 26\.0, \*\)/);
  assert.match(COORDINATOR, /SpeechTranscriber\.supportedLocale\(equivalentTo:/);
  assert.match(COORDINATOR, /preset: \.progressiveTranscription/);
  assert.match(COORDINATOR, /SpeechAnalyzer\(modules:/);
  assert.match(COORDINATOR, /bestAvailableAudioFormat/);
  assert.match(COORDINATOR, /prepareToAnalyze\(in:/);
  assert.match(COORDINATOR, /AssetInventory\.status\(forModules:/);
  assert.match(COORDINATOR, /assetInstallationRequest[\s\S]*?downloadAndInstall/);
  assert.match(COORDINATOR, /AsyncStream<AnalyzerInput>\.makeStream\(\)/);
  assert.match(COORDINATOR, /AnalyzerInput\(buffer:/);
  assert.match(COORDINATOR, /finalizeAndFinishThroughEndOfInput/);
});

// Speech INPUT and speech OUTPUT are now different things and must be judged
// differently. What you say is captured and recognised entirely on this iPhone.
// What the assistant says back is synthesised by ElevenLabs through Vici's
// server, because Apple's voices did not sound human enough to ship.
//
// The line that matters, and that these protect: RECORDED AUDIO NEVER LEAVES
// THE DEVICE. Only the finished answer text is sent, and only outbound.
test('captured microphone audio never leaves the device', () => {
  for (const forbidden of [
    // Legacy or server-assisted recognition.
    'SFSpeechRecognizer', 'requestAuthorization', 'DictationTranscriber',
    'AnalyzerInputConverter', 'CaptureInputSequenceProvider',
    // Any route by which a buffer could be persisted or uploaded.
    'FileManager', 'Data.write', 'write(to:', 'URLSession',
    'Logger(', 'ViciLog.'
  ]) {
    assert.equal(COORDINATOR.includes(forbidden), false, `forbidden speech behavior: ${forbidden}`);
  }
  // No audio buffer, sample or recognition result may be handed to the network.
  for (const forbidden of [/assistantSpeak\([^)]*buffer/i, /assistantSpeak\([^)]*audio/i,
                           /upload[A-Za-z]*\(/i, /multipart/i]) {
    assert.doesNotMatch(COORDINATOR, forbidden, 'captured audio must never be uploaded');
  }
});

test('the ONLY network call the speech coordinator makes is sending text to be spoken', () => {
  // Narrow allowance, asserted narrowly. If a second API call appears here it
  // fails, because the next one added is the one that ships a buffer.
  const apiCalls = COORDINATOR.match(/APIClient\.shared\.[A-Za-z]+/g) || [];
  assert.deepEqual([...new Set(apiCalls)], ['APIClient.shared.assistantSpeak'],
    'speech output may reach the server; nothing else here may');
  assert.match(COORDINATOR, /assistantSpeak\(text: text/, 'it sends text, not audio');
});

test('a failed server voice falls back to the local synthesiser rather than going silent', () => {
  // Silence on a voice interface reads as a crash. Apple's voice is worse and
  // always present, so the answer is still spoken when the network is not there.
  assert.match(COORDINATOR, /speakLocally\(text\)/);
  assert.match(COORDINATOR, /catch \{[\s\S]{0,400}?speakLocally/);
});

test('microphone disclosure covers calls and point-of-use Assistant dictation', () => {
  assert.match(PLIST, /NSMicrophoneUsageDescription/);
  assert.match(PLIST, /customer calls/);
  // Press and hold is gone, so the disclosure cannot still promise it. What it
  // must still promise, and what is still true, is that the microphone is not
  // left open: capture is started deliberately and ends itself when speech
  // stops.
  assert.match(PLIST, /only while you are asking the Assistant a question/);
  assert.match(PLIST, /never left listening/);
  assert.doesNotMatch(PLIST, /press and hold/,
    'the disclosure must not describe a gesture the app no longer uses');
  // Both uses must be named. Matched on the word rather than an exact phrase,
  // so rewording the sentence does not fail a test whose point is that the
  // Assistant use is disclosed at all.
  assert.match(PLIST, /Assistant/);
  assert.equal(PLIST.includes('NSSpeechRecognitionUsageDescription'), false);
  assert.match(COORDINATOR, /AVAudioApplication\.requestRecordPermission\(\)/);
});

test('capture is tap to start, ends itself, and typed fallback remains', () => {
  // Hold to talk made a conversation a physical act: hold the phone, hold the
  // button, do not let go mid sentence. Tap starts it; silence ends it.
  assert.match(VIEW, /\.onTapGesture \{/);
  assert.doesNotMatch(VIEW, /DragGesture\(minimumDistance: 0\)/,
    'holding must not be required to speak');
  assert.match(VIEW, /Tap to start speaking\. It stops on its own when you finish/);

  // Ending itself is the half that makes tapping safe: without it a tap would
  // leave the microphone open indefinitely.
  assert.match(COORDINATOR, /silenceBeforeStopping/);
  assert.match(COORDINATOR, /armSilenceTimer\(\)/);
  assert.match(COORDINATOR, /endPushToTalk\(\)/);
  // Never on an empty transcript: the microphone opening in a quiet room must
  // not close before anybody has spoken.
  assert.match(COORDINATOR, /!liveTranscript\.trimmingCharacters\(in: \.whitespaces\)\.isEmpty else \{ return \}/);
  assert.doesNotMatch(VIEW, /\.onChange\(of: isEnabled\)/);
  assert.match(VIEW, /TextField\("Ask for a verified Vici summary"/);
  assert.match(VIEW, /Open microphone settings/);
  assert.match(COORDINATOR, /30_000_000_000/);
  assert.doesNotMatch(VIEW, /\.task\s*\{[^}]*beginPushToTalk/);
  // Anchored to the accessibility action itself rather than to whatever
  // modifier happens to follow it. The orb gained its own `.onChange(of:
  // phase)` for the listening animation, which sits earlier in the file, and
  // slicing to the first match silently emptied this check.
  const a11yStart = VIEW.indexOf('.accessibilityAction {');
  assert.ok(a11yStart >= 0, 'the push to talk accessibility action must exist');
  const a11yAction = VIEW.slice(a11yStart, VIEW.indexOf('.onChange(of: phase)', a11yStart));
  assert.ok(a11yAction.length > 0, 'the accessibility action slice must not be empty');
  // Toggling off is checked before the enabled guard, so VoiceOver can always
  // stop a capture that is already running even if the control has since been
  // disabled underneath it.
  assert.ok(a11yAction.indexOf('if isPressed') >= 0 && a11yAction.indexOf('guard isEnabled') >= 0);
  assert.ok(a11yAction.indexOf('if isPressed') < a11yAction.indexOf('guard isEnabled'));
});

test('release during setup and every call stop capture and local voice output', () => {
  assert.match(COORDINATOR, /guard pressIsHeld else[\s\S]*?assetsReady\(pressIsHeld: false\)/);
  assert.match(COORDINATOR, /noteCallActivity[\s\S]*?stopAll\(interruptedByCall: true\)/);
  assert.match(COORDINATOR, /stopAudioImmediately\(\)/);
  assert.match(COORDINATOR, /finishAnalysis\(cancelled: true\)/);
  assert.match(COORDINATOR, /voiceOutput\.stop\(\)/);
  assert.match(VIEW, /\.onChange\(of: callIsActive\)[\s\S]*?speech\.noteCallActivity\(active\)/);
  const submitStart = VIEW.indexOf('private func submitQuestion');
  const submitAction = VIEW.slice(submitStart, VIEW.indexOf('Task {', submitStart));
  assert.match(submitAction, /speech\.stopAll\(\)/, 'typed send must close capture before submission');
});

test('audio session setup is ordered and fails closed without interfering with telephony', () => {
  const category = COORDINATOR.indexOf('setCategory(.record');
  const activation = COORDINATOR.indexOf('setActive(true)');
  const hardwareFormat = COORDINATOR.indexOf('outputFormat(forBus: 0)');
  const tap = COORDINATOR.indexOf('installTap(onBus: 0');
  assert.ok(category >= 0 && category < activation && activation < hardwareFormat && hardwareFormat < tap);
  assert.match(COORDINATOR, /options: \[\]/);
  assert.doesNotMatch(COORDINATOR, /TelnyxVoiceManager|CallKitCoordinator/);
  assert.match(COORDINATOR, /interruptionNotification/);
  assert.match(COORDINATOR, /routeChangeNotification/);
});

test('voice selector prefers installed locale quality and persists only its identifier', () => {
  assert.match(MODELS, /premium beats enhanced, which beats standard/);
  assert.match(COORDINATOR, /AVSpeechSynthesisVoice\.speechVoices\(\)/);
  // The coordinator now goes through `resolve`, not `select`. `select` treats a
  // stored identifier as a tie-break at the best quality, which is right for a
  // remembered automatic pick and wrong for a voice the operator chose in
  // Settings: a newly installed Premium voice would silently replace it.
  assert.match(COORDINATOR, /AssistantVoiceSelector\.resolve/);
  assert.match(COORDINATOR, /preference: preferences\.voicePreference/);
  // `resolve` still delegates to `select`, so the automatic path and the
  // deleted-pinned-voice fallback keep the locale and quality ordering.
  assert.match(MODELS, /static func resolve\(preference: AssistantVoicePreference/);
  assert.match(MODELS, /return select\(from: candidates/);
  // A pinned voice wins outright while it is installed.
  assert.match(MODELS, /if let pinned = preference\.pinnedIdentifier,[\s\S]*?return match/);
  assert.match(COORDINATOR, /defaults\.set\(selected\.identifier/);
  assert.match(COORDINATOR, /usesApplicationAudioSession = false/);
  assert.match(COORDINATOR, /mixToTelephonyUplink = false/);
  assert.doesNotMatch(COORDINATOR, /defaults\.set\((?:text|utterance|transcript|audio)/i);
  // The old disclosure said an installed Apple voice was selected. Answers are
  // now synthesised in the cloud with the voice chosen in Settings, so the
  // string had to change or it would be describing something that no longer
  // happens.
  assert.match(COORDINATOR, /synthesised in the cloud/);
  assert.doesNotMatch(COORDINATOR, /installed locale-matching Apple voice is selected/,
    'the disclosure must not claim a local Apple voice is producing the answer');
  assert.doesNotMatch(VIEW, /premium (?:quality|voice experience)/i);
});

test('voice completion and external interruption cannot wedge the shell', () => {
  assert.match(VIEW, /if started \{[\s\S]*?noteSpeechStarted\(\)[\s\S]*?else \{[\s\S]*?noteSpeechFinished\(\)/);
  assert.match(COORDINATOR, /didFinish[\s\S]*?finishOnce\(for: utterance\)/);
  assert.match(COORDINATOR, /didCancel[\s\S]*?finishOnce\(for: utterance\)/);
  assert.match(COORDINATOR, /45_000_000_000/);
  assert.match(VIEW, /case \.readyToRequest, \.microphoneDenied, \.finalizing,[\s\S]*?isPressed = false/);
});

test('generated project includes every Phase 5 source', () => {
  const generated = read('ios/ViciInbox.xcodeproj/project.pbxproj');
  for (const file of ['AssistantSpeechModels.swift', 'AssistantSpeechCoordinator.swift']) {
    assert.ok(generated.includes(file), `${file} is absent from the checked-in project`);
  }
});

test('SERVER AUDIO CONFIGURES A PLAYBACK SESSION, or it plays silently', () => {
  // Capture sets the category to .record and then deactivates, which leaves the
  // CATEGORY on .record. An AVAudioPlayer on a .record session produces no
  // sound at all: no error, no warning, nothing. This shipped once and the only
  // symptom was "I can't hear anything".
  //
  // It was invisible because the previous voice was AVSpeechSynthesizer with
  // usesApplicationAudioSession = false, which owns its own session and is
  // therefore immune to the category the app left behind.
  assert.match(COORDINATOR, /setCategory\(\.playback, mode: \.spokenAudio/);

  const speakBlock = COORDINATOR.slice(
    COORDINATOR.indexOf('func speakWithServerVoice'),
    COORDINATOR.indexOf('private func noteStartedIfNeeded')
  );
  assert.ok(speakBlock.length > 0, 'the speak block must be findable');

  const prepareAt = speakBlock.indexOf('prepareSessionForPlayback()');
  const playAt = speakBlock.indexOf('player.play()');
  // Both asserted PRESENT before they are compared. indexOf returns -1 when
  // absent, and -1 is less than any real index, so an ordering check on its own
  // passes when the call has been deleted entirely. That is how the first
  // version of this test survived a mutation that removed the fix.
  assert.ok(prepareAt >= 0, 'the playback session must be configured inside speakWithServerVoice');
  assert.ok(playAt >= 0, 'the player must be played inside speakWithServerVoice');
  assert.ok(prepareAt < playAt, 'the session must be right before anything is played into it');
});

test('playback never takes the audio session from a live call', () => {
  assert.match(COORDINATOR, /guard !callIsActive\(\) else \{ return false \}/);
  assert.match(COORDINATOR, /guard !callIsActive\(\) else \{ return \}[\s\S]{0,200}?setActive\(false/);
});

test('EVERY speech path ends in the turn being released, or the shell wedges', () => {
  // Shipped once: server audio played silently and the delegate never fired,
  // so the completion that ends the turn was never called and the assistant sat
  // on "Speaking" forever with no way back except restarting the app.
  //
  // Two independent ways out, because one of them failing is what caused it.
  const speakBlock = COORDINATOR.slice(
    COORDINATOR.indexOf('func speakWithServerVoice'),
    COORDINATOR.indexOf('private var playbackWatchdog')
  );
  assert.ok(speakBlock.length > 0, 'the speak block must be findable');

  // 1. play() refusing is treated as a failure to speak, not as speech.
  const guardAt = speakBlock.indexOf('guard player.play() else');
  assert.ok(guardAt >= 0, 'the result of play() must be checked');
  const fallbackAt = speakBlock.indexOf('speakLocally(text)', guardAt);
  assert.ok(fallbackAt > guardAt, 'a refused play must fall back rather than pretend it is speaking');

  // 2. A watchdog for the case where play() succeeds and the delegate never
  //    reports finishing anyway.
  const armAt = speakBlock.indexOf('armPlaybackWatchdog');
  assert.ok(armAt >= 0, 'playback must arm a watchdog');
  assert.match(COORDINATOR, /playbackWatchdog[\s\S]{0,600}?finishOnce\(\)/,
    'the watchdog must release the turn');

  // And it must not fire over audio that is still playing.
  assert.match(COORDINATOR, /max\(duration, 1\) \+ 5/);
  assert.match(COORDINATOR, /cancelPlaybackWatchdog\(\)/);
});

test('the assistant can be interrupted while it is speaking', () => {
  // Requiring .idle meant the microphone was dead for the whole answer, so the
  // only way to redirect was to sit through it. People interrupt each other.
  assert.match(VIEW, /model\.phase == \.idle \|\| model\.phase == \.speaking/);

  // And the answer is cut off BEFORE capture starts. Recording over the
  // assistant's own voice feeds it back through the microphone, and the
  // transcript then contains what the assistant said as though the person had
  // said it.
  const begin = VIEW.slice(VIEW.indexOf('beginDictation: {'), VIEW.indexOf('endDictation: {'));
  assert.ok(begin.length > 0, 'beginDictation must be findable');
  const stopAt = begin.indexOf('speech.stopAll()');
  const startAt = begin.indexOf('speech.beginPushToTalk');
  assert.ok(stopAt >= 0, 'speaking must be stopped when the person cuts in');
  assert.ok(startAt >= 0, 'capture must still start');
  assert.ok(stopAt < startAt, 'stop the answer before opening the microphone');

  // A capture already running is still refused, so a second tap cannot start a
  // second one on top of the first.
  assert.match(COORDINATOR, /case \.listening, \.finalizing, \.interruptedByCall: return false/);
});
