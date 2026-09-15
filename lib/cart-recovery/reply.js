'use strict';

const { privateCompletion } = require('../openrouter-private');

const CATEGORIES = Object.freeze([
  'payment_problem', 'shipping_cost', 'shipping_question', 'checkout_technical_problem',
  'discount_or_price', 'product_question', 'stock_or_availability', 'delivery_timing',
  'website_problem', 'changed_mind', 'needs_help', 'other', 'unknown'
]);

const MEDICAL = /\b(dose|dosage|inject|injection|side effect|reaction|rash|nausea|doctor|hospital|medical|health|pain|sick|unwell|human use|take it|taking it)\b/i;
const RULES = [
  ['payment_problem', /\b(card|payment|pay|declin(?:e|ed)|billing|apple pay|paypal|klarna|bank)\b/i],
  ['shipping_cost', /\b(shipping cost|postage cost|delivery cost|shipping fee|delivery fee)\b/i],
  ['delivery_timing', /\b(how long|when (?:will|would)|delivery time|arrive|arrival)\b/i],
  ['shipping_question', /\b(ship|shipping|delivery|deliver|postage|tracking)\b/i],
  ['stock_or_availability', /\b(stock|in stock|out of stock|available|availability)\b/i],
  ['product_question', /\b(product|item|size|quantity|vial)\b/i],
  ['discount_or_price', /\b(discount|coupon|promo|offer|cheaper|price|code)\b/i],
  ['changed_mind', /\b(not ready|later|next week|next month|changed my mind|don't need|do not need|just looking)\b/i],
  ['website_problem', /\b(site|website|page|link|button|screen)\b/i],
  ['checkout_technical_problem', /\b(checkout|check out|cart|error|wouldn't work|not working|stuck|crash|loading)\b/i],
  ['needs_help', /\b(help|can you assist|support)\b/i]
];

function deterministicCategory(text) {
  const value = String(text || '').trim();
  if (!value) return { category: 'unknown', confidence: 0, medical: false };
  if (MEDICAL.test(value)) return { category: 'needs_help', confidence: 1, medical: true };
  for (const [category, pattern] of RULES) {
    if (pattern.test(value)) return { category, confidence: 0.9, medical: false };
  }
  return { category: 'other', confidence: 0.35, medical: false };
}

function parseJSON(content) {
  const raw = String(content || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!CATEGORIES.includes(value.category)) return null;
    return {
      category: value.category,
      secondaryCategory: CATEGORIES.includes(value.secondary_category) && value.secondary_category !== value.category
        ? value.secondary_category : null,
      confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
      summary: String(value.summary || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      draft: typeof value.draft === 'string' ? value.draft.replace(/\s+/g, ' ').trim().slice(0, 500) : null
    };
  } catch { return null; }
}

function safeDraft(value) {
  const draft = String(value || '').replace(/\s+/g, ' ').trim();
  if (!draft || draft.length > 500) return null;
  if (/\b(dose|dosage|mg|mcg|inject|injection|take|taking|human use|side effect|diagnos|treat|cure|heal|safe|guarantee|doctor|medical advice)\b/i.test(draft)) return null;
  if (/\b(refund|replacement|will arrive|delivery date|Vici15|coupon|discount)\b/i.test(draft)) return null;
  return draft;
}

const PROMPT = `Classify a customer's reply to an abandoned checkout SMS for a US ecommerce store.
Return only JSON: {"category":"payment_problem|shipping_cost|shipping_question|checkout_technical_problem|discount_or_price|product_question|stock_or_availability|delivery_timing|website_problem|changed_mind|needs_help|other|unknown","secondary_category":null,"confidence":0.0,"summary":"short operational summary","draft":"short optional reply"}.
Never give medical, health, dosage or human-use advice. If the message raises any medical or safety issue use needs_help and set draft to null. Never invent stock, delivery, discount eligibility, order facts or a resolution. A person will review every draft before sending. Use plain US English and no emoji.`;

async function classifyRecoveryReply({ text, completion = privateCompletion, env = process.env } = {}) {
  const fallback = deterministicCategory(text);
  if (fallback.medical) return { ...fallback, summary: 'Medical or safety language needs human escalation.', draft: null, needsHuman: true };
  let parsed = null;
  try {
    const result = await completion({
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: String(text || '') }],
      maxTokens: 260, temperature: 0, timeoutMs: 8000, title: 'Vici abandoned cart reply triage', env
    });
    parsed = parseJSON(result?.content);
  } catch { parsed = null; }
  if (!parsed) {
    return { ...fallback, summary: fallback.category === 'other' ? 'Reply needs review.' : `Customer reported a ${fallback.category.replaceAll('_', ' ')}.`, draft: null, needsHuman: true };
  }
  if (MEDICAL.test(String(text || ''))) {
    return { category: 'needs_help', confidence: 1, summary: 'Medical or safety language needs human escalation.', draft: null, medical: true, needsHuman: true };
  }
  return { ...parsed, draft: safeDraft(parsed.draft), medical: false, needsHuman: true };
}

module.exports = { CATEGORIES, deterministicCategory, classifyRecoveryReply, parseJSON, safeDraft };
