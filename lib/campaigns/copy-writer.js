'use strict';
/**
 * lib/campaigns/copy-writer.js — LLM-drafted candidate SMS copy.
 *
 * The model here is a DRAFTER. It is not an approver and not a sender. It
 * produces several candidates; a human picks one, edits it, and then the
 * existing draft/review/approve/schedule machinery applies unchanged. Nothing
 * in this file writes a campaign, changes a status, or contacts anybody.
 *
 * FOUR THINGS THAT ARE LOAD-BEARING
 *
 * 1. The flag. `CAMPAIGN_AI_COPY_ENABLED` must be exactly the string `true`,
 *    matching every other campaign brake in this repository. Anything else,
 *    including `1`, `TRUE` and `yes`, is off.
 *
 * 2. No PII, ever, by construction. The prompt receives a product name, a
 *    workflow type, a brand name, and a cadence phrase this file assembles
 *    itself from a bounded integer. It does not receive a customer name, a
 *    phone number, an email, an address, an order id or a spend figure,
 *    because it is never given a shape that could carry one:
 *    `assertNoCustomerIdentity()` throws before the network call, the cadence
 *    input is a number rather than free text, and unknown input keys are
 *    rejected. `lib/openrouter-private.js` also tokenises PII on the way out —
 *    that is the second line of defence, deliberately not the first. A
 *    tokeniser that never has to fire is the design goal.
 *
 * 3. The rules reach the prompt verbatim. `renderPromptRules()` numbers the
 *    sentences from `RULES.promptRules` and joins them. No sentence is
 *    rewritten here. See lib/campaigns/copy-rules.js for why.
 *
 * 4. Nothing that fails validation is surfaced. A rejection is reported as
 *    rule identity only — the check ids, the checks' own descriptions, and any
 *    banned term that matched, all of which are constants from the rule set.
 *    No fragment of the rejected draft is returned, so a reviewer cannot copy
 *    one out of a response body and paste it into a campaign.
 */

const { privateCompletion } = require('../openrouter-private');
const { RULES, renderPromptRules } = require('./copy-rules');
const {
  renderBusinessContext, renderObservedPatterns, renderSelfCheck, renderTechniques
} = require('./copy-craft');
const { validateCopy } = require('./copy-validator');
const { cleanLabel } = require('./draft-copy');

/** Check id -> the plain description a reviewer is shown when a draft fails. */
const CHECK_TITLE = new Map(RULES.checks.map(check => [check.id, check.title]));

/** Workflow types this drafter will write for. */
const SUPPORTED_WORKFLOWS = Object.freeze({
  back_in_stock: 'A product the customer asked about is available again. Say it is back and offer help. Do not imply the customer needs it.',
  back_in_stock_requested: 'A product the customer specifically asked to be told about is available again. Say it is back and offer help.',
  back_in_stock_repeat_buyer: 'A product this customer has bought before is available again. Say it is back and offer help. Do not describe their order history.',
  reorder: 'A gentle reorder check-in. Phrase it as an offer to help, never as knowledge that the customer needs more.',
  reorder_personal: 'A gentle reorder check-in. Phrase it as an offer to help, never as knowledge that the customer needs more.',
  reorder_personal_high: 'A gentle reorder check-in. Phrase it as an offer to help, never as knowledge that the customer needs more.',
  winback: 'A quiet check-in with a customer who has not been in touch for a while. Offer help. Do not mention their spend, their history, or their absence.',
  manual: 'A manually requested campaign. Keep it plain and factual, and say only what the brief states.'
});

