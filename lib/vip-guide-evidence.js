'use strict';

const { normalisePhone } = require('./phone');
const { buildCustomerFacts } = require('./campaigns/segment-facts');

/**
 * Internal evidence packet for a future human-reviewed VIP research guide.
 * It reuses the campaign engine's canonical paid-order accounting. It does not
 * recommend a product, make a health claim, generate copy, or send anything.
 */
function buildVIPGuideEvidence(sources, contactPhone, { now = new Date() } = {}) {
  const phone = normalisePhone(contactPhone);
  if (!phone) throw new Error('A valid customer phone number is required.');
  const { facts, catalogue, now: observedAt } = buildCustomerFacts(sources, { now });
  const customer = facts.find(row => row.contactPhone === phone);
  if (!customer) return null;
  const productsByKey = new Map(catalogue.map(product => [product.productKey, product]));
  const orderedProducts = customer.productKeys.map(key => {
    const product = productsByKey.get(key);
    return {
      productKey: key,
      name: product?.name || null,
      paidOrderCount: customer.productOrderCounts[key] || 0,
      currentlyAvailable: product?.available === true
    };
  }).sort((a, b) => b.paidOrderCount - a.paidOrderCount || a.productKey.localeCompare(b.productKey));

  return {
    evidenceVersion: 1,
    observedAt,
    contactID: customer.contactID,
    contactPhone: phone,
    contactName: customer.contactName,
    paidOrderCount: customer.orderCount,
    recordedLifetimeSpend: customer.lifetimeSpend,
    averagePaidOrderValue: customer.averageOrderValue,
    lastPaidOrderAt: customer.lastOrderAt,
    cadenceMedianDays: customer.cadenceMedianDays,
    cadenceConfidence: customer.cadenceConfidence,
    orderedProducts,
    guideStatus: 'evidence_only',
    sendEnabled: false
  };
}

module.exports = { buildVIPGuideEvidence };
