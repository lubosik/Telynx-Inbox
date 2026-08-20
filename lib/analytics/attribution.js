'use strict';

const PAYMENT_REMINDER_FLOWS = new Set([
  'failed-msg1',
  'failed-msg2',
  'failed-msg3',
  'hold-msg1',
  'hold-msg2',
  'hold-msg3',
  'hold-failed-nudge'
]);

const CONFIDENCE = Object.freeze({
  direct: 1,
  strong: 0.9,
  influenced: 0.6,
  unattributed: 0
});

const DEFAULT_WINDOWS = Object.freeze({
  paymentRecoveryStrongSeconds: 24 * 60 * 60,
  paymentRecoveryMaximumSeconds: 24 * 60 * 60
});

// Deliberately narrow. This text signal can strengthen structured payment
// evidence, but it can never create revenue attribution on its own.
const PAYMENT_CONFIRMATION = /^(?:(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:sent|paid|transferred|completed|done)(?:\s+(?:it|this|that|payment|the payment|venmo|zelle))?|payment\s+sent|all\s+paid)(?:[,.!\s]*(?:thanks|thank you|ty|thx)?)?[.!\s]*$/i;

function asTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isActualReminder(row) {
  return PAYMENT_REMINDER_FLOWS.has(row?.flow_type) &&
    Boolean(row?.telnyx_message_id) &&
    row?.delivery_status === 'delivered' &&
    asTime(row?.sent_at) !== null &&
    !String(row?.message_body || '').startsWith('BACKFILL ');
}

function isPaymentConfirmation(body) {
  return PAYMENT_CONFIRMATION.test(String(body || '').trim().replace(/[’‘]/g, "'"));
}

/**
 * Classify one authoritative paid order.
 *
 * A paid order is never attributed merely because a text exists. The action
 * must be an actual logged payment reminder for the exact order, sent before
 * the authoritative payment timestamp. A customer reply is supporting
 * evidence only after those structured conditions have been met.
 */
function classifyPaymentRecovery({
  order,
  reminders = [],
  inboundMessages = [],
  identityMatched = true,
  ambiguousOrderMatch = false,
  windows = DEFAULT_WINDOWS
}) {
  const orderID = String(order?.id ?? order?.order_id ?? order?.woo_order_id ?? '');
  const paidAt = order?.paid_at || order?.date_paid_gmt || order?.date_paid;
  const paidTime = asTime(paidAt);
  const grossAmount = money(order?.amount ?? order?.total);
  const refundedAmount = Math.min(grossAmount, money(order?.refunded_amount));
  const financials = {
    grossAmount,
    refundedAmount,
    netAmount: Math.max(0, grossAmount - refundedAmount)
  };

  const unattributed = reason => ({
    orderID,
    confidenceLevel: 'unattributed',
    confidenceScore: CONFIDENCE.unattributed,
    category: null,
    workflow: null,
    action: null,
    conversionAt: paidAt || null,
    attributionWindowSeconds: null,
    reason,
    evidence: { authoritativePayment: Boolean(paidTime), exactOrderMatch: false },
    ...financials
  });

  if (!orderID) return unattributed('Order identifier is missing.');
  if (paidTime === null) return unattributed('No authoritative payment timestamp is available.');
  if (grossAmount <= 0) return unattributed('The authoritative order amount is zero or invalid.');
  if (!identityMatched) return unattributed('The reminder customer does not match the authoritative order customer.');
  if (ambiguousOrderMatch) return unattributed('Multiple or merged outstanding orders make the payment evidence ambiguous.');

  const eligible = reminders
    .filter(isActualReminder)
    .filter(row => String(row.order_id) === orderID)
    .map(row => ({ ...row, actionTime: asTime(row.sent_at) }))
    .filter(row => row.actionTime < paidTime)
    .sort((a, b) => a.actionTime - b.actionTime);

  if (!eligible.length) {
    return unattributed('No genuine payment reminder for this exact order preceded payment.');
  }

  const action = eligible.at(-1);
  const elapsedSeconds = Math.floor((paidTime - action.actionTime) / 1000);
  if (elapsedSeconds > windows.paymentRecoveryMaximumSeconds) {
    return unattributed('Payment occurred outside the configured recovery window.');
  }

  const explicitReply = inboundMessages
    .map(message => ({ ...message, messageTime: asTime(message.created_at) }))
    .filter(message => message.messageTime !== null)
    .filter(message => message.messageTime >= action.actionTime && message.messageTime <= paidTime)
    .find(message => isPaymentConfirmation(message.body));

  let confidenceLevel;
  let reason;
  if (explicitReply) {
    confidenceLevel = 'direct';
    reason = 'Exact order paid after its reminder, with a customer payment confirmation before payment completed.';
  } else if (elapsedSeconds <= windows.paymentRecoveryStrongSeconds) {
    confidenceLevel = 'strong';
    reason = 'Exact order paid within 24 hours of its reminder; no explicit confirmation was required.';
  } else return unattributed('Payment occurred outside the configured strong recovery window.');

  return {
    orderID,
    confidenceLevel,
    confidenceScore: CONFIDENCE[confidenceLevel],
    category: 'payment_recovery',
    workflow: action.flow_type,
    action: {
      id: action.id ? String(action.id) : null,
      messageID: action.telnyx_message_id || null,
      occurredAt: action.sent_at
    },
    conversionAt: paidAt,
    attributionWindowSeconds: elapsedSeconds,
    reason,
    evidence: {
      authoritativePayment: true,
      exactOrderMatch: true,
      reminderFlow: action.flow_type,
      reminderLogID: action.id ? String(action.id) : null,
      paymentConfirmationMessageID: explicitReply?.id ? String(explicitReply.id) : null
    },
    ...financials
  };
}

function confidenceScoreFor(level) {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE, level) ? CONFIDENCE[level] : null;
}

module.exports = {
  CONFIDENCE,
  DEFAULT_WINDOWS,
  PAYMENT_REMINDER_FLOWS,
  classifyPaymentRecovery,
  confidenceScoreFor,
  isActualReminder,
  isPaymentConfirmation
};
