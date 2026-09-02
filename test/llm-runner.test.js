'use strict';
/**
 * test/llm-runner.test.js — the operational shell around the privacy boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ACTUALLY AT RISK HERE
 *
 *   `privateCompletion` has no retry, no backoff, no concurrency limit, no
 *   budget and no kill switch. Every one of those absences is a way for a
 *   background sweep to spend real money in a loop nobody is watching, or to
 *   hammer a rate-limited provider until it starts refusing the request paths
 *   that customers are waiting on.
 *
 *   Four specific failures are guarded below, each of which is cheap to write
 *   and expensive to discover in production:
 *
 *   1. RETRYING A DETERMINISTIC FAILURE. A prompt that produced unparseable
 *      JSON produces unparseable JSON the second time too. Retrying it does
 *      not fix anything and halves the budget. The retry rule is therefore
 *      transport-only — 429, 5xx, abort — and there is no flag a caller can
 *      pass to widen it.
 *
 *   2. A CONCURRENCY LIMIT THAT LEAKS. The obvious semaphore — decrement, then
 *      wake a waiter — lets a newcomer take the freed slot before the waiter
 *      resumes, so the count goes past the limit. With a limit of 2 against a
 *      provider that rate-limits at 2, that is the whole point of the limit.
 *
 *   3. A BUDGET THAT COUNTS REQUESTS INSTEAD OF CALLS. A retry costs exactly
 *      as much as a first try. A budget that only counted logical requests
 *      would be understated by up to the attempt limit.
 *
 *   4. A BLANK ENV VAR READING AS ZERO. `Number('')` is 0, which is finite. An
 *      operator who cleared LLM_RUN_CALL_BUDGET would silently disable the
 *      feature while every log line said "over budget" — cost.js carries the
 *      same note about SMS_COST_PER_SEGMENT_USD, for the same reason.
 *
 *   No test here makes a real network call. `completion` is injected in every
 *   one, and `sleep` is injected so the backoff is asserted rather than slept.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKOFF_MS,
  DEFAULTS,
  LlmRunnerError,
  createDailyLedger,
  createLlmRunner,
  createSemaphore,
  isRetryable,
  limitsFrom,
  positiveInt,
  statusOf
} = require('../lib/llm-runner');

const NOW = new Date('2026-09-02T09:00:00Z').getTime();

/** A completion that never touches the network. */
function fakeCompletion(behaviour) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const outcome = typeof behaviour === 'function' ? behaviour(calls.length, request) : behaviour;
    if (outcome instanceof Error) throw outcome;
    return outcome || { content: 'ok', privateTokenCount: 0 };
  };
  fn.calls = calls;
  return fn;
}

