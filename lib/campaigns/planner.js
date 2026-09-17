'use strict';
/**
 * lib/campaigns/planner.js — say what you want, get a campaign you can review.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS JOINS UP
 *
 *   Every piece of an arbitrary campaign already existed on a different
 *   screen. A segment could be described in words and turned into rules by a
 *   model, previewed and saved. Copy could be drafted by a model. An audience
 *   could be built from a segment. Codes mint at approval.
 *
 *   Doing "a clearance on RT for people who bought it and went quiet" meant
 *   three screens, four steps, and knowing which order to do them in. This is
 *   one call: a sentence in, a reviewable proposal out.
 *
 *   It PROPOSES and nothing else. No segment is saved, no campaign created, no
 *   coupon minted. Accepting is a separate, explicit call, because a plan a
 *   model wrote from one sentence is exactly the kind of thing a person should
 *   read before it becomes real.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ORDER MATTERS
 *
 *   Audience first, then the offer, then the copy. Copy written before the
 *   audience is known cannot mention what those people bought, and an offer
 *   chosen before the audience is counted cannot know whether it is being
 *   spent on four people or four hundred.
 *
 * THE OFFER IS NOT THE MODEL'S DECISION
 *
 *   A model asked to design a discount will design a generous one, because
 *   nothing in the prompt costs it anything. The rules here are the business's:
 *   a win-back-shaped audience gets 15%, a thank-you gets nothing, and anything
 *   the owner explicitly asked for wins over both. The model's only say is
 *   reading the brief for an explicit percentage.
 */

const { draftCandidates } = require('./copy-writer');
const { assessAudience, MINIMUM_MARKETING_AUDIENCE } = require('./audience-health');
const { loadCampaignSettings } = require('./eligibility');
const { RULES } = require('./copy-rules');
const { validateCopy } = require('./copy-validator');

const PAYMENT_ANNOUNCEMENT_COPY =
  'Vin from Vici: Our checkout now takes card payments and Apple Pay. ' +
  'Shop at https://vicipeptides.com. Reply STOP to opt out.';

/** What a brief can ask for, and what each implies about the offer. */
const SHAPES = Object.freeze({
  winback: { keywords: ['win back', 'winback', 'lapsed', 'lost', 'gone quiet', 'come back', 'stopped'], discount: 15 },
  clearance: { keywords: ['clearance', 'clear out', 'get rid', 'overstock', 'discontinu', 'last of'], discount: 20 },
  thanks: { keywords: ['thank', 'appreciat', 'loyal', 'best customer', 'vip'], discount: null },
  restock: { keywords: ['back in stock', 'restock', 'available again'], discount: null },
  checkin: { keywords: ['check in', 'checkin', 'how did', 'follow up'], discount: null }
});

/**
 * The brief, in the shape copy-writer.js will accept.
 *
 * BRIEF_PATTERN there allows letters, digits and a short list of punctuation,
 * and `%` is not on it. So "clearance on RT, 20% off" was refused outright and
 * the whole plan came back with no copy at all, for a character.
 *
 * Rewriting rather than stripping, because the meaning has to survive: the
 * model is allowed to state a percentage only when the brief asks for one, and
 * deleting the symbol would silently remove the ask along with it.
 */
