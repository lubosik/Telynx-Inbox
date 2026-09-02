'use strict';
/**
 * test/campaign-variant-wiring.test.js — the bank has to be plugged in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT REVIEW AND QA BOTH FOUND
 *
 *   Phase 2 shipped six hand-written variants, a rotation, and 64 passing
 *   tests — connected to nothing. `selectCheckInVariant` appeared nowhere
 *   outside its own file and its own test, and `last_checkin_variant` was
 *   written by no code path anywhere.
 *
 *   So two guarantees were inert rather than merely unused. The selector
 *   refuses to repeat `last_checkin_variant`; with nothing writing that column
 *   it reads null forever, every person gets candidate zero on every cycle,
 *   and a bank of six behaves exactly like a bank of one. The rotation tests
 *   passed the whole time because they hand the previous variant in
 *   themselves.
 *
 *   A test suite that proves a mechanism works in isolation, while nothing
 *   calls it, is the most expensive kind of green.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('the check-in recipe declares a variant bank', () => {
  // Asserted on the parsed recipe, not by slicing the source. Two attempts at
  // a character window got this wrong — the flag sits 1406 chars in and the
  // nearest `})` closes the inner Object.freeze — which is the tell that
  // scraping source was the wrong tool for a question the module can answer.
  const { recipe } = require('../lib/campaigns/recipes');
  assert.equal(recipe('checkin_21_day').variants, 'checkin',
    'without this the builder cannot know a bank exists');

  // And no other recipe claims one it does not have.
  const { RECIPE_KEYS } = require('../lib/campaigns/recipes');
  for (const key of RECIPE_KEYS.filter(k => k !== 'checkin_21_day')) {
    assert.equal(recipe(key).variants, undefined, `${key} has no bank`);
  }
});

test('the audience builder actually calls the selector', () => {
  // The finding: it did not. Six wordings and a rotation, reachable only from
  // their own tests.
  const builder = read('lib', 'campaigns', 'audience-builder.js');
  assert.match(builder, /require\('\.\/checkin-variants'\)/);
  assert.match(builder, /selectCheckInVariant\(/);
  assert.match(builder, /groupByVariant\(/, 'and groups by what it returns');
});

test('something writes last_checkin_variant, or the rotation cannot advance', () => {
  // This is the assertion whose absence made the whole bank inert.
  const service = read('lib', 'campaigns', 'service.js');
  assert.match(service, /last_checkin_variant:\s*variant/,
    'the chosen wording must be recorded against the people who received it');
});

test('it is recorded at approval, not when the draft is built', () => {
  // An abandoned draft must not burn a wording nobody received.
  const service = read('lib', 'campaigns', 'service.js');
  const finalize = service.slice(service.indexOf('async function finalizeApproval'));
  const upToSchedule = finalize.slice(0, finalize.indexOf('async function schedule'));
  assert.match(upToSchedule, /recordCheckInVariant\(/,
    'the write belongs on the approval path');

  const builder = read('lib', 'campaigns', 'audience-builder.js');
  assert.doesNotMatch(builder, /last_checkin_variant:\s*/,
    'and must not happen while merely drafting');
});

