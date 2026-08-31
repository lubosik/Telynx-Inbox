'use strict';
/**
 * test/sql-array-literal.test.js — text[] || 'literal' does not do what it looks like.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG
 *
 *   Archiving an approved campaign failed with:
 *
 *     CAMPAIGN_DELETE_FAILED  malformed array literal: "approved"
 *
 *   v_blockers is text[], and `text[] || 'approved'` with an UNTYPED literal
 *   resolves to anyarray || anyarray. Postgres therefore tries to parse
 *   "approved" as array syntax and throws. The one append that worked in the
 *   same function,
 *
 *     v_blockers := v_blockers || ('status_' || v_campaign.status);
 *
 *   worked only because its right-hand side is a known text expression, which
 *   selects anyarray || anyelement instead.
 *
 * WHY IT SURVIVED SO LONG
 *
 *   Every blocker except the status one was unreachable. A campaign only
 *   reaches those lines once it has been approved, scheduled, submitted, or
 *   has touched a recipient, a message, the ledger or an attribution — so a
 *   pristine draft archived fine and everything real crashed. The first
 *   approved campaign anybody archived hit it.
 *
 *   The same six appends were in delete_sms_campaign_segment, which IS live
 *   in production despite the repo notes marking its migration unapplied.
 *   Checked against pg_proc rather than the docs.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

test('no SQL function appends an untyped literal to a text array', () => {
  const offenders = [];
  for (const file of fs.readdirSync(SCRIPTS).filter(name => name.endsWith('.sql'))) {
    const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      // `something := something || 'literal';` with no cast and no expression.
      if (/:=\s*[a-z_]+\s*\|\|\s*'[^']*'\s*;/.test(line) && !/::[a-z]+\s*;/.test(line)) {
        offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'These append an untyped literal to an array, which Postgres reads as '
    + 'anyarray || anyarray and rejects with "malformed array literal". Add ::text:\n  '
    + offenders.join('\n  '));
});

test('both blocker-building functions cast every literal', () => {
  // Named directly as well, because these are the two that actually broke and
  // the general rule above could be loosened by accident.
  for (const [file, expected] of [
    ['campaign-segments-migration.sql', 10],
    ['segment-lifecycle-migration.sql', 6]
  ]) {
    const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    const cast = (source.match(/v_blockers := v_blockers \|\| '[a-z_]+'::text;/g) || []).length;
    assert.equal(cast, expected, `${file} should have ${expected} cast appends, found ${cast}`);
    assert.doesNotMatch(source, /v_blockers := v_blockers \|\| '[a-z_]+';/,
      `${file} still has an uncast append`);
  }
});

test('the fix migration exists and is idempotent', () => {
  const fix = fs.readFileSync(path.join(SCRIPTS, 'fix-delete-campaign-array-literal.sql'), 'utf8');
  // CREATE OR REPLACE, so re-running it is safe and it carries no DROP.
  assert.match(fix, /CREATE OR REPLACE FUNCTION public\.delete_sms_campaign\(/);
  assert.match(fix, /CREATE OR REPLACE FUNCTION public\.delete_sms_campaign_segment\(/);
  assert.doesNotMatch(fix, /\bDROP\s+FUNCTION\b/i);
});
