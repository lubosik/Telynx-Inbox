'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hasXcodeSwiftCompiler } = require('./helpers/ios-toolchain');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MODELS = read('ios/ViciInbox/Core/AssistantNavigationModels.swift');
const COORDINATOR = read('ios/ViciInbox/App/AssistantNavigationCoordinator.swift');
const ROUTER = read('ios/ViciInbox/App/AppRouter.swift');
const SEGMENTS = read('ios/ViciInbox/App/SegmentViewModels.swift');

test('navigation parser is a closed complete-string command table', () => {
  assert.match(MODELS, /exactPhrases\[phrase\]/);
  assert.match(MODELS, /take me to the segment you just created/);
  assert.match(MODELS, /open the people and show me why they are in it/);
  assert.match(MODELS, /go to the offers/);
  for (const forbidden of [
    '.contains(', '.hasPrefix(', '.hasSuffix(', 'FoundationModels',
    'NaturalLanguage', 'NSRegularExpression', 'APIClient', 'URLSession'
  ]) {
    assert.equal(MODELS.includes(forbidden), false, `parser includes ${forbidden}`);
  }
  assert.doesNotMatch(MODELS, /case\s+segment\s*\([^)]*(?:phrase|prose|query)/i);
});

test('created-segment context is session-scoped, expiring and never persistent', () => {
  assert.match(COORDINATOR, /beginAuthenticatedSession\(userID:/);
  assert.match(COORDINATOR, /segment\.sessionID == sessionID/);
  assert.match(COORDINATOR, /segment\.userID == userID/);
  assert.match(COORDINATOR, /timeIntervalSince\(segment\.createdAt\) <= lifetime/);
  assert.match(COORDINATOR, /creationCapture\?\.sessionID == sessionID/);
  assert.match(COORDINATOR, /if activeUserID != nil \{ sessionID = UUID\(\) \}/);
  for (const forbidden of ['UserDefaults', 'FileManager', 'Keychain', 'Logger(', 'ViciLog.']) {
    assert.equal(COORDINATOR.includes(forbidden), false, `context persists or logs via ${forbidden}`);
  }
});

test('only successful creates record context and catalogue existing is excluded', () => {
  const tracking = SEGMENTS.slice(
    SEGMENTS.indexOf('func startTracking'),
    SEGMENTS.indexOf('func noteSegmentCreated')
  );
  const createCall = tracking.indexOf('createAutomaticSegment');
  const captureCall = tracking.indexOf('captureSegmentCreationSession');
  const recordCall = tracking.indexOf('recordSuccessfullyCreatedSegment');
  assert.ok(captureCall >= 0 && captureCall < createCall && recordCall > createCall);
  assert.match(tracking, /if created\.didCreate\s*\{[\s\S]*recordSuccessfullyCreatedSegment/);

  const manual = SEGMENTS.slice(
    SEGMENTS.indexOf('func createManual'),
    SEGMENTS.indexOf('func remove(')
  );
  assert.ok(manual.indexOf('createManualSegment') < manual.indexOf('recordSuccessfullyCreatedSegment'));

  const rules = SEGMENTS.slice(SEGMENTS.indexOf('func save() async -> SegmentRecord?'));
  assert.ok(rules.indexOf('createSegmentFromRules') < rules.indexOf('recordSuccessfullyCreatedSegment'));
});

test('coordinator verifies exact identity, fails closed, and never model-routes', () => {
  assert.match(COORDINATOR, /verified\.id == created\.id/);
  assert.match(COORDINATOR, /verified\.id == segmentID/);
  assert.match(COORDINATOR, /guard currentID == segmentID/);
  assert.match(COORDINATOR, /segmentPeopleRoute:\s*\{ _ in nil \}/);
  assert.match(COORDINATOR, /offersRoute:\s*\{ nil \}/);
  assert.match(COORDINATOR, /guard access\.campaignsManage/);
  assert.match(ROUTER, /let campaignsManage: Bool/);
  assert.match(COORDINATOR, /Offers and proposals is not available in this build/);
  assert.doesNotMatch(COORDINATOR, /FoundationModels|OnDeviceAssistantReasoner|APIClient|URLSession/);
  assert.doesNotMatch(COORDINATOR, /\.campaigns\),\s*"Opened offers/i);
});

test('dirty registry stores no content and requires a visual confirmation id', () => {
  assert.match(COORDINATOR, /struct Entry\s*\{\s*let source:[\s\S]*var isDirty: Bool/);
  assert.match(COORDINATOR, /confirmDiscardByVisualAction\(id: UUID/);
  assert.match(COORDINATOR, /acknowledgeDiscard\(for token:/);
  assert.match(COORDINATOR, /completeConfirmedDiscardByVisualAction/);
  assert.match(COORDINATOR, /Navigation never precedes those acknowledgements/);
  assert.match(COORDINATOR, /current\.revision == pending\.snapshot\.revision/);
  assert.match(COORDINATOR, /current\.dirtyTokenIDs == pending\.snapshot\.dirtyTokenIDs/);
  assert.match(COORDINATOR, /resolutionTask\?\.cancel\(\)[\s\S]*drafts\.cancelDiscard\(\)[\s\S]*pending = nil/);
  assert.match(COORDINATOR, /guard pending\.confirmation\.id == id else \{ return \.cancelled \}/);
  for (const forbidden of ['draftText', 'messageBody', 'attachmentData', 'customerID']) {
    assert.equal(COORDINATOR.includes(forbidden), false, `dirty registry stores ${forbidden}`);
  }
});

test('current screen is exact and navigation can be cancelled at lifecycle boundaries', () => {
  assert.match(ROUTER, /var currentMainRoute: AppRoute/);
  assert.match(COORDINATOR, /case \.background, \.callStarted, \.identityChanged, \.permissionChanged/);
  assert.match(COORDINATOR, /resolutionTask\?\.cancel\(\)/);
  assert.match(COORDINATOR, /context\.clearEphemeralContext\(\)/);
  assert.match(COORDINATOR, /router\.dismissAccount\(\)/);
});

test('Foundation smoke compiles and executes independently', { timeout: 30000 }, (t) => {
  if (!hasXcodeSwiftCompiler()) {
    t.skip('Swift smoke validation runs on the dedicated Xcode workflow');
    return;
  }
  const output = path.join(process.env.TMPDIR || '/tmp', `vici-assistant-navigation-${process.pid}`);
  const result = spawnSync('xcrun', [
    'swiftc',
    path.join(ROOT, 'ios/ViciInbox/App/AppRouter.swift'),
    path.join(ROOT, 'ios/ViciInbox/Core/AssistantNavigationModels.swift'),
    path.join(ROOT, 'ios/ViciInbox/Core/AssistantLatencyRecorder.swift'),
    path.join(ROOT, 'ios/ViciInbox/App/AssistantNavigationCoordinator.swift'),
    path.join(ROOT, 'ios/Tests/AssistantNavigationSmoke.swift'),
    '-o', output
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const run = spawnSync(output, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Assistant navigation smoke: OK/);
  fs.rmSync(output, { force: true });
});
