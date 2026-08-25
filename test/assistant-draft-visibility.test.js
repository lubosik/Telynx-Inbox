'use strict';
/**
 * test/assistant-draft-visibility.test.js
 *
 * WHAT HAPPENED, AND WHY IT LOOKED LIKE A LIE
 *
 * The owner asked for a campaign. Four drafts were written and saved. The
 * assistant said so, correctly. He then asked to be shown them, and it called
 * open_screen('campaigns') and said "you're looking at the campaigns now".
 *
 * Drafts are PROPOSALS. They live on the Campaign drafts screen. The campaigns
 * screen is a different, real, and at that moment completely empty screen. So
 * he was taken to a blank page, told he was looking at his drafts, and
 * reasonably concluded nothing had been drafted at all.
 *
 * Nothing here is about the model being wrong. It had no way to know: the
 * success payload never said where the drafts went, no tool could read a draft
 * back, and the two screens sat next to each other in an enum with one shared
 * description between them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../lib/assistant/tools');

function toolsWith(overrides = {}) {
  const stub = new Proxy({}, { get: () => async () => ({}) });
  return buildTools({
    segments: stub, campaigns: stub, proposals: stub,
    referrals: stub, analytics: stub, ...overrides
  });
}
const byName = (name, overrides) => toolsWith(overrides).find(t => t.name === name);

test('DRAFTING SAYS WHERE THE DRAFTS WENT, so being shown them is not a guess', async () => {
  const proposals = {
    draftProposals: async () => ({
      proposals: [{ mechanism: 'plain_check_in', segmentName: 'Bought once', copy: { text: 'Vici here. Reply STOP to opt out.' } }],
      model: 'test'
    }),
    saveBatch: async () => ({ saved: [{ id: 'p1' }] })
  };
  const opportunities = { read: async () => ({ id: 'finding:one_time_buyers', title: 'Bought once and never came back' }) };
  const tool = byName('draft_campaign', { proposals, opportunities });

  const result = await tool.run({ opportunityId: 'finding:one_time_buyers' }, { actor: { id: 4 } });
  assert.equal(result.ok, true);
  // The whole fix. converse() carries `navigate` out of the loop and the app
  // performs the move, so the operator lands on the drafts rather than on an
  // empty campaigns screen.
  assert.equal(result.navigate.screen, 'campaignProposals');
  // And the message read back is the TEXT, not the object that wraps it.
  assert.equal(result.message, 'Vici here. Reply STOP to opt out.');
});

test('the assistant can read its own drafts back', async () => {
  // Before this tool existed, "show me what you wrote" could only be answered
  // by navigating somewhere and hoping. Nothing could read sms_campaign_proposals.
  const proposals = {
    list: async (args) => {
      // Only open drafts. An accepted one is a campaign now, and a dismissed
      // one was rejected on purpose; reading either back as pending misleads.
      assert.equal(args.status, 'proposed');
      return {
        total: 4,
        items: [{
          id: 'p1', title: 'Plain check-in', mechanismLabel: 'Plain check-in, no offer',
          opportunityTitle: 'Bought once and never came back',
          copy: { text: 'Vici here. We are around if you need anything. Reply STOP to opt out.' }
        }]
      };
    }
  };
  const tool = byName('list_campaign_drafts', { proposals });
  const result = await tool.run({}, { actor: { id: 4 } });

  assert.match(result.summary, /4 drafts waiting for review/);
  assert.equal(result.drafts[0].message,
    'Vici here. We are around if you need anything. Reply STOP to opt out.');
  assert.equal(result.navigate.screen, 'campaignProposals');
});

test('the two campaign screens are described differently, because they are different', () => {
  const open = byName('open_screen');
  // They used to sit side by side in an enum under one description. That is
  // how "show me the drafts" became "campaigns", which was empty.
  const screen = open.schema.properties.screen.description;
  assert.match(screen, /campaignProposals.*Campaign drafts/s);
  assert.match(screen, /empty until/);
});

test('request_campaign_send no longer claims to accept draft ids', () => {
  // It said "The campaign id from list_campaigns or draft_campaign". Drafts
  // return PROPOSAL ids, and a proposal is not a campaign until somebody
  // accepts it, so that path could only ever refuse with campaign_not_found.
  const send = byName('request_campaign_send');
  const description = send.schema.properties.campaignId.description;
  assert.doesNotMatch(description, /or draft_campaign/);
  assert.match(description, /NOT a draft id/);
});

test('a failed tool is RECORDED, so an attempt that threw leaves a trace', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'assistant', 'converse.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const pushAt = source.indexOf('toolsUsed.push(tool.name)');
  const runAt = source.indexOf('await tool.run(args');
  assert.ok(pushAt >= 0 && runAt >= 0);
  // Recording after the await meant a thrown tool vanished from the saved
  // thread, so a session where drafting failed looked exactly like one where
  // it was never attempted. That is the wrong way round for diagnosing this.
  assert.ok(pushAt < runAt, 'the tool must be recorded before it is allowed to throw');
});

test('a thrown tool reaches the model as a SENTENCE, not a constant', () => {
  const { converse } = require('../lib/assistant/converse');
  assert.ok(typeof converse === 'function');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'assistant', 'converse.js'), 'utf8');
  assert.match(source, /function readableToolFailure/);
  // This is spoken out loud. "CAMPAIGN_PROPOSALS_DISABLED" is not a sentence.
  const fn = new Function('error', source.slice(
    source.indexOf('function readableToolFailure'),
    source.indexOf('function parseArguments')
  ) + '; return readableToolFailure(error);');

  assert.equal(
    fn(Object.assign(new Error('Campaign opportunity proposals are disabled.'), { code: 'CAMPAIGN_PROPOSALS_DISABLED' })),
    'Campaign opportunity proposals are disabled.');
  // But a raw database error is still withheld and the code stands in for it.
  assert.equal(
    fn(Object.assign(new Error('relation "sms_x" does not exist'), { code: 'PGRST205' })),
    'PGRST205');
  assert.equal(fn({}), 'That did not succeed.');
});
