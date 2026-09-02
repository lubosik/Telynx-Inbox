'use strict';
/**
 * test/contact-profile-narrative.test.js — the LLM half of a client profile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ACTUALLY AT RISK HERE
 *
 *   This file writes prose about a real person into a database, where it is
 *   kept, read by staff, and re-fed into later prompts. Three of its failure
 *   modes cost more than a wrong number on a screen:
 *
 *   1. INVENTED CONVERSATION. Of 809 contacts with any SMS, 559 have never
 *      sent an inbound message and 102 have sent exactly one. Point a model at
 *      those and it summarises our own outbound templates into a confident,
 *      fluent account of a conversation that did not happen — and the next
 *      thing to read it cannot tell the difference. The threshold and the
 *      substance gate are the whole defence, so most of this file is about
 *      what must NOT reach the model.
 *
 *   2. A STORED IDENTIFIER. This text is persisted and re-prompted, so a
 *      leaked phone number or order id does not leak once, it leaks every time
 *      the profile is read.
 *
 *   3. A STORED HEALTH CLAIM. This shop sells research peptides. A sentence
 *      saying a customer lost weight is a health claim in a database waiting
 *      for somebody to paste it into a message, and copy-rules.js bans that
 *      exact sentence on the way out. It must never get as far as being
 *      stored, which is why the check throws instead of sanitising.
 *
 *   And one that is not a safety failure but is the reason the feature exists:
 *
 *   4. A NARRATIVE THAT RESTATES A COLUMN. Order count, spend, products,
 *      dates and cadence are all stored exactly, in this same row. Prose about
 *      them is a lossy duplicate that will be trusted as independent evidence
 *      — the recurring production fault in this repository, bought this time
 *      at the price of a model call.
 *
 *   No test here makes a real model call. Every one injects a completion.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NARRATIVE_VERSION,
  NARRATIVE_COLUMNS,
  NARRATIVE_MAX_CHARS,
  NARRATIVE_TONES,
  NARRATIVE_TOPICS,
  NarrativeWriterError,
  SYSTEM_PROMPT,
  assertNarrativeSafe,
  buildNarrativeMessages,
  composeNarrative,
  isSubstantive,
  narrativeFingerprint,
  narrativeGate,
  narrativeSettings,
  parseNarrative,
  refreshNarratives,
  substantiveInboundCount
} = require('../lib/profiles/narrative-writer');
const { createDailyLedger, createLlmRunner } = require('../lib/llm-runner');
const { BODILY_EFFECT_MARKERS } = require('../lib/campaigns/reply-triage');

const NOW = new Date('2026-09-02T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE = '+15551110001';
const ON = { PROFILE_NARRATIVE_ENABLED: 'true' };
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

const MESSAGES_FINGERPRINT = `7:${daysAgo(2)}`;

let nextId = 1;
function message({ phone = PHONE, direction = 'inbound', body = 'is the shipping still slow this week', at = daysAgo(5) } = {}) {
  return { id: nextId++, contact_phone: phone, direction, body, created_at: at };
}
function order({ phone = PHONE, status = 'delivered', at = daysAgo(30), items = [{ sku: 'RT', name: 'RT - 10mg' }] } = {}) {
  return { id: nextId++, contact_phone: phone, status, created_at: at, items };
}

/** A profile row as the deterministic builder leaves it. */
function profileRow(overrides = {}) {
  return {
    contact_phone: PHONE,
    deterministic_built_at: daysAgo(1),
    messages_fingerprint: MESSAGES_FINGERPRINT,
    inbound_message_count: 4,
    narrative_summary: null,
    narrative_topics: [],
    narrative_tone: null,
    narrative_confidence: null,
    narrative_built_at: null,
    narrative_source_fingerprint: null,
    ...overrides
  };
}

/** Three real sentences: enough material for a narrative to be honest. */
function talkativeHistory() {
  return [
    message({ direction: 'outbound', body: 'It\'s Vici. Your order is on its way. Reply STOP to opt out.', at: daysAgo(20) }),
    message({ body: 'is there a way to get it here faster next time', at: daysAgo(19) }),
    message({ direction: 'outbound', body: 'It\'s Vici. Standard post is what we offer. Reply STOP to opt out.', at: daysAgo(18) }),
    message({ body: 'ok', at: daysAgo(18) }),
    message({ body: 'do you ever restock the larger size of the RT', at: daysAgo(10) }),
    message({ body: 'still waiting to hear about the larger size by the way', at: daysAgo(3) })
  ];
}

const GOOD_ANSWER = JSON.stringify({
  material: true,
  summary: 'Asked twice about a larger size and has had no answer either time. Also asked whether faster '
    + 'postage is possible and was told it is not. Writes in short unpunctuated lines and follows up '
    + 'himself rather than waiting.',
  topics: ['stock_availability', 'shipping'],
  tone: 'brief',
  confidence: 'high'
});

