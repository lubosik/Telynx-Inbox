'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILE = 'ios/ViciInbox/App/ViciNavigationIntents.swift';
const SOURCE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

test('three read-only intents use the shared deterministic coordinator phrases', () => {
  for (const name of [
    'OpenRecentlyCreatedSegmentIntent',
    'OpenCurrentSegmentPeopleIntent',
    'OpenOffersIntent'
  ]) assert.match(SOURCE, new RegExp(`struct ${name}: AppIntent`));
  assert.equal((SOURCE.match(/requestNavigation\(/g) || []).length, 1,
    'one adapter must own coordinator invocation');
  for (const phrase of [
    'Take me to the segment you just created.',
    'Open the people and show me why they are in it.',
    'Go to the offers.'
  ]) assert.ok(SOURCE.includes(phrase), `missing reviewed phrase: ${phrase}`);
});

test('intents require local unlock and Xcode 26 foreground behavior', () => {
  assert.equal((SOURCE.match(/\.requiresLocalDeviceAuthentication/g) || []).length, 3);
  assert.equal((SOURCE.match(/static var openAppWhenRun = true/g) || []).length, 3);
  for (const forbidden of [
    'supportedModes', 'ViewAnnotation', 'AppIntentsTesting', 'Evaluations',
    'DynamicProfile', 'FoundationModels', 'allowedExecutionTargets'
  ]) assert.equal(SOURCE.includes(forbidden), false, `Xcode 27/newer symbol: ${forbidden}`);
});

test('shortcut phrases always name the application', () => {
  assert.match(SOURCE, /struct ViciNavigationShortcuts: AppShortcutsProvider/);
  const quotedPhrases = SOURCE.match(/"[^"]*\\\(\.applicationName\)[^"]*"/g) || [];
  assert.equal(quotedPhrases.length, 6);
  assert.equal((SOURCE.match(/AppShortcut\(/g) || []).length, 3);
});

test('adapter never mutates navigation or accepts inferred record parameters', () => {
  assert.match(SOURCE, /requestNavigation\([\s\S]*source: \.appIntent/);
  for (const forbidden of [
    'AppRouter', '.open(', '.queue(', '@Parameter', 'segmentID', 'campaignID',
    'phone:', 'customer', 'messageBody', 'requestConfirmation',
    'confirmDiscardByVisualAction', 'completeConfirmedDiscardByVisualAction'
  ]) assert.equal(SOURCE.includes(forbidden), false, `unsafe intent behavior: ${forbidden}`);
});

test('all returned dialogs are fixed and contain no outcome-associated content', () => {
  assert.doesNotMatch(SOURCE, /case \.[a-zA-Z]+\s*\(let /);
  assert.doesNotMatch(SOURCE, /IntentDialog\([^"\n]/);
  for (const forbidden of ['\\.id', '\\.phone', '\\.name', '\\.message', '\\.description']) {
    assert.doesNotMatch(SOURCE, new RegExp(forbidden));
  }
});

test('intent source passes Swift parser validation without requiring an SDK module', () => {
  const result = spawnSync('xcrun', ['swiftc', '-parse', path.join(ROOT, FILE)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
