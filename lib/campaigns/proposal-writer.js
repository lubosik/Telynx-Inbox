'use strict';
/**
 * lib/campaigns/proposal-writer.js — turn ONE detected opportunity into
 * SEVERAL genuinely different campaign proposals for a human to read.
 *
 * THE OWNER'S BRIEF, WHICH IS THE DESIGN CONSTRAINT
 *   "Even if we don't send them out, it's still creating revenue-generating
 *   opportunities based on the data." So this file has to be worth running
 *   with delivery switched off. What it produces is a reviewable argument: who
 *   this targets, what the mechanism is, what it costs, what it risks, what
 *   the message would say, and which numbers are real counts versus which are
 *   conditional statements. None of that requires a send to be useful, and all
 *   of it is destroyed by one invented conversion rate.
 *
 * THE DIVISION OF LABOUR, COPIED FROM copy-writer.js AND segment-rule-writer.js
 *   The model writes WORDS. It writes a message and a sentence of rationale,
 *   for a mechanism it was handed, aimed at a cohort it was described in
 *   prose. It does not choose the mechanism, it does not choose the audience,
 *   it does not price the offer, and it does not produce a single number:
 *   `checkRationale()` refuses a rationale containing a digit, and the existing
 *   copy validator refuses a message containing a price, a percentage, a
 *   quantity or a deadline.
 *
 *   Everything a reviewer will act on — the mechanism, the audience rules, the
 *   cost, the risk, the counts — is assembled by deterministic code from the
 *   catalogue and from the opportunity.
 *
 * WHAT MAKES THE VARIATIONS ACTUALLY DIFFERENT
 *   Four deterministic layers, none of which the model participates in:
 *     1. Mechanism selection. One proposal per mechanism, one mechanism per
 *        distinctness class, the no-offer control always present.
 *        See lib/campaigns/proposal-mechanisms.js.
 *     2. Audience. Where the detector supplies the fact to narrow on, a
 *        mechanism narrows to a different set of people, validated through the
 *        same closed segment grammar as everything else.
 *     3. Offer. Structured, typed, and absent for three of the six.
 *     4. A similarity floor on the drafted copy. Two messages that are
 *        near-duplicates are not two proposals, whatever their mechanisms say,
 *        so the later one is refused with `too_similar_to` naming the other.
 *   Layer four is the backstop for the failure the owner named: three
 *   rewordings of the same offer presented as three options.
 *
 * NOTHING HERE WRITES, SCHEDULES, APPROVES OR SENDS
 *   This file has no database client and no provider client. It returns
 *   objects. Persistence is lib/campaigns/proposal-service.js and acceptance
 *   is a separate, human, audited action.
 */

const { privateCompletion } = require('../openrouter-private');
const { RULES, flattenedBannedTerms, renderPromptRules } = require('./copy-rules');
const {
  renderBusinessContext, renderObservedPatterns, renderTechniques
} = require('./copy-craft');
const { validateCopy } = require('./copy-validator');
const { cleanLabel } = require('./draft-copy');
const {
  MECHANISM_CATALOGUE_VERSION,
  DEFAULT_MECHANISM_LIMIT,
  selectMechanisms
} = require('./proposal-mechanisms');
const {
  OPPORTUNITY_KINDS,
  buildProjections,
  normaliseOpportunity,
  promptFactsFor
} = require('./opportunity-contract');
const { assertSurfaceable } = require('./proposal-guards');
const { RULE_SCHEMA_VERSION, describeRuleSet } = require('./segment-rule-schema');
const { validateRuleSet } = require('./segment-rule-validator');

/** Bumped when the meaning of a proposal changes. Stored on every row. */
const PROPOSAL_SCHEMA_VERSION = 'campaign-proposals-2026-08-23';

const CHECK_TITLE = new Map(RULES.checks.map(check => [check.id, check.title]));
const BANNED_TERMS = flattenedBannedTerms();

