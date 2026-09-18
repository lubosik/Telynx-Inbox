'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CampaignRequestError,
  assertReviewableCopy,
  createCampaignService,
  loadAllContactsAudience
} = require('../lib/campaigns/service');

const MESSAGE = 'Vin from Vici: You can now pay by card or Apple Pay at checkout. Reply STOP to opt out.';

function contactsClient(rows, { limit = 10000 } = {}) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      if (table === 'sms_contacts') {
        const query = {
          select() { return query; },
          order() { return query; },
          async range(from, to) {
            calls.push({ table, from, to });
            return { data: rows.slice(from, to + 1), error: null };
          }
        };
        return query;
      }
      if (table === 'sms_campaign_settings') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return { data: { drafts_enabled: true, max_recipients_per_campaign: limit }, error: null };
          }
        };
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: { id: 'campaign-1', title: args.p_title, proposed_message: args.p_message, revision: 1 },
        error: null
      };
    }
  };
  return client;
}

test('All Contacts snapshots more than 500 people without client recipients or truncation', async () => {
  const rows = Array.from({ length: 1128 }, (_, index) => ({
    id: index + 1,
    phone: `+1555${String(index).padStart(7, '0')}`,
    first_name: `Customer ${index + 1}`,
    last_name: null,
    name: null
  }));
  const client = contactsClient(rows);
  const result = await createCampaignService({ client }).create({
    title: 'Payment options', message: MESSAGE,
    audience: { kind: 'all_contacts' },
    recipients: [{ phone: '+15559999999' }]
  }, { id: 4 });

  assert.equal(result.recipientCount, 1128);
  const request = client.calls.find(call => call.name === 'create_sms_campaign_draft').args;
  assert.equal(request.p_recipients.length, 1128);
  assert.equal(request.p_audience_definition.kind, 'all_contacts');
  assert.equal(request.p_audience_definition.requested_count, 1128);
  assert.equal(request.p_recipients.some(row => row.contact_phone === '+15559999999'), false,
    'client-supplied recipients must be ignored for server-owned All Contacts');
  assert.deepEqual(client.calls.filter(call => call.table === 'sms_contacts').map(call => call.from),
    [0, 1000]);
});

test('All Contacts deduplicates normalized phones and records invalid rows', async () => {
  const client = contactsClient([
    { id: 1, phone: '(555) 000-0001', first_name: 'A' },
    { id: 2, phone: '+15550000001', first_name: 'B' },
    { id: 3, phone: 'bad', first_name: 'C' }
  ]);
  const result = await loadAllContactsAudience(client, 10);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.recipients.length, 1);
  assert.equal(result.duplicatePhoneCount, 1);
  assert.equal(result.invalidPhoneCount, 1);
  assert.equal(result.recipients[0].contact_id, 1);
});

test('manual campaign draft stores the exact phone-safe wording reviewed by the editor', async () => {
  const client = contactsClient([{ id: 1, phone: '+15550000001', first_name: 'Sam' }]);
  await createCampaignService({ client }).create({
    title: 'Payment options',
    message: 'Vin from Vici: We’re accepting cards and Apple Pay now. Reply STOP to opt out.',
    audience: { kind: 'all_contacts' }
  }, { id: 4 });

  const request = client.calls.find(call => call.name === 'create_sms_campaign_draft').args;
  assert.equal(request.p_message,
    "Vin from Vici: We're accepting cards and Apple Pay now. Reply STOP to opt out.");
  assert.doesNotThrow(() => assertReviewableCopy(request.p_message));
});

test('All Contacts refuses a workspace cap rather than silently saving a partial list', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: index + 1, phone: `+1555${String(index).padStart(7, '0')}`
  }));
  const client = contactsClient(rows, { limit: 500 });
  await assert.rejects(
    () => createCampaignService({ client }).create({
      title: 'Payment options', message: MESSAGE, audience: { kind: 'all_contacts' }
    }, { id: 4 }),
    error => error instanceof CampaignRequestError
      && error.code === 'CAMPAIGN_AUDIENCE_LIMIT_EXCEEDED'
  );
  assert.equal(client.calls.some(call => call.name === 'create_sms_campaign_draft'), false);
});

test('review gate accepts Vin opt-out copy and rejects unsafe manual copy', () => {
  assert.doesNotThrow(() => assertReviewableCopy(MESSAGE));
  assert.throws(
    () => assertReviewableCopy('Credit cards accepted now!'),
    error => error instanceof CampaignRequestError
      && error.code === 'CAMPAIGN_COPY_NOT_REVIEWABLE'
  );
  assert.throws(
    () => assertReviewableCopy('Vin from Vici: Cards are live ✅ Reply STOP to opt out.'),
    error => error instanceof CampaignRequestError
      && /Replace or remove "✅" at position \d+/.test(error.message)
      && !/GSM|03\.38|UCS-2|U\+/i.test(error.message)
  );
});
