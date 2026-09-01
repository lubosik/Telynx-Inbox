'use strict';
/**
 * test/campaign-sql-null-character.test.js — chr(0) is not a separator in
 * PostgreSQL, it is an error.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 *
 *   Four functions built a per-phone advisory lock key like this:
 *
 *     hashtextextended(p_workspace_id || chr(0) || contact_phone, 0)
 *
 *   The NUL was meant as a separator that cannot appear in either operand, so
 *   'a' + 'bc' and 'ab' + 'c' could never collide into the same lock. The
 *   reasoning is right and the habit is a good one in most languages.
 *
 *   PostgreSQL text values cannot contain a NUL byte at all. So chr(0) never
 *   produced a separator; it raised 54000 "null character not permitted" every
 *   time the line was reached.
 *
 *   Those four functions are the entire send path: claim, the pre-provider
 *   fence, the acceptance record, and draft persistence. Every campaign
 *   message ever scheduled failed at the first step. The delivery loop ran
 *   every two minutes, claimed nothing, and logged the same error, while four
 *   approved campaigns sat at 0 of 427 sent and the app showed them as
 *   scheduled — because a failed claim marks nothing as failed.
 *
 *   No unit test caught it because every test in this suite stubs the
 *   database. The SQL had never been executed against a real PostgreSQL.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SQL_DIR = path.join(__dirname, '..', 'scripts');

/** Every file in scripts/ that contains SQL we ship. */
function sqlFiles() {
  return fs.readdirSync(SQL_DIR)
    .filter(name => /\.(sql|txt)$/.test(name))
    .map(name => path.join(SQL_DIR, name))
    .filter(file => /CREATE OR REPLACE FUNCTION|CREATE TABLE|ALTER TABLE/.test(
      fs.readFileSync(file, 'utf8')
    ));
}

/** Strip `--` comments so prose about the bug is not mistaken for the bug. */
function executableLines(source) {
  return source.split('\n').filter(line => !/^\s*--/.test(line));
}

test('no shipped SQL calls chr(0)', () => {
  // chr(0) is not a rare edge case in PostgreSQL, it is an unconditional
  // error. Any line reaching it is dead on arrival.
  const offenders = [];
  for (const file of sqlFiles()) {
    const lines = executableLines(fs.readFileSync(file, 'utf8'));
    lines.forEach((line, index) => {
      if (line.includes('chr(0)')) {
        offenders.push(`${path.basename(file)}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'chr(0) raises 54000 in PostgreSQL. Use chr(31), the unit separator: it is '
    + 'legal, non-printing, and cannot occur in a workspace id or an E.164 phone number.');
});

test('the separator used instead is one PostgreSQL actually permits', () => {
  // A NUL is the only character PostgreSQL forbids in text. Anything else in
  // the C0 control range is legal and serves the same purpose, but the point
  // is that the choice must be deliberate rather than whatever looked
  // separator-shaped.
  const source = fs.readFileSync(path.join(SQL_DIR, 'campaigns-migration.sql'), 'utf8');
  const separators = [...source.matchAll(/hashtextextended\([^)]*?chr\((\d+)\)/g)]
    .map(match => Number(match[1]));

  assert.ok(separators.length > 0, 'the lock keys should still use an explicit separator');
  for (const code of separators) {
    assert.notEqual(code, 0, 'chr(0) is not representable in PostgreSQL text');
    assert.ok(code > 0 && code < 32,
      `chr(${code}) should be a non-printing control character so it cannot occur in real data`);
  }
});

test('every advisory lock key still has a separator at all', () => {
  // Removing chr(0) by deleting it would be worse than the bug: 'vici' plus
  // '+15551110001' and 'vic' plus 'i+15551110001' would take the same lock,
  // and two different people could be sent to concurrently.
  const source = fs.readFileSync(path.join(SQL_DIR, 'campaigns-migration.sql'), 'utf8');
  const keys = [...source.matchAll(/hashtextextended\(([^;]*?), 0\)/g)].map(match => match[1]);
  assert.ok(keys.length >= 4, 'the send path builds several per-entity lock keys');
  for (const key of keys) {
    assert.match(key, /chr\(\d+\)/,
      `lock key must keep an explicit separator, got: ${key.trim()}`);
  }
});
