'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  approvedModel,
  createTokenizer,
  privateCompletion
} = require('../lib/openrouter-private');

test('legacy model configuration moves to the reviewed current model', () => {
  assert.equal(
    approvedModel({ OPENROUTER_MODEL: 'anthropic/claude-3.5-haiku' }),
    'anthropic/claude-haiku-4.5'
  );
});

test('private OpenRouter requests enforce routing policy and reversible PII tokenisation', async () => {
  let captured;
  const fetchImpl = async (_url, options) => {
    captured = JSON.parse(options.body);
    const privateToken = captured.messages[0].content.match(/\[\[PRIVATE_\d+\]\]/)?.[0];
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: `Reply to ${privateToken}` } }] })
    };
  };
  const env = {
    OPENROUTER_API_KEY: 'test-only',
    OPENROUTER_MODEL: 'anthropic/claude-3.5-haiku',
    OPENROUTER_ALLOWED_PROVIDERS: 'amazon-bedrock,google-vertex'
  };
  const completion = await privateCompletion({
    messages: [{ role: 'user', content: 'Contact Sam at sam@example.com or +1 (561) 555-0100.' }],
    sensitiveValues: ['Sam'],
    maxTokens: 50,
    temperature: 0,
    fetchImpl,
    env
  });

  const transmitted = JSON.stringify(captured.messages);
  assert.equal(transmitted.includes('sam@example.com'), false);
  assert.equal(transmitted.includes('561'), false);
  assert.equal(transmitted.includes('Sam'), false);
  assert.equal(completion.content, 'Reply to Sam');
  assert.equal(captured.model, 'anthropic/claude-haiku-4.5');
  assert.deepEqual(captured.provider.only, ['amazon-bedrock', 'google-vertex']);
  assert.equal(captured.provider.zdr, true);
  assert.equal(captured.provider.data_collection, 'deny');
  assert.equal(captured.provider.require_parameters, true);
});

test('tokenizer removes private URLs and restores unchanged placeholders', () => {
  const tokenizer = createTokenizer();
  const privateText = tokenizer.tokenise('Track: https://example.test/order?id=secret');
  assert.equal(privateText.includes('secret'), false);
  assert.equal(tokenizer.restore(privateText), 'Track: https://example.test/order?id=secret');
});

test('an unapproved model fails closed before any provider request', async () => {
  let called = false;
  await assert.rejects(privateCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 10,
    temperature: 0,
    fetchImpl: async () => { called = true; },
    env: {
      OPENROUTER_API_KEY: 'test-only',
      OPENROUTER_MODEL: 'unapproved/model',
      OPENROUTER_ALLOWED_MODELS: 'anthropic/claude-haiku-4.5'
    }
  }), /not approved/);
  assert.equal(called, false);
});

test('all production AI callers use the central privacy boundary', () => {
  for (const relative of ['intelligence.js', 'flows/confirmed.js', 'flows/shipped.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.match(source, /privateCompletion/);
    assert.doesNotMatch(source, /openrouter\.ai\/api/);
    assert.doesNotMatch(source, /Authorization[^\n]+OPENROUTER_API_KEY/);
  }
});
