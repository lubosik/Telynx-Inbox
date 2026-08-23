'use strict';
/**
 * test/campaign-segment-contactability.test.js
 *
 * Contactability is carried as INFORMATION on a segment member. These tests
 * guard the three ways that can go wrong:
 *   - it starts filtering
 *   - it starts guessing when a source is unreadable
 *   - it starts sending 900 phone numbers in one URL, which is how the inbox
 *     went down in August (see lib/fetch-all-rows.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { IN_CHUNK_SIZE } = require('../lib/fetch-all-rows');
const {
  MAX_EVALUATED_PHONES,
  readSegmentContactability
} = require('../lib/campaigns/segment-contactability');

const NOW = new Date('2026-08-22T12:00:00.000Z');

const SETTINGS = {
  workspace_id: 'vici',
  consent_evidence_required: true,
  dnd_status_max_age_hours: 24
};

/**
 * A Supabase stand-in that records every `.in()` filter it is handed, so the
 * chunk bound is asserted rather than assumed.
 */
function fakeClient({ tables = {}, failing = new Set(), inCalls = [] } = {}) {
  return {
    from(table) {
      const builder = {
        _table: table,
        select() { return builder; },
        eq() { return builder; },
        limit() { return builder; },
        order() { return builder; },
        in(column, values) {
          inCalls.push({ table, column, count: values.length });
          builder._phones = values;
          return builder;
        },
        maybeSingle() {
          if (failing.has(table)) return Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } });
          return Promise.resolve({ data: tables[table] ?? null, error: null });
        },
        then(resolve, reject) {
          if (failing.has(table)) {
            return Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } })
              .then(resolve, reject);
          }
          const rows = (tables[table] || []).filter(row => {
            if (!builder._phones) return true;
            const phone = row.phone || row.contact_phone;
            return builder._phones.includes(phone);
          });
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        }
      };
      return builder;
    }
  };
}

test('a fully cleared, fully consenting person is reported contactable', async () => {
  const phone = '+15555550123';
  const result = await readSegmentContactability({
    client: fakeClient({
      tables: {
        sms_campaign_settings: SETTINGS,
        sms_contacts: [{
          phone, opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive',
          ghl_dnd_synced_at: '2026-08-22T11:00:00Z'
        }],
        sms_sent_log: [],
        sms_consent_events: [{
          id: 1, contact_phone: phone, event_type: 'opt_in', source: 'checkout',
          evidence_ref: 'order:1', purpose: 'promotional_sms', brand_id: 'vici',
          occurred_at: '2026-06-01T10:00:00Z'
        }],
        sms_campaign_suppressions: [],
        sms_customer_commercial_eligibility: [{
          contact_phone: phone, status: 'clear', observed_at: '2026-08-22T11:00:00Z', expires_at: null
        }]
      }
    }),
    phones: [phone], now: NOW
  });
  assert.deepEqual(result.byPhone.get(phone), { contactable: true, reasons: [], explanations: [] });
});

test('the live shape of production is reported honestly: matched, and not contactable', async () => {
  // Exactly the state on the live database: the commercial eligibility table
  // is empty, and HighLevel DND has never been synced for these people.
  const phones = ['+15555550001', '+15555550002'];
  const result = await readSegmentContactability({
    client: fakeClient({
      tables: {
        sms_campaign_settings: SETTINGS,
        sms_contacts: phones.map(phone => ({ phone, opted_out: false })),
        sms_sent_log: [],
        sms_consent_events: [],
        sms_campaign_suppressions: [],
        sms_customer_commercial_eligibility: []
      }
    }),
    phones, now: NOW
  });
  for (const phone of phones) {
    assert.deepEqual(result.byPhone.get(phone).reasons, ['support_state_unknown', 'dnd_unknown']);
    assert.equal(result.byPhone.get(phone).contactable, false);
  }
});

