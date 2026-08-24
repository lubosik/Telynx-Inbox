'use strict';
/**
 * lib/campaigns/opportunity-contract.js — the shape a detected revenue
 * opportunity must arrive in before anything will propose a campaign for it,
 * and the only place a number is allowed to enter a proposal.
 *
 * THIS IS AN ASSUMED CONTRACT, STATED SO IT CAN BE RECONCILED
 *   The cohort/portfolio opportunity detector is being built in parallel on
 *   the same base branch. Nothing in this repository produced this shape yet,
 *   so it is written here as an explicit, validated boundary rather than being
 *   guessed at each call site. If the detector lands with different field
 *   names, THIS FILE is the diff: `normaliseOpportunity()` is the single
 *   adapter, and every downstream consumer reads the normalised record.
 *
 *   Note the deliberate distinction from `sms_campaign_opportunities`, which
 *   already exists. That table holds a PER-CUSTOMER opportunity — this product
 *   is back in stock for this person. What this file describes is a
 *   PORTFOLIO opportunity — most of this cohort bought once and never came
 *   back. The two are different objects with different lifetimes and they are
 *   deliberately not merged.
 *
 * THE HONESTY RULE, WHICH IS THE POINT OF THE FILE
 *   A proposal may carry a number only if the number arrived on the
 *   opportunity, and only if it arrived with an assumption naming where it
 *   came from. There is no arithmetic in this file that invents a rate, no
 *   default conversion rate, and no fallback. A scenario whose assumption
 *   cannot be resolved is DROPPED and the drop is reported, because a
 *   projection whose basis is unknown is worse than no projection: it looks
 *   like a forecast.
 *
 *   No projection is ever labelled revenue. `assertNoRevenueClaim()` enforces
 *   that on the way out, and `test/campaign-opportunity-contract.test.js`
 *   proves it, because "projected revenue" on a screen becomes "revenue" in
 *   the retelling within about a week.
 *
 * WHAT REACHES A MODEL FROM HERE
 *   A label, a title, and a narrative sentence chosen from a closed list keyed
 *   by opportunity kind. No counts, no money, no customer, no order, no
 *   product identity beyond a verified catalogue name supplied separately.
 *   `promptFactsFor()` is the whole surface and it returns strings without
 *   digits.
 */

const { IDENTITY_SHAPES } = require('./copy-writer');

/** Bumped when the meaning of a field changes. Stored on every proposal. */
const OPPORTUNITY_CONTRACT_VERSION = 'opportunity-contract-2026-08-23';

/**
 * The kinds of portfolio opportunity this layer knows how to propose for.
 *
 * Closed, because each one carries a narrative sentence that goes into a model
 * prompt and a set of mechanisms that make sense for it. An unknown kind is
 * refused rather than handled generically: a generic proposal for an
 * opportunity nobody modelled is a plausible-sounding campaign aimed at the
 * wrong people.
 */
const OPPORTUNITY_KINDS = Object.freeze({
  repeat_purchase: Object.freeze({
    id: 'repeat_purchase',
    label: 'Turning first-time buyers into repeat buyers',
    // Number-free by construction. Asserted below.
    narrative: 'This group has bought from the business once and has not bought again. They are not lapsed regulars and they have no ordering rhythm to resume, so nothing may be phrased as a reminder, a refill, or a continuation.'
  }),
  lapsed_repeat_buyer: Object.freeze({
    id: 'lapsed_repeat_buyer',
    label: 'Repeat buyers who have gone quiet',
    narrative: 'This group has bought more than once and has since gone quiet. They know the business. Nothing may refer to how long it has been, to what they bought, or to the business having noticed their absence.'
  }),
  single_product_concentration: Object.freeze({
    id: 'single_product_concentration',
    label: 'Buyers who have only ever bought one thing',
    narrative: 'This group has only ever bought from one part of the range. Nothing may claim they need anything else, and nothing may describe what any product is for.'
  })
});

const OPPORTUNITY_KIND_IDS = Object.freeze(Object.keys(OPPORTUNITY_KINDS));

/** Statuses a projection may carry. `insufficient_data` never has a value. */
const PROJECTION_STATUSES = Object.freeze(['stated_count', 'scenario', 'insufficient_data']);

/** Confidence the detector may declare about its own sizing. */
const SIZING_CONFIDENCES = Object.freeze(['insufficient_data', 'low', 'moderate', 'high']);