function briefForDrafter(brief) {
  return String(brief || '')
    // "credit card" is deliberately blocked by the campaign validator as a
    // carrier-risk phrase. The business fact is still expressible without it:
    // customers can pay by card. Rewrite the BRIEF, not a rejected message, so
    // the model never gets instructed to repeat wording the validator must
    // discard.
    .replace(/\bcredit cards?\b/gi, 'card payments')
    .replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/[^A-Za-z0-9 .,:;'?()/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A brief that explicitly asks for the complete contact list. */
function requestsAllContacts(brief) {
  const text = String(brief || '');
  if (/\b(?:all|every)\s+(?:the\s+)?(?:contacts?|customers?)\b|\b(?:entire|whole)\s+(?:customer|contact)\s+(?:base|list)\b|\b(?:everyone|everybody)\s+in\s+(?:the\s+)?vici\s+app\b/i.test(text)) return true;
  return /\b(?:everyone|everybody)\b/i.test(text)
    && !/\b(?:who|that|which|bought|ordered|spent|segment|group)\b/i.test(text);
}

function requestsPaymentAnnouncement(brief) {
  const text = String(brief || '');
  return /\bapple\s+pay\b/i.test(text)
    && /\b(?:card|cards|credit|payment processor|checkout)\b/i.test(text);
}

/** Every warning as `{code, message}`, whatever shape it arrived in. */
function normaliseWarning(warning) {
  if (typeof warning === 'string') return { code: 'segment', message: warning };
  if (warning && typeof warning.message === 'string') {
    return { code: warning.code || 'segment', message: warning.message };
  }
  // A structured warning with no message renders as [object Object] on a
  // screen, which is worse than no warning because it looks like a bug.
  return {
    code: warning?.code || 'segment',
    message: warning?.detail || warning?.reason || JSON.stringify(warning)
  };
}

/** A percentage the owner named in the brief, if any. Theirs beats ours. */
function explicitDiscount(brief) {
  const match = String(brief || '').match(/(\d{1,2})\s*%/);
  if (!match) return null;
  const percent = Number(match[1]);
  return percent > 0 && percent < 100 ? percent : null;
}

/** Which shape the brief reads like, for the default offer and the category. */
function shapeOf(brief) {
  const lower = String(brief || '').toLowerCase();
  for (const [name, shape] of Object.entries(SHAPES)) {
    if (shape.keywords.some(keyword => lower.includes(keyword))) return name;
  }
  return 'custom';
}

/**
 * Turn a brief into a reviewable proposal.
 *
 * Every stage can fail independently and the ones after it still run where
 * they can, because a proposal with an audience and no copy is still useful
 * and a blank screen is not.
 */
async function planCampaign({
  client,
  brief,
  now = new Date(),
  workspaceID = 'vici',
  segments,
  drafter = draftCandidates,
  env = process.env
}) {
  const text = String(brief || '').trim();
  if (!text) {
    const error = new Error('Say what the campaign should do.');
    error.code = 'BRIEF_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (text.length > 600) {
    const error = new Error('Keep the campaign description to 600 characters or fewer.');
    error.code = 'BRIEF_TOO_LONG';
    error.status = 400;
    throw error;
  }

  const shape = shapeOf(text);
  const discountPercent = explicitDiscount(text) ?? SHAPES[shape]?.discount ?? null;
  const warnings = [];

  // ── 1. Who ────────────────────────────────────────────────────────────
  let audience = null;
  let audienceError = null;
  try {
    if (requestsAllContacts(text)) {
      // Count on the server. The accepted plan snapshots these rows again at
      // creation, then the ordinary campaign gates decide who is actually
      // eligible. "All Contacts" is an audience request, never permission to
      // message every phone number in the table.
      const { count, error } = await client.from('sms_contacts')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      audience = {
        kind: 'all_contacts',
        description: 'All Vici contacts. Consent, STOP, DND, suppressions and campaign limits are checked before delivery.',
        ruleSet: null,
        matchedCount: Number(count) || 0,
        consideredCount: Number(count) || 0,
        sample: []
      };
    } else {
      // A rejected model shape is safe to retry: this stage writes nothing.
      // The bound prevents a malformed prompt/provider loop from spending
      // indefinitely, while transient model-format misses get another chance.
      let draft = null;
      let preview = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          draft = await segments.draftRules({ description: text }, { now });
          if (!draft?.ruleSet) {
            // A question or an unsupported-data answer needs clarification,
            // not another identical model call. A malformed/rejected answer
            // is transient and can be tried again safely.
            if (draft?.status === 'rejected' && attempt < 2) continue;
            break;
          }
          preview = await segments.previewRules({ rules: draft.ruleSet }, { now });
          break;
        } catch (error) {
          // The writer masks transient provider failures with this stable
          // code. A stale model-generated rule can also fail live validation
          // at preview time. Neither stage writes to the database.
          if (attempt < 2 && ['SEGMENT_AI_BUILDER_UNAVAILABLE', 'SEGMENT_RULES_INVALID'].includes(error.code)) continue;
          throw error;
        }
      }
      if (!draft?.ruleSet || !preview) {
        const detail = draft?.because || draft?.questions?.[0]
          || draft?.errors?.[0]?.reason || 'The audience rules could not be drafted.';
        throw Object.assign(new Error(detail), { code: 'SEGMENT_DRAFT_REJECTED', status: 422 });
      }
      audience = {
        kind: 'rules',
        // previewRules returns plainEnglish as a structured value in some
        // shapes, and rendering an object into a screen prints [object Object].
        description: typeof preview.plainEnglish === 'string' && preview.plainEnglish
          ? preview.plainEnglish
          : (typeof draft.description === 'string' ? draft.description : text),
        ruleSet: preview.ruleSet,
        matchedCount: preview.matchedCount,
        consideredCount: preview.consideredCount,
        sample: preview.sample || []
      };
      for (const warning of preview.warnings || []) warnings.push(normaliseWarning(warning));
    }
  } catch (error) {
    audienceError = { code: error.code || 'SEGMENT_DRAFT_FAILED', message: error.message };
  }

  // ── 2. Whether it may actually be sent ────────────────────────────────
  let health = null;
  if (audience?.sample?.length || audience?.matchedCount) {
    const settings = await loadCampaignSettings(client, workspaceID).catch(() => null);
    // The sample is what previewRules returns; assessing the full audience
    // needs the saved segment, so this is the honest partial answer and the
    // accept step re-checks the whole list.
    const phones = (audience.sample || []).map(row => row.contactPhone).filter(Boolean);
    if (phones.length) {
      health = await assessAudience({
        client, phones, settings, now, workflowCategory: shape, workspaceID
      }).catch(() => null);
      for (const warning of health?.warnings || []) warnings.push(normaliseWarning(warning));
    }
    if (audience.matchedCount < MINIMUM_MARKETING_AUDIENCE && shape !== 'checkin') {
      warnings.push({
        code: 'below_floor',
        message: `${audience.matchedCount} people is below the ${MINIMUM_MARKETING_AUDIENCE} needed for a promotional campaign. Widen the audience, or send it as a one-off conversation instead.`
      });
    }
  }

  // ── 3. What it says ───────────────────────────────────────────────────
  let copy = [];
  let copyError = null;
  try {
    // No `cadence` here. It is a {value, unit} object describing a reorder
    // rhythm, not a place to put a discount, and passing a string got the
    // whole request rejected. The percentage reaches the model through the
    // brief text, which is where the owner put it.
    // The approved codes MUST be passed. The ALL-CAPS check exempts verified
    // product codes, and without this list "RT" reads as shouting: every
    // candidate for a brief mentioning RT was rejected as
    // `no_all_caps_shouting`, so the one thing the copy needed to say was the
    // one thing it could not.
    const result = await drafter({
      workflowType: 'manual',
      brief: briefForDrafter(text),
      candidateCount: 3,
      approvedProductCodes: RULES.defaultApprovedProductCodes
    });
    copy = result.candidates || [];
    if (!copy.length) {
      copyError = { code: 'ALL_DRAFTS_REJECTED', message: 'Every version broke a copy rule. Try describing it differently.' };
    }
  } catch (error) {
    copyError = { code: error.code || 'COPY_DRAFT_FAILED', message: error.message };
  }

  if (!copy.length && requestsPaymentAnnouncement(text)) {
    // Exact, already-validated fallback for this business announcement only.
    // A failed model must not block a truthful, human-reviewed announcement,
    // but we must not invent a generic fallback for arbitrary offers.
    const verdict = validateCopy(PAYMENT_ANNOUNCEMENT_COPY);
    if (verdict.ok) {
      copy = [{ text: verdict.text, septets: verdict.septets }];
      copyError = null;
      warnings.push({
        code: 'review_payment_announcement_copy',
        message: 'The draft uses a reviewed payment announcement. Confirm that card payments and Apple Pay are live before approving it.'
      });
    }
  }

  return {
    brief: text,
    shape,
    workflowCategory: shape === 'custom' ? 'custom' : shape,
    discountPercent,
    audience,
    audienceError,
    health,
    copy,
    copyError,
    warnings,
    // Everything below has to be true before Accept means anything.
    ready: Boolean(audience && copy.length && audience.matchedCount > 0
      && !warnings.some(warning => warning.code === 'below_floor'))
  };
}

module.exports = {
  SHAPES,
  briefForDrafter,
  explicitDiscount,
  normaliseWarning,
  planCampaign,
  PAYMENT_ANNOUNCEMENT_COPY,
  requestsPaymentAnnouncement,
  requestsAllContacts,
  shapeOf
};
