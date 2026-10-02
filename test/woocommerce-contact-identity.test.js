'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wooContactOwnershipConflict } = require('../lib/woocommerce-contact-identity');

const phone = '+12125550100';
const base = { phone, customerID: 42, incomingEmail: 'jane@example.com',
  phoneContact: { phone, woo_customer_id: 42, email: 'jane@example.com' }, customerContacts: [] };

test('Woo customer sync reuses a matching contact and quarantines competing ownership', () => {
  assert.equal(wooContactOwnershipConflict(base), false);
  assert.equal(wooContactOwnershipConflict({ ...base, phoneContact: { ...base.phoneContact, woo_customer_id: 99 } }), true);
  assert.equal(wooContactOwnershipConflict({ ...base, customerContacts: [{ phone: '+12125550101' }] }), true);
  assert.equal(wooContactOwnershipConflict({ ...base, customerContacts: [base.phoneContact, base.phoneContact] }), true);
  assert.equal(wooContactOwnershipConflict({ ...base, phoneContact: { phone, woo_customer_id: null, email: 'other@example.com' } }), true);
  assert.equal(wooContactOwnershipConflict({ ...base, phoneContact: { phone, woo_customer_id: null, email: 'Jane@Example.com' } }), false);
});

test('guest order cannot erase a registered customer or change an unrelated email', () => {
  assert.equal(wooContactOwnershipConflict({ ...base, customerID: null }), false);
  assert.equal(wooContactOwnershipConflict({ ...base, customerID: null, incomingEmail: 'other@example.com' }), true);
});
