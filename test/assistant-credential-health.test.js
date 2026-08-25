'use strict';
/**
 * The failure this exists to prevent.
 *
 * Railway's OPENROUTER_API_KEY was dead, answering 401 "User not found". Every
 * assistant question failed upstream, the app showed a generic "could not
 * finish that response", and the route logged nothing, so the only way to find
 * it was to test the credential by hand.
 *
 * These do not check the live key, because a test that needs the internet is a
 * test that fails on a bad day for no reason. They check the two things that
 * made a dead credential expensive rather than merely broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'assistant.js'), 'utf8');

test('an upstream failure is logged on the server, so a dead credential is findable', () => {
  assert.match(ROUTE, /console\.error\('\[ASSISTANT\] converse failed:'/);
  assert.match(ROUTE, /console\.error\('\[ASSISTANT\] speak failed:'/);
});

test('the upstream reason is never returned to the client', () => {
  // The provider message can echo the prompt back out, so it is logged and not
  // sent. What the caller gets is a fixed sentence and a code.
  const converseCatch = ROUTE.slice(
    ROUTE.indexOf("console.error('[ASSISTANT] converse failed:'"),
    ROUTE.indexOf('// ── POST /api/assistant/speak')
  );
  assert.ok(converseCatch.length > 0);
  assert.doesNotMatch(converseCatch, /error:\s*error/);
  assert.doesNotMatch(converseCatch, /error\.message\s*\}/);
  assert.match(converseCatch, /'The assistant could not answer that right now\.'/);
});
