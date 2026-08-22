'use strict';

const { DAY_MS } = require('./reorder-cadence');

function qualifyWinback({
  cadence,
  lastPurchaseAt,
  lifetimePurchaseCount = 0,
  now = new Date(),
  lastWinbackContactAt = null,
  lastWinbackRejectedAt = null,
  existingOpenOpportunity = false,
  unresolvedComplaint = false,
  refundOpen = false,
  recentNegativeSupport = false,
  productAvailable = true,
  minimumPurchases = 3,
  overdueMultiplier = 1.75,
  minimumOverdueDays = 60,
  cooldownDays = 180
} = {}) {
  const reasons = [];
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const lastPurchaseTime = Date.parse(lastPurchaseAt);
  if (!Number.isFinite(nowTime)) throw new Error('now must be a valid date.');
  if (!cadence?.reliable || !Number.isFinite(Number(cadence?.medianDays)) || Number(cadence?.medianDays) <= 0) {
    reasons.push('reliable_cadence_required');
  }
  if (!Number.isFinite(lastPurchaseTime)) reasons.push('last_purchase_missing');
  if (Number(lifetimePurchaseCount) < minimumPurchases) reasons.push('insufficient_purchase_history');
  if (existingOpenOpportunity) reasons.push('opportunity_already_open');
  if (unresolvedComplaint || refundOpen || recentNegativeSupport) reasons.push('customer_experience_block');
  if (!productAvailable) reasons.push('product_unavailable');

  const previousWinbackTimes = [lastWinbackContactAt, lastWinbackRejectedAt]
    .map(Date.parse)
    .filter(Number.isFinite);
  const lastWinbackTime = previousWinbackTimes.length ? Math.max(...previousWinbackTimes) : null;
  const cooldownEnds = lastWinbackTime === null ? null : lastWinbackTime + cooldownDays * DAY_MS;
  if (cooldownEnds !== null && nowTime < cooldownEnds) reasons.push('winback_cooldown_active');

  let eligibleAt = null;
  let daysSincePurchase = null;
  if (Number.isFinite(lastPurchaseTime) && cadence?.reliable) {
    const thresholdDays = Math.max(minimumOverdueDays, Number(cadence.medianDays) * overdueMultiplier);
    eligibleAt = lastPurchaseTime + thresholdDays * DAY_MS;
    daysSincePurchase = (nowTime - lastPurchaseTime) / DAY_MS;
    if (nowTime < eligibleAt) reasons.push('not_lapsed_beyond_cadence');
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    qualifies: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    daysSincePurchase,
    eligibleAt: eligibleAt === null ? null : new Date(eligibleAt).toISOString(),
    cooldownEndsAt: cooldownEnds === null ? null : new Date(cooldownEnds).toISOString(),
    expiresAt: uniqueReasons.length === 0 ? new Date(nowTime + 30 * DAY_MS).toISOString() : null
  };
}

module.exports = { qualifyWinback };
