#!/usr/bin/env node
'use strict';

/**
 * Set a named account's password out of band.
 *
 * SAFETY
 *   * This script WRITES to the configured Supabase project. It is not a test
 *     harness. Do not run it merely to validate a deploy.
 *   * The password is NEVER read from argv. Command-line arguments land in
 *     shell history and are visible to every process on the box through `ps`.
 *     Supply it in NEW_PASSWORD, or leave that unset and type it at the
 *     hidden prompt.
 *   * Only the scrypt hash is written. The plaintext is never logged, never
 *     echoed, and never stored.
 *   * Setting a password bumps the user's session epoch, which signs every
 *     existing session for that person out on their next request. That is
 *     intentional: a password change must end sessions opened with the old one.
 *   * The shared-password identity (is_legacy_shared) is refused. Its
 *     credential is INBOX_PASSWORD, held by Railway, not a row in this table.
 *
 * USAGE
 *   NEW_PASSWORD='...' node scripts/set-password.js --email someone@example.com
 *   node scripts/set-password.js --email someone@example.com          (prompts)
 *   node scripts/set-password.js --email someone@example.com --must-change
 *   node scripts/set-password.js --email someone@example.com --dry-run
 *
 * FLAGS
 *   --email <address>   Required. The account to update.
 *   --must-change       Force a password change at next sign-in.
 *   --dry-run           Report what would change and write nothing.
 */

require('dotenv').config();

const readline = require('node:readline');
const { hashPassword, validatePasswordStrength } = require('../lib/password');

function parseArgs(argv) {
  const args = { mustChange: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      args.email = argv[i + 1];
      i += 1;
    } else if (arg === '--must-change') {
      args.mustChange = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--password' || arg.startsWith('--password=')) {
      throw new Error(
        'Refusing --password. Command-line arguments leak into shell history and `ps`. ' +
        'Use NEW_PASSWORD in the environment, or omit it and type at the prompt.'
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Reads a line with echo suppressed so the password never appears on screen. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No TTY available for a hidden prompt. Set NEW_PASSWORD instead.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onKeypress = () => {
      // Rewrite the prompt with no characters after it.
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question);
    };
    process.stdin.on('data', onKeypress);
    rl.question(question, answer => {
      process.stdin.removeListener('data', onKeypress);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword() {
  const fromEnv = process.env.NEW_PASSWORD;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  const first = await promptHidden('New password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) throw new Error('The two passwords do not match.');
  return first;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  if (!args.email) throw new Error('An --email is required.');

  const password = await readPassword();
  const strengthProblem = validatePasswordStrength(password);
  if (strengthProblem) throw new Error(strengthProblem);

  const { supabase } = require('../db');

  const escaped = String(args.email).replace(/([\\%_])/g, '\\$1');
  const found = await supabase
    .from('sms_users')
    .select('id, email, display_name, role, is_active, is_legacy_shared')
    .ilike('email', escaped)
    .limit(2);
  if (found.error) throw new Error(`Could not look that account up: ${found.error.message}`);
  if (!found.data || found.data.length === 0) {
    throw new Error(`No account with email ${args.email}. Create it with POST /api/users or in the migration seeds.`);
  }
  if (found.data.length > 1) throw new Error('That email matched more than one account. Refusing to guess.');

  const user = found.data[0];
  if (user.is_legacy_shared) {
    throw new Error(
      'That is the shared team identity. Its credential is INBOX_PASSWORD in the Railway environment, not a row here.'
    );
  }

  console.log(`Account : ${user.display_name} <${user.email}>`);
  console.log(`Role    : ${user.role}${user.is_active ? '' : '  (INACTIVE — they still cannot sign in)'}`);
  console.log(`Rotation: ${args.mustChange ? 'required at next sign-in' : 'not required'}`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written. Re-run without --dry-run to apply.');
    return;
  }

  const password_hash = await hashPassword(password);
  const updated = await supabase
    .from('sms_users')
    .update({
      password_hash,
      password_set_at: new Date().toISOString(),
      must_change_password: args.mustChange === true,
      failed_login_count: 0,
      locked_until: null
    })
    .eq('id', user.id);
  if (updated.error) throw new Error(`Could not set the password: ${updated.error.message}`);

  const bumped = await supabase.rpc('bump_sms_user_session_epoch', { p_user_id: user.id });
  if (bumped.error) {
    console.warn(`Password set, but existing sessions were NOT revoked: ${bumped.error.message}`);
  } else {
    console.log(`\nPassword set. Existing sessions revoked (session epoch is now ${bumped.data}).`);
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { parseArgs };