/** A runner whose completion is a stub. No network, no timers, no shared ledger. */
function stubRunner(behaviour, env = {}) {
  const calls = [];
  const completion = async (request) => {
    calls.push(request);
    const outcome = typeof behaviour === 'function' ? behaviour(calls.length, request) : behaviour;
    if (outcome instanceof Error) throw outcome;
    return { content: typeof outcome === 'string' ? outcome : GOOD_ANSWER, privateTokenCount: 0 };
  };
  // The caller's object is used, not a copy, so a test can flip a flag
  // mid-run the way an operator flips one in Railway.
  if (!env.LLM_MAX_ATTEMPTS) env.LLM_MAX_ATTEMPTS = '2';
  const runner = createLlmRunner({
    completion,
    env,
    now: () => NOW.getTime(),
    sleep: async () => {},
    ledger: createDailyLedger(),
    label: 'narrative-test'
  });
  runner.calls = calls;
  return runner;
}

// ── The gate: who never reaches the model ──────────────────────────────────

test('the feature is off unless the flag is the exact string true', () => {
  // The repository convention. An LLM feature that turned itself on because
  // somebody wrote "1" is a bill nobody authorised.
  for (const value of ['', '1', 'yes', 'TRUE', 'True', undefined]) {
    const gate = narrativeGate({ profile: profileRow(), now: NOW, env: { PROFILE_NARRATIVE_ENABLED: value } });
    assert.deepEqual(gate, { build: false, reason: 'disabled' }, `"${value}" must not enable it`);
  }
  assert.equal(narrativeGate({ profile: profileRow(), now: NOW, env: ON }).build, true);
});

test('a contact below the inbound threshold never reaches the model', () => {
  // The measured population this exists for: 559 contacts have zero inbound
  // messages and 102 have exactly one. For all of them the only text is our
  // own outbound templates, and a summary of those is fiction with a
  // confidence score attached.
  for (const inbound of [0, 1, 2]) {
    const gate = narrativeGate({ profile: profileRow({ inbound_message_count: inbound }), now: NOW, env: ON });
    assert.deepEqual(gate, { build: false, reason: 'below_threshold' }, `${inbound} inbound must be refused`);
  }
  // The boundary itself is included, not excluded.
  assert.equal(narrativeGate({ profile: profileRow({ inbound_message_count: 3 }), now: NOW, env: ON }).build, true);
});

test('the threshold is configurable and its default is 3', () => {
  assert.equal(narrativeSettings({}).minInbound, 3);
  const env = { ...ON, PROFILE_NARRATIVE_MIN_INBOUND: '5' };
  assert.equal(narrativeGate({ profile: profileRow({ inbound_message_count: 4 }), now: NOW, env }).reason, 'below_threshold');
  assert.equal(narrativeGate({ profile: profileRow({ inbound_message_count: 5 }), now: NOW, env }).build, true);

  // A blank value must fall back, not read as zero — zero would narrate all
  // 559 silent contacts, which is the exact outcome the threshold prevents.
  assert.equal(narrativeSettings({ PROFILE_NARRATIVE_MIN_INBOUND: '' }).minInbound, 3);
  assert.equal(narrativeSettings({ PROFILE_NARRATIVE_MIN_INBOUND: '0' }).minInbound, 1,
    'a floor of at least one inbound message is not negotiable');
});

test('a profile the deterministic builder has never touched is refused', () => {
  // analyseConversation() upserts on contact_phone and creates rows the
  // builder has never seen. With NOT NULL defaults those read as a real
  // silent, zero-order customer. deterministic_built_at is the only
  // discriminator, and the migration's partial indexes rely on the same fact.
  assert.equal(narrativeGate({
    profile: profileRow({ deterministic_built_at: null }), now: NOW, env: ON
  }).reason, 'not_built');
  assert.equal(narrativeGate({
    profile: profileRow({ messages_fingerprint: null }), now: NOW, env: ON
  }).reason, 'not_built');
});

test('an unchanged message fingerprint is skipped without a read or a call', () => {
  // The whole cost model. Without this, every sweep re-narrates every
  // qualifying contact at full price for no new information.
  const profile = profileRow({
    narrative_source_fingerprint: narrativeFingerprint(MESSAGES_FINGERPRINT),
    narrative_built_at: daysAgo(90)
  });
  assert.deepEqual(narrativeGate({ profile, now: NOW, env: ON }), { build: false, reason: 'unchanged' });
});

test('the version prefix invalidates every fingerprint at once', () => {
  // Changing the prompt or the threshold must reassess everybody. Storing the
  // raw messages_fingerprint would have meant an improvement applying only to
  // contacts who happened to text us afterwards — the same fault
  // profile_version exists to prevent on the deterministic half.
  assert.match(narrativeFingerprint(MESSAGES_FINGERPRINT), /^n\d+:/);
  const stale = profileRow({ narrative_source_fingerprint: MESSAGES_FINGERPRINT, narrative_built_at: daysAgo(90) });
  assert.equal(narrativeGate({ profile: stale, now: NOW, env: ON }).build, true,
    'a fingerprint without the version prefix is not current');
});

