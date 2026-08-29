'use strict';
/**
 * test/campaign-reply-triage.test.js — reading a reply and deciding what,
 * if anything, to do about it.
 *
 * The thing this replaced was a substring list, so the tests that matter are
 * about what the model is NOT allowed to cause: it may withhold the code but
 * never invent a reason to send one, and nothing it writes may reach a
 * customer unread or unvalidated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTO_SEND_CONFIDENCE,
  INTENTS,
  finishDraft,
  looksObviouslyUnhappy,
  parseVerdict,
  recordForHuman,
  triageReply
} = require('../lib/campaigns/reply-triage');

const { RULES } = require('../lib/campaigns/copy-rules');

/** A completion stub returning whatever the model is pretending to say. */
const model = (content) => async () => ({ content });
const modelJSON = (verdict) => model(JSON.stringify(verdict));

test('a confident happy reply is the only thing that auto-sends', async () => {
  const result = await triageReply({
    // Unambiguous praise about delivery, not "all good thanks", which is now
    // deliberately `acknowledged` and has its own test below.
    text: 'arrived fast and packaging was perfect',
    completion: modelJSON({ intent: 'happy', confidence: 0.95, summary: 'happy', draft_reply: null })
  });
  assert.equal(result.autoSendCode, true);
  assert.equal(result.needsHuman, false);
  assert.equal(result.draftReply, null, 'a happy reply needs no drafted answer');
});

test('every other intent needs a person, however confident', async () => {
  for (const intent of INTENTS.filter(i => i !== 'happy')) {
    const result = await triageReply({
      text: 'something',
      completion: modelJSON({ intent, confidence: 0.99, summary: 's', draft_reply: 'We will look into it.' })
    });
    assert.equal(result.autoSendCode, false, intent);
    assert.equal(result.needsHuman, true, intent);
  }
});

test('an unsure happy does not auto-send', async () => {
  const result = await triageReply({
    text: 'ok',
    completion: modelJSON({ intent: 'happy', confidence: AUTO_SEND_CONFIDENCE - 0.01, summary: 's', draft_reply: null })
  });
  // The cost of a wrong `happy` is a discount answering a complaint. The cost
  // of a wrong `needsHuman` is somebody reading a message they need not have.
  assert.equal(result.autoSendCode, false);
});

test('the keyword list can veto a wrong happy but can never create one', async () => {
  // The model calls it happy; the words say otherwise. Safe direction wins.
  const vetoed = await triageReply({
    text: 'it arrived broken',
    completion: modelJSON({ intent: 'happy', confidence: 0.99, summary: 's', draft_reply: null })
  });
  assert.equal(vetoed.autoSendCode, false);
  assert.equal(vetoed.obviouslyUnhappy, true);

  // And the reverse is impossible: no keyword can turn a problem into a send.
  const stillProblem = await triageReply({
    text: 'lovely wonderful perfect',
    completion: modelJSON({ intent: 'problem', confidence: 0.99, summary: 's', draft_reply: 'x' })
  });
  assert.equal(stillProblem.autoSendCode, false);
});

test('an unreachable model sends nothing and says so', async () => {
  const result = await triageReply({
    text: 'arrived fast and packaging was perfect',
    completion: async () => { throw new Error('timeout'); }
  });
  assert.equal(result.autoSendCode, false);
  assert.equal(result.needsHuman, true);
  assert.equal(result.reason, 'triage_unavailable');
});

test('a malformed answer is treated as no answer', async () => {
  for (const content of ['not json', '{"intent":"nonsense"}', '', '{"confidence":1}']) {
    const result = await triageReply({ text: 'hi', completion: model(content) });
    assert.equal(result.autoSendCode, false, JSON.stringify(content));
    assert.equal(result.reason, 'triage_unavailable', JSON.stringify(content));
  }
});

test('during an outage the keyword list still flags a complaint', async () => {
  // An outage must not turn "it arrived broken" into a coupon, and it must not
  // hide the complaint either.
  const result = await triageReply({
    text: 'it arrived broken', completion: async () => { throw new Error('down'); }
  });
  assert.equal(result.obviouslyUnhappy, true);
});

// ── What the model may write ───────────────────────────────────────────────

test('a draft naming a compound is refused, not shown', async () => {
  // The one thing a drafted reply must never do. A suggestion a human cannot
  // send is worse than none: they read it, tap send, and get an error they did
  // not cause.
  const draft = finishDraft('Your Tirzepatide order is on the way.');
  assert.equal(draft.rejected, true);
  assert.ok(draft.failedChecks.includes('no_banned_terms'));
});

