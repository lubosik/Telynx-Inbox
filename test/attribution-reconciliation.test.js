'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAttributionCandidate,
  stageAttributionCandidate
} = require('../lib/analytics/reconciliation');
const { chooseAttributionWinner } = require('../lib/campaigns/attribution-policy');

function payload(overrides = {}) {
  return {
    workspace_id: 'vici', order_id: '18472', gross_amount: '219.00',
    refunded_amount: '0.00', net_amount: '219.00', category: 'payment_recovery',
    workflow: 'payment_recovery', confidence_level: 'direct', confidence_score: '1.00',
    supporting_evidence: { exactOrderMatch: true, paymentConfirmationMessageID: 'reply-1' },
    ...overrides
  };
}

test('candidate builder enforces the fixed confidence mapping and stable identity', () => {
  const candidate = buildAttributionCandidate(payload(), {
    sourceType: 'payment_recovery', sourceKey: 'payment-recovery:18472',
    financialStatus: 'processing', financialObservedAt: '2026-08-22T10:00:00Z'
  });
  assert.equal(candidate.evidence_rank, 700);
  assert.equal(candidate.financial_invalidated, false);
  assert.equal(candidate.financial_observed_at, '2026-08-22T10:00:00.000Z');
  assert.throws(() => buildAttributionCandidate(payload({ confidence_score: '0.90' }), {
    sourceType: 'payment_recovery', sourceKey: 'x', financialObservedAt: '2026-08-22T10:00:00Z'
  }), /fixed mapping/);

  const cancelled = buildAttributionCandidate(payload(), {
    sourceType: 'campaign', sourceKey: 'campaign:c1:r1',
    financialStatus: 'cancelled', financialObservedAt: '2026-08-22T10:01:00Z'
  });
  assert.equal(cancelled.financial_invalidated, true);
  assert.equal(cancelled.invalidation_reason, 'Authoritative order status is cancelled.');
});

test('staging uses one atomic RPC and never performs a client read/choose/write', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { order_id: '18472', confidence_level: 'direct' }, error: null };
  } };
  const result = await stageAttributionCandidate(client, payload(), {
    sourceType: 'payment_recovery', sourceKey: 'payment-recovery:18472',
    financialStatus: 'processing', financialObservedAt: '2026-08-22T10:00:00Z'
  });
  assert.equal(result.confidence_level, 'direct');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'stage_revenue_attribution_candidate');
});

test('global policy selects only one winner across payment and campaign', () => {
  const common = { workspaceID: 'vici', orderID: '18472', netAmount: '219.00', attributionWindowSeconds: 900 };
  const campaign = { ...common, sourceType: 'campaign', actionID: 'campaign-action', confidenceLevel: 'strong', supportingEvidence: { codes: ['exact_target_product'] } };
  const payment = { ...common, sourceType: 'payment_recovery', actionID: 'payment-action', confidenceLevel: 'strong', supportingEvidence: { codes: ['exact_payment_reminder'] } };
  const result = chooseAttributionWinner([campaign, payment]);
  assert.equal(result.winner.actionID, 'payment-action');
  assert.equal(result.displaced.length, 1);
});

test('reconciliation migration serializes, rejects stale state and protects the RPC', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'attribution-reconciliation-migration.sql'), 'utf8');
  assert.match(sql, /UNIQUE \(workspace_id, order_id, source_type, source_key\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS revenue_attribution_candidates_one_winner_idx/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\(v_workspace\), hashtext\(v_order\)\)/);
  assert.match(sql, /EXCLUDED\.financial_observed_at >= public\.revenue_attribution_order_state\.financial_observed_at/);
  assert.match(sql, /EXCLUDED\.candidate_observed_at >= public\.revenue_attribution_candidates\.candidate_observed_at/);
  assert.match(sql, /ON CONFLICT \(workspace_id, order_id\) DO UPDATE SET/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.stage_revenue_attribution_candidate\(jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.stage_revenue_attribution_candidate\(jsonb\) TO service_role/);
});

test('live Woo attribution delegates persistence to the reconciler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analytics', 'events.js'), 'utf8');
  assert.match(source, /stageAttributionCandidate\(supabase, payload/);
  assert.doesNotMatch(source, /from\('revenue_attributions'\)[\s\S]{0,600}upsert\(payload/);
});
