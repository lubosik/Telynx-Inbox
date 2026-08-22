'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const TYPE_PRIORITY = Object.freeze({
  back_in_stock_requested: 800,
  back_in_stock_repeat_buyer: 760,
  back_in_stock: 720,
  reorder_personal_high: 650,
  reorder_personal: 620,
  unconverted_enquiry: 560,
  winback: 480,
  manual_exact_product: 360,
  manual: 260,
  generic_promotion: 100
});

const DEFAULT_EXPIRY_DAYS = Object.freeze({
  back_in_stock_requested: 7,
  back_in_stock_repeat_buyer: 7,
  back_in_stock: 7,
  reorder_personal_high: 21,
  reorder_personal: 21,
  unconverted_enquiry: 7,
  winback: 30,
  manual_exact_product: 14,
  manual: 14,
  generic_promotion: 7
});

function asTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function opportunityType(opportunity) {
  return String(opportunity?.type || opportunity?.opportunityType || opportunity?.campaignType || '').trim();
}

function evaluateOpportunityExpiry(opportunity, context = {}, options = {}) {
  const now = asTime(options.now || new Date());
  if (now === null) throw new Error('now must be a valid date.');

  const type = opportunityType(opportunity);
  const reasons = [];
  if (opportunity?.status && ['converted', 'closed', 'expired', 'cancelled'].includes(opportunity.status)) {
    reasons.push(`status_${opportunity.status}`);
  }
  if (context.converted || context.reordered || context.customerPurchased) reasons.push('customer_converted');
  if (context.consentActive === false || context.optedOut || context.dnd || context.pendingRevocation) {
    reasons.push('contact_no_longer_eligible');
  }
  if (context.supportProblemOpen || context.refundOpen) reasons.push('customer_experience_block');

  if (type.startsWith('back_in_stock') && context.productAvailable !== true) {
    reasons.push('product_unavailable');
  }
  if (type.startsWith('reorder') && context.productAvailable === false) {
    reasons.push('product_unavailable');
  }
  if (opportunity?.offerEndsAt && asTime(opportunity.offerEndsAt) !== null && asTime(opportunity.offerEndsAt) <= now) {
    reasons.push('offer_ended');
  }

  const explicitExpiry = asTime(opportunity?.expiresAt);
  const sourceTime = asTime(opportunity?.detectedAt || opportunity?.createdAt || opportunity?.sourceOccurredAt);
  const configuredDays = Number(options.expiryDaysByType?.[type] ?? DEFAULT_EXPIRY_DAYS[type]);
  const derivedExpiry = sourceTime !== null && Number.isFinite(configuredDays) && configuredDays > 0
    ? sourceTime + (configuredDays * DAY_MS)
    : null;
  const expiryTime = explicitExpiry ?? derivedExpiry;

  // Unknown lifetime is not safe for a sendable opportunity. The orchestrator
  // can still keep it as a non-sendable candidate until a bounded expiry is set.
  if (expiryTime === null) reasons.push('expiry_unknown');
  else if (expiryTime <= now) reasons.push('opportunity_stale');

  return {
    active: reasons.length === 0,
    expired: reasons.length > 0,
    reasons: [...new Set(reasons)],
    expiresAt: expiryTime === null ? null : new Date(expiryTime).toISOString()
  };
}

function compareOpportunities(left, right) {
  const leftType = opportunityType(left);
  const rightType = opportunityType(right);
  const priorityDifference = (TYPE_PRIORITY[rightType] || 0) - (TYPE_PRIORITY[leftType] || 0);
  if (priorityDifference) return priorityDifference;

  const numericFields = ['intentScore', 'relevanceScore', 'cadenceConfidence'];
  for (const field of numericFields) {
    const difference = (Number(right?.[field]) || 0) - (Number(left?.[field]) || 0);
    if (difference) return difference;
  }

  const leftExpiry = asTime(left?.expiresAt) ?? Number.MAX_SAFE_INTEGER;
  const rightExpiry = asTime(right?.expiresAt) ?? Number.MAX_SAFE_INTEGER;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  const leftCreated = asTime(left?.detectedAt || left?.createdAt) ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = asTime(right?.detectedAt || right?.createdAt) ?? Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;

  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function resolveOpportunityCollision(opportunities, {
  now = new Date(),
  contextsByID = {},
  nextEligibleContactAt = null,
  activePaymentRecovery = false
} = {}) {
  if (!Array.isArray(opportunities)) throw new Error('opportunities must be an array.');

  const evaluated = opportunities.map(opportunity => {
    const id = String(opportunity?.id || '');
    return {
      opportunity,
      expiry: evaluateOpportunityExpiry(opportunity, contextsByID[id] || {}, { now })
    };
  });
  const active = evaluated.filter(item => item.expiry.active).map(item => item.opportunity).sort(compareOpportunities);
  if (activePaymentRecovery) {
    return {
      selected: null,
      closed: evaluated.filter(item => !item.expiry.active).map(item => ({
        opportunity: item.opportunity,
        reasons: item.expiry.reasons
      })),
      suppressed: active.map(opportunity => ({
        opportunity,
        reason: 'active_payment_recovery',
        selectedOpportunityID: null,
        nextEligibleContactAt: null
      }))
    };
  }
  const selected = active[0] || null;
  const selectedID = selected ? String(selected.id || '') : null;

  return {
    selected,
    closed: evaluated.filter(item => !item.expiry.active).map(item => ({
      opportunity: item.opportunity,
      reasons: item.expiry.reasons
    })),
    suppressed: active.slice(1).map(opportunity => ({
      opportunity,
      reason: 'lower_priority_collision',
      selectedOpportunityID: selectedID,
      nextEligibleContactAt: nextEligibleContactAt || null
    }))
  };
}

module.exports = {
  DEFAULT_EXPIRY_DAYS,
  TYPE_PRIORITY,
  compareOpportunities,
  evaluateOpportunityExpiry,
  resolveOpportunityCollision
};
