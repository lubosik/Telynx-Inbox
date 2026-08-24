'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'check-failed-orders.js'), 'utf8');

test('failed-order utility reads Supabase credentials from the environment', () => {
  assert.match(source, /process\.env\.SUPABASE_URL/);
  assert.match(source, /process\.env\.SUPABASE_SERVICE_KEY/);
  assert.doesNotMatch(source, /https:\/\/[a-z]+\.supabase\.co/);
  assert.doesNotMatch(source, /eyJ[A-Za-z0-9_.-]+/);
});