test('recording the variant cannot undo an approval', () => {
  // The campaign is approved and its messages are frozen by this point.
  // Failing over bookkeeping that self-corrects on the next run would throw
  // away a real approval.
  const service = read('lib', 'campaigns', 'service.js');
  const finalize = service.slice(service.indexOf('async function finalizeApproval'));
  assert.match(finalize.slice(0, 2000), /recordCheckInVariant\(id\)\.catch\(/,
    'best effort, and loudly logged');
});

test('no profiles means the wording the check-in has always used', () => {
  // Profiles are an enhancement to a campaign that has been sending fine
  // without them. Not migrated, not backfilled, or a failed read must all give
  // the known-good pair rather than no campaign at all — and must not hand the
  // entire audience variant one, which would be worse than not trying.
  const builder = read('lib', 'campaigns', 'audience-builder.js');
  const fn = builder.slice(builder.indexOf('async function groupByVariant'),
    builder.indexOf('async function buildFromRecipe'));

  assert.match(fn, /return null/, 'it degrades rather than throwing');
  assert.match(fn, /if \(!profiles\.size\) return null/,
    'an empty backfill falls back instead of giving everyone one variant');
  assert.match(fn, /if \(!profile\) return null/,
    'a partial backfill is not a basis to split an audience on');
  assert.match(fn, /catch/, 'and a failed read is a fallback, not an outage');
});

// ── The narrative sweep ────────────────────────────────────────────────────

test('the narrative sweep is registered, and off unless explicitly enabled', () => {
  // The last handoff shipped a module nothing called. This one checks the
  // wiring exists rather than assuming it.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function startNarrativeProfileSweep\(/);
  assert.match(server, /^startNarrativeProfileSweep\(\);$/m, 'and is actually invoked');

  const fn = server.slice(server.indexOf('function startNarrativeProfileSweep'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // A job that spends money per contact must not start because somebody
  // deployed. Exactly "true", following this repo's flag convention.
  assert.match(body, /PROFILE_NARRATIVE_ENABLED !== 'true'/,
    'off by default, and only the exact string enables it');

  // Separate from the drift sweep on purpose: one flag turning off both the
  // free thing and the expensive one would take the free thing with it, and
  // the free thing is the one that must always run.
  assert.doesNotMatch(body, /sweepProfileDrift/);
});

test('the narrative sweep cannot send anything', () => {
  // Its worst outcome should be a paragraph somebody disagrees with, never a
  // message a customer receives.
  const writer = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'profiles', 'narrative-writer.js'), 'utf8');
  for (const forbidden of ['sendSMS', 'createCoupons', 'scheduleSMS', 'telnyx']) {
    assert.ok(!writer.includes(forbidden),
      `the narrative writer must not reach ${forbidden}`);
  }
});

// ── The campaign screen after the messages are gone ────────────────────────

test('a sent campaign stops giving advice about approving it', () => {
  // The screenshot: a campaign showing "Sent", above "1 cannot be personalised
  // and must be removed from the audience before this can be approved."
  // Advice about an approval that happened yesterday, concerning a person who
  // was already left out of a send that has finished.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI', 'CampaignsView.swift'), 'utf8');

  // `status` is passed into the section, not reached for. The first attempt
  // read `campaign.status` inside a child struct where no `campaign` exists —
  // swiftc -parse accepted it because that only checks syntax, and the real
  // build failed on name resolution. A local parse is not a compile.
  assert.match(view, /let isFinished = status == \.completed \|\| status == \.sending/);
  assert.match(view, /CampaignPreviewSection\(preview: preview, status: campaign\.status\)/,
    'and the caller supplies it from a campaign it actually has');
  assert.match(view, /if !preview\.rendersForEveryone && !isFinished \{/,
    'the instruction is only shown while it is still actionable');
  assert.match(view, /could not be personalised and were left out of the send/,
    'and is replaced by a statement of what happened');
});

test('every campaign shows three messages, not three hundred', () => {
  // First capped only after sending, on the reasoning that a reviewer
  // deciding whether wording works should see the whole spread. The owner's
  // answer, having actually done that review: three is what he needs, and a
  // dozen means scrolling past a dozen to reach the approve button.
  //
  // The number that decides an approval is how many people DROP OUT, stated
  // above in one line. The samples exist to show the merge fields substitute
  // at all, which three demonstrate as well as three hundred.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI', 'CampaignsView.swift'), 'utf8');
  assert.match(view, /let sampleLimit = 3/);
  assert.match(view, /ForEach\(preview\.samples\.prefix\(sampleLimit\)\)/);
  assert.match(view, /Showing 3 of \\\(preview\.samples\.count\) messages/,
    'and says it is showing a sample rather than hiding the rest silently');
});

test('the placeholder-code note disappears once the codes are real', () => {
  // "Codes shown here are placeholders" is true before approval and a lie
  // afterwards: those are the codes that went to customers.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI', 'CampaignsView.swift'), 'utf8');
  const section = view.slice(view.indexOf('if preview.samples.count > sampleLimit'));
  assert.match(section.slice(0, 900), /if !isFinished \{[\s\S]*?Codes shown here are placeholders/);
});

test('a finished campaign reads as Live, not Sent or Completed', () => {
  // "Completed" is a word about the job. "Sent" sounds filed away, and the
  // campaign is not finished at that point: replies are arriving, codes are
  // being redeemed, revenue lands against it for weeks.
  const models = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'Core', 'CampaignModels.swift'), 'utf8');
  assert.match(models, /case \.completed: return "Live"/);
});

test('the chart keeps its bars off the axis labels', () => {
  // With a day or two of data the first bar sat flush against the y-axis and
  // covered the "0", so the scale read as though it started at 200 — worst on
  // exactly the data a brand new campaign produces.
  const analytics = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI', 'AnalyticsView.swift'), 'utf8');
  assert.match(analytics, /\.chartXScale\(range: \.plotDimension\(startPadding: \d+/);
});
