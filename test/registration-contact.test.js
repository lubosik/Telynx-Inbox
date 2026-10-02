'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { customerConflict, syncRegistrationContact } = require('../lib/cart-recovery/registration-contact');
const { createCartRecoveryService } = require('../lib/cart-recovery/service');

const EVENT = { event_type: 'consent.updated', phone: '+12125550100', customer_id: '42',
  customer_email: 'jane@example.com', customer_first_name: 'Jane', consent: { granted: false } };
const IDENTITY = { identity_id: 'identity-42', contact_phone: null, luko_contact_linked: false };

function fakeClient(initialContacts = [], initialIdentities = [{ id: 'identity-42', wordpress_user_id: '42', contact_phone: null,
  luko_contact_linked: false }]) {
  const contacts = initialContacts.map(item => ({ ...item }));
  const identities = initialIdentities.map(item => ({ ...item }));
  const client = { contacts, identities, from(table) {
    let action = 'read', payload = null, filters = [], count = Infinity;
    const rows = table === 'sms_contacts' ? contacts : identities;
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => String(row[key]) === String(value)); return q; },
      is(key, value) { filters.push(row => row[key] === value); return q; },
      limit(value) { count = value; return q; },
      insert(value) { action = 'insert'; payload = value; return q; },
      update(value) { action = 'update'; payload = value; return q; },
      async maybeSingle() { const result = await execute(); return { ...result, data: result.data?.[0] || null }; },
      async single() { const result = await execute(); return { ...result, data: result.data?.[0] || null }; },
      then(resolve, reject) { return execute().then(resolve, reject); }
    };
    async function execute() {
      if (action === 'insert') {
        if (contacts.some(row => row.phone === payload.phone)) return { data: null, error: { code: '23505' } };
        const inserted = { id: `contact-${contacts.length + 1}`, ...payload };
        contacts.push(inserted);
        return { data: [inserted], error: null };
      }
      const matched = rows.filter(row => filters.every(fn => fn(row))).slice(0, count);
      if (action === 'update') matched.forEach(row => Object.assign(row, payload));
      return { data: matched, error: null };
    }
    return q;
  } };
  return client;
}

test('completed registration creates one contact even without an SMS opt-in, and retries do not duplicate it', async () => {
  const db = fakeClient();
  const first = await syncRegistrationContact(db, EVENT, IDENTITY);
  assert.equal(first.status, 'created');
  assert.equal(db.contacts.length, 1);
  assert.equal(db.contacts[0].woo_customer_id, 42);
  assert.equal(db.contacts[0].source, 'vici_registration');
  assert.equal(db.contacts[0].last_seen, undefined, 'signup is not inbox message activity');
  assert.equal(db.contacts[0].opted_out, undefined, 'contact creation is not a consent change');
  assert.equal(db.identities[0].contact_phone, EVENT.phone);
  const second = await syncRegistrationContact(db, EVENT, { ...IDENTITY, contact_phone: EVENT.phone, luko_contact_linked: true });
  assert.equal(second.status, 'existing');
  assert.equal(db.contacts.length, 1);
});

test('a matching existing contact is reused and a blank Woo ID is linked only when email matches', async () => {
  const db = fakeClient([{ id: 'contact-1', phone: EVENT.phone, email: 'Jane@Example.com', woo_customer_id: null }]);
  const result = await syncRegistrationContact(db, EVENT, IDENTITY);
  assert.equal(result.status, 'existing');
  assert.equal(db.contacts[0].woo_customer_id, 42);
  assert.equal(db.identities[0].contact_phone, EVENT.phone);
});

test('different Woo owner, different email, and an existing other phone are quarantined', async () => {
  const ownerConflict = fakeClient([{ id: 'contact-1', phone: EVENT.phone, email: EVENT.customer_email, woo_customer_id: 99 }]);
  assert.equal((await syncRegistrationContact(ownerConflict, EVENT, IDENTITY)).status, 'identity_conflict');
  assert.equal(ownerConflict.identities[0].contact_phone, null);
  const emailConflict = fakeClient([{ id: 'contact-1', phone: EVENT.phone, email: 'other@example.com', woo_customer_id: null }]);
  assert.equal((await syncRegistrationContact(emailConflict, EVENT, IDENTITY)).status, 'identity_conflict');
  const noIdentityEvidence = fakeClient([{ id: 'contact-1', phone: EVENT.phone, email: null, woo_customer_id: null }]);
  assert.equal((await syncRegistrationContact(noIdentityEvidence, EVENT, IDENTITY)).status, 'identity_conflict');
  const otherPhone = fakeClient([{ id: 'contact-1', phone: '+12125550101', email: EVENT.customer_email, woo_customer_id: 42 }]);
  assert.equal((await syncRegistrationContact(otherPhone, EVENT, IDENTITY)).status, 'identity_conflict');
  assert.equal(otherPhone.contacts.length, 1);
});

test('phone identity mismatch or missing email never creates a contact', async () => {
  const db = fakeClient();
  assert.equal((await syncRegistrationContact(db, EVENT, { ...IDENTITY, contact_phone: '+12125550101' })).status, 'skipped');
  assert.equal((await syncRegistrationContact(db, { ...EVENT, customer_email: '' }, IDENTITY)).status, 'email_missing');
  assert.equal(db.contacts.length, 0);
  assert.equal(customerConflict({ woo_customer_id: 99 }, '42', EVENT.customer_email), true);
});

test('a signed registration event reaches the contact bridge after durable event ingestion', async () => {
  const db = fakeClient();
  const applied = [];
  db.rpc = async (name, args) => {
    if (name === 'resolve_luko_cart_customer_identity') return { data: IDENTITY, error: null };
    if (name === 'apply_luko_cart_event') { applied.push(args.p_event); return { data: { accepted: true }, error: null }; }
    throw new Error(`Unexpected RPC: ${name}`);
  };
  const service = createCartRecoveryService({ client: db, env: { LUKO_WP_STORE_ID: 'vici' },
    now: () => new Date('2026-10-01T20:00:00.000Z') });
  await service.processEvent({ event_id: 'registration-42', event_type: 'consent.updated', store: 'vici',
    occurred_at: '2026-10-01T19:59:00.000Z', customer: {
      wordpress_user_id: 42, phone: EVENT.phone, email: EVENT.customer_email,
      first_name: EVENT.customer_first_name
    }, consent: { granted: false, phone: EVENT.phone } });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].consent.granted, false);
  assert.equal(db.contacts.length, 1);
  assert.equal(db.identities[0].contact_phone, EVENT.phone);
});
