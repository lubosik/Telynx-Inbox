'use strict';

function email(value) { return String(value || '').trim().toLowerCase(); }

function wooContactOwnershipConflict({ phone, customerID, incomingEmail, phoneContact, customerContacts = [] }) {
  const id = customerID == null || Number(customerID) <= 0 ? null : String(customerID);
  if (customerContacts.length > 1 || customerContacts.some(row => row.phone !== phone)) return true;
  if (!phoneContact) return false;
  if (id && phoneContact.woo_customer_id != null && String(phoneContact.woo_customer_id) !== id) return true;
  // A shared phone is not enough to merge people. Require a matching email
  // when no stable customer ID on the contact can establish ownership.
  if (phoneContact.woo_customer_id == null && (!email(incomingEmail) || email(phoneContact.email) !== email(incomingEmail))) return true;
  if (!id && email(phoneContact.email) && email(incomingEmail) && email(phoneContact.email) !== email(incomingEmail)) return true;
  return false;
}

module.exports = { wooContactOwnershipConflict };