test('an opted-out person is not contactable, whatever else is true of them', async () => {
  const phone = '+15555550123';
  const result = await readSegmentContactability({
    client: fakeClient({
      tables: {
        sms_campaign_settings: SETTINGS,
        sms_contacts: [{
          phone, opted_out: true, ghl_dnd: false, ghl_sms_dnd_status: 'inactive',
          ghl_dnd_synced_at: '2026-08-22T11:00:00Z'
        }],
        sms_sent_log: [],
        sms_consent_events: [],
        sms_campaign_suppressions: [],
        sms_customer_commercial_eligibility: [{
          contact_phone: phone, status: 'clear', observed_at: '2026-08-22T11:00:00Z', expires_at: null
        }]
      }
    }),
    phones: [phone], now: NOW
  });
  assert.deepEqual(result.byPhone.get(phone).reasons, ['opted_out']);
});

test('an unreadable eligibility source degrades to "we do not know", never to "yes"', async () => {
  const phone = '+15555550123';
  const result = await readSegmentContactability({
    client: fakeClient({
      failing: new Set(['sms_contacts']),
      tables: {
        sms_campaign_settings: SETTINGS,
        sms_sent_log: [], sms_consent_events: [], sms_campaign_suppressions: [],
        sms_customer_commercial_eligibility: [{
          contact_phone: phone, status: 'clear', observed_at: '2026-08-22T11:00:00Z', expires_at: null
        }]
      }
    }),
    phones: [phone], now: NOW
  });
  assert.equal(result.byPhone.get(phone).contactable, false);
  assert.deepEqual(result.byPhone.get(phone).reasons, ['eligibility_check_failed']);
});

test('an unreadable clearance source is a reason, not a crash and not a pass', async () => {
  const phone = '+15555550123';
  const result = await readSegmentContactability({
    client: fakeClient({
      failing: new Set(['sms_customer_commercial_eligibility']),
      tables: {
        sms_campaign_settings: SETTINGS,
        sms_contacts: [{
          phone, opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive',
          ghl_dnd_synced_at: '2026-08-22T11:00:00Z'
        }],
        sms_sent_log: [],
        sms_consent_events: [{
          id: 1, contact_phone: phone, event_type: 'opt_in', source: 'checkout',
          evidence_ref: 'order:1', purpose: 'promotional_sms', brand_id: 'vici',
          occurred_at: '2026-06-01T10:00:00Z'
        }],
        sms_campaign_suppressions: []
      }
    }),
    phones: [phone], now: NOW
  });
  assert.deepEqual(result.byPhone.get(phone).reasons, ['support_state_source_unavailable']);
});

test('every phone filter is chunked; this is the bound that took the inbox down when it was missing', async () => {
  const inCalls = [];
  const phones = Array.from({ length: 907 }, (_, index) => `+1555${String(5550000 + index).padStart(7, '0')}`);
  await readSegmentContactability({
    client: fakeClient({ inCalls, tables: { sms_campaign_settings: SETTINGS } }),
    phones, now: NOW
  });
  assert.ok(inCalls.length > 0);
  for (const call of inCalls) assert.ok(call.count <= IN_CHUNK_SIZE, `${call.table} sent ${call.count} values`);
});

test('an oversized segment is counted and admitted to, not silently truncated', async () => {
  const phones = Array.from({ length: MAX_EVALUATED_PHONES + 1 },
    (_, index) => `+1555${String(1000000 + index).padStart(7, '0')}`);
  const result = await readSegmentContactability({ client: fakeClient(), phones, now: NOW });
  assert.equal(result.evaluated, false);
  assert.equal(result.notEvaluatedReason, 'segment_too_large_to_evaluate');
  assert.equal(result.phoneCount, phones.length);
  assert.equal(result.byPhone.size, 0);
});

test('missing campaign settings is a reason on the row, not an exception', async () => {
  const phone = '+15555550123';
  const result = await readSegmentContactability({
    client: fakeClient({ tables: { sms_customer_commercial_eligibility: [] } }),
    phones: [phone], now: NOW
  });
  assert.ok(result.byPhone.get(phone).reasons.includes('campaign_settings_missing'));
});

// ── The service carries it, and never filters on it ─────────────────────────

