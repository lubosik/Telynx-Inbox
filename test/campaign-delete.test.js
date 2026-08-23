'use strict';
/**
 * Deleting a campaign, and the line between destroying one and archiving it.
 *
 * THE RULE: a campaign that has been approved, scheduled, or has ANY recipient
 * that reached a provider must not be destroyable. Those rows are the only
 * evidence that a promotional message was authorised and delivered, and the
 * revenue attribution chain hangs off them. Only an unapproved draft with no
 * approval history is genuinely deleted.
 *
 * The rule is enforced in two places and both are checked here:
 *   1. campaignLooksDestructible() in lib/campaigns/service.js, the pre-flight
 *      that decides whether the route may write a `campaign.deleted` audit row.
 *   2. delete_sms_campaign in scripts/campaign-segments-migration.sql, which
 *      repeats every check transactionally and has no force path.
 *
 * MUTATION EVIDENCE is at the bottom: the status guard is removed from a copy
 * of the real source and the tests asserting the rule are shown to fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const createCampaignRouter = require('../routes/campaigns');
const { archivedFilter, campaignLooksDestructible } = require('../lib/campaigns/service');

const ROOT = path.join(__dirname, '..');
const SERVICE_SOURCE = path.join(ROOT, 'lib', 'campaigns', 'service.js');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'scripts/campaign-segments-migration.sql'), 'utf8');

function draft(overrides = {}) {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    title: 'Test draft',
    status: 'draft',
    revision: 1,
    campaign_type: 'manual',
    workflow_category: 'manual',
    archived_at: null,
    approved_at: null,
    approval_audit_recorded_at: null,
    scheduled_for: null,
    submitted_for_review_at: null,
    completed_at: null,
    rejected_at: null,
    cancelled_at: null,
    ...overrides
  };
}

function handler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}

/** A campaign service stub whose remove() records what it was asked to do. */
function stubService(campaign, outcome) {
  const calls = [];
  return {
    calls,
    deletionPreview: async () => ({ campaign, destructible: campaignLooksDestructible(campaign) }),
    remove: async (id, options, actor) => {
      calls.push({ id, options, actorID: actor?.id ?? null });
      return {
        outcome,
        campaignId: id,
        blockers: outcome === 'archived' ? ['status_scheduled'] : [],
        title: campaign.title,
        status: campaign.status,
        recipientsRemoved: outcome === 'deleted' ? 3 : 0
      };
    }
  };
}

// ── The pre-flight rule ─────────────────────────────────────────────────────

test('only an untouched draft looks destructible', () => {
  assert.equal(campaignLooksDestructible(draft()), true);
});

test('a campaign that was approved, scheduled or sent is never destructible', () => {
  const undestroyable = [
    ['a non-draft status', draft({ status: 'scheduled' })],
    ['a sent campaign', draft({ status: 'completed' })],
    ['a campaign mid-send', draft({ status: 'sending' })],
    ['an approved campaign', draft({ status: 'approved', approved_at: '2026-08-20T00:00:00.000Z' })],
    ['a draft carrying an approval timestamp', draft({ approved_at: '2026-08-20T00:00:00.000Z' })],
    ['a draft whose approval audit row exists', draft({ approval_audit_recorded_at: '2026-08-20T00:00:00.000Z' })],
    ['a scheduled draft', draft({ scheduled_for: '2026-09-01T00:00:00.000Z' })],
    ['a draft that reached review', draft({ submitted_for_review_at: '2026-08-20T00:00:00.000Z' })],
    ['a completed draft', draft({ completed_at: '2026-08-20T00:00:00.000Z' })],
    ['a rejected campaign', draft({ status: 'rejected', rejected_at: '2026-08-20T00:00:00.000Z' })],
    ['a cancelled campaign', draft({ status: 'cancelled', cancelled_at: '2026-08-20T00:00:00.000Z' })],
    ['an already archived draft', draft({ archived_at: '2026-08-20T00:00:00.000Z' })],
    ['nothing at all', null],
    ['an empty object', {}]
  ];
  for (const [label, campaign] of undestroyable) {
    assert.equal(campaignLooksDestructible(campaign), false, `${label} must not be destructible`);
  }
});