const MAX_RATIONALE_LENGTH = 240;
const MIN_RATIONALE_LENGTH = 12;
/** Braces, brackets and backticks: injection and template shapes, not prose. */
const FORBIDDEN_GLYPHS = /[<>{}[\]`|\\^~]/;

/**
 * How similar two drafts may be before the second is not a second proposal.
 *
 * Jaccard overlap of the content words, after the brand prefix and the
 * mandatory opt-out sentence are removed — both are identical in every
 * compliant message and would otherwise inflate every comparison toward one.
 * 0.6 is a judgement: it clears "we are here if you need anything" against
 * "there is something waiting for you on your next order", and catches a
 * message that has been reworded rather than rethought.
 */
const MAX_COPY_SIMILARITY = 0.6;

class ProposalDraftError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ProposalDraftError';
    this.code = code;
    this.status = status;
  }
}

/** The brake. Exactly the lowercase string `true`, like every other one here. */
function proposalsEnabled(env = process.env) {
  return env.CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED === 'true';
}

// ── The prompt ──────────────────────────────────────────────────────────────

/**
 * The system prompt.
 *
 * The compliance block is `renderPromptRules()` and nothing else, transported
 * verbatim from docs/campaigns/SMS-COPY-RESEARCH.md through
 * lib/campaigns/copy-rules.js. Nothing in the framing restates a compliance
 * rule in different words, because a paraphrase is how a rule loosens.
 *
 * The framing does add three instructions that are about this task rather than
 * about compliance, and they are here rather than in the rule set because they
 * are not compliance rules and must not be mistaken for them:
 *   - write for the mechanism you were given, do not substitute another
 *   - write no numbers at all, in the message or the rationale
 *   - the offer terms are not yours to state
 */
function buildSystemPrompt() {
  return [
    'You draft candidate SMS marketing copy for a US business, one candidate per campaign',
    'mechanism you are given. A human reads everything you write, a deterministic validator',
    'discards anything that breaks a rule below before the human sees it, and nothing you',
    'write is ever sent as written.',
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
    'RULES. These are absolute. A draft that breaks any of them is discarded.',
    '',
    renderPromptRules(),
    '',
    'THREE FURTHER INSTRUCTIONS FOR THIS TASK.',
    'A. Write one message for each mechanism you are given, following that mechanism\'s own',
    '   instruction. Do not swap a mechanism for one you prefer, do not merge two, and do not',
    '   invent one. If a mechanism\'s instruction says to offer nothing, offer nothing.',
    'B. Write no numbers anywhere, in the message or in the rationale. Not a figure, not a',
    '   percentage, not a count, not a price, not a date, not a duration, not a spelled-out',
    '   number. Every figure a person sees comes from elsewhere.',
    'C. Where a mechanism involves an offer, the terms are set by a human reviewer afterwards.',
    '   Do not state, hint at, or describe the value of anything.',
    '',
    'For each mechanism also write ONE short sentence of rationale: why this mechanism might',
    'work on this particular group. Plain words, no numbers, no claim about the product, no',
    'claim about health, and no prediction of a result.',
    '',
    'Reply with ONLY a JSON array and nothing else. No prose, no code fence. Each element:',
    '{"mechanism":"<the exact id you were given>","message":"<the SMS>","rationale":"<one sentence>"}'
  ].join('\n');
}

function buildUserPrompt({ promptFacts, brandName, mechanisms, productName, linkUrl }) {
  const lines = [
    `Brand name: ${brandName}`,
    `Opportunity: ${promptFacts.kindLabel}`,
    `What the business noticed: ${promptFacts.title}`,
    `Who this group is: ${promptFacts.cohortLabel}`,
    `What is true of them: ${promptFacts.narrative}`,
    ''
  ];
  if (productName) {
    lines.push(`Verified product name. Use it exactly as written, or not at all: ${productName}`, '');
  }
  if (linkUrl) lines.push(`Approved link. If you use it, use it exactly once, exactly as written: ${linkUrl}`, '');
  else lines.push('There is no approved link. Do not include any link or web address.', '');

  lines.push('MECHANISMS. Write exactly one message and one rationale for each.', '');
  for (const mechanism of mechanisms) {
    lines.push(`- id: ${mechanism.id}`);
    lines.push(`  what it is: ${mechanism.label}`);
    lines.push(`  what the message must do: ${mechanism.copyDirective}`);
    lines.push(`  why the business is considering it: ${mechanism.premise}`);
    lines.push('');
  }
  lines.push(
    `Every message must start with "${brandName}" and end with "${RULES.optOut.exactSuffix}".`,
    'The messages must differ from one another in substance, not only in wording. Two messages',
    'that say the same thing in different words will both be discarded.'
  );
  return lines.join('\n');
}

/**
 * Parse the model's reply.
 *
 * Strict. An element missing a field, carrying a mechanism nobody asked for,
 * or arriving as anything other than an object is dropped rather than
 * repaired, and the drop is reported. Guessing which half of a malformed reply
 * was meant is how a stray sentence becomes a customer message.
 */
function parseDrafts(content) {
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
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({
      mechanism: typeof item.mechanism === 'string' ? item.mechanism.trim() : '',
      message: typeof item.message === 'string' ? item.message.trim() : '',
      rationale: typeof item.rationale === 'string' ? item.rationale.replace(/\s+/g, ' ').trim() : ''
    }))
    .filter(item => item.mechanism && item.message);
}

// ── Deterministic checks on what came back ──────────────────────────────────

/**
 * The model's rationale, which is the one piece of its prose a human reads.
 *
 * Rejected, never trimmed into shape. Four rules:
 *   - no digit anywhere, which is the "the model does not produce numbers"
 *     instruction made enforceable rather than requested
 *   - no glyph that belongs to a template expression or an injected instruction
 *   - no link
 *   - no term from the compliance lexicon, because a health claim in the
 *     reasoning is the same drift as a health claim in the copy, and it is the
 *     drift that gets read as justification for shipping the copy
 *
 * @returns {{ok: boolean, text?: string, reasons?: string[], bannedTerms?: string[]}}
 */
function checkRationale(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const reasons = [];
  if (text.length < MIN_RATIONALE_LENGTH) reasons.push('rationale_missing_or_too_short');
  if (text.length > MAX_RATIONALE_LENGTH) reasons.push('rationale_too_long');
  if (/\d/.test(text)) reasons.push('rationale_contains_a_number');
  if (FORBIDDEN_GLYPHS.test(text)) reasons.push('rationale_contains_a_template_or_markup_glyph');
  if (/https?:\/\//i.test(text)) reasons.push('rationale_contains_a_link');

  const lowered = ` ${text.toLowerCase()} `;
  const matched = [];
  for (const entry of BANNED_TERMS) {
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(lowered)) matched.push(entry.term);
  }
  if (matched.length) reasons.push('rationale_uses_a_banned_term');

  if (reasons.length) return { ok: false, reasons, bannedTerms: [...new Set(matched)] };
  return { ok: true, text };
}

/** Content words of a message, with the two mandatory fixed parts removed. */
function contentTokens(text, brandName) {
  return String(text)
    .replace(new RegExp(`^${brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,-]?\\s*`, 'i'), '')
    .replace(RULES.optOut.exactSuffix, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard overlap of two token sets. 1 is identical, 0 shares nothing. */
function similarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ── The audience ────────────────────────────────────────────────────────────

/**
 * Build the audience for one mechanism.
 *
 * The cohort's rule set is validated by the SAME validator that guards the
 * hand-built and AI-drafted segment paths, against the live catalogue, so a
 * detector that emits a dimension nobody implemented produces a refusal with a
 * reason rather than a segment matching everybody.
 *
 * Narrowing is applied only when the opportunity supplied the fact it needs.
 * Nothing here invents a threshold. When the fact is absent the proposal
 * targets the whole cohort and says, in `narrowingSkipped`, why it did not
 * narrow — which is more useful to a reviewer than a silently wider audience.
 */
function buildAudience(opportunity, mechanism, { products, segments }) {
  const cohort = opportunity.cohort;
  const base = {
    cohortKey: cohort.key,
    cohortLabel: cohort.label,
    segmentKey: cohort.segmentKey,
    cohortSize: cohort.size,
    cohortSizeBasis: cohort.sizeBasis,
    narrowedBy: null,
    narrowingSkipped: null,
    ruleSet: null,
    schemaVersion: RULE_SCHEMA_VERSION,
    plainEnglish: null,
    // A proposal can be read, saved and dismissed without a saved segment.
    // It cannot be ACCEPTED without one; see assertAudienceIsSaved().
    requiresSegment: !cohort.segmentKey
  };

  if (!cohort.definition) {
    return {
      ok: true,
      audience: {
        ...base,
        kind: cohort.segmentKey ? 'segment' : 'cohort_only',
        plainEnglish: cohort.segmentKey
          ? `Everyone in the saved segment behind "${cohort.label}".`
          : `Everyone the detector counted in "${cohort.label}". This cohort has no saved rules, so the audience cannot be previewed or attached to a campaign until it is saved as a segment.`
      }
    };
  }

  const conditions = Array.isArray(cohort.definition.conditions)
    ? [...cohort.definition.conditions]
    : [];
  let narrowedBy = null;
  let narrowingSkipped = null;

  const narrowing = mechanism.audienceNarrowing;
  if (narrowing) {
    const fact = cohort[narrowing.requiresFact];
    if (fact) {
      conditions.push({
        dimension: narrowing.dimension,
        operator: narrowing.operator,
        value: [fact]
      });
      narrowedBy = narrowing.note;
    } else {
      narrowingSkipped = `The detector supplied no ${narrowing.requiresFact}, so this proposal targets the whole cohort rather than a narrower slice. Nothing here invents a threshold.`;
    }
  }

  const verdict = validateRuleSet(
    { match: cohort.definition.match, conditions },
    { products, segments }
  );
  if (!verdict.ok) {
    return { ok: false, errors: verdict.errors };
  }

  const description = verdict.description || describeRuleSet(verdict.ruleSet);
  return {
    ok: true,
    audience: {
      ...base,
      kind: 'rules',
      narrowedBy,
      narrowingSkipped,
      ruleSet: verdict.ruleSet,
      // `describeRuleSet` returns { sentence, lines }. The sentence is what a
      // reviewer reads; the lines are what a UI renders as a list. Both are
      // DERIVED from the validated rules, never written by the model, so what
      // is on the screen is a rendering of what would actually run.
      plainEnglish: description.sentence,
      plainEnglishLines: description.lines,
      warnings: verdict.warnings
    }
  };
}

// ── Assembly ────────────────────────────────────────────────────────────────

function offerFor(mechanism) {
  if (!mechanism.offer) {
    return {
      kind: 'none',
      appliedBy: null,
      termsRequiredFromHuman: [],
      statedInCopy: false,
      note: 'This proposal deliberately carries no offer. It is the arm that answers whether this cohort needs one.'
    };
  }
  const statedInCopy = mechanism.offer.statedInCopy === true;
  return {
    kind: mechanism.offer.kind,
    appliedBy: mechanism.offer.appliedBy,
    termsRequiredFromHuman: [...mechanism.offer.termsRequiredFromHuman],
    // THE MECHANISM'S OWN DECISION, not a constant. This was hardcoded false
    // with a note saying a percentage or a code fails the copy validator.
    // Neither does now, and two mechanisms exist specifically to state theirs.
    statedInCopy,
    note: statedInCopy
      ? 'The drafted message states a percentage and carries {{code}}, which the copy rules now permit. A currency amount is still refused. The code itself does not exist until it is minted per recipient, and the percentage in the store must match the one in the message before anything is approved.'
      : 'The drafted message does not state these terms. The playbook attaches an offer during human review. Set the terms in the store, then in the campaign, before approving anything.'
  };
}

function proposalKey(opportunity, mechanismID) {
  return `${opportunity.id}:${mechanismID}`;
}

/**
 * Draft several campaign proposals for one opportunity.
 *
 * @param {object} input
 * @param {object} input.opportunity  a portfolio opportunity; see lib/campaigns/opportunity-contract.js
 * @param {Array}  [input.products]   verified catalogue: { productID, variationID, name }
 * @param {Array}  [input.segments]   existing segments: { key, name }
 * @param {string} [input.brandName]
 * @param {string} [input.linkUrl]    an approved first-party link, or nothing
 * @param {number} [input.mechanismLimit]
 * @param {string[]} [input.excludeMechanisms] ids already dismissed for this opportunity
 * @param {object} [dependencies]     { env, completion, validator }
 * @returns {Promise<object>} { enabled, opportunity, proposals, refused, ... }
 */
async function draftProposals(input = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const completion = dependencies.completion || privateCompletion;
  const validator = dependencies.validator || validateCopy;

  if (!proposalsEnabled(env)) {
    throw new ProposalDraftError(
      'Campaign opportunity proposals are disabled. Set CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED=true to enable them.',
      'CAMPAIGN_PROPOSALS_DISABLED', 503
    );
  }

  const allowedKeys = new Set([
    'opportunity', 'opportunitySource', 'products', 'segments', 'brandName', 'linkUrl',
    'mechanismLimit', 'excludeMechanisms'
  ]);
  const unknown = Object.keys(input).filter(key => !allowedKeys.has(key));
  if (unknown.length) {
    throw new ProposalDraftError(
      `Unexpected proposal input: ${unknown.join(', ')}. Customer evidence is server-owned and is never accepted here.`,
      'CAMPAIGN_PROPOSALS_INPUT_REJECTED', 400
    );
  }

  const opportunity = normaliseOpportunity(input.opportunity);
  const promptFacts = promptFactsFor(opportunity);
  // Where the cohort figures came from. It travels with every proposal and is
  // stored on the row, because a count an operator typed in must never be
  // presented the same way as a count this server measured.
  const opportunitySource = input.opportunitySource === 'client_supplied' ? 'client_supplied' : 'detector';
  const products = Array.isArray(input.products) ? input.products : [];
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const brandName = cleanLabel(input.brandName, RULES.brand.defaultName);
  // `undefined` rather than `[]` when the catalogue is empty. validateCopy
  // treats ANY array as the complete list, so an empty one would silently
  // replace RULES.defaultApprovedProductCodes and fail every message naming a
  // real SKU. Absent means "use the defaults"; present means "use exactly
  // these".
  const catalogueNames = products.map(entry => cleanLabel(entry?.name, '')).filter(Boolean);
  const approvedProductCodes = catalogueNames.length ? catalogueNames : undefined;

  let linkUrl = null;
  if (input.linkUrl) {
    linkUrl = String(input.linkUrl).trim();
    const probe = validator(`${brandName}: ${linkUrl} ${RULES.optOut.exactSuffix}`, { brandName, approvedProductCodes });
    const linkFailure = probe.failures.find(item => item.check === 'link_count_and_destination');
    if (linkFailure) {
      throw new ProposalDraftError(
        `linkUrl is not an approved destination: ${linkFailure.reason}`,
        'CAMPAIGN_PROPOSALS_LINK_REJECTED', 400
      );
    }
  }

  const mechanisms = selectMechanisms({
    limit: Number.isInteger(input.mechanismLimit) ? input.mechanismLimit : DEFAULT_MECHANISM_LIMIT,
    exclude: input.excludeMechanisms,
    // So a loyalty thank-you is never offered for people who bought once, and
    // a win-back is never offered for people who order every month.
    opportunity
  });
  if (!mechanisms.length) {
    throw new ProposalDraftError(
      'Every mechanism for this opportunity has already been dismissed.',
      'CAMPAIGN_PROPOSALS_EXHAUSTED', 409
    );
  }

  // The audience is built BEFORE the model is called. A cohort definition the
  // segment validator refuses is wrong for every proposal, and spending a
  // model call to find that out would be spending it to produce copy nobody
  // can use.
  const audiences = new Map();
  const refused = [];
  for (const mechanism of mechanisms) {
    const built = buildAudience(opportunity, mechanism, { products, segments });
    if (!built.ok) {
      refused.push({
        mechanism: mechanism.id,
        mechanismLabel: mechanism.label,
        stage: 'audience',
        reasons: ['audience_rules_rejected'],
        errors: built.errors
      });
      continue;
    }
    audiences.set(mechanism.id, built.audience);
  }
  const drafting = mechanisms.filter(mechanism => audiences.has(mechanism.id));
  if (!drafting.length) {
    return {
      enabled: true,
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      catalogueVersion: MECHANISM_CATALOGUE_VERSION,
      opportunity: publicOpportunity(opportunity),
      opportunitySource,
      requested: mechanisms.length,
      returned: 0,
      proposals: [],
      refused,
      model: null,
      reviewRequirements: REVIEW_REQUIREMENTS
    };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: buildUserPrompt({
        promptFacts,
        brandName,
        mechanisms: drafting,
        productName: opportunity.cohort.anchorProductName,
        linkUrl
      })
    }
  ];

  let result;
  try {
    result = await completion({
      messages,
      maxTokens: 160 * drafting.length + 200,
      temperature: 0.7,
      timeoutMs: 25_000,
      title: 'Vici Campaign Opportunity Proposals',
      // Nothing above carries customer identity. The opportunity contract
      // refuses identity shapes and digits on every field that reaches this
      // prompt, so there is nothing to declare and declaring something in
      // order to have it tokenised would defeat the point.
      sensitiveValues: [],
      env
    });
  } catch {
    throw new ProposalDraftError(
      'The proposal drafting model could not be reached. No proposals were produced.',
      'CAMPAIGN_PROPOSALS_UNAVAILABLE', 503
    );
  }

  const draftsByMechanism = new Map();
  for (const draft of parseDrafts(result?.content)) {
    // First answer per mechanism wins. A model that answers twice for one
    // mechanism has ignored the instruction, and picking the "better" one
    // would be this file choosing copy, which is the human's job.
    if (!draftsByMechanism.has(draft.mechanism)) draftsByMechanism.set(draft.mechanism, draft);
  }

  const { projections, dropped: droppedProjections } = buildProjections(opportunity);
  const proposals = [];
  const acceptedTokens = [];

  for (const mechanism of drafting) {
    const draft = draftsByMechanism.get(mechanism.id);
    if (!draft) {
      refused.push({
        mechanism: mechanism.id,
        mechanismLabel: mechanism.label,
        stage: 'model',
        reasons: ['model_wrote_nothing_for_this_mechanism']
      });
      continue;
    }

    const verdict = validator(draft.message, { brandName, approvedProductCodes });
    if (!verdict.ok) {
      // Rule identity only. The reasons in `verdict.failures` quote the
      // offending fragment, so returning them would put a piece of a rejected
      // draft in front of the reviewer — exactly what refusing to surface it
      // was for. The check ids, the checks' own titles and any matched banned
      // term are all constants from the rule set.
      refused.push({
        mechanism: mechanism.id,
        mechanismLabel: mechanism.label,
        stage: 'copy_validator',
        failedChecks: verdict.failedChecks,
        reasons: verdict.failedChecks.map(id => CHECK_TITLE.get(id)).filter(Boolean),
        bannedTerms: [...new Set(verdict.failures.map(item => item.detail?.term).filter(Boolean))]
      });
      continue;
    }

    const rationale = checkRationale(draft.rationale);
    if (!rationale.ok) {
      refused.push({
        mechanism: mechanism.id,
        mechanismLabel: mechanism.label,
        stage: 'rationale',
        reasons: rationale.reasons,
        bannedTerms: rationale.bannedTerms
      });
      continue;
    }

    const tokens = contentTokens(verdict.text, brandName);
    const tooSimilar = acceptedTokens.find(entry => similarity(entry.tokens, tokens) >= MAX_COPY_SIMILARITY);
    if (tooSimilar) {
      refused.push({
        mechanism: mechanism.id,
        mechanismLabel: mechanism.label,
        stage: 'distinctness',
        reasons: ['too_similar_to_another_proposal'],
        tooSimilarTo: tooSimilar.mechanism
      });
      continue;
    }
    acceptedTokens.push({ mechanism: mechanism.id, tokens });

    const audience = audiences.get(mechanism.id);
    const proposal = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      catalogueVersion: MECHANISM_CATALOGUE_VERSION,
      contractVersion: opportunity.contractVersion,
      proposalKey: proposalKey(opportunity, mechanism.id),
      opportunityId: opportunity.id,
      opportunityKind: opportunity.kind,
      opportunityTitle: opportunity.title,
      opportunitySource,
      mechanism: mechanism.id,
      mechanismLabel: mechanism.label,
      distinctnessClass: mechanism.distinctnessClass,
      title: `${mechanism.label} for ${opportunity.cohort.label}`,
      audience,
      offer: offerFor(mechanism),
      copy: {
        text: verdict.text,
        septets: verdict.septets,
        gsm7: verdict.gsm7,
        brandName,
        validated: true,
        failedChecks: [],
        copyRulesVersion: RULES.version
      },
      reasoning: {
        // The model's sentence, checked and never edited. It is labelled as
        // the model's so a reviewer never mistakes it for a finding.
        modelRationale: rationale.text,
        rationaleAuthor: 'model',
        // The business premise, from the catalogue, written by a person.
        mechanismPremise: mechanism.premise,
        cohortNarrative: OPPORTUNITY_KINDS[opportunity.kind].narrative,
        evidenceStatus: mechanism.evidence.status,
        evidenceSource: mechanism.evidence.source
      },
      costs: mechanism.costs.map(cost => ({ ...cost })),
      risks: mechanism.risks.map(risk => ({ ...risk })),
      projections,
      droppedProjections,
      status: 'proposed',
      reviewRequirements: REVIEW_REQUIREMENTS
    };

    // Belt and braces. The guard is the thing that decides what a human sees,
    // and it is applied here, again in the service before an insert, and again
    // in the route before a response, so deleting any one call site does not
    // open the gate.
    assertSurfaceable(proposal);
    proposals.push(proposal);
  }

  return {
    enabled: true,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    catalogueVersion: MECHANISM_CATALOGUE_VERSION,
    opportunity: publicOpportunity(opportunity),
    opportunitySource,
    requested: mechanisms.length,
    returned: proposals.length,
    proposals,
    refused,
    model: result?.model || null,
    reviewRequirements: REVIEW_REQUIREMENTS
  };
}

/**
 * Said in the payload as well as in the interface, because a client that
 * forgets to say it presents a draft as a decision.
 */
const REVIEW_REQUIREMENTS = Object.freeze([
  'a_proposal_is_not_a_campaign',
  'read_the_risks_before_the_copy',
  'every_figure_shown_carries_its_basis_or_is_not_shown',
  'offer_terms_are_set_by_a_human_and_are_not_in_the_message',
  'accepting_creates_a_draft_that_still_needs_the_normal_approval_path'
]);

/** The opportunity as it is echoed back: shape and counts, never a person. */
function publicOpportunity(opportunity) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    kindLabel: opportunity.kindLabel,
    title: opportunity.title,
    cohort: {
      key: opportunity.cohort.key,
      label: opportunity.cohort.label,
      size: opportunity.cohort.size,
      sizeBasis: opportunity.cohort.sizeBasis,
      segmentKey: opportunity.cohort.segmentKey
    },
    facts: opportunity.facts,
    detectedAt: opportunity.detectedAt,
    detectorVersion: opportunity.detectorVersion,
    contractVersion: opportunity.contractVersion
  };
}

module.exports = {
  FORBIDDEN_GLYPHS,
  MAX_COPY_SIMILARITY,
  MAX_RATIONALE_LENGTH,
  PROPOSAL_SCHEMA_VERSION,
  ProposalDraftError,
  REVIEW_REQUIREMENTS,
  buildAudience,
  buildSystemPrompt,
  buildUserPrompt,
  checkRationale,
  contentTokens,
  draftProposals,
  offerFor,
  parseDrafts,
  proposalKey,
  proposalsEnabled,
  publicOpportunity,
  similarity
};
