'use strict';
/**
 * test/campaign-cancel-archive.test.js — a superseded campaign should not
 * appear in front of anybody.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 *
 *   The owner archived every cancelled campaign in the app, and four more
 *   appeared. He reasonably concluded that archiving was not sticking.
 *
 *   It was. 21 of 25 were archived and stayed archived. The four had been
 *   CREATED after he tidied up: each rebuild cancels the previous drafts, and
 *   those fresh cancelled rows landed straight in his working list.
 *
 *   Two reasons a campaign is cancelled deserve different endings. Somebody
 *   deciding not to send one is a decision and belongs in the list until they
 *   say otherwise. A campaign cancelled because it was rebuilt is bookkeeping,
 *   and should never have been shown at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCampaignService } = require('../lib/campaigns/service');

/** A client that records what was asked of it. */
function fakeClient({ onUpdate } = {}) {
  const calls = { rpc: [], updates: [] };
  return {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: [{ id: args.p_campaign_id, status: 'cancelled' }], error: null });
    },
    from() {
      const chain = {
        update(patch) { calls.updates.push(patch); chain._patch = patch; return chain; },
        eq() { return chain; },
        is() { return Promise.resolve(onUpdate ? onUpdate(chain._patch) : { error: null }); },
        select() { return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); }
      };
      return chain;
    }
  };
}

test('an ordinary cancel leaves the campaign on the working list', () => {
  // Deciding not to send something is a decision. It stays visible until the
  // person who made it says otherwise.
  const client = fakeClient();
  const service = createCampaignService({ client, env: {} });
  return service.cancel('c1', 'changed my mind', null).then(() => {
    assert.equal(client.calls.rpc.length, 1);
    assert.equal(client.calls.rpc[0].name, 'cancel_sms_campaign');
    assert.deepEqual(client.calls.updates, [], 'nothing should be archived');
  });
});

test('a superseded cancel archives in the same call', async () => {
  // One call, because superseding something and then remembering to tidy up
  // after it is exactly the two-step nobody performs reliably.
  const client = fakeClient();
  const service = createCampaignService({ client, env: {} });
  await service.cancel('c1', 'rebuilt', null, { archive: true });

  assert.equal(client.calls.rpc[0].name, 'cancel_sms_campaign');
  assert.equal(client.calls.updates.length, 1);
  assert.ok(client.calls.updates[0].archived_at, 'archived_at must be set');
});

test('a failed archive does not fail the cancel', async () => {
  // The cancel is the part that matters and has already succeeded. Throwing
  // here would turn a cosmetic problem into a real one: a campaign the caller
  // believes is still live.
  const client = fakeClient({ onUpdate: () => ({ error: { message: 'connection reset' } }) });
  const service = createCampaignService({ client, env: {} });
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await service.cancel('c1', 'rebuilt', null, { archive: true });
    assert.equal(result.status, 'cancelled', 'the cancel still succeeded');
  } finally {
    console.error = realError;
  }
  assert.ok(errors.some(line => /could not archive/.test(line)),
    'and the failure to tidy up is logged rather than swallowed');
});

test('archiving only ever touches a row that is not archived already', () => {
  // `.is('archived_at', null)` guards it, so re-archiving cannot overwrite the
  // timestamp of an archive somebody performed days ago.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', 'service.js'), 'utf8');
  const body = source.slice(source.indexOf('async function cancel('), source.indexOf('async function dryRun('));
  assert.match(body, /\.is\('archived_at', null\)/,
    'the archive update must not touch an already-archived row');
});