test('the archived list filter defaults to the working list', () => {
  assert.equal(archivedFilter(undefined), 'live');
  assert.equal(archivedFilter(''), 'live');
  assert.equal(archivedFilter('false'), 'live');
  assert.equal(archivedFilter('nonsense'), 'live');
  assert.equal(archivedFilter('true'), 'archived');
  assert.equal(archivedFilter(true), 'archived');
  assert.equal(archivedFilter('all'), 'all');
});

// ── The route ───────────────────────────────────────────────────────────────

test('DELETE on an unapproved draft writes the audit row BEFORE destroying it', async () => {
  const order = [];
  const campaign = draft();
  const service = stubService(campaign, 'deleted');
  service.remove = async (...args) => {
    order.push('delete');
    return {
      outcome: 'deleted', campaignId: campaign.id, blockers: [],
      title: campaign.title, status: 'draft', recipientsRemoved: 0
    };
  };
  let auditInput;
  const router = createCampaignRouter({
    service,
    campaignDeletionAuditWriter: async input => {
      order.push('audit');
      auditInput = input;
      return { recorded: true, id: 42 };
    }
  });

  const res = response();
  await handler(router, 'delete', '/:id')({
    params: { id: campaign.id }, body: {}, actor: { id: 7 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.outcome, 'deleted');
  assert.deepEqual(order, ['audit', 'delete'], 'the audit row must exist before the row is destroyed');
  assert.equal(auditInput.eventType, 'campaign.deleted');
  assert.equal(auditInput.entityId, campaign.id);
  assert.equal(auditInput.previousState.status, 'draft');
  assert.equal(auditInput.fingerprint, `campaign-deleted:${campaign.id}`);
});

test('a failed audit write refuses the delete outright', async () => {
  const campaign = draft();
  let removeCalled = false;
  const router = createCampaignRouter({
    service: {
      deletionPreview: async () => ({ campaign, destructible: true }),
      remove: async () => { removeCalled = true; return { outcome: 'deleted' }; }
    },
    campaignDeletionAuditWriter: async () => ({ recorded: false, reason: 'write_failed' })
  });

  const res = response();
  await handler(router, 'delete', '/:id')({ params: { id: campaign.id }, body: {}, actor: { id: 7 } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'CAMPAIGN_DELETE_AUDIT_REQUIRED');
  assert.equal(removeCalled, false, 'nothing may be destroyed without a recorded audit row');
});

test('a duplicate audit fingerprint is a success, not a reason to refuse', async () => {
  const campaign = draft();
  let removeCalled = false;
  const router = createCampaignRouter({
    service: {
      deletionPreview: async () => ({ campaign, destructible: true }),
      remove: async () => {
        removeCalled = true;
        return { outcome: 'deleted', campaignId: campaign.id, blockers: [], recipientsRemoved: 0 };
      }
    },
    campaignDeletionAuditWriter: async () => ({ recorded: false, reason: 'duplicate' })
  });
  const res = response();
  await handler(router, 'delete', '/:id')({ params: { id: campaign.id }, body: {}, actor: { id: 7 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(removeCalled, true);
});

test('DELETE on a sent campaign archives it and never writes campaign.deleted', async () => {
  const campaign = draft({ status: 'completed', completed_at: '2026-08-20T00:00:00.000Z' });
  const service = stubService(campaign, 'archived');
  const deletionAudits = [];
  const router = createCampaignRouter({
    service,
    campaignDeletionAuditWriter: async input => {
      deletionAudits.push(input);
      return { recorded: true, id: 1 };
    }
  });

  const res = response();
  await handler(router, 'delete', '/:id')({
    params: { id: campaign.id }, body: { reason: 'clutter' }, actor: { id: 7 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.outcome, 'archived');
  assert.deepEqual(
    deletionAudits, [],
    'campaign.deleted must never be written for a campaign that was not destroyed'
  );
  assert.deepEqual(service.calls[0].options, { mode: 'auto', reason: 'clutter' });
  assert.equal(service.calls[0].actorID, 7);
});

test('an explicit archive request archives even a destructible draft', async () => {
  const campaign = draft();
  const service = stubService(campaign, 'archived');
  const deletionAudits = [];
  const router = createCampaignRouter({
    service,
    campaignDeletionAuditWriter: async input => { deletionAudits.push(input); return { recorded: true }; }
  });

  const res = response();
  await handler(router, 'delete', '/:id')({
    params: { id: campaign.id }, body: { mode: 'archive' }, actor: { id: 7 }
  }, res);

  assert.equal(res.payload.outcome, 'archived');
  assert.deepEqual(deletionAudits, []);
  assert.equal(service.calls[0].options.mode, 'archive');
});

test('the route offers no way to ask for a forced delete', async () => {
  const campaign = draft({ status: 'completed' });
  const service = stubService(campaign, 'archived');
  const router = createCampaignRouter({
    service,
    campaignDeletionAuditWriter: async () => ({ recorded: true })
  });

  for (const body of [{ mode: 'force' }, { mode: 'delete' }, { mode: 'hard' }, { force: true }]) {
    const res = response();
    await handler(router, 'delete', '/:id')({ params: { id: campaign.id }, body, actor: { id: 7 } }, res);
    assert.equal(res.payload.outcome, 'archived', `body ${JSON.stringify(body)} must not force a delete`);
  }
  // Every one of those normalised to the 'auto' mode, which the RPC then
  // resolves to an archive because the campaign carries evidence.
  assert.deepEqual([...new Set(service.calls.map(call => call.options.mode))], ['auto']);
});

// ── The database half ───────────────────────────────────────────────────────

test('delete_sms_campaign refuses to destroy anything carrying evidence', () => {
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.delete_sms_campaign/);
  // Every blocker the brief names, plus the ones a reader would expect.
  for (const blocker of [
    'approval_history', 'recipient_events', 'commercial_contact_ledger',
    'linked_messages', 'linked_sent_log', 'recipient_reached_provider',
    'revenue_attribution', 'approved', 'scheduled', 'submitted_for_review'
  ]) {
    assert.ok(MIGRATION.includes(`'${blocker}'`), `delete_sms_campaign must check for ${blocker}`);
  }
  // The provider footprint test must cover an in-flight attempt, not only a
  // completed send.
  assert.match(MIGRATION, /provider_attempt_started_at IS NOT NULL/);
  assert.match(MIGRATION, /provider_idempotency_key IS NOT NULL/);
  assert.match(MIGRATION, /state IN \('claimed', 'sending', 'sent', 'delivered', 'failed', 'reconciliation_required'\)/);
  // Any blocker at all forces the archive branch.
  assert.match(MIGRATION, /IF p_mode = 'archive' OR array_length\(v_blockers, 1\) IS NOT NULL THEN/);
  // And there is no force mode to ask for.
  assert.match(MIGRATION, /NOT IN \('auto', 'archive'\)[\s\S]{0,120}campaign_delete_mode_invalid/);
  // No force parameter, and no third mode value anywhere in the signature.
  assert.doesNotMatch(MIGRATION, /p_force\b/);
  assert.doesNotMatch(MIGRATION, /p_mode\s*=\s*'(?!auto|archive)/);
});

test('archival is additive and destroys nothing on an existing table', () => {
  assert.match(MIGRATION, /ALTER TABLE public\.sms_campaigns\s*\n\s*ADD COLUMN IF NOT EXISTS archived_at timestamptz/);
  assert.doesNotMatch(MIGRATION, /\bDROP TABLE\b/i);
  assert.doesNotMatch(MIGRATION, /\bDROP COLUMN\b/i);
  assert.doesNotMatch(MIGRATION, /\bTRUNCATE\b/i);
  // The only DELETEs in the file are inside the two functions that are allowed
  // to remove rows, never a bare statement at migration scope.
  for (const line of MIGRATION.split('\n')) {
    if (!/^\s*DELETE FROM/.test(line)) continue;
    assert.ok(/^\s{2,}DELETE FROM/.test(line), `unindented DELETE at migration scope: ${line.trim()}`);
  }
});

// ── Mutation evidence ───────────────────────────────────────────────────────

function loadMutant(name, mutate) {
  const source = fs.readFileSync(SERVICE_SOURCE, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation "${name}" changed nothing, so it proves nothing`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-delete-mutant-'));
  // The module requires siblings by relative path, so the copy must sit in the
  // real directory tree. Use a uniquely named file next to the original and
  // remove it again immediately after loading.
  const file = path.join(ROOT, 'lib', 'campaigns', `.service-mutant-${path.basename(directory)}.js`);
  fs.writeFileSync(file, mutated);
  try {
    delete require.cache[file];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(file);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('MUTATION: dropping the status guard makes a sent campaign look destructible', () => {
  const mutant = loadMutant('drop the draft-only guard', source => source.replace(
    "  if (!campaign || campaign.status !== 'draft') return false;",
    '  if (!campaign) return false;'
  ));

  // The mutant says yes to exactly the campaigns the rule exists to protect.
  assert.equal(
    mutant.campaignLooksDestructible(draft({ status: 'completed' })), true,
    'the mutation must actually loosen the rule, otherwise it proves nothing'
  );
  assert.throws(
    () => assert.equal(mutant.campaignLooksDestructible(draft({ status: 'completed' })), false),
    /AssertionError/,
    'the live assertion "a sent campaign is not destructible" must fail against the mutant'
  );
  assert.throws(
    () => assert.equal(mutant.campaignLooksDestructible(draft({ status: 'sending' })), false),
    /AssertionError/
  );
});

test('MUTATION: dropping the timestamp guard makes an approved draft look destructible', () => {
  const mutant = loadMutant('drop the approval timestamp guard', source => source.replace(
    `  return [
    'approved_at', 'approval_audit_recorded_at', 'scheduled_for',
    'submitted_for_review_at', 'completed_at', 'rejected_at', 'cancelled_at'
  ].every(column => campaign[column] === null || campaign[column] === undefined);`,
    '  return true;'
  ));

  const approvedDraft = draft({ approved_at: '2026-08-20T00:00:00.000Z' });
  assert.equal(
    mutant.campaignLooksDestructible(approvedDraft), true,
    'the mutation must actually loosen the rule'
  );
  assert.throws(
    () => assert.equal(mutant.campaignLooksDestructible(approvedDraft), false),
    /AssertionError/,
    'the live assertion "an approved draft is not destructible" must fail against the mutant'
  );
});

test('MUTATION: a route that skipped the pre-flight would delete without an audit row', async () => {
  // This mutation is expressed as a stub rather than a source edit, because the
  // thing being proved is that the ROUTE consults the pre-flight at all. A stub
  // that reports every campaign destructible stands in for a pre-flight that
  // was removed.
  const campaign = draft({ status: 'completed' });
  const deletionAudits = [];
  const router = createCampaignRouter({
    service: {
      deletionPreview: async () => ({ campaign, destructible: true }),
      remove: async () => ({
        outcome: 'deleted', campaignId: campaign.id, blockers: [], recipientsRemoved: 0
      })
    },
    campaignDeletionAuditWriter: async input => { deletionAudits.push(input); return { recorded: true }; }
  });

  const res = response();
  await handler(router, 'delete', '/:id')({ params: { id: campaign.id }, body: {}, actor: { id: 7 } }, res);

  // With a broken pre-flight the route DOES write campaign.deleted for a sent
  // campaign, which is exactly what the honest test above asserts never happens.
  assert.equal(deletionAudits.length, 1);
  assert.throws(
    () => assert.deepEqual(deletionAudits, []),
    /AssertionError/,
    'the live assertion "a sent campaign never writes campaign.deleted" must fail here'
  );
  // And the real service is the backstop: delete_sms_campaign would have
  // returned 'archived' regardless, which is why the honest path is safe even
  // if this pre-flight is wrong.
  assert.match(MIGRATION, /'recipient_reached_provider'/);
});
