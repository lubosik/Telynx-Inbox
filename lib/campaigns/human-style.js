'use strict';

// A user-specific writing guide, not a model trained on customer conversations.
// Only future outbound one-to-one messages with a proven sender are sampled.
// Customer text, numbers, names and message bodies never enter the AI prompt.
const TRAITS = Object.freeze({
  direct: 'Lead with the concrete news or benefit, not a long introduction.',
  concise: 'Use short, easy-to-read sentences and remove filler.',
  warm: 'Sound like a real person who is glad to help, not a corporate blast.',
  question: 'Where it suits the brief, invite a simple reply.',
  thanks: 'A brief thank-you can close the human part of the message.',
  first_name: 'A first-name greeting may be used as a merge field when it reads naturally.'
});

function isDominic(actor) {
  return /^dominic(?:\s|$)/i.test(String(actor?.displayName || actor?.display_name || '').trim());
}

function traitsFromMessages(messages, actor) {
  const bodies = (messages || []).filter(row => row?.direction === 'outbound'
    && Number(row?.sender_user_id) === Number(actor?.id))
    .map(row => String(row.body || '').trim()).filter(Boolean);
  // The owner supplied one example explicitly. It establishes a modest seed,
  // not an invented history. Observed messages may refine it over time.
  const traits = new Set(isDominic(actor) ? ['direct', 'concise', 'warm', 'thanks', 'first_name'] : []);
  if (!bodies.length) return [...traits];
  const ratio = predicate => bodies.filter(predicate).length / bodies.length;
  if (ratio(body => body.length <= 180) >= 0.6) traits.add('concise');
  if (ratio(body => /\?$/.test(body)) >= 0.25) traits.add('question');
  if (ratio(body => /\bthank(?:s| you)\b/i.test(body)) >= 0.2) traits.add('thanks');
  if (ratio(body => /^(?:hi|hey|hello|good morning|good afternoon)\b/i.test(body)) >= 0.3) traits.add('warm');
  return [...traits].filter(key => Object.hasOwn(TRAITS, key));
}

async function loadHumanStyle({ client, actor } = {}) {
  if (!Number.isSafeInteger(Number(actor?.id)) || Number(actor.id) < 1) return [];
  if (!client) return traitsFromMessages([], actor);
  try {
    const { data, error } = await client.from('sms_messages')
      .select('body,direction,sender_user_id')
      .eq('sender_user_id', Number(actor.id)).eq('direction', 'outbound')
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return traitsFromMessages(data || [], actor);
  } catch {
    // A missing optional migration must never block campaign planning.
    // Crucially, it also must never cause unattributed old messages to be
    // mislabelled as this person.
    return traitsFromMessages([], actor);
  }
}

function renderHumanStyle(keys) {
  return [...new Set(Array.isArray(keys) ? keys : [])]
    .filter(key => Object.hasOwn(TRAITS, key))
    .map(key => TRAITS[key]);
}

module.exports = { TRAITS, isDominic, traitsFromMessages, loadHumanStyle, renderHumanStyle };
