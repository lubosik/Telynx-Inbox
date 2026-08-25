'use strict';
/**
 * lib/campaigns/copy-writer.js — the drafter.
 *
 * The language model is mocked completely. Nothing in this file makes a
 * network request, and one test asserts that: the real `privateCompletion` is
 * never reached, because a test that quietly hits OpenRouter is a test that
 * fails in CI for the wrong reason and costs money for no reason.
 *
 * The properties under test are the ones that matter if the model misbehaves:
 * the flag is off by default, no customer identity can reach the prompt, the
 * rules reach the prompt verbatim, and nothing that fails validation is
 * surfaced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RULES, renderPromptRules } = require('../lib/campaigns/copy-rules');

// The sender's name is a BUSINESS DECISION and it has already changed once,
// from "Vici" to "Vin from Vici". Fixtures that hardcode it turn every one of
// these tests into a test of the current name, so 30 of them failed on a
// two-word copy change that broke nothing. Read it from the rules instead: the
// name can change again and only the rule file needs editing.
const { RULES: COPY_RULES } = require('../lib/campaigns/copy-rules');
const BRAND = COPY_RULES.brand.defaultName;

const {
  CopyDraftError,
  SUPPORTED_WORKFLOWS,
  aiCopyEnabled,
  assertNoCustomerIdentity,
  buildSystemPrompt,
  cadencePhrase,
  draftCandidates,
  parseCandidates
} = require('../lib/campaigns/copy-writer');

const OPT_OUT = RULES.optOut.exactSuffix;
const ENABLED = { CAMPAIGN_AI_COPY_ENABLED: 'true' };

const GOOD_DRAFTS = [
  `${BRAND}: your product is back in stock. Reply if you would like help. ${OPT_OUT}`,
  `${BRAND}: we have restocked your product. Reply here for a hand. ${OPT_OUT}`,
  `${BRAND}: your product is available again. Reply if you want a hand. ${OPT_OUT}`
];

/** A model stub that records what it was asked and returns what it is told. */
function stubModel(reply, record = {}) {
  return async input => {
    record.calls = (record.calls || 0) + 1;
    record.messages = input.messages;
    record.system = input.messages[0].content;
    record.user = input.messages[1].content;
    record.sensitiveValues = input.sensitiveValues;
    record.title = input.title;
    if (typeof reply === 'function') return reply(input);
    return { content: JSON.stringify(reply), model: 'anthropic/claude-haiku-4.5' };
  };
}

function draft(input, reply, record = {}, env = ENABLED) {
  return draftCandidates(input, { completion: stubModel(reply, record), env });
}

// ── The feature flag ───────────────────────────────────────────────────────

test('the flag is off unless it is exactly the string true', () => {
  assert.equal(aiCopyEnabled({}), false);
  assert.equal(aiCopyEnabled({ CAMPAIGN_AI_COPY_ENABLED: 'false' }), false);
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '']) {
    assert.equal(aiCopyEnabled({ CAMPAIGN_AI_COPY_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.equal(aiCopyEnabled({ CAMPAIGN_AI_COPY_ENABLED: 'true' }), true);
});

test('with the flag off, nothing is drafted and the model is never called', async () => {
  const record = {};
  await assert.rejects(
    draft({ workflowType: 'winback' }, GOOD_DRAFTS, record, { CAMPAIGN_AI_COPY_ENABLED: 'false' }),
    error => error instanceof CopyDraftError && error.code === 'CAMPAIGN_AI_COPY_DISABLED' && error.status === 503
  );
  assert.equal(record.calls, undefined, 'the model must not be reached with the flag off');
});

test('the flag reads exactly like the other campaign brakes, and is documented', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'lib/campaigns/copy-writer.js'), 'utf8');
  assert.match(source, /env\.CAMPAIGN_AI_COPY_ENABLED === 'true'/);
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^CAMPAIGN_AI_COPY_ENABLED=false$/m);
});

// ── No customer identity, by construction ──────────────────────────────────