test('the cooldown caps rebuild cost, and does not delay a first narrative', () => {
  // The cooldown is the cost ceiling: changed messages alone are not enough.
  //
  // The stored prefix must be the CURRENT version, or this is accidentally
  // testing a rules change instead — which now outranks the cooldown. It was
  // hardcoded 'n1:' and started passing for the wrong reason the moment the
  // version moved to 2.
  const changed = { narrative_source_fingerprint: `n${NARRATIVE_VERSION}:stale` };
  assert.equal(narrativeGate({
    profile: profileRow({ ...changed, narrative_built_at: daysAgo(3) }), now: NOW, env: ON
  }).reason, 'cooldown');

  // Exactly at the boundary it is due, not held for another sweep.
  assert.equal(narrativeGate({
    profile: profileRow({ ...changed, narrative_built_at: daysAgo(7) }), now: NOW, env: ON
  }).build, true);

  // But somebody who has never had one is built now. Waiting a week to say
  // anything about a person who has been talking to us is not thrift.
  assert.equal(narrativeGate({
    profile: profileRow({ narrative_built_at: null }), now: NOW, env: ON
  }).build, true);

  const env = { ...ON, PROFILE_NARRATIVE_COOLDOWN_DAYS: '30' };
  assert.equal(narrativeGate({
    profile: profileRow({ ...changed, narrative_built_at: daysAgo(10) }), now: NOW, env
  }).reason, 'cooldown');
});

test('a rules change outranks the cooldown', () => {
  // The cooldown asks "has enough time passed to spend again under the same
  // rules". A version bump means the rules changed, so that is no longer the
  // question being asked.
  //
  // Found the hard way: version 1 stored "asked about product effects
  // (sleepiness)" — a health claim recorded as a conversation topic, which no
  // word list would have caught. The prompt was corrected, the version bumped,
  // and nothing rebuilt: the cooldown held every affected row for seven days.
  // A safety fix that cannot be applied for a week is not a fix, and the rows
  // carrying the problem are the ones a cooldown protects longest.
  const underOldRules = {
    narrative_source_fingerprint: `n${NARRATIVE_VERSION - 1}:whatever`,
    narrative_built_at: daysAgo(1)
  };
  assert.equal(narrativeGate({ profile: profileRow(underOldRules), now: NOW, env: ON }).build, true,
    'rebuilt immediately, not in a week');
});

// ── Substance: the second gate, and why counting is not enough ─────────────

test('three acknowledgements clear the count and are not material', () => {
  // "ok", "yes", "thanks" is what the live corpus holds at the low end. It
  // proves engagement — which engagement_tier already records exactly — and
  // contains no question, no unresolved thread and no manner of speaking.
  const yeses = [message({ body: 'ok' }), message({ body: 'Thanks!' }), message({ body: 'yes please' })];
  assert.equal(substantiveInboundCount(yeses), 0);

  for (const body of ['ok', 'OK.', 'thanks', 'Thank you', 'yep', 'got it', 'sounds good', 'k', '👍', '']) {
    assert.equal(isSubstantive(body), false, `"${body}" is an utterance, not a sentence`);
  }
});

test('a sentence is material, and outbound messages never count as one', () => {
  assert.equal(isSubstantive('do you ever restock the larger size'), true);
  assert.equal(isSubstantive('  when   will   it   ship  '), true, 'whitespace is normalised first');

  // Our own templates are the thing that must never be mistaken for the
  // customer talking. That mistake is precisely how the 559 would get
  // narratives.
  const ourOwnWords = [
    message({ direction: 'outbound', body: 'It\'s Vici. Your order is on its way. Reply STOP to opt out.' }),
    message({ direction: 'outbound', body: 'It\'s Vici. We restocked the size you asked about. Reply STOP to opt out.' })
  ];
  assert.equal(substantiveInboundCount(ourOwnWords), 0);
  assert.equal(substantiveInboundCount(talkativeHistory()), 3);
});

test('a contact who cleared the count but said nothing costs no model call', async () => {
  // The gate is on the profile row, the substance check is on the text, and
  // this is the case only the second one catches.
  const runner = stubRunner();
  const outcome = await composeNarrative({
    profile: profileRow(),
    messages: [message({ body: 'ok' }), message({ body: 'yes' }), message({ body: 'thanks' })],
    orders: [order()],
    run: runner.run,
    now: NOW
  });

  assert.equal(runner.calls.length, 0, 'no model call was made');
  assert.equal(outcome.called, false);
  assert.equal(outcome.reason, 'no_material');
  assert.equal(outcome.payload.narrative_summary, null);
  assert.equal(outcome.payload.narrative_confidence, 'none');
  assert.equal(outcome.payload.narrative_source_fingerprint, narrativeFingerprint(MESSAGES_FINGERPRINT),
    'the assessment is recorded, so the next sweep does not pay to rediscover it');
});

