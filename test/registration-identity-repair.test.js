'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRepair } = require('../scripts/repair-vici-registration-identities');

const source = { id: 42, phone: '+12125550100', email: 'jane@example.com' };
const wordpress = { wordpress_user_id: 42, phone: source.phone, verified: true,
  evidence: { source: 'vici_registration', occurred_at: '2026-10-01T18:00:00Z',
    version: 'vici_marketing_sms_voice_v1', disclosure: 'Consent',
    privacy_url: 'https://vicipeptides.com/privacy-policy/',
    terms_url: 'https://vicipeptides.com/terms-and-conditions/' } };
const identity = { id: 'identity-42', wordpress_user_id: '42', customer_email: source.email,
  contact_phone: null, luko_contact_linked: false };
const contact = { id: 'contact-42', phone: source.phone, email: source.email, woo_customer_id: 42 };
const input = { source, wordpress, identity, contact, otherIdentities: [] };

test('only exact signed WordPress, contact and identity evidence qualifies for the repair', () => {
  assert.equal(classifyRepair(input), 'safe_repair');
  assert.equal(classifyRepair({ ...input, wordpress: { ...wordpress, verified: false } }), 'not_verified');
  assert.equal(classifyRepair({ ...input, contact: { ...contact, woo_customer_id: 99 } }), 'contact_customer_conflict');
  assert.equal(classifyRepair({ ...input, contact: { ...contact, email: 'other@example.com' } }), 'email_mismatch');
  assert.equal(classifyRepair({ ...input, identity: { ...identity, contact_phone: '+12125550101' } }), 'identity_phone_conflict');
  assert.equal(classifyRepair({ ...input, otherIdentities: [{ id: 'other', wordpress_user_id: '99' }] }),
    'shared_phone_identity_conflict');
});
