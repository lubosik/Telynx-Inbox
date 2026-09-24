'use strict';

/**
 * Vici's permanent VIP definition.
 *
 * Membership describes commercial history only. It is never consent to send,
 * never bypasses STOP/DND/quiet hours, and never creates a second contact.
 */
const VIP_SEGMENT_KEY = 'best_repeat_customers';
const VIP_MIN_PAID_ORDERS = 3;
const VIP_MIN_LIFETIME_SPEND = 500;

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function automaticVIP(fact = {}) {
  const orders = finite(fact.orderCount) ?? 0;
  const spend = finite(fact.lifetimeSpend) ?? 0;
  return orders >= VIP_MIN_PAID_ORDERS && spend >= VIP_MIN_LIFETIME_SPEND;
}

function attentionState(fact = {}) {
  const days = finite(fact.daysSinceLastOrder);
  const cadence = finite(fact.cadenceMedianDays);
  if (days === null || cadence === null || cadence <= 0) return 'active';
  if (days > cadence * 1.5) return 'needs_attention';
  if (days > cadence) return 'due_soon';
  return 'active';
}

function progressState(fact = {}) {
  const orders = finite(fact.orderCount) ?? 0;
  const spend = finite(fact.lifetimeSpend) ?? 0;
  if (orders === 2 && spend >= VIP_MIN_LIFETIME_SPEND) return 'one_order_away';
  if (orders === 1 && spend >= VIP_MIN_LIFETIME_SPEND) return 'high_value_first_order';
  if (orders >= VIP_MIN_PAID_ORDERS && spend < VIP_MIN_LIFETIME_SPEND) {
    return 'frequent_building_value';
  }
  return 'standard';
}

function classifyVIPCustomer(fact = {}, { manuallyIncluded = false, segmentID = null } = {}) {
  const automatic = automaticVIP(fact);
  const vip = automatic || manuallyIncluded === true;
  const lifetimeSpend = Math.max(0, finite(fact.lifetimeSpend) ?? 0);
  return {
    customer_tier: vip ? 'vip' : 'standard',
    vip_state: vip ? attentionState(fact) : null,
    vip_source: automatic ? 'automatic' : (manuallyIncluded ? 'manual' : null),
    vip_automatic: automatic,
    vip_manual_override: manuallyIncluded === true,
    vip_progress: vip ? null : progressState(fact),
    vip_segment_id: segmentID,
    paid_order_count: Math.max(0, Math.trunc(finite(fact.orderCount) ?? 0)),
    lifetime_spend_cents: Math.round(lifetimeSpend * 100),
    days_since_last_order: finite(fact.daysSinceLastOrder),
    typical_order_gap_days: finite(fact.cadenceMedianDays)
  };
}

module.exports = {
  VIP_MIN_LIFETIME_SPEND,
  VIP_MIN_PAID_ORDERS,
  VIP_SEGMENT_KEY,
  attentionState,
  automaticVIP,
  classifyVIPCustomer,
  progressState
};