// ── The prompt ─────────────────────────────────────────────────────────────

test('the prompt tells the model exactly what it has and does not have', () => {
  // A model that is not told it lacks the order count will supply one, and it
  // will be plausible and wrong. Stating the absence is cheaper than checking
  // for every number afterwards.
  for (const absent of ['name', 'phone number', 'email', 'address', 'order numbers', 'order dates']) {
    assert.match(SYSTEM_PROMPT, new RegExp(absent, 'i'), `the prompt must say it has no ${absent}`);
  }
  assert.match(SYSTEM_PROMPT, /already stored exactly, in database columns/);
  assert.match(SYSTEM_PROMPT, /what they actually asked about/);
  assert.match(SYSTEM_PROMPT, /what was left unanswered or unresolved/);
  assert.match(SYSTEM_PROMPT, /invented conversation is the worst possible outcome/i);
});

test('the prompt bans the same health words the assertion checks for', () => {
  // One list, two uses. A generator working from a different list than the
  // checker produces narratives that are rejected after being paid for.
  for (const marker of BODILY_EFFECT_MARKERS) {
    assert.ok(SYSTEM_PROMPT.includes(marker), `"${marker}" must be named as banned in the prompt`);
  }
});

test('the prompt offers a closed vocabulary rather than free text', () => {
  // Free-text topics become a taxonomy nobody owns, and downstream code
  // branches on strings the model invented. A closed list also means a topic
  // cannot carry an identifier.
  for (const topic of NARRATIVE_TOPICS) assert.ok(SYSTEM_PROMPT.includes(topic));
  for (const tone of NARRATIVE_TONES) assert.ok(SYSTEM_PROMPT.includes(tone));
});

test('orders reach the prompt as product codes only — never as facts to restate', () => {
  // Orders are entirely queryable, so nothing about them may appear in the
  // output. They are in the prompt for one reason: so the model can tell what
  // "has mine shipped" refers to.
  const [, user] = buildNarrativeMessages({
    messages: talkativeHistory(),
    orders: [
      order({ items: [{ sku: 'RT', name: 'RT - 10mg' }], at: daysAgo(30) }),
      order({ items: [{ sku: 'GLP3', name: 'GLP3-Ret - 30mg' }], at: daysAgo(120) }),
      order({ status: 'cancelled', items: [{ sku: 'NEVERPAID' }] })
    ]
  });

  assert.match(user.content, /RT/);
  assert.match(user.content, /GLP3/);
  assert.match(user.content, /never mention them/);
  assert.equal(user.content.includes('NEVERPAID'), false, 'a cancelled order is not a purchase');
  // No dates, no totals, no order ids anywhere in the product context line.
  const productLine = user.content.split('\n')[0];
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(productLine), false, 'no dates');
  assert.equal(/\$|total/i.test(productLine), false, 'no money');
});

