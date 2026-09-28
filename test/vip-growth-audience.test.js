'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCampaignService } = require('../lib/campaigns/service');
const { createSegmentService } = require('../lib/campaigns/segment-service');
const { planCampaign } = require('../lib/campaigns/planner');

const MAIN = '+15550000001';
const VIP = '+15550000002';
const WORKSPACE = 'vici';

function fakeClient(extra = {}) {
  const tables = {
    sms_contacts: [{ id: 1, phone: MAIN, name: 'Main' }, { id: 2, phone: VIP, name: 'VIP' }],
    sms_orders: [1, 2, 3].map(id => ({ id, woo_order_id: id, contact_phone: VIP,
      status: 'completed', total: 200, created_at: '2026-09-01T12:00:00Z' })),
    sms_campaign_segments: [], sms_campaign_segment_members: [], sms_campaign_segment_overrides: [],
    sms_campaign_settings: [{ workspace_id: WORKSPACE, drafts_enabled: true, max_recipients_per_campaign: 10000 }],
    ...extra
  };
  const calls = [];
  return {
    tables, calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { id: 'created', title: args.p_title, proposed_message: args.p_message,
        revision: 1, audience_definition: args.p_audience_definition }, error: null };
    },
    from(table) {
      const predicates = [], ordering = [];
      let range, limit, head = false;
      const b = {
        select(_columns, options) { head = options?.head === true; return b; },
        eq(k, v) { predicates.push(row => row[k] === v); return b; },
        neq(k, v) { predicates.push(row => row[k] !== v); return b; },
        is(k, v) { predicates.push(row => (row[k] ?? null) === v); return b; },
        not(k, _op, v) { predicates.push(row => (row[k] ?? null) !== v); return b; },
        in(k, values) { assert.ok(values.length <= 200); predicates.push(row => values.includes(row[k])); return b; },
        order(k, options = {}) { ordering.push([k, options.ascending !== false]); return b; },
        range(start, end) { range = [start, end]; return b; },
        limit(n) { limit = n; return b; },
        maybeSingle: async () => { const result = await resolve(); return { ...result, data: result.data[0] || null }; },
        then(onFulfilled, onRejected) { return resolve().then(onFulfilled, onRejected); }
      };
      async function resolve() {
        calls.push({ table, range });
        let rows = (tables[table] || []).filter(row => predicates.every(check => check(row)));
        const count = rows.length;
        rows.sort((a, c) => {
          for (const [key, asc] of ordering) {
            const diff = String(a[key] ?? '').localeCompare(String(c[key] ?? ''));
            if (diff) return asc ? diff : -diff;
          }
          return 0;
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        else rows = rows.slice(0, limit ?? 1000);
        return { data: head ? null : rows, count, error: null };
      }
      return b;
    }
  };
}

function campaign(id, fields = {}) {
  return { id, workspace_id: WORKSPACE, workflow_category: 'manual', status: 'review_required',
    archived_at: null, created_at: `2026-09-${String(id).padStart(2, '0')}T12:00:00Z`, ...fields };
}

function recipient(id, campaignID, phone) {
  return { id, campaign_id: campaignID, contact_phone: phone, workspace_id: WORKSPACE, selected: true };
}

test('scoped campaigns filter before pagination, mixed jobs stay canonical and empty drafts stay visible', async () => {
  const client = fakeClient({
    sms_campaigns: [campaign(1), campaign(2), campaign(3), campaign(4, { status: 'draft' })],
    sms_campaign_recipients: [recipient(1, 1, MAIN), recipient(2, 2, MAIN), recipient(3, 2, VIP), recipient(4, 3, VIP)]
  });
  const service = createCampaignService({ client });
  const first = await service.list({ audience: 'vip', pageSize: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.items[0].id, 4, 'empty draft remains visible');
  const third = await service.list({ audience: 'vip', pageSize: 1, page: 3 });
  assert.equal(third.items[0].id, 2);
  assert.equal(third.items[0].audience_scope, 'mixed');
  assert.equal(third.items[0].global_recipient_total, 2);
  assert.equal(third.items[0].scoped_recipient_count, 1);
  assert.equal(third.items[0].shared_visible, true);
  assert.equal((await service.reviewCount({ audience: 'vip' })).count, 2);
  assert.equal(client.calls.filter(call => call.name).length, 0, 'display never changes jobs');
});

test('scoped campaign membership reads beyond the provider 1000-row cap', async () => {
  const rows = Array.from({ length: 1100 }, (_, id) => recipient(id, 1, MAIN));
  rows.push(recipient(1101, 1, VIP));
  const client = fakeClient({ sms_campaigns: [campaign(1)], sms_campaign_recipients: rows });
  const page = await createCampaignService({ client }).list({ audience: 'vip' });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].scoped_recipient_count, 1);
  assert.ok(client.calls.some(call => call.table === 'sms_campaign_recipients' && call.range?.[0] === 1000));
});

test('archived review jobs do not inflate the scoped active review badge', async () => {
  const client = fakeClient({ sms_campaigns: [campaign(1), campaign(2, { archived_at: '2026-09-28T12:00:00Z' })],
    sms_campaign_recipients: [recipient(1, 1, VIP), recipient(2, 2, VIP)] });
  assert.equal((await createCampaignService({ client }).reviewCount({ audience: 'vip' })).count, 1);
});