test('a draft using the approved product code is allowed', () => {
  const draft = finishDraft('Someone will sort your RT order out today.');
  assert.equal(draft.rejected, undefined);
  assert.match(draft.text, /^It's Vin from Vici\./);
  assert.ok(draft.text.endsWith(RULES.optOut.exactSuffix));
});

test('the opt-out line is appended exactly, never left to the model', () => {
  // It must match exactly or the validator refuses it for a reason nobody
  // reading the draft would understand.
  const draft = finishDraft('We will look into it.');
  assert.ok(draft.text.endsWith(RULES.optOut.exactSuffix));
  // And it is not doubled when the model already added one.
  const already = finishDraft(`We will look into it. ${RULES.optOut.exactSuffix}`);
  assert.equal((already.text.match(/Reply STOP to opt out/g) || []).length, 1);
});

test('a rejected draft still leaves the reply flagged for a person', async () => {
  const result = await triageReply({
    text: 'is this the semaglutide one',
    completion: modelJSON({
      intent: 'question', confidence: 0.9, summary: 'asks about a compound',
      draft_reply: 'Yes that is our Semaglutide product.'
    })
  });
  assert.equal(result.needsHuman, true);
  assert.equal(result.draftReply, null, 'the unusable draft must not be shown');
  assert.equal(result.draftRejected, true);
});

test('parseVerdict clamps confidence and refuses unknown intents', () => {
  assert.equal(parseVerdict('{"intent":"happy","confidence":5}').confidence, 1);
  assert.equal(parseVerdict('{"intent":"happy","confidence":-2}').confidence, 0);
  assert.equal(parseVerdict('{"intent":"delighted","confidence":1}'), null);
  // Models wrap JSON in prose or fences more often than they should.
  assert.equal(parseVerdict('```json\n{"intent":"happy","confidence":0.9}\n```').intent, 'happy');
});

// ── Recording it ───────────────────────────────────────────────────────────

test('a triaged reply is recorded for a human with its draft', async () => {
  const writes = [];
  const client = {
    from() {
      return { insert(row) { writes.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 1 }, error: null }) }) }; } };
    }
  };
  await recordForHuman({
    client, phone: '+15550000001', replyText: 'it broke',
    triage: { intent: 'problem', summary: 'the vial cracked', draftReply: 'We will sort it.', obviouslyUnhappy: true }
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].suggestion_type, 'reply_draft');
  assert.equal(writes[0].status, 'pending');
  assert.equal(writes[0].suggested_message, 'We will sort it.');
  assert.match(writes[0].suggestion_text, /problem \(reads as a complaint\)/);
});

test('the handler honours an opt-out the phrase list would miss', () => {
  // Measured against isOptOutRequest: "stop texting me" is caught, but
  // "please stop sending me these" and "leave me alone" are not. Those are
  // unambiguous, and suppressing on the model's word is the safe direction:
  // a false positive is undone by hand, an unhonoured opt-out is not.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'check-in-reply.js'), 'utf8'
  );
  assert.match(source, /opt_out_intent/);
  assert.match(source, /suppressOptOut\(phone/);
  // And it must be checked BEFORE the code path, or a reply asking to be left
  // alone could still earn a discount.
  assert.ok(
    source.indexOf('opt_out_intent') < source.indexOf('mayIssueCode('),
    'the opt-out branch must come before the code budget'
  );
});

test('looksObviouslyUnhappy is only ever used to withhold', () => {
  assert.equal(looksObviouslyUnhappy('it arrived broken'), true);
  assert.equal(looksObviouslyUnhappy('all good thanks'), false);
});

// ── The two ambiguities a keyword list could never see ─────────────────────

test('"all good thanks" is acknowledged, not happy, and does not auto-send', async () => {
  // The owner's point, and he is right: "all good thanks" is two readings at
  // once. The order was fine and they would buy again, or they are politely
  // declining. A model is confidently right about the words and possibly wrong
  // about the person, and confidence cannot fix an ambiguity that is really in
  // the message. So it gets a human.
  const result = await triageReply({
    text: 'all good thanks',
    completion: modelJSON({ intent: 'acknowledged', confidence: 0.95, summary: 'non-committal', draft_reply: 'Thanks for letting me know.' })
  });
  assert.equal(result.intent, 'acknowledged');
  assert.equal(result.autoSendCode, false);
  assert.equal(result.needsHuman, true);
  assert.ok(result.draftReply, 'a person needs something to send');
});