const CADENCE_UNITS = Object.freeze(['days', 'weeks', 'months']);
const MAX_CADENCE_VALUE = 240;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 5;
const DEFAULT_CANDIDATES = 4;
const PRODUCT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .+/()-]{0,59}$/;
/**
 * Typographic characters a phone produces, mapped to what a keyboard means.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   The owner typed an instruction on an iPhone and it was refused:
 *
 *     "Your instruction contains a character that cannot be sent to the
 *      drafting model."
 *
 *   The character was ’ — U+2019, which iOS substitutes for a straight
 *   apostrophe automatically. His instruction said "it's saying" and "they're
 *   getting", so it contained three of them.
 *
 *   That means EVERY instruction containing a contraction was rejected from a
 *   phone. "don't", "can't", "it's", "we're". Which is close to every sentence
 *   a person actually writes.
 *
 * WHY NORMALISE RATHER THAN ALLOW
 *
 *   The brief is input to a model, not output to a customer, so the GSM-7
 *   limits that govern a MESSAGE do not apply to it. But mapping to ASCII is
 *   still better than widening the pattern: it keeps one canonical form
 *   reaching the model, and if the model echoes a phrase back from the brief
 *   into a draft, that draft is already free of characters copy-rules.js
 *   would reject in a message.
 *
 *   The user is not told this happened, because nothing was lost. An
 *   apostrophe is an apostrophe.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const TYPOGRAPHIC_EQUIVALENTS = Object.freeze({
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",   // single quotes
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',   // double quotes
  '\u2013': '-', '\u2014': '-', '\u2012': '-', '\u2015': '-',   // dashes
  '\u2026': '...',                                              // ellipsis
  '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u2009': ' ',   // odd spaces
  '\u00B4': "'", '\u0060': "'"                                  // stray accents
});

function normaliseTypography(text) {
  return String(text).replace(
    /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2012\u2013\u2014\u2015\u2026\u00A0\u2007\u202F\u2009\u00B4\u0060]/g,
    character => TYPOGRAPHIC_EQUIVALENTS[character] || character
  );
}

/**
 * How much brief the owner is allowed to write.
 *
 * Was 80 characters, and not by decision: assertBrief ran the brief through
 * `cleanLabel`, a LABEL helper whose job is trimming a title, and cleanLabel
 * ends with .slice(0, 80). The .slice(0, 200) beside it was therefore dead
 * code, and the owner's instruction was cut off mid-sentence with no warning
 * and no error. He reported it as the model ignoring him. It was, but only
 * because it never saw the second half of what he asked for.
 *
 * 600 is room for a real instruction — what to change, what to keep, what the
 * offer is and who it is going to — while still being far too short to paste a
 * customer list into.
 */
const BRIEF_MAX_LENGTH = 600;

/**
 * What a brief may contain.
 *
 * The old pattern allowed only [A-Za-z0-9 .,:;'?()/-], which refused the
 * percent sign. copy-rules.js rule 12 says, in the prompt, "You may state a
 * percentage only when the brief asks for one" — so the rules invited a brief
 * the validator made it impossible to write. Two components answering one
 * question, and the wrong one winning.
 *
 * This allows ordinary writing punctuation. It is not the security boundary:
 * assertNoCustomerIdentity is, and it runs on every field regardless.
 */
const BRIEF_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9 .,:;'"?!%&$£€@#*+=_()\\[\\]/-]{0,${BRIEF_MAX_LENGTH - 1}}$`);

class CopyDraftError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CopyDraftError';
    this.code = code;
    this.status = status;
  }
}

function aiCopyEnabled(env = process.env) {
  return env.CAMPAIGN_AI_COPY_ENABLED === 'true';
}

/**
 * Shapes that must never reach a model prompt, checked on the raw input rather
 * than trusted to the tokeniser downstream.
 *
 * This is not a redaction step. There is nothing to redact: none of these
 * fields is supposed to contain identity in the first place, so finding one is
 * evidence that a caller is passing the wrong thing, and the correct response
 * is to refuse the request loudly rather than to quietly strip it.
 */