function httpError(status) {
  return new Error(`OpenRouter request failed (${status})`);
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** A runner with everything injected: no clock, no timer, no shared ledger. */
function runner(env = {}, { completion, slept = [], now = () => NOW, ledger } = {}) {
  return createLlmRunner({
    completion: completion || fakeCompletion(),
    env,
    now,
    sleep: async (ms) => { slept.push(ms); },
    ledger: ledger || createDailyLedger(),
    label: 'test'
  });
}

// ── Settings ───────────────────────────────────────────────────────────────

test('a blank or nonsensical setting falls back rather than reading as zero', () => {
  // Number('') is 0 and 0 is finite. A budget that read as zero would refuse
  // every call while the feature looked configured.
  for (const blank of ['', '   ', undefined, null, 'lots', '-4', '0']) {
    const limits = limitsFrom({
      LLM_MAX_CONCURRENCY: blank,
      LLM_MAX_ATTEMPTS: blank,
      LLM_RUN_CALL_BUDGET: blank,
      LLM_DAILY_CALL_BUDGET: blank
    });
    assert.deepEqual(limits, {
      concurrency: DEFAULTS.concurrency,
      attempts: DEFAULTS.attempts,
      runCallBudget: DEFAULTS.runCallBudget,
      dailyCallBudget: DEFAULTS.dailyCallBudget
    }, `"${blank}" must fall back to the defaults`);
  }
  assert.equal(positiveInt('7', 2), 7);
  assert.equal(positiveInt('7.9', 2), 7, 'truncated, not rounded — a budget is a count');
});

test('the kill switch is the exact string true and nothing else', async () => {
  // This repository's flag convention. 'TRUE', '1' and 'yes' are somebody
  // guessing, and a kill switch that quietly did not engage is worse than none.
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
    const completion = fakeCompletion();
    await runner({ LLM_KILL_SWITCH: value }, { completion }).run({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(completion.calls.length, 1, `"${value}" must not engage the kill switch`);
  }

  const completion = fakeCompletion();
  await assert.rejects(
    () => runner({ LLM_KILL_SWITCH: 'true' }, { completion }).run({ messages: [] }),
    (error) => error instanceof LlmRunnerError && error.code === 'LLM_KILL_SWITCH'
  );
  assert.equal(completion.calls.length, 0, 'the kill switch must refuse BEFORE the provider is called');
});

test('the kill switch is read at call time, not at construction', async () => {
  // A switch that only took effect on the next deploy is not a kill switch.
  // Railway restarts on an env change, but a runner held across a long sweep
  // must not cache the answer either.
  const env = { LLM_KILL_SWITCH: '' };
  const completion = fakeCompletion();
  const llm = runner(env, { completion });

  await llm.run({ messages: [] });
  env.LLM_KILL_SWITCH = 'true';
  await assert.rejects(() => llm.run({ messages: [] }), (e) => e.code === 'LLM_KILL_SWITCH');
  assert.equal(completion.calls.length, 1);
});

// ── Retry ──────────────────────────────────────────────────────────────────

test('retries only on 429, 5xx and abort — the transport failures', () => {
  for (const error of [httpError(429), httpError(500), httpError(502), httpError(503), abortError()]) {
    assert.equal(isRetryable(error), true, `${error.message} must be retryable`);
  }
  // A DOMException-shaped abort, which is what Node's fetch actually throws.
  assert.equal(isRetryable(Object.assign(new Error('This operation was aborted'), { name: 'Error' })), true);
});

test('never retries a validation, parse or configuration failure', () => {
  // The rule that matters. Each of these is deterministic: the second attempt
  // produces the identical failure and the only thing that changed is the
  // budget. There is deliberately no way for a caller to override this.
  const deterministic = [
    new Error('The model did not answer with usable JSON.'),
    new Error('OpenRouter returned no completion'),
    new Error('OpenRouter response contained an unresolved private token'),
    new Error('OPENROUTER_API_KEY is not configured'),
    new Error('OpenRouter model is not approved: some/model'),
    httpError(400),
    httpError(401),
    httpError(404)
  ];
  for (const error of deterministic) {
    assert.equal(isRetryable(error), false, `${error.message} must NOT be retried`);
  }
  assert.equal(isRetryable(null), false);
});

test('an explicit error.status beats the message shape', () => {
  // The message parse is coupled to the exact string privateCompletion throws.
  // An injected completion should be able to say what it means instead of
  // imitating that string.
  assert.equal(statusOf(Object.assign(new Error('nope'), { status: 503 })), 503);
  assert.equal(statusOf(httpError(429)), 429);
  assert.equal(statusOf(new Error('no status here')), null);
  assert.equal(isRetryable(Object.assign(new Error('nope'), { status: 503 })), true);
});

test('a retried call backs off 500ms then 1500ms and succeeds on the second attempt', async () => {
  const slept = [];
  const completion = fakeCompletion((n) => (n === 1 ? httpError(429) : { content: 'second time' }));
  const llm = runner({ LLM_MAX_ATTEMPTS: '2' }, { completion, slept });

  const result = await llm.run({ messages: [] });
  assert.equal(result.content, 'second time');
  assert.deepEqual(slept, [BACKOFF_MS[0]], 'exactly one backoff, at 500ms');

  const stats = llm.stats();
  assert.equal(stats.calls, 2, 'both attempts are billable and both are counted');
  assert.equal(stats.requests, 1, 'one logical request');
  assert.equal(stats.retries, 1);
});

test('the backoff schedule holds at its last value rather than running off the end', async () => {
  const slept = [];
  const completion = fakeCompletion(() => httpError(500));
  const llm = runner({ LLM_MAX_ATTEMPTS: '4' }, { completion, slept });

  await assert.rejects(() => llm.run({ messages: [] }), (e) => e.code === 'LLM_CALL_FAILED');
  assert.deepEqual(slept, [500, 1500, 1500], 'three sleeps for four attempts, holding at 1500');
});

test('a deterministic failure costs exactly one call, not two', async () => {
  // The failure this whole retry rule exists to prevent.
  const completion = fakeCompletion(() => new Error('The model did not answer with usable JSON.'));
  const llm = runner({ LLM_MAX_ATTEMPTS: '2' }, { completion });

  await assert.rejects(() => llm.run({ messages: [] }), (error) => {
    assert.equal(error.code, 'LLM_CALL_FAILED');
    assert.equal(error.retryable, false);
    assert.match(error.message, /usable JSON/, 'the original failure survives the wrapping');
    return true;
  });
  assert.equal(completion.calls.length, 1, 'a parse failure must never be attempted twice');
});

test('the original error is kept as the cause, so a failure can still be diagnosed', async () => {
  const cause = httpError(500);
  const llm = runner({ LLM_MAX_ATTEMPTS: '1' }, { completion: fakeCompletion(() => cause) });
  await assert.rejects(() => llm.run({ messages: [] }), (error) => {
    assert.equal(error.cause, cause);
    assert.equal(error.status, 500);
    return true;
  });
});

// ── Concurrency ────────────────────────────────────────────────────────────

test('the semaphore never exceeds its limit, including across a release', async () => {
  // The leak this guards: freeing a slot and then waking a waiter lets a
  // newcomer take the slot first, so the woken waiter pushes the count over.
  const semaphore = createSemaphore(2);
  let active = 0;
  let peak = 0;

  const work = async () => {
    await semaphore.acquire();
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    semaphore.release();
  };

  await Promise.all(Array.from({ length: 12 }, work));
  assert.equal(peak, 2, `at most 2 in flight, saw ${peak}`);
  assert.equal(semaphore.active, 0, 'every slot is returned');
  assert.equal(semaphore.queued, 0);
});

test('concurrency is honoured across real runner calls', async () => {
  let inFlight = 0;
  let peak = 0;
  const completion = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
    return { content: 'ok' };
  };
  const llm = runner({ LLM_MAX_CONCURRENCY: '2' }, { completion });

  await Promise.all(Array.from({ length: 8 }, () => llm.run({ messages: [] })));
  assert.equal(peak, 2);
  assert.equal(llm.stats().calls, 8);
});

test('a failing call still returns its slot', async () => {
  // A leaked slot deadlocks the next sweep rather than failing it, which is
  // the sort of outage that looks like "the job just stopped running".
  const llm = runner({ LLM_MAX_CONCURRENCY: '1', LLM_MAX_ATTEMPTS: '1' },
    { completion: fakeCompletion(() => httpError(400)) });

  await assert.rejects(() => llm.run({ messages: [] }));
  assert.deepEqual(llm.inFlight(), { active: 0, queued: 0 });
});

// ── Budgets ────────────────────────────────────────────────────────────────

test('the per-run budget counts attempts, because a retry costs the same as a first try', async () => {
  const completion = fakeCompletion(() => httpError(429));
  const llm = runner({ LLM_RUN_CALL_BUDGET: '3', LLM_MAX_ATTEMPTS: '2' }, { completion });

  // Two attempts, budget now 2 of 3.
  await assert.rejects(() => llm.run({ messages: [] }), (e) => e.code === 'LLM_CALL_FAILED');
  assert.equal(llm.stats().calls, 2);

  // One attempt left: the retry is refused by the budget, not by the rule.
  await assert.rejects(() => llm.run({ messages: [] }), (error) => {
    assert.equal(error.code, 'LLM_RUN_BUDGET_EXHAUSTED');
    return true;
  });
  assert.equal(completion.calls.length, 3, 'the provider is called exactly three times');
  assert.equal(llm.stats().runCallsRemaining, 0);
});

test('an exhausted budget mid-retry still carries the transport failure as its cause', async () => {
  // Otherwise a run that hit its ceiling while the provider was down reports
  // only "budget spent" and the outage is invisible.
  const cause = httpError(503);
  const llm = runner({ LLM_RUN_CALL_BUDGET: '1', LLM_MAX_ATTEMPTS: '2' },
    { completion: fakeCompletion(() => cause) });

  await assert.rejects(() => llm.run({ messages: [] }), (error) => {
    assert.equal(error.code, 'LLM_RUN_BUDGET_EXHAUSTED');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('the daily budget is shared between runners and refuses before the provider is called', async () => {
  const ledger = createDailyLedger();
  const completion = fakeCompletion();
  const env = { LLM_DAILY_CALL_BUDGET: '2', LLM_MAX_ATTEMPTS: '1' };

  const first = runner(env, { completion, ledger });
  const second = runner(env, { completion, ledger });

  await first.run({ messages: [] });
  await second.run({ messages: [] });
  await assert.rejects(() => first.run({ messages: [] }), (e) => e.code === 'LLM_DAILY_BUDGET_EXHAUSTED');

  assert.equal(completion.calls.length, 2, 'a refused call never reaches the provider');
  assert.equal(second.stats().dailyCallsUsed, 2, 'both runners see one count');
});

test('the daily budget resets on the UTC day boundary and not before', async () => {
  // The boundary is UTC so a sweep straddling midnight London time does not
  // reset in summer and hold in winter — the same run behaving differently in
  // March and October is the kind of bug nobody reproduces.
  const ledger = createDailyLedger();
  let clock = Date.parse('2026-09-02T23:59:00Z');
  const completion = fakeCompletion();
  const llm = createLlmRunner({
    completion,
    env: { LLM_DAILY_CALL_BUDGET: '1', LLM_MAX_ATTEMPTS: '1' },
    now: () => clock,
    sleep: async () => {},
    ledger
  });

  await llm.run({ messages: [] });
  await assert.rejects(() => llm.run({ messages: [] }), (e) => e.code === 'LLM_DAILY_BUDGET_EXHAUSTED');

  clock = Date.parse('2026-09-03T00:00:01Z');
  await llm.run({ messages: [] });
  assert.equal(completion.calls.length, 2);
});

test('the run budget is per runner, so one run cannot spend another run\'s allowance', async () => {
  const ledger = createDailyLedger();
  const env = { LLM_RUN_CALL_BUDGET: '1', LLM_MAX_ATTEMPTS: '1' };
  const completion = fakeCompletion();

  const first = runner(env, { completion, ledger });
  await first.run({ messages: [] });
  await assert.rejects(() => first.run({ messages: [] }), (e) => e.code === 'LLM_RUN_BUDGET_EXHAUSTED');

  // A fresh runner is a fresh run, and starts with a fresh allowance.
  const second = runner(env, { completion, ledger });
  await second.run({ messages: [] });
  assert.equal(completion.calls.length, 2);
  assert.equal(second.stats().calls, 1, 'the new run does not inherit the old run\'s spend');
});

// ── The boundary stays the boundary ────────────────────────────────────────

test('the request is passed through untouched, and env is forwarded', async () => {
  // This file must not become a second place where prompts are edited or
  // routing is decided. It adds `env` (so the boundary reads the configuration
  // the budget was computed from) and changes nothing else.
  const completion = fakeCompletion();
  const env = { OPENROUTER_MODEL: 'anthropic/claude-haiku-4.5' };
  const request = {
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 400,
    temperature: 0.2,
    timeoutMs: 20_000,
    title: 'Vici client narrative',
    sensitiveValues: ['Dave']
  };

  await runner(env, { completion }).run(request);
  const sent = completion.calls[0];
  for (const [key, value] of Object.entries(request)) {
    assert.deepEqual(sent[key], value, `${key} must reach the boundary unchanged`);
  }
  assert.equal(sent.env, env);
  assert.equal('model' in sent, false, 'the runner must never name a model — approvedModel() owns that');
});

test('a caller may still override env, so a test never reads the real process env', async () => {
  const completion = fakeCompletion();
  const override = { OPENROUTER_API_KEY: 'x' };
  await runner({}, { completion }).run({ messages: [], env: override });
  assert.equal(completion.calls[0].env, override);
});

test('stats report what is measurable and do not invent a token count', async () => {
  // privateCompletion does not return OpenRouter's `usage`, and this file will
  // not start parsing response bodies behind the boundary's back. What it can
  // count honestly is calls and REDACTED values — named so nobody reads them
  // as cost.
  const completion = fakeCompletion(() => ({ content: 'ok', privateTokenCount: 3 }));
  const llm = runner({ LLM_RUN_CALL_BUDGET: '10' }, { completion });
  await llm.run({ messages: [] });
  await llm.run({ messages: [] });

  const stats = llm.stats();
  assert.equal(stats.privateTokensRedacted, 6);
  assert.equal(stats.succeeded, 2);
  assert.equal(stats.failed, 0);
  assert.equal(stats.refused, 0);
  assert.equal(stats.runCallsRemaining, 8);
  assert.equal('tokensIn' in stats, false, 'no invented cost figures');
});
