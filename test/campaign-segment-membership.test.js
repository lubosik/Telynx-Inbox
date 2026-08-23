'use strict';
/**
 * The reconciliation rules for an automatic segment, and proof that the tests
 * asserting them are not vacuous.
 *
 * The load-bearing rule is: A MANUAL EXCLUSION SURVIVES RECOMPUTE. It is the
 * one an operator relies on and the one a refactor is most likely to lose,
 * because the natural way to write a recompute is "delete everything, insert
 * what the engine said" and that quietly reinstates every excluded person.
 *
 * MUTATION EVIDENCE at the bottom of this file: the exclusion filter is
 * deleted from a copy of the real source, the copy is loaded, and the tests
 * that claim to cover the rule are asserted to FAIL against it. If they pass
 * against the broken version they are not testing anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  activeOverrides,
  computedSetDigest,
  isMaterialSegmentChange,
  reconcileSegmentMembership
} = require('../lib/campaigns/segment-membership');

const SOURCE = path.join(__dirname, '..', 'lib', 'campaigns', 'segment-membership.js');

function computed(...phones) {
  return phones.map(phone => ({
    contactPhone: phone,
    contactID: null,
    contactName: null,
    inclusionEvidence: { detector: 'reorder', confidence: 'high', medianIntervalDays: 30 }
  }));
}

function existing(...rows) {
  return rows.map(([phone, source = 'computed']) => ({
    contactPhone: phone,
    membershipSource: source,
    inclusionEvidence: { detector: 'reorder' },
    engineMatched: true
  }));
}

function exclusion(phone, { revokedAt = null } = {}) {
  return { contactPhone: phone, overrideType: 'exclude', revokedAt };
}

function forcedInclude(phone, { revokedAt = null } = {}) {
  return { contactPhone: phone, overrideType: 'include', revokedAt };
}

// ── The rule ────────────────────────────────────────────────────────────────

test('a manual exclusion survives a recompute that would otherwise re-add the person', () => {
  const result = reconcileSegmentMembership({
    existing: [],
    computed: computed('+15550000001', '+15550000002', '+15550000003'),
    overrides: [exclusion('+15550000002')]
  });

  assert.deepEqual(result.submit.map(row => row.contactPhone), ['+15550000001', '+15550000003']);
  assert.deepEqual(result.members.map(row => row.contactPhone), ['+15550000001', '+15550000003']);
  assert.deepEqual(result.blockedByExclusion, ['+15550000002']);
  assert.equal(result.summary.excludedCount, 1);
  assert.equal(result.summary.memberCount, 2);
});

test('the exclusion holds across repeated recomputes, not just the first one', () => {
  const overrides = [exclusion('+15550000002')];
  let members = [];
  for (let run = 0; run < 5; run += 1) {
    const result = reconcileSegmentMembership({
      existing: members.map(row => ({
        contactPhone: row.contactPhone,
        membershipSource: row.membershipSource,
        inclusionEvidence: row.inclusionEvidence,
        engineMatched: row.engineMatched
      })),
      computed: computed('+15550000001', '+15550000002', '+15550000003'),
      overrides
    });
    members = result.members;
    assert.equal(
      members.some(row => row.contactPhone === '+15550000002'), false,
      `the excluded person reappeared on run ${run + 1}`
    );
  }
});

test('an exclusion evicts somebody who is already a member', () => {
  const result = reconcileSegmentMembership({
    existing: existing(['+15550000001'], ['+15550000002']),
    computed: computed('+15550000001', '+15550000002'),
    overrides: [exclusion('+15550000002')]
  });
  assert.deepEqual(result.members.map(row => row.contactPhone), ['+15550000001']);
  assert.deepEqual(result.left, ['+15550000002']);
});

test('revoking the exclusion lets the engine decide again', () => {
  const stillExcluded = reconcileSegmentMembership({
    existing: [],
    computed: computed('+15550000002'),
    overrides: [exclusion('+15550000002')]
  });
  assert.deepEqual(stillExcluded.members, []);

  const revoked = reconcileSegmentMembership({
    existing: [],
    computed: computed('+15550000002'),
    overrides: [exclusion('+15550000002', { revokedAt: '2026-08-23T10:00:00.000Z' })]
  });
  assert.deepEqual(revoked.members.map(row => row.contactPhone), ['+15550000002']);
});

test('an exclusion beats a force include, because refusing to contact is the safe direction', () => {
  const overrides = [forcedInclude('+15550000009'), exclusion('+15550000009')];
  assert.deepEqual([...activeOverrides(overrides).include], []);
  assert.deepEqual([...activeOverrides(overrides).exclude], ['+15550000009']);

  const result = reconcileSegmentMembership({
    existing: existing(['+15550000009', 'forced_include']),
    computed: computed('+15550000009'),
    overrides
  });
  assert.deepEqual(result.members, []);
  assert.deepEqual(result.blockedByExclusion, ['+15550000009']);
});

// ── Force includes ──────────────────────────────────────────────────────────

test('a force-included person stays when the engine no longer matches them', () => {
  const result = reconcileSegmentMembership({
    existing: existing(['+15550000001'], ['+15550000007', 'forced_include']),
    computed: computed('+15550000001'),
    overrides: [forcedInclude('+15550000007')]
  });

  const kept = result.members.find(row => row.contactPhone === '+15550000007');
  assert.ok(kept, 'the force-included person must remain a member');
  assert.equal(kept.membershipSource, 'forced_include');
  assert.equal(kept.engineMatched, false, 'the UI must be able to say the engine no longer agrees');
  assert.equal(kept.engineEvidence, null);
  assert.deepEqual(result.keptByOverride, ['+15550000007']);
  assert.deepEqual(result.left, [], 'a person kept by an override has not left');
});

test('a force-included person the engine DOES match keeps their human reason', () => {
  const humanReason = { source: 'manual_override_include', reason: 'Called in and asked' };
  const result = reconcileSegmentMembership({
    existing: [{
      contactPhone: '+15550000007',
      membershipSource: 'forced_include',
      inclusionEvidence: humanReason,
      engineMatched: false
    }],
    computed: computed('+15550000007'),
    overrides: [forcedInclude('+15550000007')]
  });

  const row = result.members[0];
  assert.equal(row.membershipSource, 'forced_include');
  assert.deepEqual(row.inclusionEvidence, humanReason, 'the human reason must not be overwritten');
  assert.equal(row.engineMatched, true);
  assert.equal(row.engineEvidence.detector, 'reorder', 'the engine view is recorded alongside');
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test('recompute is idempotent: the second run on an unchanged world moves nobody', () => {
  const set = computed('+15550000001', '+15550000002');
  const first = reconcileSegmentMembership({ existing: [], computed: set, overrides: [] });
  assert.equal(first.summary.joinedCount, 2);
  assert.equal(first.summary.leftCount, 0);

  const second = reconcileSegmentMembership({
    existing: first.members.map(row => ({
      contactPhone: row.contactPhone,
      membershipSource: row.membershipSource,
      inclusionEvidence: row.inclusionEvidence,
      engineMatched: row.engineMatched
    })),
    computed: set,
    overrides: []
  });
  assert.equal(second.summary.joinedCount, 0);
  assert.equal(second.summary.leftCount, 0);
  assert.equal(second.summary.refreshedCount, 2);
  assert.deepEqual(
    second.members.map(row => row.contactPhone),
    first.members.map(row => row.contactPhone)
  );
});

test('the digest is stable across input order and changes when the facts change', () => {
  const a = computedSetDigest(computed('+15550000002', '+15550000001'));
  const b = computedSetDigest(computed('+15550000001', '+15550000002'));
  assert.equal(a, b, 'the run key must not depend on the order rows came back in');

  const changed = computedSetDigest([
    ...computed('+15550000001'),
    { contactPhone: '+15550000002', inclusionEvidence: { detector: 'reorder', medianIntervalDays: 31 } }
  ]);
  assert.notEqual(a, changed, 'different evidence must produce a different run key');
});

test('duplicate computed rows for one person collapse to one member', () => {
  const result = reconcileSegmentMembership({
    existing: [],
    computed: [...computed('+15550000001'), ...computed('+15550000001')],
    overrides: []
  });
  assert.equal(result.members.length, 1);
  assert.equal(result.summary.joinedCount, 1);
});

// ── Materiality ─────────────────────────────────────────────────────────────

test('a change is material when the segment is created or when people move', () => {
  assert.equal(isMaterialSegmentChange({ joinedCount: 0, leftCount: 0 }, { created: true }), true);
  assert.equal(isMaterialSegmentChange({ joinedCount: 0, leftCount: 0 }), false);
  assert.equal(isMaterialSegmentChange({ joinedCount: 1, leftCount: 0 }), true);
  assert.equal(isMaterialSegmentChange({ joinedCount: 0, leftCount: 3 }), true);
  assert.equal(isMaterialSegmentChange({ joinedCount: 2, leftCount: 0 }, { minimumDelta: 5 }), false);
  assert.equal(isMaterialSegmentChange({ joinedCount: 3, leftCount: 2 }, { minimumDelta: 5 }), true);
  // A nonsense threshold must not disable the feature silently.
  assert.equal(isMaterialSegmentChange({ joinedCount: 1, leftCount: 0 }, { minimumDelta: 0 }), true);
});

// ── Mutation evidence ───────────────────────────────────────────────────────

/**
 * Load a deliberately broken copy of the real module.
 *
 * The copy is written to a scratch directory and required fresh, so nothing
 * here can leave a mutated module in the require cache for another test.
 */
