'use strict';
/**
 * test/sql-files-are-runnable.test.js
 *
 * A .sql file handed to somebody must be pasteable whole.
 *
 * THE MISTAKE THIS EXISTS FOR
 *   I wrote a migration for the owner to run and dressed it with plain English
 *   section headings sitting between the statements, like a document. He
 *   pasted the file, and Postgres said:
 *
 *     ERROR: 42601: syntax error at or near "RUN"
 *     LINE 2: RUN THIS IN THE SUPABASE SQL EDITOR
 *
 *   Correctly. It was prose in a file whose entire job was to be executed. The
 *   explanation is worth keeping and every line of it belongs behind a `--`.
 *
 *   Nothing catches this at review: the SQL in the middle is perfect, and the
 *   broken part looks like a heading rather than like code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-sql-runnable.js');

/** Files meant to be pasted into a SQL console, whatever their extension. */
function runnableSqlFiles() {
  const dir = path.join(ROOT, 'scripts');
  return fs.readdirSync(dir)
    // .sql and .txt both, because the owner asked for text files he can open
    // on a phone and a .txt full of SQL is still pasted into a SQL console.
    // A .md is a document and is deliberately not checked: the fix for mixing
    // prose and SQL was to stop mixing them, not to comment out the prose.
    .filter(name => name.endsWith('.sql') || name.endsWith('.txt'))
    .map(name => path.join(dir, name));
}

test('every SQL file we hand somebody is SQL all the way down', () => {
  const files = runnableSqlFiles();
  assert.ok(files.length > 0, 'there should be SQL files to check');

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, [CHECKER, file], { encoding: 'utf8' });
    } catch (error) {
      broken.push(`${path.basename(file)}\n${error.stdout || error.message}`);
    }
  }
  assert.deepEqual(broken, [],
    `these files contain lines that are neither SQL nor a SQL comment, so pasting them fails at the first one:\n\n${broken.join('\n')}`);
});

test('THE CHECKER ACTUALLY CATCHES PROSE, or it is checking nothing', () => {
  // Without this the test above passes for a checker that always succeeds.
  const scratch = path.join(process.env.TMPDIR || '/tmp', `vici-sql-check-${process.pid}.sql`);
  fs.writeFileSync(scratch, [
    '-- a real comment',
    'SELECT 1;',
    '',
    'RUN THIS IN THE SUPABASE SQL EDITOR',
    'SELECT 2;'
  ].join('\n'));

  let failed = false;
  let output = '';
  try {
    execFileSync(process.execPath, [CHECKER, scratch], { encoding: 'utf8' });
  } catch (error) {
    failed = true;
    output = error.stdout || '';
  }
  fs.rmSync(scratch, { force: true });

  assert.equal(failed, true, 'the checker must reject a file with prose in it');
  assert.match(output, /RUN THIS IN THE SUPABASE SQL EDITOR/);
  // The exact line Postgres rejected: 'syntax error at or near "RUN"'.
});

test('and it does not reject legitimate SQL it happens not to recognise', () => {
  // The first version of the checker flagged "SECURITY DEFINER", which is
  // perfectly good SQL. A checker that cries wolf gets switched off.
  const scratch = path.join(process.env.TMPDIR || '/tmp', `vici-sql-ok-${process.pid}.sql`);
  fs.writeFileSync(scratch, [
    'CREATE OR REPLACE FUNCTION public.thing() RETURNS boolean',
    'LANGUAGE plpgsql',
    'SECURITY DEFINER',
    'STABLE',
    'AS $body$',
    'BEGIN',
    '  -- a comment inside the body',
    '  RETURN true;',
    'END;',
    '$body$;'
  ].join('\n'));

  assert.doesNotThrow(() => execFileSync(process.execPath, [CHECKER, scratch], { encoding: 'utf8' }));
  fs.rmSync(scratch, { force: true });
});
