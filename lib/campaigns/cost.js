'use strict';
/**
 * lib/campaigns/cost.js — what a campaign will cost before anybody approves it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   Approving a campaign committed real money and the screen said nothing
 *   about it. The owner found out a message had become two segments from a
 *   warning icon, asked what it meant, and the honest answer was "it costs
 *   twice as much" — which is exactly the sort of thing that should be on the
 *   approval screen rather than deduced from a badge.
 *
 * WHAT A SEGMENT IS
 *
 *   The billing unit, not a message. A GSM-7 text up to 160 septets is one
 *   segment. Longer, and it is split for transmission and joined back up by
 *   the handset — so the recipient still sees ONE message, but every part is
 *   billed. Concatenated parts carry a 7-septet reassembly header, so they
 *   hold 153 each rather than 160. A 200-septet message is therefore two
 *   segments, not "one and a bit".
 *
 * THE RATE IS A SETTING, NOT A FACT
 *
 *   Nothing here knows what the provider actually charges: that depends on the
 *   plan, the destination and the carrier surcharges of the day. The rate is
 *   read from the environment and the arithmetic is returned alongside every
 *   figure, so a number that looks wrong can be checked rather than believed.
 *   An estimate presented as a fact is worse than no estimate.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { RULES } = require('./copy-rules');
const { septetLength } = require('./copy-validator');

/**
 * What one segment costs, in US dollars.
 *
 * The default is a plausible US 10DLC figure INCLUDING carrier pass-through,
 * and it is a placeholder rather than a quote. Set SMS_COST_PER_SEGMENT_USD to
 * whatever the provider actually bills and every estimate follows it.
 */
const DEFAULT_COST_PER_SEGMENT_USD = 0.0079;

function costPerSegment(env = process.env) {
  const raw = env?.SMS_COST_PER_SEGMENT_USD;
  // An UNSET or empty variable must fall back, not read as zero. Number('')
  // is 0, which is finite and non-negative, so an env var somebody cleared
  // would have made every campaign estimate as free — the one wrong answer
  // that nobody questions.
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_COST_PER_SEGMENT_USD;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_COST_PER_SEGMENT_USD;
}

/**
 * How many segments one message costs.
 *
 * Not `ceil(length / 160)`. A message that fits in one segment uses the full
 * 160; the moment it does not, EVERY part drops to 153 because each carries
 * the reassembly header. Getting this wrong under-counts long messages by one
 * segment at exactly the sizes campaigns tend to land on.
 */
function segmentsFor(text) {
  const septets = septetLength(String(text || ''));
  if (septets === 0) return 0;
  const single = RULES.length.septetsPerSingleSegment;
  if (septets <= single) return 1;
  return Math.ceil(septets / RULES.length.septetsPerConcatenatedSegment);
}

/** Round to whole cents, so a total never displays as 6.000000000001. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100) / 100;
}

/**
 * Estimate a campaign from its RENDERED messages.
 *
 * Rendered, not the template: the template has no length until a name and a
 * product are in it, and the whole point of the estimate is the real send.
 * Messages are counted individually rather than multiplying one length by the
 * audience, because a long name can push one person into a second segment
 * while everybody else stays in one.
 */
function estimateCampaignCost({ messages = [], env = process.env } = {}) {
  const rate = costPerSegment(env);
  let segments = 0;
  let oneSegment = 0;
  let multiSegment = 0;
  let longest = 0;

  for (const message of messages) {
    const count = segmentsFor(message);
    segments += count;
    if (count <= 1) oneSegment += 1; else multiSegment += 1;
    longest = Math.max(longest, septetLength(String(message || '')));
  }

  const recipients = messages.length;
  return {
    recipients,
    segments,
    oneSegment,
    multiSegment,
    longestSeptets: longest,
    costPerSegmentUsd: rate,
    estimatedCostUsd: toCents(segments * rate),
    // The arithmetic, so a figure that looks wrong can be checked rather than
    // taken on trust.
    workedOut: `${recipients} recipients, ${segments} segments at `
      + `$${rate.toFixed(4)} = $${toCents(segments * rate).toFixed(2)}`,
    // What it would cost if every message fitted one segment, so the price of
    // the longer wording is visible rather than implied.
    ifAllSingleSegmentUsd: toCents(recipients * rate),
    estimateOnly: true
  };
}

module.exports = {
  DEFAULT_COST_PER_SEGMENT_USD,
  costPerSegment,
  estimateCampaignCost,
  segmentsFor,
  toCents
};