test('the transcript is labelled by speaker and truncated from the oldest end', () => {
  // What somebody asked last week is what is still unresolved. A two-year-old
  // exchange about a delivery that arrived is not what this note is for — and
  // an unbounded transcript is an unbounded prompt bill.
  const many = Array.from({ length: 60 }, (_, i) =>
    message({ body: `question about the delivery window marker-${i}`, at: daysAgo(60 - i) }));
  const [, user] = buildNarrativeMessages({ messages: many, orders: [] });

  const lines = user.content.split('\n').filter(line => line.startsWith('Customer:') || line.startsWith('Shop:'));
  assert.equal(lines.length, 40, 'the newest 40 only');
  assert.equal(/marker-0$/m.test(user.content), false, 'the oldest message is dropped');
  assert.match(user.content, /marker-59$/m, 'the newest is kept');

  const [, mixed] = buildNarrativeMessages({ messages: talkativeHistory(), orders: [] });
  assert.match(mixed.content, /^Customer: is there a way to get it here faster next time$/m);
  assert.match(mixed.content, /^Shop: It's Vici\./m);

  // A single enormous message cannot blow the prompt open either.
  const [, huge] = buildNarrativeMessages({ messages: [message({ body: 'x'.repeat(5000) })], orders: [] });
  assert.equal(huge.content.includes('x'.repeat(281)), false, 'each message is clipped');
});

// ── Parsing ────────────────────────────────────────────────────────────────

test('a topic outside the closed list is dropped, not stored and not thrown over', () => {
  // A hallucinated topic is noise, not a leak. Losing a whole paid-for
  // narrative because the model invented one extra word would be the more
  // expensive mistake.
  const parsed = parseNarrative(JSON.stringify({
    material: true, summary: 'x', topics: ['shipping', 'vibes', 'SHIPPING', 'complaint'], tone: 'brief', confidence: 'high'
  }));
  assert.deepEqual(parsed.topics, ['shipping', 'complaint']);
});

test('an unknown tone reads as unclear rather than being stored verbatim', () => {
  // A tone column with free-text values in it is a column nothing can select on.
  assert.equal(parseNarrative('{"tone":"enthusiastic","summary":"x"}').tone, 'unclear');
  assert.equal(parseNarrative('{"tone":"IMPATIENT","summary":"x"}').tone, 'impatient');
});

test('JSON wrapped in prose or a code fence is still read', () => {
  const wrapped = 'Sure, here you go:\n```json\n{"material":true,"summary":"they asked twice","tone":"brief"}\n```';
  assert.equal(parseNarrative(wrapped).summary, 'they asked twice');
  for (const junk of ['', 'no json here', '{not json', null]) {
    assert.equal(parseNarrative(junk), null, `"${junk}" must not parse`);
  }
});

// ── Assertion (a): identifiers ─────────────────────────────────────────────

test('an identifier shape is never stored', () => {
  // This text is persisted AND re-fed into later prompts, so a leak compounds
  // every time the profile is read.
  const leaks = [
    ['a phone number', 'Asked us to call him on +1 555 111 0001 instead of texting.'],
    ['an email', 'Wants the answer sent to dave.smith@example.com rather than by text.'],
    ['a street address', 'Asked whether we deliver to 44 Bridge Street on a Saturday.'],
    ['an order number', 'Chasing order 100482941 and has had no answer.'],
    ['a bare year', 'Has been asking about the larger size since 2024.'],
    ['an unresolved private token', 'Asked [[PRIVATE_3]] about the larger size.']
  ];
  for (const [what, text] of leaks) {
    assert.throws(() => assertNarrativeSafe(text), (error) => {
      assert.ok(error instanceof NarrativeWriterError);
      assert.equal(error.code, 'NARRATIVE_UNSAFE');
      return true;
    }, `${what} must be refused`);
  }
});

test('a rejection names the failed checks and never repeats the offending text', () => {
  // copy-writer.js's discipline: the rejected text is never shown, only the
  // check ids. Logging the leak to prove the leak happened is still writing it
  // somewhere it is kept.
  try {
    assertNarrativeSafe('Chasing order 100482941 for dave@example.com.');
    assert.fail('should have thrown');
  } catch (error) {
    // A nine-digit order number is caught by more than one shape, and every
    // one of them is reported: an operator debugging a rejection needs to know
    // which rules fired, not just that one did.
    assert.ok(error.failedChecks.includes('email'));
    assert.ok(error.failedChecks.includes('long_number'));
    assert.equal(error.message.includes('100482941'), false, 'the leak must not be in the message');
    assert.equal(error.message.includes('dave@example.com'), false);
  }
});

test('a name is caught even though it has no shape', () => {
  // The one identifier no regex can find. The only way to catch it is to know
  // it, so sms_contacts is read and the known name is asserted out.
  assert.throws(() => assertNarrativeSafe('Dave asked twice about the larger size.', { names: ['Dave'] }),
    (error) => error.failedChecks.includes('customer_name'));
  // Word boundaries, so an unlucky substring is not a false positive.
  assert.doesNotThrow(() => assertNarrativeSafe('Asked about the standard package.', { names: ['Dave', 'Stan'] }));
  // Two characters is not a name, it is a substring of half the dictionary.
  assert.doesNotThrow(() => assertNarrativeSafe('Asked about the larger size.', { names: ['Jo'] }));
});

test('an ordinary narrative passes every check', () => {
  // The guard has to let the good case through or the feature is decorative.
  assert.equal(assertNarrativeSafe(
    'Asked twice about a larger size and has had no answer either time. Writes in short '
    + 'unpunctuated lines and follows up himself rather than waiting. Turned down faster postage on price.'
  ), true);
});

// ── Assertion (b): health claims ───────────────────────────────────────────

test('a customer-stated health outcome is never stored, in either direction', () => {
  // The single most dangerous sentence this feature could produce. A stored
  // claim that somebody lost weight is a health claim in a database, waiting
  // for a human to paste it into a message — and copy-rules.js bans exactly
  // that sentence on the way out.
  const claims = [
    'Says he has lost a lot since starting and wants to keep going.',
    'Reports better sleep and more energy since the second order.',
    'Mentioned his appetite changed and asked whether that was normal.',
    'Told us it works well for him.'
  ];
  for (const text of claims) {
    assert.throws(() => assertNarrativeSafe(text), (error) => {
      assert.ok(error.failedChecks.includes('health_claim'), `"${text}" must fail the health check`);
      return true;
    });
  }
});

test('the health check is reply-triage\'s list, not a second copy of it', () => {
  // Two lists of banned health words drift apart, and the weaker one wins.
  // This asserts the shared list is genuinely load-bearing here: every marker
  // in it must be refused.
  for (const marker of BODILY_EFFECT_MARKERS) {
    assert.throws(() => assertNarrativeSafe(`Mentioned ${marker} in passing while asking about postage.`),
      (error) => error.failedChecks.includes('health_claim'),
      `"${marker}" is in BODILY_EFFECT_MARKERS and must be refused`);
  }
});

// ── Composition ────────────────────────────────────────────────────────────

test('a narrative that leaks is thrown away, not trimmed or stored', async () => {
  const runner = stubRunner(JSON.stringify({
    material: true,
    summary: 'Chasing order 100482941 about the larger size and has had no reply from us at all yet today.',
    topics: ['order_status'], tone: 'impatient', confidence: 'high'
  }));

  await assert.rejects(
    () => composeNarrative({ profile: profileRow(), messages: talkativeHistory(), orders: [order()], run: runner.run, now: NOW }),
    (error) => error.code === 'NARRATIVE_UNSAFE'
  );
});

test('an over-long summary is rejected rather than truncated', async () => {
  // Cutting at 400 characters stores a sentence that stops mid-clause, and a
  // half-sentence about a customer is read as though it were whole.
  const runner = stubRunner(JSON.stringify({
    material: true,
    summary: `Asked about the larger size. ${'and asked again about postage. '.repeat(20)}`,
    topics: [], tone: 'chatty', confidence: 'low'
  }));

  await assert.rejects(
    () => composeNarrative({ profile: profileRow(), messages: talkativeHistory(), orders: [], run: runner.run, now: NOW }),
    (error) => {
      assert.equal(error.code, 'NARRATIVE_TOO_LONG');
      assert.match(error.message, new RegExp(String(NARRATIVE_MAX_CHARS)));
      return true;
    }
  );
});

test('an unparseable answer fails once and is never retried', async () => {
  // The rule the whole runner exists to hold. The same prompt produces the
  // same unparseable answer; a retry buys nothing and costs the same again.
  const runner = stubRunner('I am afraid I cannot help with that.', { LLM_MAX_ATTEMPTS: '2' });
  await assert.rejects(
    () => composeNarrative({ profile: profileRow(), messages: talkativeHistory(), orders: [], run: runner.run, now: NOW }),
    (error) => error.code === 'NARRATIVE_UNPARSEABLE'
  );
  assert.equal(runner.calls.length, 1, 'a deterministic failure must cost exactly one call');
});

test('the model saying there is nothing to say is recorded, not treated as a failure', async () => {
  // The escape hatch that keeps the model from inventing. It must be cheaper
  // to say "nothing here" than to make something up, and the outcome has to be
  // stored or we pay to ask again next sweep.
  const runner = stubRunner(JSON.stringify({ material: false, summary: '', topics: [], tone: 'brief', confidence: 'low' }));
  const outcome = await composeNarrative({
    profile: profileRow(), messages: talkativeHistory(), orders: [], run: runner.run, now: NOW
  });

  assert.equal(outcome.reason, 'no_material');
  assert.equal(outcome.payload.narrative_summary, null);
  assert.equal(outcome.payload.narrative_confidence, 'none');
  assert.equal(outcome.payload.narrative_built_at, NOW.toISOString());
});

test('a summary too thin to be worth keeping is recorded as no material', async () => {
  const runner = stubRunner(JSON.stringify({ material: true, summary: 'Asked a thing.', topics: [], tone: 'brief', confidence: 'low' }));
  const outcome = await composeNarrative({
    profile: profileRow(), messages: talkativeHistory(), orders: [], run: runner.run, now: NOW
  });
  assert.equal(outcome.reason, 'summary_too_thin');
  assert.equal(outcome.payload.narrative_summary, null);
});

test('high confidence is capped by the evidence, not taken from the model', async () => {
  // One sentence is not enough to be sure how somebody communicates, whatever
  // the model claims. An overclaimed narrative is what gets believed over a
  // column.
  const thin = [
    message({ body: 'do you ever restock the larger size of the RT' }),
    message({ body: 'ok' }),
    message({ body: 'thanks' })
  ];
  const runner = stubRunner(GOOD_ANSWER);
  const capped = await composeNarrative({ profile: profileRow(), messages: thin, orders: [], run: runner.run, now: NOW });
  assert.equal(capped.payload.narrative_confidence, 'low', 'one substantive message cannot support "high"');

  const full = await composeNarrative({
    profile: profileRow(), messages: talkativeHistory(), orders: [], run: stubRunner(GOOD_ANSWER).run, now: NOW
  });
  assert.equal(full.payload.narrative_confidence, 'high');
});

test('the payload carries the six narrative columns and nothing else', async () => {
  // The sole-writer rule, at the payload level. A stray deterministic column
  // here would be a second writer for it, and the emptiest writer eventually
  // wins — this repository has shipped a 15% coupon on a 20% promise that way.
  const outcome = await composeNarrative({
    profile: profileRow(), messages: talkativeHistory(), orders: [order()], run: stubRunner(GOOD_ANSWER).run, now: NOW
  });
  assert.deepEqual(Object.keys(outcome.payload).sort(), [...NARRATIVE_COLUMNS].sort());
  assert.deepEqual(outcome.payload.narrative_topics, ['stock_availability', 'shipping']);
  assert.equal(outcome.payload.narrative_tone, 'brief');
});

test('composeNarrative refuses to run without a budgeted runner', async () => {
  // No default. A default would be an unbudgeted, unretried, unlimited call
  // that nobody chose to make.
  await assert.rejects(
    () => composeNarrative({ profile: profileRow(), messages: talkativeHistory(), orders: [], now: NOW }),
    (error) => error.code === 'NARRATIVE_NO_RUNNER'
  );
});

// ── refreshNarratives, against a fake Supabase ─────────────────────────────

function fakeClient({ tables = {}, updateError = null } = {}) {
  const updates = [];
  const requests = [];
  const compare = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));

  return {
    updates,
    requests,
    from(table) {
      const state = { filters: [], orders: [], range: null, update: null, eq: null };
      const chain = {
        select() { return chain; },
        range(from, to) { state.range = [from, to]; return chain; },
        gte(column, value) { state.filters.push(row => Number(row?.[column]) >= Number(value)); return chain; },
        eq(column, value) {
          state.eq = [column, value];
          state.filters.push(row => row?.[column] === value);
          return chain;
        },
        in(column, values) {
          const set = new Set(values);
          state.filters.push(row => set.has(row?.[column]));
          return chain;
        },
        order(column, options = {}) {
          state.orders.push({ column, ascending: options.ascending !== false });
          return chain;
        },
        update(payload) { state.update = payload; return chain; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (state.update) {
              updates.push({ table, payload: state.update, where: state.eq });
              if (updateError) return { data: null, error: { message: updateError } };
              for (const row of tables[table] || []) {
                if (state.filters.every(match => match(row))) Object.assign(row, state.update);
              }
              return { data: null, error: null };
            }
            requests.push({ table, range: state.range });
            let rows = (tables[table] || []).filter(row => state.filters.every(match => match(row)));
            for (const sort of [...state.orders].reverse()) {
              rows = rows.slice().sort((a, b) => compare(a[sort.column], b[sort.column]) * (sort.ascending ? 1 : -1));
            }
            const [from, to] = state.range || [0, rows.length - 1];
            return { data: rows.slice(from, to + 1), error: null };
          }).then(resolve, reject);
        }
      };
      return chain;
    }
  };
}