test('identifier-shaped input is refused before the model is called', async () => {
  const attempts = [
    { workflowType: 'winback', brief: 'follow up with sarah at sarah@example.com' },
    { workflowType: 'winback', brief: 'call her on +1 561 555 0100' },
    { workflowType: 'winback', brief: 'about order #10482' },
    { workflowType: 'winback', brief: 'she is at 120 Ocean Drive' },
    { workflowType: 'winback', brief: 'she spent $940 with us' },
    { workflowType: 'winback', brief: 'send them to https://example.com/x' },
    { workflowType: 'winback', brief: 'greet {{first_name}} warmly' },
    { workflowType: 'back_in_stock', productName: 'peptide 12345678' }
  ];
  for (const attempt of attempts) {
    const record = {};
    await assert.rejects(
      draft(attempt, GOOD_DRAFTS, record),
      error => error instanceof CopyDraftError &&
        ['CAMPAIGN_AI_COPY_PII_REJECTED', 'CAMPAIGN_AI_COPY_INPUT_REJECTED'].includes(error.code),
      JSON.stringify(attempt)
    );
    assert.equal(record.calls, undefined, `the model was called for ${JSON.stringify(attempt)}`);
  }
});

test('assertNoCustomerIdentity names the field and the shape it found', () => {
  assert.throws(
    () => assertNoCustomerIdentity('brief', 'mail sam@example.com'),
    error => error.code === 'CAMPAIGN_AI_COPY_PII_REJECTED' && /brief/.test(error.message) && /email/.test(error.message)
  );
  assert.doesNotThrow(() => assertNoCustomerIdentity('brief', 'a plain reorder check-in'));
});

test('unknown input keys are rejected rather than ignored', async () => {
  const record = {};
  await assert.rejects(
    draft({ workflowType: 'winback', recipientPhone: '+15615550100' }, GOOD_DRAFTS, record),
    error => error.code === 'CAMPAIGN_AI_COPY_INPUT_REJECTED' && /recipientPhone/.test(error.message)
  );
  assert.equal(record.calls, undefined);
});

test('cadence is a bounded integer, never free text', () => {
  assert.equal(cadencePhrase(undefined), null);
  assert.match(cadencePhrase({ value: 8, unit: 'weeks' }), /about 8 weeks ago/);
  // The phrase also tells the model not to repeat it back.
  assert.match(cadencePhrase({ value: 8, unit: 'weeks' }), /Do not state it/);

  // A string is refused for BEING a string, not incidentally because it has
  // no .value. Free text is the field a caller would put a customer's name in,
  // so the type guard is asserted on its own message.
  assert.throws(
    () => cadencePhrase('eight weeks since sarah ordered'),
    error => /must be an object with value and unit/.test(error.message)
  );

  for (const bad of [
    'eight weeks since sarah ordered',
    { value: 8, unit: 'fortnights' },
    { value: 0, unit: 'weeks' },
    { value: 999, unit: 'weeks' },
    { value: 1.5, unit: 'weeks' },
    { value: 8, unit: 'weeks', note: 'sarah' },
    ['8', 'weeks']
  ]) {
    assert.throws(() => cadencePhrase(bad), error => error.code === 'CAMPAIGN_AI_COPY_INPUT_REJECTED', JSON.stringify(bad));
  }
});

test('no customer identity appears anywhere in the transmitted prompt', async () => {
  const record = {};
  await draft(
    { workflowType: 'reorder', productName: 'Recovery Blend', cadence: { value: 8, unit: 'weeks' } },
    GOOD_DRAFTS, record
  );
  // The user prompt is everything campaign-specific, so it must be clean of
  // every identifier shape.
  // '{{' is no longer forbidden and must not be: the prompt names the four
  // variables so the model knows which exist. That is the OPPOSITE of leaking
  // an identity, it is the mechanism for never sending one. What must stay
  // absent is a real name, address, number or amount.
  for (const forbidden of ['@', 'http', '+1', 'Sarah', 'order #', '$']) {
    assert.equal(record.user.includes(forbidden), false, `user prompt contained ${forbidden}`);
  }
  // The system prompt legitimately contains "S@ve" because rule 17 names it as
  // an example of a violation, so the sweep across both messages is narrower.
  const transmitted = JSON.stringify(record.messages);
  for (const forbidden of ['http', 'Sarah', 'order #']) {
    assert.equal(transmitted.includes(forbidden), false, `prompt contained ${forbidden}`);
  }
  // And nothing had to be tokenised, which is the point: the boundary in
  // openrouter-private.js is the second defence, not the first.
  assert.deepEqual(record.sensitiveValues, []);
});