/**
 * A Supabase-shaped fake with `then` and nothing else, matching the one in
 * test/campaign-segment-api.test.js. `.catch()` on a builder throws before the
 * query is sent, so the fake must not offer one.
 */
function segmentClient(tables) {
  function builder(table) {
    const state = { table, filters: [], range: null, single: false, count: false };
    const chain = {
      select(_columns, options) { state.count = options?.count === 'exact'; return chain; },
      eq(column, value) { state.filters.push(['eq', column, value]); return chain; },
      is(column, value) { state.filters.push(['is', column, value]); return chain; },
      in(column, values) { state.filters.push(['in', column, values]); return chain; },
      order() { return chain; },
      limit() { return chain; },
      range(from, to) { state.range = [from, to]; return chain; },
      maybeSingle() { state.single = true; return chain; },
      then(resolve, reject) {
        const rows = tables[table] || [];
        const filtered = rows.filter(row => state.filters.every(([kind, column, value]) => {
          if (kind === 'eq') return String(row[column]) === String(value);
          if (kind === 'is') return row[column] === value;
          if (kind === 'in') return value.includes(row[column]);
          return true;
        }));
        const paged = state.range ? filtered.slice(state.range[0], state.range[1] + 1) : filtered;
        const result = state.single
          ? { data: paged[0] || null, error: null }
          : { data: paged, error: null, count: state.count ? filtered.length : null };
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return chain;
  }
  return {
    from: builder,
    rpc: () => Promise.resolve({ data: null, error: { code: '42883', message: 'no rpc' } })
  };
}

test('segment detail shows everyone who matches, and says how many can be messaged', async () => {
  const { createSegmentService } = require('../lib/campaigns/segment-service');
  const phones = ['+15555550001', '+15555550002', '+15555550003'];
  const client = segmentClient({
    sms_campaign_settings: [{ ...SETTINGS }],
    sms_campaign_segments: [{
      id: 's0000000-0000-4000-8000-000000000001', workspace_id: 'vici',
      segment_key: 'reorder_due', name: 'Reorder due', description: null,
      segment_kind: 'automatic', definition: { definitionKey: 'reorder_due' },
      rule_version: 'segments-2026-08-23', member_count: 3, last_computed_at: null,
      archived_at: null, created_at: '2026-08-23T00:00:00Z', updated_at: '2026-08-23T00:00:00Z'
    }],
    sms_campaign_segment_members: phones.map((contact_phone, index) => ({
      id: `m${index}`, segment_id: 's0000000-0000-4000-8000-000000000001', workspace_id: 'vici',
      contact_phone, contact_id: null, contact_name_snapshot: null,
      membership_source: 'computed', inclusion_evidence: { detector: 'reorder' },
      evidence_rule_version: 'segments-2026-08-23', engine_matched: true, engine_evidence: null,
      first_seen_at: '2026-08-23T00:00:00Z', last_seen_at: '2026-08-23T00:00:00Z'
    })),
    sms_campaign_segment_overrides: [],
    // Nobody has clearance and nobody has a DND sync. This is production.
    sms_contacts: phones.map(phone => ({ phone, opted_out: false })),
    sms_sent_log: [],
    sms_consent_events: [],
    sms_campaign_suppressions: [],
    sms_customer_commercial_eligibility: []
  });

  const result = await createSegmentService({ client })
    .detail('s0000000-0000-4000-8000-000000000001', {});

  // Everyone who matches is still listed. This is the whole point: an empty
  // list is indistinguishable from a broken engine.
  assert.equal(result.members.items.length, 3);
  assert.equal(result.members.total, 3);
  // And the screen can be honest about the gap.
  assert.equal(result.contactability.matched, 3);
  assert.equal(result.contactability.contactable, 0);
  assert.ok(result.contactability.reasons.some(row => row.reason === 'support_state_unknown'));
  for (const member of result.members.items) {
    assert.equal(member.contactability.contactable, false);
    assert.ok(member.contactability.reasons.length > 0);
  }
});