function world(overrides = {}) {
  return {
    sms_customer_profiles: [profileRow(overrides)],
    sms_messages: talkativeHistory(),
    sms_orders: [order()],
    sms_contacts: [{ phone: PHONE, name: 'Dave Smith', first_name: 'Dave', last_name: 'Smith' }]
  };
}

test('the whole pass is inert while the flag is off — no reads, no calls, no writes', async () => {
  // "Off" has to mean off at the top, not off at the last moment. A disabled
  // feature that still pages three tables is a disabled feature with a bill.
  const client = fakeClient({ tables: world() });
  const runner = stubRunner();
  const summary = await refreshNarratives({ client, runner, now: NOW, env: {} });

  assert.equal(summary.enabled, false);
  assert.equal(summary.reason, 'disabled');
  assert.equal(client.requests.length, 0);
  assert.equal(client.updates.length, 0);
  assert.equal(runner.calls.length, 0);
});

test('a full pass writes only the narrative columns, on the right row', async () => {
  // The sole-writer rule at the write level, and UPDATE rather than upsert: an
  // upsert on a contact with no profile row invents one that reads as a real
  // silent zero-order customer, which is exactly what the engagement_tier
  // index is built to find.
  const tables = world();
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER);

  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON });

  assert.equal(summary.written, 1);
  assert.equal(summary.failed.length, 0);
  assert.equal(client.updates.length, 1);
  const [write] = client.updates;
  assert.equal(write.table, 'sms_customer_profiles');
  assert.deepEqual(write.where, ['contact_phone', PHONE]);
  assert.deepEqual(Object.keys(write.payload).sort(), [...NARRATIVE_COLUMNS].sort(),
    'no deterministic column and no legacy column may appear in this payload');
});