// ── The rules reach the model verbatim ─────────────────────────────────────

test('the system prompt embeds the rule sentences unaltered', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(renderPromptRules()), 'the rendered rule block is not present verbatim');
  for (const rule of RULES.promptRules) {
    assert.ok(prompt.includes(rule), `rule missing from the prompt: ${rule}`);
  }
});

test('the prompt does not restate a rule in different words', () => {
  // Every sentence of the prompt is either framing, or a rule taken verbatim
  // from RULES.promptRules. Nothing in the framing is imperative about copy,
  // because a second, friendlier statement of a rule is how a rule loosens.
  const prompt = buildSystemPrompt();
  const ruleBlock = renderPromptRules();
  const framing = prompt.replace(ruleBlock, '').toLowerCase();
  for (const forbidden of ['avoid ', 'try not to', 'generally', 'where possible', 'ideally', 'prefer not']) {
    assert.equal(framing.includes(forbidden), false, `framing hedges a rule with "${forbidden}"`);
  }
});

test('copy-writer never rebuilds the rules out of its own strings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/campaigns/copy-writer.js'), 'utf8');
  assert.match(source, /renderPromptRules\(\)/);
  // The banned lists must exist in exactly one place. A second copy here, even
  // a well-meant "extra safety" one, is a copy that will fall out of step with
  // the doc. Checking for quoted literals rather than for the substring lets
  // the module refer to `bannedTerms` as data while never restating its
  // contents.
  const duplicated = [];
  for (const group of Object.values(RULES.bannedTerms)) {
    for (const term of group.terms) {
      if (source.includes(`'${term}'`) || source.includes(`"${term}"`)) duplicated.push(term);
    }
  }
  assert.deepEqual(duplicated, [], 'these banned terms are hardcoded in copy-writer.js as well as the rule set');
});

// ── Candidates, plural ─────────────────────────────────────────────────────

test('several candidates are returned so a human chooses', async () => {
  const result = await draft({ workflowType: 'back_in_stock', productName: 'Recovery Blend' }, GOOD_DRAFTS);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.returned, 3);
  assert.equal(result.copyStatus, 'human_review_required');
  assert.ok(result.reviewRequirements.includes('verify_promotional_consent_scope'));
  for (const candidate of result.candidates) {
    assert.equal(typeof candidate.text, 'string');
    assert.ok(candidate.septets > 0 && candidate.septets <= 160);
  }
});

test('the requested candidate count is clamped to a sane range', async () => {
  for (const [asked, expected] of [[1, 2], [4, 4], [5, 5], [50, 5], [undefined, 4]]) {
    const record = {};
    await draft({ workflowType: 'winback', candidateCount: asked }, GOOD_DRAFTS, record);
    assert.match(record.user, new RegExp(`Write ${expected} different candidate messages`), `asked ${asked}`);
  }
});

test('duplicate drafts collapse rather than pretending to be a choice', async () => {
  const result = await draft({ workflowType: 'winback' }, [GOOD_DRAFTS[0], GOOD_DRAFTS[0], GOOD_DRAFTS[1]]);
  assert.equal(result.candidates.length, 2);
});

// ── Validation is not optional ─────────────────────────────────────────────

test('a draft that fails validation is never surfaced as a candidate', async () => {
  const model = [
    GOOD_DRAFTS[0],
    `${BRAND}: Fr33 shipping, guaranteed results! ${OPT_OUT}`,
    `Vici — only 3 left, act now. ${OPT_OUT}`,
    'Hello, buy now at https://bit.ly/x'
  ];
  const result = await draft({ workflowType: 'winback' }, model);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].text, GOOD_DRAFTS[0]);
  assert.equal(result.rejected.length, 3);
});

