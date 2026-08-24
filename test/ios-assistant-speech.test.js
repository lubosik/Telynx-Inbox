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

test('speech remains on device and does not use legacy recognition or new SDK-only helpers', () => {
  for (const forbidden of [
    'SFSpeechRecognizer', 'requestAuthorization', 'DictationTranscriber',
    'AnalyzerInputConverter', 'CaptureInputSequenceProvider',
    'APIClient', 'URLSession', 'FileManager', 'Data.write', 'Logger(', 'ViciLog.'
  ]) assert.equal(COORDINATOR.includes(forbidden), false, `forbidden speech behavior: ${forbidden}`);
  assert.doesNotMatch(COORDINATOR, /\/api\//);
  assert.doesNotMatch(COORDINATOR, /write\(to:/);
});

test('microphone disclosure covers calls and point-of-use Assistant dictation', () => {
  assert.match(PLIST, /NSMicrophoneUsageDescription/);
  assert.match(PLIST, /customer calls/);
  assert.match(PLIST, /only while you press and hold/);
  assert.match(PLIST, /Assistant questions/);
  assert.equal(PLIST.includes('NSSpeechRecognitionUsageDescription'), false);
  assert.match(COORDINATOR, /AVAudioApplication\.requestRecordPermission\(\)/);
});

test('push to talk is bounded, explicit, accessible, and typed fallback remains', () => {
  assert.match(VIEW, /DragGesture\(minimumDistance: 0\)/);
  assert.match(VIEW, /\.onChanged[\s\S]*?begin\(\)/);
  assert.match(VIEW, /\.onEnded[\s\S]*?end\(\)/);
  assert.match(VIEW, /Press and hold, or double tap to start and double tap again to stop\. Typed input is always available\./);
  assert.doesNotMatch(VIEW, /\.onChange\(of: isEnabled\)/);
  assert.match(VIEW, /TextField\("Ask for a verified Vici summary"/);
  assert.match(VIEW, /Open microphone settings/);
  assert.match(COORDINATOR, /30_000_000_000/);
  assert.doesNotMatch(VIEW, /\.task\s*\{[^}]*beginPushToTalk/);
  const a11yAction = VIEW.slice(VIEW.indexOf('.accessibilityAction {'), VIEW.indexOf('.onChange(of: phase)'));
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
  assert.match(COORDINATOR, /Listening quality still needs physical-iPhone review/);
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
