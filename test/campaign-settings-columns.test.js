'use strict';
/**
 * test/campaign-settings-columns.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAULT THIS EXISTS FOR
 *
 *   loadCampaignSettings() selects an EXPLICIT column list. Add a column to
 *   the table, apply the migration, write a reader for it, and it is still
 *   invisible — because the loader never asked for it.
 *
 *   The symptom is not an error. It is `undefined`, which every `!== true`
 *   check reads as false. So `checkin_automation_enabled` went in, the
 *   migration was applied, the toggle wrote `true` to the database, and the
 *   sweep still reported `automation_disabled` while the switch in the app
 *   snapped straight back to Off. Nothing logged. Nothing threw.
 *
 *   This is the same shape as the last five bugs in this subsystem: two
 *   components answering one question, and the quieter one winning. So the
 *   guard is structural rather than a test of one column — it reads the code
 *   for every `settings.<name>` any caller touches and insists the loader
 *   asked for it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ELIGIBILITY = fs.readFileSync(path.join(ROOT, 'lib', 'campaigns', 'eligibility.js'), 'utf8');

/** The column list inside loadCampaignSettings. */
function selectedColumns() {
  const body = ELIGIBILITY.slice(ELIGIBILITY.indexOf('async function loadCampaignSettings'));
  const match = body.match(/\.select\('([^']+)'\)/);
  assert.ok(match, 'loadCampaignSettings must still select an explicit column list');
  return new Set(match[1].split(',').map(name => name.trim()).filter(Boolean));
}

/**
 * Every file that reads a settings row, and how it names the variable.
 *
 * Listed explicitly rather than globbed: a glob would silently stop covering a
 * file that renamed its variable, which is precisely the kind of quiet gap
 * this test exists to close.
 */
const READERS = [
  ['lib/campaigns/check-in-automation.js', 'settings'],
  ['lib/campaigns/eligibility.js', 'settings'],
  ['lib/campaigns/service.js', 'settings'],
  ['routes/campaigns.js', 'settings']
];

/** Column names that are not columns. */
const NOT_COLUMNS = new Set(['length', 'map', 'filter', 'find', 'then', 'catch']);

test('the settings loader asks for every column its callers read', () => {
  const selected = selectedColumns();
  const missing = [];

  for (const [file, variable] of READERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // `settings.some_column` and `settings?.some_column`. snake_case only:
    // camelCase members are helpers, not columns.
    const pattern = new RegExp(`\\b${variable}\\??\\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\\b`, 'g');
    for (const match of source.matchAll(pattern)) {
      const column = match[1];
      if (NOT_COLUMNS.has(column) || selected.has(column)) continue;
      missing.push(`${file} reads settings.${column}`);
    }
  }

  assert.deepEqual(missing, [],
    'These columns are read but never selected, so they arrive as undefined — which every '
    + '`!== true` check silently treats as false:\n  ' + missing.join('\n  ')
    + '\nAdd them to the .select() in loadCampaignSettings.');
});

test('the automation flag specifically is selected', () => {
  // Named on its own as well as covered structurally above, because this is
  // the one that shipped broken and the one whose absence is hardest to
  // notice: the feature simply never runs.
  assert.ok(selectedColumns().has('checkin_automation_enabled'),
    'checkin_automation_enabled must be selected, or the automatic check-in can never turn on');
});

test('quiet hours are selected, because the send time is computed from them', () => {
  const selected = selectedColumns();
  for (const column of ['quiet_hours_start', 'quiet_hours_end', 'business_timezone']) {
    assert.ok(selected.has(column), `${column} must be selected`);
  }
});

test('every selected column exists in the migration that creates the table', () => {
  // The other direction: selecting a column that was never migrated makes the
  // whole read fail with PGRST204, which takes the campaigns screen down
  // rather than degrading one feature.
  const migrations = ['campaigns-migration.sql', 'checkin-automation-migration.sql']
    .map(name => {
      const file = path.join(ROOT, 'scripts', name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    })
    .join('\n');

  for (const column of selectedColumns()) {
    assert.ok(migrations.includes(column),
      `loadCampaignSettings selects "${column}" but no migration under scripts/ creates it. `
      + 'A column that does not exist fails the whole read with PGRST204.');
  }
});
