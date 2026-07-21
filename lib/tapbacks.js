'use strict';
/**
 * lib/tapbacks.js — iPhone tapback (reaction) detection on inbound SMS
 *
 * When an iPhone user reacts to an SMS/MMS, Apple sends the reaction as a
 * plain text fallback, e.g.:
 *   Loved "Your order is on its way!"
 *   Laughed at "See you tomorrow"
 *   Loved an image
 *   Removed a heart from "Your order is on its way!"
 *
 * We parse those, attach the reaction to the message it targets, and let the
 * UI render it as an iMessage-style badge instead of a loose text row.
 */

const ADD_PATTERNS = [
  { re: /^Loved (?:"|“)(.+)(?:"|”)$/s,       type: 'loved' },
  { re: /^Liked (?:"|“)(.+)(?:"|”)$/s,       type: 'liked' },
  { re: /^Disliked (?:"|“)(.+)(?:"|”)$/s,    type: 'disliked' },
  { re: /^Laughed at (?:"|“)(.+)(?:"|”)$/s,  type: 'laughed' },
  { re: /^Emphasized (?:"|“)(.+)(?:"|”)$/s,  type: 'emphasized' },
  { re: /^Questioned (?:"|“)(.+)(?:"|”)$/s,  type: 'questioned' },
  // Reactions to a picture we sent — no quoted text to match
  { re: /^Loved an (image|attachment|audio message|video)$/i,      type: 'loved',      target: 'media' },
  { re: /^Liked an (image|attachment|audio message|video)$/i,      type: 'liked',      target: 'media' },
  { re: /^Disliked an (image|attachment|audio message|video)$/i,   type: 'disliked',   target: 'media' },
  { re: /^Laughed at an (image|attachment|audio message|video)$/i, type: 'laughed',    target: 'media' },
  { re: /^Emphasized an (image|attachment|audio message|video)$/i, type: 'emphasized', target: 'media' },
  { re: /^Questioned an (image|attachment|audio message|video)$/i, type: 'questioned', target: 'media' }
];

const REMOVE_PATTERNS = [
  { re: /^Removed a heart from (?:"|“)(.+)(?:"|”)$/s,            type: 'loved' },
  { re: /^Removed a like from (?:"|“)(.+)(?:"|”)$/s,             type: 'liked' },
  { re: /^Removed a dislike from (?:"|“)(.+)(?:"|”)$/s,          type: 'disliked' },
  { re: /^Removed a laugh from (?:"|“)(.+)(?:"|”)$/s,            type: 'laughed' },
  { re: /^Removed an exclamation from (?:"|“)(.+)(?:"|”)$/s,     type: 'emphasized' },
  { re: /^Removed a question mark from (?:"|“)(.+)(?:"|”)$/s,    type: 'questioned' }
];

/**
 * Returns { action: 'add'|'remove', type, quotedText|null, target: 'text'|'media' }
 * or null when the text is not a tapback.
 */
function parseTapback(text) {
  if (!text) return null;
  const t = text.trim();

  for (const p of ADD_PATTERNS) {
    const m = t.match(p.re);
    if (m) {
      return p.target === 'media'
        ? { action: 'add', type: p.type, quotedText: null, target: 'media' }
        : { action: 'add', type: p.type, quotedText: m[1], target: 'text' };
    }
  }
  for (const p of REMOVE_PATTERNS) {
    const m = t.match(p.re);
    if (m) return { action: 'remove', type: p.type, quotedText: m[1], target: 'text' };
  }
  return null;
}

/**
 * Finds the message a tapback targets within a contact's thread.
 * Text tapbacks quote the original body (Apple may truncate with a trailing
 * ellipsis); media tapbacks target the most recent outbound message that has
 * attachments. Returns the matched row or null.
 */
async function findTapbackTarget(supabase, phone, tapback) {
  const { data: candidates } = await supabase
    .from('sms_messages')
    .select('id, body, direction, media_urls, reactions, created_at')
    .eq('contact_phone', phone)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!candidates?.length) return null;

  if (tapback.target === 'media') {
    return candidates.find(m => Array.isArray(m.media_urls) && m.media_urls.length > 0) || null;
  }

  const quoted = (tapback.quotedText || '').trim();
  if (!quoted) return null;
  const quotedNoEllipsis = quoted.replace(/[……]+$/, '').trim();

  // Exact match first, then prefix match for Apple-truncated quotes
  return (
    candidates.find(m => (m.body || '').trim() === quoted) ||
    candidates.find(m => quotedNoEllipsis.length >= 12 && (m.body || '').trim().startsWith(quotedNoEllipsis)) ||
    null
  );
}

module.exports = { parseTapback, findTapbackTarget };
