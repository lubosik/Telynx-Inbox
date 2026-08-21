'use strict';
/**
 * .env.example must document every environment variable the code reads.
 *
 * It did not. Seventeen were missing, including `APNS_KEY_ID`, `APNS_TEAM_ID`
 * and `APNS_KEY_P8_BASE64` — which AGENTS.md names as required Railway runtime
 * configuration, and without which `lib/apns-notify.js` returns null and sends
 * nothing at all. Nothing fails, no error is logged at the call site, and the
 * only symptom is that iPhones stop receiving message alerts. An undocumented
 * required variable is a deploy that looks healthy and is not.
 *
 * This is a documentation guard, not a runtime check. It asserts the variable
 * is NAMED in .env.example, never that it holds a value; .env.example must
 * stay placeholder-only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'flows', 'lib', 'sync', 'scripts'];

/**
 * Variables deliberately absent from .env.example, each with a reason.
 * Empty today. Add to it only when a variable genuinely is not deploy
 * configuration — a CI-injected value, for instance.
 */
const UNDOCUMENTED_ON_PURPOSE = new Map();

function walk(dir) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : [];
  });
}

function sourceFiles() {
  return [
    ...SCAN_DIRS.flatMap(walk),
    ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
      .map(entry => entry.name)
  ];
}

/**
 * Both spellings used in this repository: `process.env.NAME` directly, and
 * `env.NAME` where `env = process.env` was taken as an injectable parameter
 * (lib/voice-credentials.js, lib/audit/redact.js, lib/private-recordings.js).
 * The second is restricted to SCREAMING_SNAKE names so it cannot match an
 * ordinary property access.
 */
function readsEnvVars() {
  const names = new Map();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!names.has(match[1])) names.set(match[1], file);
    }
    for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) {
      if (!names.has(match[1])) names.set(match[1], file);
    }
  }
  return names;
}

function documentedVars() {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  return new Set(
    text.split('\n')
      .map(line => line.match(/^([A-Z0-9_]+)\s*=/))
      .filter(Boolean)
      .map(match => match[1])
  );
}

test('.env.example names every environment variable the code reads', () => {
  const documented = documentedVars();
  const missing = [...readsEnvVars()]
    .filter(([name]) => !documented.has(name) && !UNDOCUMENTED_ON_PURPOSE.has(name))
    .map(([name, file]) => `${name}  (first read in ${file})`);

  assert.deepStrictEqual(
    missing, [],
    '\n\nThese variables are read by the code but are not named in ' +
    '.env.example, so nothing tells an operator to set them:\n\n  ' +
    missing.join('\n  ') +
    '\n\nAdd each one with a one-line comment saying what it is for and ' +
    'whether it is required. Placeholders only — never a real value.\n'
  );
});

test('.env.example carries no filled-in secret values', () => {
  // A placeholder file is only useful if it stays a placeholder file. Every
  // credential-shaped name must be present and empty.
  const secretish = /(SECRET|PASSWORD|_KEY|TOKEN|P8_BASE64|DATABASE_URL|DB_URL)$/;
  const offenders = [];
  for (const line of fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)\s*=(.*)$/);
    if (!match) continue;
    const [, name, rest] = match;
    if (!secretish.test(name)) continue;
    // Strip a trailing `# ...` comment; the value is what precedes it.
    const value = rest.replace(/\s+#.*$/, '').trim();
    if (value) offenders.push(`${name} has a value in .env.example`);
  }
  assert.deepStrictEqual(offenders, [], `\n\n${offenders.join('\n')}\n`);
});

test('the APNs trio AGENTS.md calls required is documented as required', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const name of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8_BASE64']) {
    const line = text.split('\n').find(candidate => candidate.startsWith(`${name}=`));
    assert.ok(line, `${name} must be present in .env.example`);
    assert.match(line, /required/i, `${name} must be labelled as required`);
  }
});