test('the text of a rejected draft never leaves the drafter', async () => {
  // A reviewer must not be able to lift a rejected draft out of a response.
  const poison = `${BRAND}: Fr33 guaranteed cure, act now! ${OPT_OUT}`;
  const result = await draft({ workflowType: 'winback' }, [GOOD_DRAFTS[0], poison]);
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('Fr33'), false);
  assert.equal(serialised.includes('guaranteed cure'), false);
  // Not even a fragment: the per-instance reasons quote the offending token,
  // so what is reported is the check's own description instead.
  assert.equal(serialised.includes('mixes letters with'), false);
  for (const entry of result.rejected) {
    assert.equal(entry.text, undefined);
    assert.ok(Array.isArray(entry.failedChecks) && entry.failedChecks.length > 0);
    assert.ok(entry.reasons.every(reason => typeof reason === 'string' && reason.length > 10));
    // Everything reported is a constant from the rule set, never draft text.
    const titles = new Set(RULES.checks.map(check => check.title));
    for (const reason of entry.reasons) assert.ok(titles.has(reason), reason);
    const banned = new Set(Object.values(RULES.bannedTerms).flatMap(group => group.terms));
    for (const term of entry.bannedTerms) assert.ok(banned.has(term), term);
  }
  assert.ok(
    result.rejected.some(entry => entry.bannedTerms.length > 0),
    'a rejection for a banned term should still name the rule constant it matched'
  );
});

test('when every draft fails, zero candidates are returned rather than the least bad one', async () => {
  const result = await draft({ workflowType: 'winback' }, [
    `${BRAND}: Fr33 stuff! ${OPT_OUT}`,
    'Buy now at https://bit.ly/x'
  ]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.returned, 0);
  assert.equal(result.rejected.length, 2);
});

test('validation is not skippable by injecting a permissive validator through the public API', async () => {
  // draftCandidates takes its validator from a second, internal argument. The
  // route calls it with one argument, so a request body cannot reach it.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/campaigns.js'), 'utf8');
  const call = source.match(/await drafter\(([^)]*)\)/);
  assert.ok(call, 'the route must call the drafter');
  assert.equal(call[1].trim(), 'input', 'the route must pass only the request input');
});

// ── Model failure modes ────────────────────────────────────────────────────

test('a model that returns prose instead of JSON yields no candidates', async () => {
  const result = await draft({ workflowType: 'winback' }, async () => ({
    content: 'Sure! Here are some ideas:\n1. Hey there\n2. Come back',
    model: 'anthropic/claude-haiku-4.5'
  }));
  assert.deepEqual(result.candidates, []);
});

test('a fenced JSON array is still parsed', () => {
  assert.deepEqual(parseCandidates('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseCandidates('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseCandidates('not json'), []);
  assert.deepEqual(parseCandidates('{"a":1}'), []);
  assert.deepEqual(parseCandidates('["a", 5, null, "  ", "b"]'), ['a', 'b']);
  assert.deepEqual(parseCandidates(undefined), []);
});

test('a model error becomes a clean 503 and never a partial result', async () => {
  await assert.rejects(
    draftCandidates({ workflowType: 'winback' }, {
      env: ENABLED,
      completion: async () => { throw new Error('OpenRouter request failed (429)'); }
    }),
    error => error instanceof CopyDraftError && error.code === 'CAMPAIGN_AI_COPY_UNAVAILABLE' && error.status === 503
  );
});

test('a provider error message is not leaked to the caller', async () => {
  try {
    await draftCandidates({ workflowType: 'winback' }, {
      env: ENABLED,
      completion: async () => { throw new Error('Bearer sk-or-v1-secret rejected'); }
    });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.message.includes('sk-or-v1'), false);
    assert.equal(error.message.includes('Bearer'), false);
  }
});

// ── Workflow and input surface ─────────────────────────────────────────────