const MAX_TITLE_LENGTH = 120;
const MAX_LABEL_LENGTH = 120;
const MAX_STATEMENT_LENGTH = 400;
const MAX_ASSUMPTIONS = 12;
const MAX_SCENARIOS = 6;
const MAX_FACTS = 20;

/**
 * Plain words, spaces and light punctuation. No brackets, braces or symbols.
 *
 * The underscore is allowed because a basis statement legitimately names a
 * table or a column — "counted from sms_orders" — and refusing that would push
 * whoever writes the detector into vaguer provenance, which is the opposite of
 * what a basis field is for. It carries no template meaning on its own; `${`
 * and `{{` are both still refused by the brace.
 */
const PLAIN_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .,:;'?()/%_-]{0,399}$/;
/**
 * A machine key: an id, a cohort key, a segment key, a product key.
 *
 * Separate from PLAIN_TEXT because these legitimately carry underscores and
 * colons, and because they are never shown to a customer, never sent to a
 * model as prose, and never rendered as a sentence. Keeping them apart means
 * PLAIN_TEXT can stay strict about the things that ARE read by people.
 */
const MACHINE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

class OpportunityContractError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'OpportunityContractError';
    this.code = code;
    this.status = status;
  }
}

function reject(message, code = 'OPPORTUNITY_CONTRACT_REJECTED') {
  throw new OpportunityContractError(message, code, 400);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Plain text that will be shown to a human and may be shown to a model.
 *
 * Refuses rather than strips, for the same reason the rest of this codebase
 * does: silently removing a brace from a detector's output changes what the
 * detector said and hides that it said it.
 */
function plainText(value, field, maxLength = MAX_STATEMENT_LENGTH) {
  if (typeof value !== 'string') reject(`${field} must be a string.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) reject(`${field} must not be empty.`);
  if (text.length > maxLength) reject(`${field} must be ${maxLength} characters or fewer.`);
  if (!PLAIN_TEXT.test(text)) {
    reject(`${field} must be plain words. Brackets, braces, angle brackets and template markers are not accepted.`);
  }
  for (const shape of IDENTITY_SHAPES) {
    if (shape.pattern.test(text)) {
      reject(
        `${field} looks like it contains ${shape.id.replace(/_/g, ' ')}. An opportunity describes a cohort, never a person.`,
        'OPPORTUNITY_PII_REJECTED'
      );
    }
  }
  return text;
}

/**
 * Plain text that will additionally be transported into a model prompt.
 *
 * The extra rule is: no digits at all. A cohort label of "700 one-time buyers"
 * is a number the model will repeat, and every number a human sees has to come
 * from the deterministic layer with its basis attached. Refusing at the
 * boundary tells whoever wrote the detector immediately, rather than failing
 * later at prompt-assembly time when the cause is three files away.
 */
function promptSafeText(value, field, maxLength = MAX_LABEL_LENGTH) {
  const text = plainText(value, field, maxLength);
  if (/\d/.test(text)) {
    reject(
      `${field} must contain no digits. It is transported into a model prompt, and every figure a person sees comes from the deterministic layer with its basis attached.`,
      'OPPORTUNITY_PROMPT_NUMBER_REJECTED'
    );
  }
  return text;
}

/**
 * A machine key. Refused rather than slugified: turning "Order Count" into
 * "order_count" would invent an identifier the detector did not emit, and the
 * two would then disagree about which key means which cohort.
 */
function machineKey(value, field) {
  if (typeof value !== 'string') reject(`${field} must be a string.`);
  const text = value.trim();
  if (!text) reject(`${field} must not be empty.`);
  if (!MACHINE_KEY.test(text)) {
    reject(`${field} must be a short machine key: letters, digits, and . _ : - only.`);
  }
  return text;
}

function wholeNumber(value, field, { min = 0, max = 10_000_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    reject(`${field} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function finiteNumber(value, field, { min = 0, max = 1_000_000_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    reject(`${field} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * A fact the detector computed. Aggregate only.
 *
 * `basis` is mandatory and is not decoration: it is the answer to "where did
 * this number come from", and a fact that cannot answer it does not get to be
 * shown next to a campaign proposal.
 */
function normaliseFact(raw, index) {
  if (!isPlainObject(raw)) reject(`facts[${index}] must be an object.`);
  const id = machineKey(raw.id, `facts[${index}].id`);
  const label = plainText(raw.label, `facts[${index}].label`, MAX_LABEL_LENGTH);
  const basis = plainText(raw.basis, `facts[${index}].basis`);
  const unit = raw.unit === undefined || raw.unit === null
    ? null
    : plainText(raw.unit, `facts[${index}].unit`, 40);
  if (raw.value === undefined || raw.value === null) {
    reject(`facts[${index}].value is required. A fact with no value is not a fact.`);
  }
  const value = typeof raw.value === 'string'
    ? plainText(raw.value, `facts[${index}].value`, MAX_LABEL_LENGTH)
    : finiteNumber(raw.value, `facts[${index}].value`);
  return Object.freeze({ id, label, value, unit, basis });
}

function normaliseAssumption(raw, index) {
  if (!isPlainObject(raw)) reject(`sizing.assumptions[${index}] must be an object.`);
  return Object.freeze({
    id: machineKey(raw.id, `sizing.assumptions[${index}].id`),
    statement: plainText(raw.statement, `sizing.assumptions[${index}].statement`),
    source: plainText(raw.source, `sizing.assumptions[${index}].source`, MAX_LABEL_LENGTH)
  });
}

/**
 * A scenario is a conditional statement, never a forecast.
 *
 * It must name the assumption it rests on, and that assumption must exist on
 * the same opportunity. A scenario pointing at an assumption nobody wrote is
 * exactly the shape of an invented conversion rate.
 */
function normaliseScenario(raw, index, assumptionIDs) {
  if (!isPlainObject(raw)) reject(`sizing.scenarios[${index}] must be an object.`);
  const id = machineKey(raw.id, `sizing.scenarios[${index}].id`);
  const label = plainText(raw.label, `sizing.scenarios[${index}].label`, MAX_LABEL_LENGTH);
  const assumptionID = machineKey(raw.assumptionId, `sizing.scenarios[${index}].assumptionId`);
  if (!assumptionIDs.has(assumptionID)) {
    reject(
      `sizing.scenarios[${index}] rests on assumption "${assumptionID}", which is not declared on this opportunity. A number without a stated assumption is not presentable.`,
      'OPPORTUNITY_ASSUMPTION_MISSING'
    );
  }
  const value = raw.value === undefined || raw.value === null
    ? null
    : finiteNumber(raw.value, `sizing.scenarios[${index}].value`);
  const unit = plainText(raw.unit, `sizing.scenarios[${index}].unit`, 40);
  return Object.freeze({ id, label, assumptionId: assumptionID, value, unit });
}

function normaliseSizing(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) reject('sizing must be an object when present.');

  const confidence = String(raw.confidence || '');
  if (!SIZING_CONFIDENCES.includes(confidence)) {
    reject(`sizing.confidence must be one of ${SIZING_CONFIDENCES.join(', ')}.`);
  }

  const assumptionsRaw = Array.isArray(raw.assumptions) ? raw.assumptions : [];
  if (assumptionsRaw.length > MAX_ASSUMPTIONS) reject(`sizing.assumptions must hold ${MAX_ASSUMPTIONS} entries or fewer.`);
  const assumptions = assumptionsRaw.map(normaliseAssumption);
  const assumptionIDs = new Set(assumptions.map(item => item.id));
  if (assumptionIDs.size !== assumptions.length) reject('sizing.assumptions must have unique ids.');

  const scenariosRaw = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  if (scenariosRaw.length > MAX_SCENARIOS) reject(`sizing.scenarios must hold ${MAX_SCENARIOS} entries or fewer.`);
  const scenarios = scenariosRaw.map((item, index) => normaliseScenario(item, index, assumptionIDs));

  return Object.freeze({
    reachable: raw.reachable === undefined || raw.reachable === null
      ? null
      : wholeNumber(raw.reachable, 'sizing.reachable'),
    reachableBasis: raw.reachableBasis === undefined || raw.reachableBasis === null
      ? null
      : plainText(raw.reachableBasis, 'sizing.reachableBasis'),
    confidence,
    assumptions: Object.freeze(assumptions),
    scenarios: Object.freeze(scenarios)
  });
}

function normaliseCohort(raw) {
  if (!isPlainObject(raw)) reject('cohort is required and must be an object.');
  const definition = raw.definition === undefined || raw.definition === null ? null : raw.definition;
  if (definition !== null && !isPlainObject(definition)) {
    reject('cohort.definition must be a rule set object when present.');
  }
  return Object.freeze({
    key: machineKey(raw.key, 'cohort.key'),
    label: promptSafeText(raw.label, 'cohort.label'),
    size: wholeNumber(raw.size, 'cohort.size'),
    sizeBasis: plainText(raw.sizeBasis, 'cohort.sizeBasis'),
    // The rule set is NOT validated here. It is validated by
    // lib/campaigns/segment-rule-validator.js at proposal time, against the
    // live catalogue, so there is one validator for a rule set rather than
    // two that can disagree.
    definition,
    // A saved segment key, when the detector already has one. Without it a
    // proposal can be reviewed, saved and dismissed, but cannot be accepted:
    // there is no audience to attach to a campaign draft. That refusal is in
    // lib/campaigns/proposal-guards.js and is deliberate.
    segmentKey: raw.segmentKey === undefined || raw.segmentKey === null
      ? null
      : machineKey(raw.segmentKey, 'cohort.segmentKey'),
    // A verified catalogue product this cohort is concentrated on, as
    // `productID:variationID`. Optional. Used only to narrow the assortment
    // proposal, never to describe the product.
    anchorProductKey: raw.anchorProductKey === undefined || raw.anchorProductKey === null
      ? null
      : machineKey(raw.anchorProductKey, 'cohort.anchorProductKey'),
    anchorProductName: raw.anchorProductName === undefined || raw.anchorProductName === null
      ? null
      : plainText(raw.anchorProductName, 'cohort.anchorProductName', MAX_LABEL_LENGTH)
  });
}

/**
 * Validate and normalise one portfolio opportunity.
 *
 * @param {object} raw
 * @returns {object} frozen, normalised opportunity
 * @throws {OpportunityContractError} with a reason a person can act on
 */
function normaliseOpportunity(raw) {
  if (!isPlainObject(raw)) reject('An opportunity must be an object.');

  const allowed = new Set([
    'id', 'kind', 'title', 'cohort', 'facts', 'sizing', 'detectedAt', 'detectorVersion'
  ]);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length) {
    reject(`Unexpected opportunity field: ${unknown.join(', ')}. Customer evidence never travels on an opportunity.`);
  }

  const kind = String(raw.kind || '');
  if (!Object.prototype.hasOwnProperty.call(OPPORTUNITY_KINDS, kind)) {
    reject(
      `No proposal mechanisms exist for opportunity kind "${kind || 'unknown'}". Known kinds: ${OPPORTUNITY_KIND_IDS.join(', ')}.`,
      'OPPORTUNITY_KIND_UNSUPPORTED'
    );
  }

  const factsRaw = Array.isArray(raw.facts) ? raw.facts : [];
  if (factsRaw.length > MAX_FACTS) reject(`facts must hold ${MAX_FACTS} entries or fewer.`);
  const facts = factsRaw.map(normaliseFact);
  const factIDs = new Set(facts.map(item => item.id));
  if (factIDs.size !== facts.length) reject('facts must have unique ids.');

  const detectedAt = raw.detectedAt === undefined || raw.detectedAt === null
    ? null
    : new Date(raw.detectedAt);
  if (detectedAt !== null && !Number.isFinite(detectedAt.getTime())) {
    reject('detectedAt must be a valid date when present.');
  }

  return Object.freeze({
    contractVersion: OPPORTUNITY_CONTRACT_VERSION,
    id: machineKey(raw.id, 'id'),
    kind,
    kindLabel: OPPORTUNITY_KINDS[kind].label,
    title: promptSafeText(raw.title, 'title', MAX_TITLE_LENGTH),
    cohort: normaliseCohort(raw.cohort),
    facts: Object.freeze(facts),
    sizing: normaliseSizing(raw.sizing),
    detectedAt: detectedAt ? detectedAt.toISOString() : null,
    detectorVersion: raw.detectorVersion === undefined || raw.detectorVersion === null
      ? null
      : machineKey(raw.detectorVersion, 'detectorVersion')
  });
}

/**
 * Everything about an opportunity that a model is allowed to see.
 *
 * Strings, no digits, no identity. The title is checked again here rather than
 * trusted: this function is the last thing between the detector's output and a
 * prompt, and it is cheap to check twice.
 */
function promptFactsFor(opportunity) {
  const kind = OPPORTUNITY_KINDS[opportunity.kind];
  /* istanbul ignore next — normaliseOpportunity refuses an unknown kind. */
  if (!kind) throw new OpportunityContractError('Unknown opportunity kind.', 'OPPORTUNITY_KIND_UNSUPPORTED', 400);

  const cohortLabel = String(opportunity.cohort?.label || '');
  const title = String(opportunity.title || '');
  const fields = { cohortLabel, title, narrative: kind.narrative, kindLabel: kind.label };

  for (const [field, text] of Object.entries(fields)) {
    if (/\d/.test(text)) {
      throw new OpportunityContractError(
        `${field} contains a digit and cannot be sent to a model. Every number a person sees comes from the deterministic layer.`,
        'OPPORTUNITY_PROMPT_NUMBER_REJECTED', 400
      );
    }
  }
  return Object.freeze(fields);
}

/**
 * The numbers a proposal may show, and nothing else.
 *
 * Three sources, all of them the detector's:
 *   - the cohort size, which is a count the detector made
 *   - the reachable count, when the detector supplied one with its basis
 *   - each scenario, restated as a conditional with its assumption attached
 *
 * A scenario on an opportunity whose sizing confidence is `insufficient_data`
 * is emitted WITH THAT LABEL AND NO VALUE. That is
 * docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md, "anything marked
 * insufficient_data must appear with that label and no point estimate",
 * applied to sizing rather than to feature effects.
 *
 * @returns {{projections: Array, dropped: Array}}
 */
function buildProjections(opportunity) {
  const projections = [];
  const dropped = [];

  projections.push(Object.freeze({
    id: 'cohort_size',
    label: 'People in this cohort',
    value: opportunity.cohort.size,
    unit: 'people',
    status: 'stated_count',
    assumption: null,
    basis: opportunity.cohort.sizeBasis,
    isForecast: false
  }));

  const sizing = opportunity.sizing;
  if (!sizing) {
    dropped.push(Object.freeze({
      id: 'sizing',
      reason: 'The detector supplied no sizing, so this proposal carries a count and nothing else.'
    }));
    return { projections: Object.freeze(projections), dropped: Object.freeze(dropped) };
  }

  if (sizing.reachable !== null) {
    if (!sizing.reachableBasis) {
      dropped.push(Object.freeze({
        id: 'reachable',
        reason: 'A reachable count arrived without a basis, so it is not shown. A count nobody can explain is not evidence.'
      }));
    } else {
      projections.push(Object.freeze({
        id: 'reachable',
        label: 'People in this cohort the business may currently contact',
        value: sizing.reachable,
        unit: 'people',
        status: 'stated_count',
        assumption: null,
        basis: sizing.reachableBasis,
        isForecast: false
      }));
    }
  }

  const assumptionsByID = new Map(sizing.assumptions.map(item => [item.id, item]));
  for (const scenario of sizing.scenarios) {
    const assumption = assumptionsByID.get(scenario.assumptionId) || null;
    /* istanbul ignore next — normaliseScenario already refused an unresolvable
       assumption id, so this branch is a second belt on the same trousers. */
    if (!assumption) {
      dropped.push(Object.freeze({
        id: scenario.id,
        reason: 'This scenario named an assumption that is not on the opportunity, so it is not shown.'
      }));
      continue;
    }
    if (sizing.confidence === 'insufficient_data') {
      projections.push(Object.freeze({
        id: scenario.id,
        label: scenario.label,
        value: null,
        unit: scenario.unit,
        status: 'insufficient_data',
        assumption,
        basis: 'The detector reported insufficient data to size this, so no figure is shown.',
        isForecast: false
      }));
      continue;
    }
    if (scenario.value === null) {
      dropped.push(Object.freeze({
        id: scenario.id,
        reason: 'This scenario arrived with no figure, and nothing here computes one.'
      }));
      continue;
    }
    projections.push(Object.freeze({
      id: scenario.id,
      label: scenario.label,
      value: scenario.value,
      unit: scenario.unit,
      status: 'scenario',
      assumption,
      basis: `Holds only if: ${assumption.statement} (${assumption.source})`,
      isForecast: true
    }));
  }

  const built = Object.freeze(projections);
  assertNoRevenueClaim(built);
  return { projections: built, dropped: Object.freeze(dropped) };
}

/**
 * Nothing this layer produces may be called revenue.
 *
 * A scenario is a conditional statement about what would follow IF an
 * assumption held. Labelling it revenue turns it into a number the business
 * has, and that number then gets repeated without its condition. The word is
 * refused outright, including "projected revenue": there is no phrasing of it
 * that survives being quoted out of context.
 */
function assertNoRevenueClaim(projections) {
  for (const projection of projections) {
    if (!PROJECTION_STATUSES.includes(projection.status)) {
      // A status outside the closed list means a new kind of number was added
      // without deciding how honest it has to be. That decision is not allowed
      // to default to "shown".
      throw new OpportunityContractError(
        `Projection "${projection.id}" has status "${projection.status}", which is not one of ${PROJECTION_STATUSES.join(', ')}.`,
        'OPPORTUNITY_PROJECTION_STATUS_UNKNOWN', 500
      );
    }
    const text = `${projection.label} ${projection.unit || ''}`;
    if (/revenue|earnings|profit/i.test(text)) {
      throw new OpportunityContractError(
        `A projection may not be labelled "${projection.label}". This layer produces conditional statements, never revenue.`,
        'OPPORTUNITY_REVENUE_CLAIM_REJECTED', 500
      );
    }
    if (projection.status === 'insufficient_data' && projection.value !== null) {
      throw new OpportunityContractError(
        `Projection "${projection.id}" is marked insufficient_data and still carries a figure.`,
        'OPPORTUNITY_POINT_ESTIMATE_REJECTED', 500
      );
    }
    if (projection.status === 'scenario' && !projection.assumption) {
      throw new OpportunityContractError(
        `Projection "${projection.id}" is a scenario with no assumption attached.`,
        'OPPORTUNITY_ASSUMPTION_MISSING', 500
      );
    }
  }
  return true;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ADAPTER. The detector has landed, and this is the diff.
 *
 * The header of this file said the portfolio detector was being built on a
 * parallel branch and that `normaliseOpportunity()` would be the single place
 * to reconcile the two shapes. It has landed:
 * `lib/campaigns/opportunity-detector.js` emits FINDINGS, and a finding is not
 * an opportunity. This is the whole of the translation and there is no other.
 *
 * WHICH FINDINGS BECOME OPPORTUNITIES, AND WHY THE MAP IS CLOSED
 *   `FINDING_KIND_MAP` is exhaustive and a finding whose key is not in it is
 *   REFUSED with a stated reason, never handled generically. Every kind carries
 *   a narrative sentence that goes into a model prompt and a set of mechanisms
 *   that make sense for it, so a generic mapping would produce a
 *   plausible-sounding campaign aimed at the wrong people, which is the exact
 *   failure the closed kind list exists to prevent.
 *
 *   The six one-order cohorts all map to `repeat_purchase`. They are the same
 *   population cut at different tenures and different order values, they have
 *   all bought exactly once, and the `repeat_purchase` narrative already says
 *   what may not be claimed about them.
 *
 *   THE THREE STRUCTURAL FINDINGS ARE REFUSED BY NAME.
 *     `repeat_behaviour_is_cross_product` is a fact about why an engine finds
 *       few people. There is no audience in it.
 *     `contacts_with_no_paid_order` is people who have never bought anything.
 *       A promotional message to a non-customer is where consent is thinnest,
 *       and nothing about a portfolio count is permission to find out.
 *     `one_time_buyers_whose_product_is_gone` names an audience whose only
 *       possible message is about a product that cannot be bought.
 *
 *   `lapsed_repeat_buyer` and `single_product_concentration` are declared kinds
 *   that NO current finding produces. They are listed in `KINDS_NO_FINDING_YET`
 *   so the gap is visible here rather than looking like an oversight to the
 *   next reader.
 *
 * SIZING IS DELIBERATELY DROPPED, NOT TRANSLATED
 *   The detector's sizing is `lib/campaigns/opportunity-sizing.js`: `observed`,
 *   `project` and `refuse`, with ranges, samples and named claims. This
 *   contract's sizing is `{confidence, assumptions, scenarios}`. They are two
 *   different honesty systems and a mapping between them would be a third
 *   thing, invented here, that neither file's tests cover. So `sizing` is null
 *   and `buildProjections()` does what it already does with that: the proposal
 *   carries the cohort count with its basis and nothing else. That is strictly
 *   more conservative than the detector's own output and it cannot overstate.
 *   Translating the two properly is its own reviewed change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Finding key -> opportunity kind. Closed. Anything absent is refused. */
const FINDING_KIND_MAP = Object.freeze({
  one_time_buyers: 'repeat_purchase',
  one_time_first_month: 'repeat_purchase',
  one_time_slipping: 'repeat_purchase',
  one_time_lapsed: 'repeat_purchase',
  one_time_above_typical_spend: 'repeat_purchase',
  one_time_multi_product: 'repeat_purchase'
});

/** Findings that are facts about the business rather than audiences. */
const FINDINGS_NOT_AUDIENCES = Object.freeze({
  repeat_behaviour_is_cross_product:
    'This finding explains why the same product reorder engine reaches so few people. It names no audience.',
  contacts_with_no_paid_order:
    'These people have never bought anything. A promotional message to a non customer is not something a portfolio count may authorise.',
  one_time_buyers_whose_product_is_gone:
    'The only thing a message to this group could be about is a product that can no longer be bought.'
});

/** Declared kinds that no current finding produces. Stated, not hidden. */
const KINDS_NO_FINDING_YET = Object.freeze([
  Object.freeze({
    kind: 'lapsed_repeat_buyer',
    reason: 'No cohort of repeat buyers who have gone quiet is computed yet. The buyer cohorts are all one order cuts.'
  }),
  Object.freeze({
    kind: 'single_product_concentration',
    reason: 'No cohort of buyers concentrated on one part of the range is computed yet.'
  })
]);

/**
 * One detector finding -> one normalised opportunity, or a stated refusal.
 *
 * Never throws for an unmapped finding: a scheduler walking every finding on
 * every run must be able to skip the ones that are not audiences without the
 * whole pass failing. A finding that IS mapped but whose fields fail the
 * contract still throws, because that is a real disagreement between two
 * modules and silence would hide it.
 *
 * @param {object} finding      one entry from detectOpportunities().findings
 * @param {object} [options]
 * @param {string} [options.detectorVersion]
 * @param {Date|string} [options.detectedAt]
 * @returns {{ok: true, opportunity: object}|{ok: false, reason: string, detail: string}}
 */
function opportunityFromFinding(finding, { detectorVersion = null, detectedAt = null } = {}) {
  if (!isPlainObject(finding)) {
    return { ok: false, reason: 'not_a_finding', detail: 'A finding must be an object.' };
  }
  const key = String(finding.key || '').trim();
  if (!key) {
    return { ok: false, reason: 'no_key', detail: 'A finding with no key cannot be identified.' };
  }
  if (Object.prototype.hasOwnProperty.call(FINDINGS_NOT_AUDIENCES, key)) {
    return { ok: false, reason: 'not_an_audience', detail: FINDINGS_NOT_AUDIENCES[key] };
  }
  const kind = FINDING_KIND_MAP[key];
  if (!kind) {
    return {
      ok: false,
      reason: 'no_kind_mapped',
      detail: `No opportunity kind is mapped for finding "${key}". Add it to FINDING_KIND_MAP deliberately, with a narrative that describes these people, or leave it unmapped.`
    };
  }

  // The count's provenance, in the detector's own words where it has them.
  const countedFrom = String(finding.evidence?.people?.countedFrom || '').trim();
  const sizeBasis = countedFrom
    || 'Counted per person from paid orders by the portfolio opportunity detector.';

  return {
    ok: true,
    opportunity: normaliseOpportunity({
      id: `finding:${key}`,
      kind,
      // The detector's own title. Cohort names carry no digits by
      // construction, and promptSafeText() refuses one if that ever changes.
      title: String(finding.title || ''),
      cohort: {
        key,
        label: String(finding.title || ''),
        size: Number.parseInt(finding.population, 10) || 0,
        sizeBasis,
        // The cohort keys ARE the saved segment keys in
        // lib/campaigns/segment-definitions.js, which is what lets an accepted
        // proposal resolve a real audience. A key that has not been saved as a
        // segment is refused later by assertAudienceIsSaved(), which is the
        // right place for it.
        segmentKey: String(finding.segmentKey || key)
      },
      facts: [],
      // Deliberately null. See the note above.
      sizing: null,
      detectedAt,
      detectorVersion
    })
  };
}

module.exports = {
  FINDINGS_NOT_AUDIENCES,
  FINDING_KIND_MAP,
  KINDS_NO_FINDING_YET,
  MAX_TITLE_LENGTH,
  OPPORTUNITY_CONTRACT_VERSION,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_KIND_IDS,
  OpportunityContractError,
  PROJECTION_STATUSES,
  SIZING_CONFIDENCES,
  assertNoRevenueClaim,
  buildProjections,
  normaliseOpportunity,
  opportunityFromFinding,
  promptFactsFor
};