function loadMutant(name, mutate) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation "${name}" changed nothing, so it proves nothing`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-mutant-'));
  const file = path.join(directory, 'segment-membership.js');
  fs.writeFileSync(file, mutated);
  try {
    delete require.cache[file];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(file);
  } finally {
    // The module is already loaded into memory; the files on disk are not
    // needed and must not accumulate.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('MUTATION: removing the exclusion filter breaks the exclusion tests', () => {
  // The mutation is the exact regression this rule exists to prevent: recompute
  // stops consulting the exclusion set and re-adds everybody the engine matched.
  const mutant = loadMutant('drop the exclusion check', source => source.replace(
    `    if (exclude.has(phone)) {
      blockedByExclusion.push(phone);
      continue;
    }`,
    '    // mutated: the exclusion check is gone'
  ));

  const result = mutant.reconcileSegmentMembership({
    existing: [],
    computed: computed('+15550000001', '+15550000002', '+15550000003'),
    overrides: [exclusion('+15550000002')]
  });

  // Against the mutant, the assertions of the two exclusion tests above are
  // false. Asserting that here is what makes those tests non-vacuous.
  assert.deepEqual(
    result.submit.map(row => row.contactPhone),
    ['+15550000001', '+15550000002', '+15550000003'],
    'the mutant must reinstate the excluded person, otherwise the mutation was not real'
  );
  assert.notDeepEqual(result.blockedByExclusion, ['+15550000002']);
  assert.throws(
    () => assert.equal(
      result.members.some(row => row.contactPhone === '+15550000002'), false
    ),
    /Expected values to be strictly equal|AssertionError/,
    'the live assertion "the excluded person is not a member" must fail against the mutant'
  );
});

test('MUTATION: treating a revoked override as still active breaks the revoke test', () => {
  const mutant = loadMutant('ignore revocation', source => source.replace(
    '    if (!row || row.revokedAt || row.revoked_at) continue;',
    '    if (!row) continue;'
  ));

  const revoked = mutant.reconcileSegmentMembership({
    existing: [],
    computed: computed('+15550000002'),
    overrides: [exclusion('+15550000002', { revokedAt: '2026-08-23T10:00:00.000Z' })]
  });
  assert.deepEqual(
    revoked.members, [],
    'the mutant must keep honouring a revoked exclusion, otherwise the mutation was not real'
  );
  assert.throws(
    () => assert.deepEqual(revoked.members.map(row => row.contactPhone), ['+15550000002']),
    /AssertionError/,
    'the live assertion "revoking lets the engine decide again" must fail against the mutant'
  );
});

test('MUTATION: dropping force-include preservation breaks the kept-by-override test', () => {
  const mutant = loadMutant('drop force include preservation', source => source.replace(
    `    if (row.membershipSource === 'forced_include' && !exclude.has(phone)) {
      keptByOverride.push(phone);
      continue;
    }`,
    '    // mutated: force includes are no longer preserved'
  ));

  const result = mutant.reconcileSegmentMembership({
    existing: existing(['+15550000001'], ['+15550000007', 'forced_include']),
    computed: computed('+15550000001'),
    overrides: [forcedInclude('+15550000007')]
  });
  assert.deepEqual(result.keptByOverride, []);
  assert.deepEqual(result.left, ['+15550000007']);
  assert.throws(
    () => assert.ok(result.members.find(row => row.contactPhone === '+15550000007')),
    /AssertionError/,
    'the live assertion "a force-included person stays" must fail against the mutant'
  );
});
