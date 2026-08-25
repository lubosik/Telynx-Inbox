#!/usr/bin/env node
'use strict';
/**
 * scripts/check-sql-runnable.js — is this file pasteable into a SQL console?
 *
 * THE BUG THIS CATCHES
 *   A migration was written for the owner to run and dressed with plain
 *   English section headings between the statements, like a document. Pasting
 *   it produced:
 *
 *     ERROR: 42601: syntax error at or near "RUN"
 *     LINE 2: RUN THIS IN THE SUPABASE SQL EDITOR
 *
 *   The SQL in the middle was perfect. The broken part looked like a heading
 *   rather than like code, which is exactly why reading it did not catch it.
 *
 * HOW IT CHECKS
 *   Line-by-line keyword matching does not work: half of real SQL is
 *   continuation lines like "ADD COLUMN IF NOT EXISTS x text," or a bare
 *   column list, and flagging those makes the tool useless and then ignored.
 *
 *   So comments and dollar-quoted bodies are removed, what remains is split on
 *   semicolons, and each statement must BEGIN with a SQL command word. A block
 *   of prose becomes a statement starting "RUN THIS IN THE..." and is caught,
 *   while every continuation line stays part of the statement it belongs to.
 */

const fs = require('node:fs');

const COMMANDS = new Set([
  'select', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'truncate',
  'begin', 'commit', 'rollback', 'savepoint', 'comment', 'grant', 'revoke',
  'with', 'set', 'do', 'call', 'analyze', 'vacuum', 'explain', 'copy',
  'refresh', 'reindex', 'notify', 'listen', 'prepare', 'execute', 'deallocate',
  'lock', 'declare', 'fetch', 'close', 'reset', 'show', 'values', 'start', 'end'
]);

/** Remove line comments, block comments and dollar-quoted bodies. */
function stripNonStatements(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[index] === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(index));
      if (tag) {
        const end = source.indexOf(tag[0], index + tag[0].length);
        // A dollar-quoted body is opaque on purpose: it is a function's source
        // and may legitimately contain anything at all.
        out += ' ';
        index = end === -1 ? source.length : end + tag[0].length;
        continue;
      }
    }
    if (source[index] === "'") {
      const end = source.indexOf("'", index + 1);
      out += ' ';
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

function offenders(source) {
  const stripped = stripNonStatements(source);
  const bad = [];
  for (const chunk of stripped.split(';')) {
    const statement = chunk.trim();
    if (!statement) continue;
    const first = (statement.match(/^[A-Za-z_]+/) || [''])[0].toLowerCase();
    if (!COMMANDS.has(first)) {
      bad.push(statement.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  return bad;
}

if (require.main === module) {
  const file = process.argv[2];
  const bad = offenders(fs.readFileSync(file, 'utf8'));
  if (bad.length) {
    console.log('NOT PASTEABLE. These are neither SQL statements nor comments:');
    for (const entry of bad) console.log('  ' + entry);
    process.exit(1);
  }
  console.log('every statement is SQL and every explanation is a comment');
}

module.exports = { offenders };
