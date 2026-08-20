'use strict';

const { normalisePhone } = require('../phone');
const CLASSIFIER_VERSION = 'local-privacy-v1';

const VERY_NEGATIVE = [
  /\b(?:scam|fraud|chargeback|unacceptable|disgusting|worst)\b/i,
  /\bwhere (?:the hell|tf|the fuck)\b/i,
  /\b(?:never buying|report(?:ing)? you)\b/i
];
const NEGATIVE = [
  /\b(?:angry|upset|frustrated|disappointed|annoyed|terrible|awful)\b/i,
  /\b(?:problem|issue|wrong|missing|damaged|broken|failed|late|delayed)\b/i,
  /\b(?:not arrived|never arrived|have not received|haven't received|did not receive|didn't receive)\b/i,
  /\b(?:refund|cancel my order)\b/i,
  /\bwhere (?:is|are) my\b/i
];
const VERY_POSITIVE = [
  /\b(?:thank you|thanks) so much\b/i,
  /\b(?:absolutely )?(?:amazing|incredible|perfect|fantastic)\b/i,
  /\b(?:love it|love you guys|best service)\b/i
];
const POSITIVE = [
  /\b(?:thank you|thanks|appreciate|awesome|great|excellent|happy|excited|helpful)\b/i,
  /\b(?:sounds good|that works|got it)\b/i,
  /(?:❤️|❤|😊|😍|🙌|🔥)/u
];
const TAPBACK = /^(?:loved|liked|disliked|laughed at|emphasized|questioned|removed (?:a )?heart from)\b/i;

function matchCount(patterns, value) {
  return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
}

function classifyLocalSentiment(body) {
  const text = String(body || '').trim().slice(0, 1000);
  if (!text) return { eligible: false, reason: 'empty' };
  if (TAPBACK.test(text)) return { eligible: false, reason: 'tapback' };

  const veryNegative = matchCount(VERY_NEGATIVE, text);
  const negative = matchCount(NEGATIVE, text);
  const veryPositive = matchCount(VERY_POSITIVE, text);
  const positive = matchCount(POSITIVE, text);
  const negativeEvidence = veryNegative + negative;
  const positiveEvidence = veryPositive + positive;

  // Conflicting emotional cues need context. Preserve them as unclassified
  // rather than arbitrarily forcing a customer into a dashboard bucket.
  if (negativeEvidence > 0 && positiveEvidence > 0) {
    return { eligible: false, reason: 'ambiguous_mixed' };
  }

  let score = 0;
  let reasonCode = 'no_clear_emotion';
  if (veryNegative > 0 || negative >= 2) { score = -2; reasonCode = 'severe_complaint'; }
  else if (negative > 0) { score = -1; reasonCode = 'complaint_or_frustration'; }
  else if (veryPositive > 0 || positive >= 2) { score = 2; reasonCode = 'strong_praise_or_gratitude'; }
  else if (positive > 0) { score = 1; reasonCode = 'praise_or_gratitude'; }

  const labels = {
    '-2': 'very_negative',
    '-1': 'negative',
    '0': 'neutral',
    '1': 'positive',
    '2': 'very_positive'
  };
  return {
    eligible: true,
    score,
    label: labels[String(score)],
    reasonCode,
    classifier: 'local_rule',
    classifierVersion: CLASSIFIER_VERSION
  };
}

async function classifyAndStoreSentiment(client, message) {
  if (!message || message.direction !== 'inbound' || message.reply_to_message_id) return null;
  const excludedPhones = new Set([
    process.env.TELNYX_PHONE_NUMBER,
    ...String(process.env.ANALYTICS_EXCLUDED_PHONES || '').split(',')
  ].map(normalisePhone).filter(Boolean));
  if (excludedPhones.has(normalisePhone(message.contact_phone))) return null;
  const result = classifyLocalSentiment(message.body);
  if (!result.eligible) return null;
  const messageID = message.id ?? message.message_id;
  if (messageID === null || messageID === undefined || !message.created_at) return null;
  const { error } = await client.from('message_sentiment').upsert({
    workspace_id: 'vici',
    message_id: String(messageID),
    occurred_at: message.created_at,
    score: result.score,
    label: result.label,
    classifier: result.classifier,
    classifier_version: result.classifierVersion,
    model: null,
    confidence: result.score === 0 ? 0.55 : 0.8
  }, { onConflict: 'workspace_id,message_id,classifier_version', ignoreDuplicates: true });
  if (error) throw error;
  return result;
}

module.exports = {
  CLASSIFIER_VERSION,
  classifyAndStoreSentiment,
  classifyLocalSentiment
};
