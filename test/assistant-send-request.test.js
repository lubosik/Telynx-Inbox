'use strict';
/**
 * test/assistant-send-request.test.js
 *
 * The assistant may prepare a send. It may not perform one. Everything here
 * exists to make that difference mechanical rather than a claim in a comment.
 *
 * The tests that matter most are the refusals, because the failure this
 * guards against is not "the send did not happen". It is "somebody's face was
 * scanned to confirm a number that was not true".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSendConfirmation } = require('../lib/assistant/send-request');

const OWNER = { id: 1, permissions: new Set(['campaigns.approve', 'campaigns.launch', 'campaigns.manage']) };

/** A campaign service that records every method anybody touched. */
function service({ campaign, dry }) {
  const touched = [];
  return {
    touched,
    async read(id) { touched.push(`read:${id}`); return campaign; },
    async dryRun(id) { touched.push(`dryRun:${id}`); return dry; },
    // Anything below this line reaching `touched` is a bug worth failing on.
    async approve() { touched.push('approve'); throw new Error('approve must never be called from here'); },
    async schedule() { touched.push('schedule'); throw new Error('schedule must never be called from here'); },
    async finalizeApproval() { touched.push('finalizeApproval'); throw new Error('nope'); }
  };
}

const READY = { id: 'c1', status: 'approved', revision: 7, name: 'Reorder check-in', message: 'Vici: ready for another? Reply STOP to opt out.', segment_name: 'Due a reorder' };
const HEALTHY_DRY = { revision: 7, total: 900, eligible: 41, suppressed: 859, reasons: { eligible: 41, consent_not_recorded: 800, do_not_contact: 55, cadence_too_soon: 4 }, liveEligibility: { enabled: false } };

test('a confirmation reads the campaign and the dry run, and writes nothing', async () => {
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });

  assert.equal(outcome.ok, true);
  // The whole safety argument in one assertion: two reads, no writes.
  assert.deepEqual(campaigns.touched, ['read:c1', 'dryRun:c1']);
});

test('the confirmation carries the SUPPRESSED count, not just the flattering one', async () => {
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  const { confirmSend } = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });

  assert.equal(confirmSend.recipients, 41);
  assert.equal(confirmSend.suppressed, 859);
  // Ordered by size, so the reason that removed 800 people is the first thing
  // read. A person confirming a send to 41 of 900 is usually looking at a
  // broken audience, and the top reason is what tells them which.
  assert.equal(confirmSend.topReasons[0].reason, 'consent_not_recorded');
  assert.equal(confirmSend.topReasons[0].count, 800);
  // 'eligible' is not a suppression reason and must not pad the list.
  assert.ok(!confirmSend.topReasons.some(entry => entry.reason === 'eligible'));
});

test('the revision travels with the confirmation so edited copy fails closed', async () => {
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  const { confirmSend } = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });
  // The approve route rejects a stale revision. Without this field the app
  // would confirm revision 7 and send whatever revision existed by then.
  assert.equal(confirmSend.revision, 7);
  assert.equal(confirmSend.requiresBiometricConfirmation, true);
});

test('it refuses when nobody is eligible, and still says why', async () => {
  const campaigns = service({
    campaign: READY,
    dry: { total: 900, eligible: 0, suppressed: 900, reasons: { consent_not_recorded: 900 }, liveEligibility: { enabled: false } }
  });
  const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'nobody_eligible');
  // A refusal with no reason produces "I could not do that", and the operator
  // goes looking in the wrong place. The reason IS the answer here.
  assert.equal(outcome.topReasons[0].reason, 'consent_not_recorded');
});

test('it refuses a campaign that already went out', async () => {
  for (const status of ['sent', 'sending']) {
    const campaigns = service({ campaign: { ...READY, status }, dry: HEALTHY_DRY });
    const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });
    assert.equal(outcome.ok, false, `${status} must be refused`);
    assert.equal(outcome.reason, 'already_sent');
    // And it must not have bothered running a dry run on something finished.
    assert.ok(!campaigns.touched.includes('dryRun:c1'));
  }
});

test('it refuses a campaign that is already scheduled rather than double booking it', async () => {
  const campaigns = service({ campaign: { ...READY, status: 'scheduled', scheduled_for: '2026-09-01T10:00:00Z' }, dry: HEALTHY_DRY });
  const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: OWNER });
  assert.equal(outcome.reason, 'already_scheduled');
  assert.equal(outcome.scheduledFor, '2026-09-01T10:00:00Z');
});

test('an account that cannot finish the send is told BEFORE the face prompt', async () => {
  // Support Agent: may manage campaigns, may not approve or launch one.
  const agent = { id: 8, permissions: new Set(['campaigns.manage', 'campaigns.read']) };
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: agent });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cannot_finish_send');
  assert.deepEqual(outcome.missingPermissions, ['campaigns.approve', 'campaigns.launch']);
  // It must not have read the campaign at all. Refusing after showing somebody
  // the message and the recipient count leaks both to a role that cannot send.
  assert.deepEqual(campaigns.touched, []);
});

test('holding only one half of sending is still not enough', async () => {
  const halfway = { id: 9, permissions: new Set(['campaigns.approve', 'campaigns.manage']) };
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  const outcome = await buildSendConfirmation({ campaignId: 'c1', campaigns, actor: halfway });
  assert.equal(outcome.reason, 'cannot_finish_send');
  assert.deepEqual(outcome.missingPermissions, ['campaigns.launch']);
});

test('a missing campaign is a refusal, not a crash', async () => {
  const campaigns = service({ campaign: null, dry: HEALTHY_DRY });
  const outcome = await buildSendConfirmation({ campaignId: 'nope', campaigns, actor: OWNER });
  assert.equal(outcome.reason, 'campaign_not_found');
});

test('an empty id never reaches the service', async () => {
  const campaigns = service({ campaign: READY, dry: HEALTHY_DRY });
  for (const id of ['', '   ', null, undefined]) {
    const outcome = await buildSendConfirmation({ campaignId: id, campaigns, actor: OWNER });
    assert.equal(outcome.reason, 'campaign_id_required');
  }
  assert.deepEqual(campaigns.touched, []);
});

test('the master brake is reported, not hidden', async () => {
  const off = service({ campaign: READY, dry: HEALTHY_DRY });
  const a = await buildSendConfirmation({ campaignId: 'c1', campaigns: off, actor: OWNER });
  assert.equal(a.confirmSend.liveSendEnabled, false);

  const on = service({ campaign: READY, dry: { ...HEALTHY_DRY, liveEligibility: { enabled: true } } });
  const b = await buildSendConfirmation({ campaignId: 'c1', campaigns: on, actor: OWNER });
  assert.equal(b.confirmSend.liveSendEnabled, true);
  // Both are confirmable. Being told the brake is on before the face prompt is
  // the point; refusing outright would make the demo path untestable.
  assert.equal(a.ok, true);
});