test('legacy campaign list performs no extra tier reads and bad scope is rejected', async () => {
  const client = fakeClient({ sms_campaigns: [campaign(1)] });
  const service = createCampaignService({ client });
  assert.equal((await service.list()).total, 1);
  assert.deepEqual(client.calls.map(call => call.table), ['sms_campaigns']);
  await assert.rejects(service.list({ audience: 'secret' }), error => error.status === 400);
});

test('new all-contact VIP draft freezes only VIP contacts and records its explicit constraint', async () => {
  const client = fakeClient();
  await createCampaignService({ client }).create({ title: 'VIP update', message: 'Hi {{first_name}}, Vin from Vici here.',
    customerScope: 'vip', audience: { kind: 'all_contacts' } }, { id: 1 });
  const request = client.calls.find(call => call.name === 'create_sms_campaign_draft').args;
  assert.deepEqual(request.p_recipients.map(row => row.contact_phone), [VIP]);
  assert.equal(request.p_audience_definition.customer_scope, 'vip');
});

test('explicit cross-space recipients are rejected rather than silently saving a partial campaign', async () => {
  const client = fakeClient();
  await assert.rejects(createCampaignService({ client }).create({ title: 'VIP', message: 'Hello',
    customerScope: 'vip', recipients: [VIP, MAIN] }, { id: 1 }),
  error => error.code === 'CAMPAIGN_CUSTOMER_SCOPE_MISMATCH');
  assert.equal(client.calls.filter(call => call.name).length, 0);
});

test('editing copy preserves the frozen audience and stored scope without revisiting membership', async () => {
  const client = fakeClient({ sms_campaigns: [campaign('draft', {
    status: 'draft', revision: 4, proposed_message: 'Old copy', audience_definition: { customer_scope: 'vip' },
    scheduled_for: null
  })] });
  client.rpc = async (name, args) => {
    client.calls.push({ name, args });
    return { data: { ...client.tables.sms_campaigns[0], revision: 5, proposed_message: args.p_message }, error: null };
  };
  const result = await createCampaignService({ client }).edit('draft', { message: 'New copy' }, { id: 1 });
  assert.equal(result.audience_definition.customer_scope, 'vip');
  const replacement = client.calls.find(call => call.name === 'replace_sms_campaign_draft').args;
  assert.equal(replacement.p_recipients, null, 'copy edit cannot replace recipients');
  assert.equal(replacement.p_expected_revision, 4);
  assert.equal(client.calls.filter(call => call.table === 'sms_orders').length, 0, 'promotion does not rewrite frozen selection');
});

test('editing cannot silently change the workspace constraint without complete audience selection', async () => {
  const client = fakeClient({ sms_campaigns: [campaign('draft', {
    status: 'draft', revision: 4, proposed_message: 'Old copy', audience_definition: { customer_scope: 'vip' }
  })] });
  await assert.rejects(createCampaignService({ client }).edit('draft', { message: 'New copy', customerScope: 'main' }, { id: 1 }),
    error => error.code === 'CAMPAIGN_CUSTOMER_SCOPE_AUDIENCE_REQUIRED');
  assert.equal(client.calls.filter(call => call.name).length, 0);
});

test('scheduled campaigns cannot be edited by using a workspace constraint', async () => {
  const client = fakeClient({ sms_campaigns: [campaign('scheduled', {
    status: 'scheduled', revision: 4, scheduled_for: '2026-09-28T22:00:00Z'
  })] });
  await assert.rejects(createCampaignService({ client }).edit('scheduled', { message: 'New copy', customerScope: 'vip', recipients: [VIP] }, { id: 1 }),
    error => error.code === 'CAMPAIGN_NOT_EDITABLE');
  assert.equal(client.tables.sms_campaigns[0].scheduled_for, '2026-09-28T22:00:00Z');
  assert.equal(client.calls.filter(call => call.name).length, 0);
});

test('segment scoped counts come from complete membership without modifying the canonical definition', async () => {
  const client = fakeClient({
    sms_campaign_segments: [{ id: 'segment', workspace_id: WORKSPACE, segment_key: 'manual',
      segment_kind: 'manual', name: 'Mixed', member_count: 2 }],
    sms_campaign_segment_members: [{ segment_id: 'segment', workspace_id: WORKSPACE, contact_phone: MAIN },
      { segment_id: 'segment', workspace_id: WORKSPACE, contact_phone: VIP }]
  });
  const list = await createSegmentService({ client }).list({ audience: 'vip' });
  assert.equal(list.items[0].memberCount, 1);
  assert.equal(list.items[0].globalMemberCount, 2);
  assert.equal(client.tables.sms_campaign_segments[0].member_count, 2);
});

test('segment candidate picker scopes before paging and membership subtraction', async () => {
  const client = fakeClient({ sms_campaign_segments: [{ id: 's', workspace_id: WORKSPACE, segment_kind: 'manual' }] });
  const result = await createSegmentService({ client }).candidates('s', { audience: 'vip', pageSize: 1 });
  assert.equal(result.candidates.total, 1);
  assert.equal(result.candidates.items[0].contactPhone, VIP);
});

test('described all-contact preview counts only the explicitly selected customer space', async () => {
  const client = fakeClient();
  const planned = await planCampaign({ client, customerScope: 'vip', brief: 'Tell all contacts that payments are back online',
    drafter: async () => ({ candidates: [{ text: 'Vin from Vici: payments are online. Reply STOP to opt out.' }] }) });
  assert.equal(planned.customerScope, 'vip');
  assert.equal(planned.audience.matchedCount, 1);
});