const IDENTITY_SHAPES = Object.freeze([
  { id: 'email_address', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { id: 'phone_number', pattern: /\+?\d[\d().\-\s]{7,}\d/ },
  { id: 'long_digit_run', pattern: /\d{6,}/ },
  { id: 'street_address', pattern: /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\b/i },
  { id: 'order_reference', pattern: /\b(?:order|invoice|ref|customer)\s*#?\s*\d+/i },
  { id: 'currency_amount', pattern: /[$£€]\s*\d/ },
  { id: 'url', pattern: /https?:\/\//i },
  { id: 'merge_field', pattern: /\{\{|\}\}|\$\{|%%/ }
]);

/**
 * Shapes a BRIEF may legitimately contain, which the shared list refuses.
 *
 * EMPTY, after an attempt to add `currency_amount` was caught by
 * test/campaign-copy-writer.test.js. The reasoning had been that "$20 off the
 * bundle" is the shop's own pricing rather than a customer fact — but
 * "she spent $940 with us" matches the same shape and is squarely a customer
 * fact, and no pattern separates the two.
 *
 * It also buys nothing. copy-rules.js rule 12 forbids the MESSAGE from quoting
 * a currency amount at all, so a brief that mentions one is asking for a draft
 * the validator would discard. The real contradiction was never the dollar
 * sign: rule 12 invites a percentage ("You may state a percentage only when
 * the brief asks for one") while BRIEF_PATTERN refused the % character. That
 * is fixed in the pattern, where it belonged.
 *
 * Kept as an explicit empty set rather than deleted, so the next person to
 * reach for this finds the reasoning instead of repeating it.
 */
const BRIEF_ALLOWED_SHAPES = Object.freeze(new Set());

/**
 * Shapes a CURRENT MESSAGE may contain that a brief may not.
 *
 * The current message is copy the owner has already written and the app has
 * already rendered a preview of, so it legitimately contains merge fields.
 * Refusing `{{first_name}}` would make it impossible to ask for a revision of
 * any personalised message, which is most of them.
 *
 * Currency is NOT allowed here either, for the reason above.
 *
 * `{{first_name}}` is a PLACEHOLDER for identity, which is the opposite of
 * identity: it is precisely the form the data takes when it has NOT been
 * substituted in. Real names still cannot appear, because they do not match
 * any merge field and the other shapes still run.
 */
const CURRENT_MESSAGE_ALLOWED_SHAPES = Object.freeze(new Set(['merge_field']));

function assertNoCustomerIdentity(field, value, { allow = null } = {}) {
  const text = String(value ?? '');
  if (!text) return;
  for (const shape of IDENTITY_SHAPES) {
    if (allow && allow.has(shape.id)) continue;
    if (!shape.pattern.test(text)) continue;
    throw new CopyDraftError(
      `Campaign copy drafting rejected "${field}": it looks like it contains ${shape.id.replace(/_/g, ' ')}. Customer identity is never sent to a model.`,
      'CAMPAIGN_AI_COPY_PII_REJECTED', 400
    );
  }
}

/**
 * Turn a bounded integer into the abstract cadence phrase the prompt gets.
 * Free-text cadence is deliberately not accepted: a string field is a place a
 * caller can put "since Sarah's order on 3 May", and a number is not.
 */
/**
 * The message the owner is editing, when there is one.
 *
 * Longer limit than the brief because it is a whole SMS plus merge fields, and
 * a different allowance because it legitimately contains {{first_name}}.
 */
function assertCurrentMessage(message) {
  if (message === undefined || message === null || message === '') return null;
  const cleaned = normaliseTypography(message)
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length > 480) {
    throw new CopyDraftError(
      'The message being revised is too long to send to the drafting model.',
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  assertNoCustomerIdentity('currentMessage', cleaned, { allow: CURRENT_MESSAGE_ALLOWED_SHAPES });
  return cleaned;
}

function cadencePhrase(cadence) {
  if (cadence === undefined || cadence === null) return null;
  if (typeof cadence !== 'object' || Array.isArray(cadence)) {
    throw new CopyDraftError('cadence must be an object with value and unit.', 'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400);
  }
  const unknown = Object.keys(cadence).filter(key => !['value', 'unit'].includes(key));
  if (unknown.length) {
    throw new CopyDraftError(
      `cadence accepts only value and unit; received ${unknown.join(', ')}.`,
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  const value = Number(cadence.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CADENCE_VALUE) {
    throw new CopyDraftError(
      `cadence.value must be a whole number between 1 and ${MAX_CADENCE_VALUE}.`,
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  if (!CADENCE_UNITS.includes(cadence.unit)) {
    throw new CopyDraftError(
      `cadence.unit must be one of ${CADENCE_UNITS.join(', ')}.`,
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  return `The customer's last order was about ${value} ${cadence.unit} ago. This is background for tone only. Do not state it, imply you are tracking them, or say they are due for anything.`;
}

function assertProductName(productName, workflowType) {
  if (productName === undefined || productName === null || productName === '') {
    if (workflowType.startsWith('back_in_stock') || workflowType.startsWith('reorder')) {
      throw new CopyDraftError(
        `${workflowType} copy needs a verified product name.`,
        'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
      );
    }
    return null;
  }
  const cleaned = cleanLabel(productName, '');
  if (!PRODUCT_NAME_PATTERN.test(cleaned)) {
    throw new CopyDraftError(
      'productName must be a short plain product label from the verified catalogue.',
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  assertNoCustomerIdentity('productName', cleaned);
  return cleaned;
}

function assertBrief(brief) {
  if (brief === undefined || brief === null || brief === '') return null;
  // Deliberately NOT cleanLabel: that is a title helper and it truncates to 80.
  // Typography normalised FIRST, so a curly apostrophe from a phone keyboard
  // never reaches the pattern below.
  const cleaned = normaliseTypography(brief)
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length > BRIEF_MAX_LENGTH) {
    // Say so rather than silently cutting. Being told the instruction was too
    // long is recoverable; having half of it dropped in silence is what
    // produced "it did not adhere to what I said".
    throw new CopyDraftError(
      `Your instruction is ${cleaned.length} characters and the limit is ${BRIEF_MAX_LENGTH}. `
      + 'Shorten it and try again.',
      'CAMPAIGN_AI_COPY_BRIEF_TOO_LONG', 400
    );
  }
  if (!BRIEF_PATTERN.test(cleaned)) {
    const offending = [...cleaned].find(character => !BRIEF_PATTERN.test(character)
      && !/[A-Za-z0-9 ]/.test(character));
    throw new CopyDraftError(
      offending
        ? `Your instruction contains ${JSON.stringify(offending)}, which cannot be sent to the `
          + 'drafting model. Plain writing punctuation is fine; links and brackets around '
          + 'variables are not.'
        : 'Your instruction contains a character that cannot be sent to the drafting model.',
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }
  assertNoCustomerIdentity('brief', cleaned, { allow: BRIEF_ALLOWED_SHAPES });
  return cleaned;
}

/**
 * The system prompt.
 *
 * The rule block is `renderPromptRules()` and nothing else. Everything around
 * it is framing, and the framing deliberately contains no rule of its own: if
 * a constraint is worth stating to the model it belongs in
 * `RULES.promptRules`, in the research doc, under review, where the validator
 * can be kept in step with it.
 */
function buildSystemPrompt() {
  return [
    'You write SMS marketing copy for a US shop. A human reads everything you write before',
    'anything is sent, and a deterministic validator discards drafts that break a rule below',
    'before the human ever sees them.',
    '',
    'Your job is to do what the brief asks. The rules are the floor, not the brief: a message',
    'that breaks no rule and also does not do what was asked is a failed draft.',
    '',
    '── THE BUSINESS ────────────────────────────────────────────────────────',
    renderBusinessContext(),
    '',
    '── HOW TO WRITE WELL ───────────────────────────────────────────────────',
    renderTechniques(),
    '',
    '── WHAT WORKS IN REAL SMS MARKETING ────────────────────────────────────',
    'Taken from marketing messages this business\'s owner actually received, and',
    'filtered down to the techniques that survive the rules below.',
    '',
    renderObservedPatterns(),
    '',
    '── ABSOLUTE RULES ──────────────────────────────────────────────────────',
    'These are not style advice. A draft that breaks any of them is thrown away.',
    '',
    renderPromptRules(),
    '',
    '── BEFORE YOU ANSWER ───────────────────────────────────────────────────',
    'Check each message you have written against these, and fix any that fail:',
    renderSelfCheck(),
    '',
    '── OUTPUT ──────────────────────────────────────────────────────────────',
    'Return ONLY a JSON array of strings: the candidate messages, nothing else. No prose, no',
    'code fence, no keys, no commentary. Each string is one complete message including the',
    `brand at the start and "${RULES.optOut.exactSuffix}" at the end.`
  ].join('\n');
}

function buildUserPrompt({
  workflowType, productName, brandName, cadenceNote, brief, candidateCount, linkUrl, currentMessage
}) {
  const lines = [];

  // ── THE TASK GOES FIRST ────────────────────────────────────────────────
  //
  // It used to be one unemphasised line called "Reviewer brief:", sitting
  // after twenty-one prohibitions and before a closing instruction that
  // restated the required opening and closing. The model anchored on the
  // boilerplate and treated the brief as a hint. The owner reported this as
  // the drafts not adhering to what he said, which is exactly what it was.
  if (brief) {
    lines.push(
      '── WHAT YOU HAVE BEEN ASKED TO DO ──────────────────────────────────',
      brief,
      '',
      'That instruction is the job. If a draft does not do it, it is wrong, however well',
      'written it is.',
      ''
    );
  }

  if (currentMessage) {
    lines.push(
      '── THE MESSAGE BEING REVISED ───────────────────────────────────────',
      currentMessage,
      '',
      brief
        ? 'Revise THIS message according to the instruction above. Keep what the instruction '
          + 'does not ask you to change, including its variables and its structure, and change '
          + 'what it does. Do not start from scratch unless the instruction asks you to.'
        : 'Rewrite this message. Keep what it is saying and who it is saying it to; find a '
          + 'better way to say it.',
      ''
    );
  }

  lines.push(
    '── CONTEXT ─────────────────────────────────────────────────────────',
    `Brand name, and the exact words the message must open with: ${brandName}`,
    `Campaign type: ${workflowType}`,
    `What this campaign is: ${SUPPORTED_WORKFLOWS[workflowType]}`
  );
  if (productName) lines.push(`Verified product name, use it exactly as written: ${productName}`);
  if (cadenceNote) lines.push(cadenceNote);
  if (linkUrl) lines.push(`Approved link, include it exactly once, exactly as written: ${linkUrl}`);
  else lines.push('There is no approved link for this campaign. Do not include any link or web address.');

  lines.push(
    '',
    '── WHAT TO RETURN ──────────────────────────────────────────────────',
    `Write ${candidateCount} candidate messages.`,
    'Make them genuinely different from each other: a different opening idea, a different',
    'reason, a different order. Three wordings of one sentence is one candidate, not three.',
    `Every one must start with "${brandName}" and end with "${RULES.optOut.exactSuffix}".`
  );
  return lines.join('\n');
}

/**
 * Parse the model's reply into candidate strings.
 *
 * Strict on purpose. A model that returns prose instead of an array is a model
 * that ignored the instruction, and guessing which lines were "meant" to be
 * candidates is how a stray sentence becomes a customer message.
 */
function parseCandidates(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Draft candidate campaign copy.
 *
 * @returns {Promise<{enabled: boolean, candidates: Array<{text: string, septets: number}>,
 *   rejected: Array<{failedChecks: string[], reasons: string[]}>, requested: number,
 *   returned: number, model: string|null}>}
 */
async function draftCandidates(input = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const completion = dependencies.completion || privateCompletion;
  const validator = dependencies.validator || validateCopy;

  if (!aiCopyEnabled(env)) {
    throw new CopyDraftError(
      'AI campaign copy drafting is disabled. Set CAMPAIGN_AI_COPY_ENABLED=true to enable it.',
      'CAMPAIGN_AI_COPY_DISABLED', 503
    );
  }

  // `currentMessage` is the copy the owner is editing right now. It is the one
  // piece of context that turns "write me three messages" into "revise this one",
  // and its absence is why every draft came back as a fresh generic message
  // rather than a revision of what he had written.
  const allowedKeys = new Set(['workflowType', 'productName', 'brandName', 'cadence', 'brief',
    'candidateCount', 'linkUrl', 'approvedProductCodes', 'currentMessage']);
  const unknown = Object.keys(input).filter(key => !allowedKeys.has(key));
  if (unknown.length) {
    throw new CopyDraftError(
      `Unexpected drafting input: ${unknown.join(', ')}. Customer evidence is server-owned and never accepted here.`,
      'CAMPAIGN_AI_COPY_INPUT_REJECTED', 400
    );
  }

  const workflowType = String(input.workflowType || '');
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_WORKFLOWS, workflowType)) {
    throw new CopyDraftError(
      `No copy rules exist for workflow "${workflowType || 'unknown'}".`,
      'CAMPAIGN_AI_COPY_WORKFLOW_UNSUPPORTED', 400
    );
  }

  const brandName = cleanLabel(input.brandName, RULES.brand.defaultName);
  assertNoCustomerIdentity('brandName', brandName);
  const productName = assertProductName(input.productName, workflowType);
  const brief = assertBrief(input.brief);
  const currentMessage = assertCurrentMessage(input.currentMessage);
  const cadenceNote = cadencePhrase(input.cadence);

  const approvedProductCodes = Array.isArray(input.approvedProductCodes)
    ? input.approvedProductCodes.map(code => cleanLabel(code, '')).filter(Boolean)
    : [];

  let linkUrl = null;
  if (input.linkUrl) {
    linkUrl = String(input.linkUrl).trim();
    const probe = validator(`${brandName}: ${linkUrl} ${RULES.optOut.exactSuffix}`, {
      brandName, approvedProductCodes
    });
    const linkFailure = probe.failures.find(item => item.check === 'link_count_and_destination');
    if (linkFailure) {
      throw new CopyDraftError(
        `linkUrl is not an approved destination: ${linkFailure.reason}`,
        'CAMPAIGN_AI_COPY_LINK_REJECTED', 400
      );
    }
  }

  const requested = Math.min(
    MAX_CANDIDATES,
    Math.max(MIN_CANDIDATES, Number.isInteger(input.candidateCount) ? input.candidateCount : DEFAULT_CANDIDATES)
  );

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: buildUserPrompt({ workflowType, productName, brandName, cadenceNote, brief, candidateCount: requested, linkUrl, currentMessage })
    }
  ];

  let result;
  try {
    result = await completion({
      messages,
      maxTokens: 90 * requested + 120,
      temperature: 0.7,
      timeoutMs: 15_000,
      title: 'Vici Campaign Copy Draft',
      // Nothing above carries customer identity, so there is nothing to
      // declare here. An empty list is the honest value, and passing a
      // customer name in order to have it tokenised would defeat the point.
      sensitiveValues: [],
      env
    });
  } catch (error) {
    throw new CopyDraftError(
      'The copy drafting model could not be reached. No drafts were produced.',
      'CAMPAIGN_AI_COPY_UNAVAILABLE', 503
    );
  }

  const candidates = [];
  const rejected = [];
  const seen = new Set();

  for (const text of parseCandidates(result?.content)) {
    if (seen.has(text)) continue;
    seen.add(text);
    const verdict = validator(text, { brandName, approvedProductCodes });
    if (!verdict.ok) {
      // A rejection is reported as rule identity only.
      //
      // The obvious version of this returns `verdict.failures[].reason`, and
      // that is a leak: those reasons quote the offending fragment, so a
      // response carrying "\"Fr33\" mixes letters with 3" has put a piece of a
      // rejected draft in front of the reviewer after all. What leaves here is
      // the check id, the check's own description, and any banned term that
      // matched — all three are constants from the rule set, none of them is
      // draft text. The full reason, fragment and all, stays in-process for
      // whoever is debugging the prompt.
      rejected.push({
        failedChecks: verdict.failedChecks,
        reasons: verdict.failedChecks.map(id => CHECK_TITLE.get(id)).filter(Boolean),
        bannedTerms: [...new Set(verdict.failures.map(item => item.detail?.term).filter(Boolean))]
      });
      continue;
    }
    candidates.push({ text: verdict.text, septets: verdict.septets });
  }

  return {
    enabled: true,
    workflowType,
    brandName,
    requested,
    returned: candidates.length,
    candidates,
    rejected,
    model: result?.model || null,
    copyStatus: 'human_review_required',
    reviewRequirements: [
      'verify_product_and_brand_wording',
      'verify_promotional_consent_scope',
      'verify_provider_campaign_scope',
      'verify_opt_out_language',
      'verify_destination_and_offer_terms'
    ]
  };
}

module.exports = {
  normaliseTypography,
  CopyDraftError,
  // Exported so lib/campaigns/segment-rule-writer.js checks the SAME list of
  // identity shapes rather than growing a second, drifting copy of it. Its
  // refusal message differs because its caller is not drafting copy; the
  // shapes must not.
  IDENTITY_SHAPES,
  SUPPORTED_WORKFLOWS,
  aiCopyEnabled,
  assertNoCustomerIdentity,
  buildSystemPrompt,
  buildUserPrompt,
  cadencePhrase,
  draftCandidates,
  parseCandidates
};