test('a reply describing a bodily effect never auto-sends, however positive', async () => {
  const { mentionsBodilyEffect } = require('../lib/campaigns/reply-triage');
  for (const text of [
    'lost 10lbs already, amazing stuff',
    'my joints feel so much better',
    "it's really working for me",
    'so much more energy now'
  ]) {
    assert.equal(mentionsBodilyEffect(text), true, text);
    const result = await triageReply({
      text,
      completion: modelJSON({ intent: 'happy', confidence: 0.99, summary: 'positive', draft_reply: 'Thanks for getting back to me.' })
    });
    // A business that answers an efficacy testimonial with money is soliciting
    // more of them, and for a research-compound seller a file of
    // customer-reported effects reads as marketing for human use.
    assert.equal(result.autoSendCode, false, text);
    assert.equal(result.bodilyEffect, true, text);
    assert.ok(result.draftReply, 'held back but still needs an answer to send');
  }
});

test('praise about delivery or packaging still auto-sends', async () => {
  const { mentionsBodilyEffect } = require('../lib/campaigns/reply-triage');
  const text = 'arrived fast and packaging was perfect';
  assert.equal(mentionsBodilyEffect(text), false);
  const result = await triageReply({
    text, completion: modelJSON({ intent: 'happy', confidence: 0.95, summary: 'praised delivery', draft_reply: null })
  });
  assert.equal(result.autoSendCode, true);
});

test('the acknowledgement writer refuses anything that reaches past a clause', async () => {
  const { acknowledgementFor } = require('../lib/campaigns/reply-triage');
  // Each of these is the model doing more than it was asked. Falling back to
  // the fixed wording is worse copy and perfectly safe; splicing any of them
  // into the message is not.
  for (const bad of [
    'Here is 15% off your next order.',
    'Visit http://example.com for more.',
    'Reply STOP to opt out.',
    'Use {{code}} today.',
    'Glad to hear it. '.repeat(6)
  ]) {
    assert.equal(await acknowledgementFor({ text: 'hi', completion: model(bad) }), null, bad);
  }
  // And a plain clause is kept, with a full stop added.
  assert.equal(
    await acknowledgementFor({ text: 'hi', completion: model('Glad it turned up quickly') }),
    'Glad it turned up quickly.'
  );
});

test('an unreachable clause writer falls back rather than failing the send', async () => {
  const { acknowledgementFor } = require('../lib/campaigns/reply-triage');
  const result = await acknowledgementFor({
    text: 'great thanks', completion: async () => { throw new Error('down'); }
  });
  assert.equal(result, null, 'null means the caller uses the fixed wording');
});

test('the code message composes the clause in and validates the whole thing', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'check-in-reply.js'), 'utf8'
  );
  // The clause is spliced BEFORE validateCopy runs, so model-written text is
  // checked exactly like the rest rather than trusted.
  assert.ok(
    source.indexOf('acknowledgementFor(') < source.indexOf('validateCopy(outcome.text'),
    'the acknowledgement must be composed before the message is validated'
  );
  const { TEMPLATE, FALLBACK_ACKNOWLEDGEMENT, codeMessageTemplate } =
    require('../lib/campaigns/check-in-reply');
  const { validateCopy } = require('../lib/campaigns/copy-validator');
  const { RULES } = require('../lib/campaigns/copy-rules');
  const options = {
    brandName: RULES.brand.defaultName,
    approvedProductCodes: RULES.defaultApprovedProductCodes
  };

  // The clause is composed by a function, not a `{{acknowledgement}}`
  // placeholder. That placeholder is not a merge field and validateCopy rightly
  // refuses unknown ones, so the first version of this could never be validated
  // as written and failed its own compliance test.
  assert.equal(validateCopy(TEMPLATE, options).ok, true, 'the default message must be valid');
  assert.equal(
    validateCopy(codeMessageTemplate('Glad it turned up quickly.'), options).ok, true,
    'a composed message must be valid too'
  );
  // The commercial half must be identical whatever the clause says.
  for (const clause of [undefined, 'Glad it turned up quickly.', FALLBACK_ACKNOWLEDGEMENT]) {
    assert.match(codeMessageTemplate(clause), /\{\{code\}\} is 15% off your next order\. Reply STOP to opt out\.$/);
  }
  assert.ok(FALLBACK_ACKNOWLEDGEMENT.length > 0);
});