test('running twice writes once — the second pass finds the fingerprint current', async () => {
  // Idempotence is the cost model, not a nicety. Without it a nightly sweep
  // re-narrates every qualifying contact at full price, forever.
  const tables = world();
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER);

  await refreshNarratives({ client, runner, now: NOW, env: ON });
  const second = await refreshNarratives({ client, runner, now: NOW, env: ON });

  assert.equal(second.written, 0);
  assert.equal(second.eligible, 0);
  assert.equal(second.skipped.unchanged, 1);
  assert.equal(runner.calls.length, 1, 'the model is called once across both passes');
  assert.equal(client.updates.length, 1);
});

test('contacts below the threshold are counted as skipped and never read for text', async () => {
  const tables = {
    ...world(),
    sms_customer_profiles: [
      profileRow({ contact_phone: '+15551110002', inbound_message_count: 0 }),
      profileRow({ contact_phone: '+15551110003', inbound_message_count: 1 }),
      profileRow()
    ]
  };
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER);
  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON });

  // The candidate read filters at the database with .gte(), so the two below
  // the threshold never even come back.
  assert.equal(summary.considered, 1);
  assert.equal(summary.eligible, 1);
  assert.equal(runner.calls.length, 1);
});

test('an unsafe narrative is recorded as a failure, with check ids and no write', async () => {
  // A leak must stay visible. Marking the contact assessed would hide it, and
  // the next run would never look again.
  const tables = world();
  const client = fakeClient({ tables });
  const runner = stubRunner(JSON.stringify({
    material: true,
    summary: 'Dave asked twice about the larger size and has still had no answer from anybody here.',
    topics: ['stock_availability'], tone: 'brief', confidence: 'low'
  }));

  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON });

  assert.equal(summary.written, 0);
  assert.equal(client.updates.length, 0, 'nothing is stored');
  assert.equal(summary.failed.length, 1);
  assert.deepEqual(summary.failed[0].failedChecks, ['customer_name']);
  assert.equal(summary.failed[0].error.includes('Dave asked twice'), false, 'the text never leaves the writer');
  assert.equal(tables.sms_customer_profiles[0].narrative_source_fingerprint, null,
    'the contact stays unassessed, so the failure is retried and stays visible');
});

