'use strict';

/**
 * One privacy boundary for every OpenRouter request in Vici.
 *
 * Direct callers are intentionally not allowed to choose arbitrary routing:
 * every request is tokenised, restricted to approved models/providers, and
 * requires both Zero Data Retention and data-collection denial.
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const LEGACY_MODEL_ALIASES = new Map([
  ['anthropic/claude-3.5-haiku', DEFAULT_MODEL]
]);
const DEFAULT_PROVIDERS = ['amazon-bedrock', 'google-vertex'];

function csv(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : [...fallback];
}

function approvedModel(env = process.env) {
  const configured = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const model = LEGACY_MODEL_ALIASES.get(configured) || configured;
  const allowed = csv(env.OPENROUTER_ALLOWED_MODELS, [DEFAULT_MODEL]);
  if (!allowed.includes(model)) {
    throw new Error(`OpenRouter model is not approved: ${model}`);
  }
  return model;
}

function approvedProviders(env = process.env) {
  const providers = csv(env.OPENROUTER_ALLOWED_PROVIDERS, DEFAULT_PROVIDERS);
  if (!providers.length) throw new Error('No approved OpenRouter provider is configured');
  return providers;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createTokenizer(extraSensitiveValues = []) {
  const originals = new Map();
  const reverse = new Map();
  let next = 1;

  function tokenFor(raw) {
    const value = String(raw || '');
    if (!value) return value;
    if (reverse.has(value)) return reverse.get(value);
    const token = `[[PRIVATE_${next++}]]`;
    originals.set(token, value);
    reverse.set(value, token);
    return token;
  }

  const explicit = [...new Set(extraSensitiveValues
    .map(value => String(value || '').trim())
    .filter(value => value.length >= 3))]
    .sort((a, b) => b.length - a.length);

  function tokenise(input) {
    let text = String(input ?? '');
    for (const value of explicit) {
      text = text.replace(new RegExp(escapeRegExp(value), 'gi'), match => tokenFor(match));
    }

    // URLs first so access tokens, order IDs and query strings never leave the
    // app. Returned text can still reproduce the opaque token and be restored.
    text = text.replace(/https?:\/\/[^\s<>"']+/gi, match => tokenFor(match));
    text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, match => tokenFor(match));
    text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, match => tokenFor(match));
    text = text.replace(/(?:\+?\d[\d(). \t-]{7,}\d)/g, match => tokenFor(match));
    text = text.replace(
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\b/gi,
      match => tokenFor(match)
    );
    return text;
  }

  function restore(input) {
    let text = String(input ?? '');
    for (const [token, value] of originals) text = text.split(token).join(value);
    if (/\[\[PRIVATE_\d+\]\]/.test(text)) {
      throw new Error('OpenRouter response contained an unresolved private token');
    }
    return text;
  }

  return { tokenise, restore, tokenCount: () => originals.size };
}

/**
 * @param {object}   options
 * @param {Array}    options.messages
 * @param {Array}    [options.tools]      OpenAI-shape tool definitions. When
 *                                        given, the model may answer with tool
 *                                        calls instead of prose, and the result
 *                                        carries `toolCalls`.
 * @param {string|object} [options.toolChoice]
 */
async function privateCompletion({
  messages,
  tools,
  toolChoice,
  maxTokens,
  temperature,
  sensitiveValues = [],
  timeoutMs = 10_000,
  title = 'Vici Private AI',
  fetchImpl = global.fetch,
  env = process.env
}) {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('OpenRouter messages are required');

  const tokenizer = createTokenizer(sensitiveValues);
  const privateMessages = messages.map(message => ({
    ...message,
    // An assistant turn that only calls a tool has null content, and a tool
    // result turn carries its own fields. Tokenising null would stringify it
    // into the transcript as the word "null" and the model would answer about
    // it. Only real text is tokenised; everything else passes through.
    ...(typeof message.content === 'string'
      ? { content: tokenizer.tokenise(message.content) }
      : {})
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.APP_URL || 'https://vici-sms.railway.app',
        'X-Title': title
      },
      body: JSON.stringify({
        model: approvedModel(env),
        messages: privateMessages,
        max_tokens: maxTokens,
        temperature,
        // Omitted entirely when absent, so the request every existing caller
        // sends is byte-identical to what it was before tools existed.
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        provider: {
          only: approvedProviders(env),
          allow_fallbacks: true,
          require_parameters: true,
          zdr: true,
          data_collection: 'deny'
        }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    // A turn that only calls a tool legitimately has no prose, so empty content
    // is an answer rather than a failure. Without tools the old rule stands:
    // no text means the request produced nothing usable.
    if (!rawToolCalls.length && (typeof content !== 'string' || !content.trim())) {
      throw new Error('OpenRouter returned no completion');
    }

    // Arguments are restored before the caller sees them. A tokenised phone
    // number reaching a real query would look up a customer that does not
    // exist, and the failure would surface as "no such record" rather than as
    // a privacy layer doing its job.
    const toolCalls = rawToolCalls.map(call => ({
      id: call.id,
      name: call.function?.name,
      rawArguments: tokenizer.restore(call.function?.arguments || '{}')
    }));

    return {
      content: typeof content === 'string' ? tokenizer.restore(content).trim() : '',
      toolCalls,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      model: data.model || approvedModel(env),
      privateTokenCount: tokenizer.tokenCount()
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL,
  approvedModel,
  approvedProviders,
  createTokenizer,
  privateCompletion
};
