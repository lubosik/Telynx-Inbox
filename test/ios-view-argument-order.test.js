'use strict';
/**
 * test/ios-view-argument-order.test.js — catch a Swift build failure without
 * a Swift build.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   This machine has no iOS SDK, so the only real compile is CI, and every
 *   Swift mistake costs a four to ten minute round trip. Two builds failed in
 *   one afternoon on errors a compiler catches instantly and `swiftc -parse`
 *   does not, because parsing checks syntax and neither of these was a syntax
 *   error:
 *
 *     cannot find 'campaign' in scope
 *     incorrect argument labels in call
 *       (have 'preview:status:removing:onRemove:',
 *        expected 'preview:removing:onRemove:status:')
 *
 *   Swift requires a memberwise initialiser's arguments in DECLARATION order,
 *   so adding a property in the middle of a struct silently breaks every call
 *   site — and reads as correct to anybody scanning it, because all the labels
 *   are right and only the sequence is wrong.
 *
 *   This is not a substitute for compiling. It is the specific check for the
 *   specific mistake that has actually been made here, twice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI_DIR = path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI');

/** Stored properties of each `struct X: View`, in declaration order. */
function viewStructs(source) {
  const structs = new Map();
  const pattern = /(?:private\s+)?struct\s+(\w+):\s*View\s*\{([\s\S]*?)\n\}/g;
  for (const match of source.matchAll(pattern)) {
    const [, name, whole] = match;
    // Only what precedes `var body:` — everything after is the view tree.
    const head = whole.split('var body:')[0];
    const props = [...head.matchAll(/^\s*(?:let|var)\s+(\w+)\s*:/gm)].map(m => m[1]);
    if (props.length) structs.set(name, props);
  }
  return structs;
}

/**
 * Every argument list passed to `name(...)`, balanced on brackets.
 *
 * A plain `\\(([^)]*)\\)` stops at the first `)`, which for a SwiftUI call is
 * usually inside a closure rather than at the end of the call.
 */
function callsTo(source, name) {
  const calls = [];
  const opener = new RegExp(`\\b${name}\\(`, 'g');
  for (const match of source.matchAll(opener)) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index + 1;
    for (; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) calls.push(source.slice(start, index));
  }
  return calls;
}

/**
 * The argument labels, and ONLY the argument labels.
 *
 * A label is the identifier at the START of a top-level argument. Scanning for
 * every `word:` instead matches a ternary — `actionMessage: x == y ?
 * actionMessage : nil` yields "actionMessage" twice and reports a mismatch in
 * code that compiles perfectly. That false positive is worse than no test: it
 * teaches somebody to ignore this one.
 */
function topLevelLabels(argumentList) {
  const labels = [];
  let depth = 0;
  let current = '';
  const pieces = [];
  for (const ch of argumentList) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { pieces.push(current); current = ''; continue; }
    current += ch;
  }
  pieces.push(current);
  for (const piece of pieces) {
    const label = piece.trim().match(/^(\w+)\s*:/);
    if (label) labels.push(label[1]);
  }
  return labels;
}

test('every SwiftUI call passes arguments in declaration order', () => {
  const failures = [];

  for (const file of fs.readdirSync(UI_DIR).filter(f => f.endsWith('.swift'))) {
    const source = fs.readFileSync(path.join(UI_DIR, file), 'utf8');
    const structs = viewStructs(source);

    for (const [name, props] of structs) {
      for (const call of callsTo(source, name)) {
        const labels = topLevelLabels(call);
        const passed = labels.filter(label => props.includes(label));
        if (passed.length < 2) continue;
        const expected = props.filter(prop => passed.includes(prop));
        if (passed.join(',') !== expected.join(',')) {
          failures.push(
            `${file}: ${name}(...) passes ${passed.join(', ')} — `
            + `Swift requires declaration order: ${expected.join(', ')}`
          );
        }
      }
    }
  }

  assert.deepEqual([...new Set(failures)], [],
    'a memberwise initialiser takes its arguments in the order the properties '
    + 'are declared, so inserting a property breaks every call site');
});

test('the check is actually looking at something', () => {
  // A structural test that silently matches nothing passes for ever and
  // protects nothing.
  const source = fs.readFileSync(path.join(UI_DIR, 'CampaignsView.swift'), 'utf8');
  const structs = viewStructs(source);
  assert.ok(structs.size >= 10, `expected many view structs, found ${structs.size}`);
  assert.ok(structs.has('CampaignPreviewSection'), 'including the one that broke twice');
  assert.deepEqual(structs.get('CampaignPreviewSection'),
    ['preview', 'removing', 'onRemove', 'status']);
});