test('a spent budget stops the run cleanly instead of failing every remaining contact', async () => {
  // Otherwise a ceiling reached at contact 3 produces 147 identical "budget
  // spent" failures and buries whatever else went wrong.
  const tables = {
    ...world(),
    sms_customer_profiles: Array.from({ length: 5 }, (_, i) => profileRow({ contact_phone: `+1555111000${i}` })),
    sms_messages: Array.from({ length: 5 }, (_, i) => talkativeHistory()
      .map(row => ({ ...row, contact_phone: `+1555111000${i}` }))).flat()
  };
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER, { LLM_RUN_CALL_BUDGET: '2', LLM_MAX_CONCURRENCY: '1' });

  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON });

  assert.equal(summary.stopped, true);
  assert.equal(summary.reason, 'run_budget_exhausted');
  assert.equal(summary.written, 2);
  assert.equal(summary.failed.length, 0, 'a budget ceiling is not a failure');
  assert.equal(runner.calls.length, 2);
});

test('the kill switch stops a pass already in flight', async () => {
  const tables = {
    ...world(),
    sms_customer_profiles: Array.from({ length: 3 }, (_, i) => profileRow({ contact_phone: `+1555111000${i}` })),
    sms_messages: Array.from({ length: 3 }, (_, i) => talkativeHistory()
      .map(row => ({ ...row, contact_phone: `+1555111000${i}` }))).flat()
  };
  const client = fakeClient({ tables });
  // The stub shares the env object the runner reads, so flipping it after the
  // first call is the same thing an operator does in Railway mid-sweep.
  const env = { LLM_MAX_CONCURRENCY: '1', LLM_KILL_SWITCH: '' };
  const flipping = stubRunner(() => { env.LLM_KILL_SWITCH = 'true'; return GOOD_ANSWER; }, env);

  const summary = await refreshNarratives({ client, runner: flipping, now: NOW, env: ON });
  assert.equal(summary.stopped, true);
  assert.equal(summary.reason, 'kill_switch');
  assert.equal(summary.written, 1, 'the call already made is kept; nothing further is attempted');
  assert.equal(flipping.calls.length, 1, 'the remaining two contacts are never sent');
});

test('dryRun reports the gate decisions and spends nothing', async () => {
  // An operator has to be able to ask "who would this narrate, and how much
  // would it cost" without it costing that.
  const tables = world();
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER);

  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON, dryRun: true });
  assert.equal(summary.reason, 'dry_run');
  assert.equal(summary.eligible, 1);
  assert.equal(runner.calls.length, 0);
  assert.equal(client.updates.length, 0);
});

test('a missing migration says which file to run', async () => {
  // Without this the sweep logs `column narrative_summary does not exist` once
  // a night forever and nobody connects it to an unapplied migration.
  const client = fakeClient({ tables: world(), updateError: 'column "narrative_summary" does not exist' });
  const summary = await refreshNarratives({ client, runner: stubRunner(GOOD_ANSWER), now: NOW, env: ON });

  assert.equal(summary.reason, 'columns_missing');
  assert.match(summary.failed[0].error, /contact-profiles-narrative-migration\.sql/);
});

test('a contact with no messages at all produces no call and no invented story', async () => {
  // The 559. If the gate and the substance check ever both fail open, this is
  // the test that notices before the model writes 559 confident paragraphs
  // about conversations that never happened.
  const tables = { ...world(), sms_messages: [] };
  const client = fakeClient({ tables });
  const runner = stubRunner(GOOD_ANSWER);

  const summary = await refreshNarratives({ client, runner, now: NOW, env: ON });
  assert.equal(runner.calls.length, 0);
  assert.equal(summary.written, 0);
  assert.equal(summary.noMaterial, 1);
  assert.equal(tables.sms_customer_profiles[0].narrative_summary, null);
});
