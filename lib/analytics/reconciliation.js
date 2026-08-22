'use strict';

const { evidenceRank } = require('../campaigns/attribution-policy');

const CONFIDENCE_SCORES = Object.freeze({
  direct: 1,
  strong: 0.9,
  influenced: 0.6,
  unattributed: 0
});
const SOURCES = new Set(['payment_recovery', 'campaign', 'call', 'conversation']);
const FINANCIALLY_INVALID_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash']);

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function buildAttributionCandidate(payload, {
  sourceType,
  sourceKey,
  financialStatus,
  financialObservedAt
} = {}) {
  const confidenceLevel = required(payload?.confidence_level, 'confidence_level');
  const expectedScore = CONFIDENCE_SCORES[confidenceLevel];
  if (expectedScore === undefined || Number(payload?.confidence_score) !== expectedScore) {
    throw new Error('confidence_level and confidence_score must use the documented fixed mapping.');
  }
  const normalizedSource = required(sourceType, 'sourceType');
  if (!SOURCES.has(normalizedSource)) throw new Error('sourceType is not supported.');
  const observed = required(financialObservedAt, 'financialObservedAt');
  if (!Number.isFinite(Date.parse(observed))) throw new Error('financialObservedAt must be an ISO timestamp.');
  const normalizedFinancialStatus = String(financialStatus || 'unknown').toLowerCase();

  return {
    ...payload,
    workspace_id: required(payload?.workspace_id, 'workspace_id'),
    order_id: required(payload?.order_id, 'order_id'),
    candidate_source_type: normalizedSource,
    candidate_source_key: required(sourceKey, 'sourceKey'),
    evidence_rank: evidenceRank({
      ...payload,
      confidenceLevel,
      supportingEvidence: payload?.supporting_evidence
    }),
    financial_status: normalizedFinancialStatus,
    financial_observed_at: new Date(observed).toISOString(),
    financial_invalidated: Boolean(payload?.invalidated_at) ||
      Number(payload?.net_amount) <= 0 || FINANCIALLY_INVALID_STATUSES.has(normalizedFinancialStatus),
    invalidation_reason: payload?.invalidation_reason ||
      (FINANCIALLY_INVALID_STATUSES.has(normalizedFinancialStatus)
        ? `Authoritative order status is ${normalizedFinancialStatus}.`
        : null)
  };
}

/**
 * Atomically stages one candidate and asks Postgres to recompute the single
 * workspace/order winner. There is deliberately no JS read/choose/write gap.
 */
async function stageAttributionCandidate(client, payload, options) {
  if (!client?.rpc) throw new Error('A database client with rpc() is required.');
  const candidate = buildAttributionCandidate(payload, options);
  const { data, error } = await client.rpc('stage_revenue_attribution_candidate', {
    p_candidate: candidate
  });
  if (error) throw error;
  return data;
}

module.exports = {
  CONFIDENCE_SCORES,
  FINANCIALLY_INVALID_STATUSES,
  SOURCES,
  buildAttributionCandidate,
  stageAttributionCandidate
};
