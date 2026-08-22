'use strict';

const EXACT_OPT_OUT = new Set([
  'stop',
  'stopall',
  'stop all',
  'quit',
  'end',
  'revoke',
  'cancel',
  'unsubscribe',
  'opt out',
  'optout'
]);

function normaliseRequest(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recognise standard keywords and clear natural-language revocations without
 * treating an ordinary support sentence containing words such as "stop" or
 * "cancel" as a marketing opt-out. Provider classification is accepted only
 * when the caller has already established that the webhook is trusted.
 */
function isOptOutRequest(text, trustedProviderClassification = null) {
  const provider = normaliseRequest(trustedProviderClassification);
  if (['stop', 'opt out', 'unsubscribe'].includes(provider)) return true;

  const value = normaliseRequest(text);
  if (!value) return false;
  if (EXACT_OPT_OUT.has(value)) return true;

  const patterns = [
    /^(?:please\s+)?(?:unsubscribe|opt\s+out)\s+me(?:\s+please)?$/,
    /^(?:please\s+)?stop\s+(?:sending\s+)?(?:me\s+)?(?:the\s+)?(?:texts?|messages?|sms)(?:\s+please)?$/,
    // "me" is optional: a bare "stop texting" is unambiguous, and the previous
    // production keyword list honoured it. Dropping it would have narrowed
    // opt-out coverage while this module was widening it everywhere else.
    /^(?:please\s+)?stop\s+(?:texting|messaging|contacting)(?:\s+me)?(?:\s+please)?$/,
    /^(?:please\s+)?(?:do\s+not|don't)\s+(?:text|message|contact)\s+me(?:\s+again)?(?:\s+please)?$/,
    /^(?:please\s+)?no\s+more\s+(?:texts?|messages?|sms)(?:\s+please)?$/,
    /^(?:please\s+)?(?:remove|take)\s+me\s+(?:off|from)\s+(?:(?:your|the)\s+)?(?:texting|message|sms|contact|marketing)?\s*list(?:\s+please)?$/,
    /^(?:i\s+)?(?:hereby\s+)?revoke\s+(?:my\s+)?consent(?:\s+to\s+(?:texts?|messages?|sms|marketing))?$/,
    /^(?:i\s+)?(?:do\s+not|don't)\s+want\s+(?:any\s+)?(?:more\s+)?(?:texts?|messages?|sms)(?:\s+from\s+(?:you|this\s+(?:number|business)))?$/
  ];
  return patterns.some(pattern => pattern.test(value));
}

module.exports = { EXACT_OPT_OUT, isOptOutRequest, normaliseRequest };
