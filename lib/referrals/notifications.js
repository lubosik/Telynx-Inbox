'use strict';

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

/**
 * Produces an internal APNs preparation. It does not load devices or send.
 * The note is allowed in this short-lived push payload, but is deliberately
 * absent from the immutable Activity/audit record.
 */
function assignedNotification({ referral, recipientUserID, referrerName, contactName, note }) {
  const who = clean(referrerName, 80) || 'A teammate';
  const customer = clean(contactName, 100) || clean(referral?.contact_phone, 24) || 'a customer';
  const internalNote = clean(note, 500);
  return {
    channel: 'native_push_preparation',
    eventType: 'referrals.assigned',
    userID: String(recipientUserID),
    collapseID: `referral-${referral.id}`,
    payload: {
      aps: { alert: { title: `${who} referred ${customer}`, body: internalNote || 'Open the conversation to take over.' } },
      screen: 'conversation',
      referralID: String(referral.id),
      phone: referral.contact_phone
    }
  };
}

function resolvedNotification({ referral, recipientUserID, actorName, contactName }) {
  const who = clean(actorName, 80) || 'A teammate';
  const customer = clean(contactName, 100) || clean(referral?.contact_phone, 24) || 'a customer';
  return {
    channel: 'native_push_preparation',
    eventType: 'referrals.resolved',
    userID: String(recipientUserID),
    collapseID: `referral-${referral.id}-resolved`,
    payload: {
      aps: { alert: { title: 'Referral handled', body: `${who} resolved the referral for ${customer}.` } },
      screen: 'conversation',
      referralID: String(referral.id),
      phone: referral.contact_phone
    }
  };
}

module.exports = { assignedNotification, resolvedNotification };