test('only the reviewed workflow types are drafted for', async () => {
  for (const workflowType of Object.keys(SUPPORTED_WORKFLOWS)) {
    const input = { workflowType };
    if (workflowType.startsWith('back_in_stock') || workflowType.startsWith('reorder')) {
      input.productName = 'Recovery Blend';
    }
    const result = await draft(input, GOOD_DRAFTS);
    assert.ok(result.candidates.length > 0, workflowType);
  }
  await assert.rejects(
    draft({ workflowType: 'flash_sale' }, GOOD_DRAFTS),
    error => error.code === 'CAMPAIGN_AI_COPY_WORKFLOW_UNSUPPORTED'
  );
  await assert.rejects(
    draft({}, GOOD_DRAFTS),
    error => error.code === 'CAMPAIGN_AI_COPY_WORKFLOW_UNSUPPORTED'
  );
});

test('a product name must be a short plain catalogue label', async () => {
  // The charset guard is separate from the identifier guard, and needs its own
  // cases: a mutation run showed that removing it changed nothing, because
  // every test case happened to be caught by the PII check instead.
  for (const productName of [
    'Recovery [Blend]',
    'Recovery <Blend>',
    'Recovery Blend \u2014 new',
    'Recovery Blend \ud83d\ude00',
    'Recovery; DROP TABLE',
    'Recovery "Blend"',
    'x'.repeat(80)
  ]) {
    const record = {};
    await assert.rejects(
      draft({ workflowType: 'back_in_stock', productName }, GOOD_DRAFTS, record),
      error => error.code === 'CAMPAIGN_AI_COPY_INPUT_REJECTED',
      JSON.stringify(productName)
    );
    assert.equal(record.calls, undefined, `the model saw ${JSON.stringify(productName)}`);
  }

  // Ordinary catalogue labels still work.
  for (const productName of ['Recovery Blend', 'BPC-157', 'Blend 2.0', 'Blend (10 pack)']) {
    const result = await draft({ workflowType: 'back_in_stock', productName }, GOOD_DRAFTS);
    assert.ok(result.candidates.length > 0, productName);
  }
});

test('a product workflow without a product name is refused', async () => {
  for (const workflowType of ['back_in_stock', 'reorder_personal_high']) {
    await assert.rejects(
      draft({ workflowType }, GOOD_DRAFTS),
      error => error.code === 'CAMPAIGN_AI_COPY_INPUT_REJECTED'
    );
  }
  // winback and manual legitimately have no product.
  await draft({ workflowType: 'winback' }, GOOD_DRAFTS);
});

test('a link must pass the destination rule before it is offered to the model', async () => {
  const record = {};
  await assert.rejects(
    draft({ workflowType: 'winback', linkUrl: 'https://bit.ly/x' }, GOOD_DRAFTS, record),
    error => error.code === 'CAMPAIGN_AI_COPY_LINK_REJECTED' && /shortener/.test(error.message)
  );
  assert.equal(record.calls, undefined);

  const accepted = {};
  await draft({ workflowType: 'winback', linkUrl: 'https://vicipeptides.com/shop' }, GOOD_DRAFTS, accepted);
  assert.match(accepted.user, /include it exactly once/);
});

test('with no approved link the model is told there is no link', async () => {
  const record = {};
  await draft({ workflowType: 'winback' }, GOOD_DRAFTS, record);
  assert.match(record.user, /Do not include any link or web address/);
});

// ── The privacy boundary ───────────────────────────────────────────────────

test('the drafter reaches OpenRouter only through the shared private boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/campaigns/copy-writer.js'), 'utf8');
  assert.match(source, /require\('\.\.\/openrouter-private'\)/);
  assert.doesNotMatch(source, /openrouter\.ai\/api/);
  assert.doesNotMatch(source, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});

test('no test in this file can reach the network', async () => {
  // Belt and braces: run the drafter with global fetch removed. If anything
  // bypassed the injected completion, this throws instead of dialling out.
  const realFetch = global.fetch;
  global.fetch = () => { throw new Error('network access from a unit test'); };
  try {
    const result = await draft({ workflowType: 'winback' }, GOOD_DRAFTS);
    assert.equal(result.candidates.length, 3);
  } finally {
    global.fetch = realFetch;
  }
});
