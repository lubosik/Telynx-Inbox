'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const RECORDER = read('ios/ViciInbox/Core/AssistantLatencyRecorder.swift');
const COORDINATOR = read('ios/ViciInbox/App/AssistantSpeechCoordinator.swift');
const NAVIGATION = read('ios/ViciInbox/App/AssistantNavigationCoordinator.swift');
const MODEL = read('ios/ViciInbox/App/AssistantModel.swift');

test('latency telemetry is aggregate, bounded, monotonic and identifier-free by construction', () => {
  assert.match(RECORDER, /@MainActor\s+final class AssistantLatencyRecorder/);
  assert.match(RECORDER, /ProcessInfo\.processInfo\.systemUptime/);
  assert.match(RECORDER, /defaultCapacity = 200/);
  assert.match(RECORDER, /private var samplesMilliseconds:/);
  assert.match(RECORDER, /p50Milliseconds/);
  assert.match(RECORDER, /p95Milliseconds/);
  assert.match(RECORDER, /let count: Int/);
  assert.doesNotMatch(RECORDER, /\bDate\s*\(/);
  assert.doesNotMatch(RECORDER, /UserDefaults|FileManager|URLSession|Logger|ViciLog/);
  assert.doesNotMatch(RECORDER, /func record[^\{]*(prompt|transcript|text|name|phone|identifier|route|id)\s*:/i);
});

test('first transcript timing uses the first nonempty callback and Result audio-range start', () => {
  assert.match(COORDINATOR, /result\.range\.start\.seconds/);
  assert.match(COORDINATOR, /consumeFirstNonemptyCallback/);
  assert.match(COORDINATOR, /speechFirstTranscriptCallback/);
  assert.match(COORDINATOR, /firstTranscriptLatency\.cancel\(\)/);
  assert.match(COORDINATOR, /pendingFirstTranscriptSample = nil/);
  const finish = COORDINATOR.slice(
    COORDINATOR.lastIndexOf('func finishAnalysis(cancelled: Bool)'),
    COORDINATOR.indexOf('private func cancelFailedSetup')
  );
  assert.match(finish, /guard analysisSucceeded, !resultStreamFailed, !callIsActive\(\)/);
  assert.doesNotMatch(finish, /latencyRecorder\.record/);
  const outerFinish = COORDINATOR.slice(
    COORDINATOR.indexOf('let result = await activeCapture.finishAnalysis(cancelled: false)'),
    COORDINATOR.indexOf('func consumeDictation()')
  );
  assert.ok(outerFinish.indexOf('finishingGeneration == self.generation') < outerFinish.indexOf('latencyRecorder.record'));
  assert.ok(outerFinish.indexOf('!self.callIsActive') < outerFinish.indexOf('latencyRecorder.record'));
  assert.doesNotMatch(outerFinish.slice(outerFinish.indexOf('latencyRecorder.record'), outerFinish.indexOf('self.liveTranscript')), /await/);
});

test('voice start is an honest first-delegate software proxy and cancelled output cannot report late', () => {
  assert.match(COORDINATOR, /didStart utterance: AVSpeechUtterance/);
  assert.match(COORDINATOR, /voiceOutputStartProxy/);
  assert.match(COORDINATOR, /guard activeUtterance === utterance,[\s\S]*?!didRecordStart/);
  assert.match(COORDINATOR, /finishOnce\(for: utterance\)/);
  assert.match(COORDINATOR, /activeUtterance = nil/);
  assert.match(COORDINATOR, /queuedUptime = nil/);
  const recordCalls = [...COORDINATOR.matchAll(/latencyRecorder\.record\(([\s\S]*?)\n\s*\)/g)];
  assert.ok(recordCalls.length >= 2);
  for (const [, argumentsText] of recordCalls) {
    assert.doesNotMatch(argumentsText, /\b(text|utterance|transcript|name|phone|identifier|route|id)\s*:/i);
  }
});

test('finalized dictation exposes a monotonic boundary through an exactly-once handoff', () => {
  assert.match(RECORDER, /struct AssistantFinalizedDictation/);
  assert.match(RECORDER, /let completionUptime: TimeInterval/);
  assert.match(RECORDER, /struct AssistantFinalizedDictationSlot/);
  assert.match(RECORDER, /mutating func consume\(\)[\s\S]*?defer \{ pending = nil \}/);
  assert.match(COORDINATOR, /consumeFinalizedDictation\(\) -> AssistantFinalizedDictation\?/);
  assert.match(COORDINATOR, /completionUptime: AssistantMonotonicClock\.now/);
  assert.match(COORDINATOR, /pendingDictation\.clear\(\)/);
});

test('tool and voice-navigation samples are recorded only at verified completion boundaries', () => {
  assert.match(MODEL, /intent != nil, !response\.citations\.isEmpty[\s\S]*?\.toolBackedAnswer/);
  assert.match(NAVIGATION, /destinationDidBecomeVisible[\s\S]*?source == \.assistantVoice[\s\S]*?\.voiceNavigation/);
  assert.match(NAVIGATION, /Human confirmation time is deliberately excluded[\s\S]*?speechCompletionUptime: nil/);
  assert.ok(NAVIGATION.indexOf('router.dismissAccount()') > NAVIGATION.indexOf('destinationDidBecomeVisible'));
});
