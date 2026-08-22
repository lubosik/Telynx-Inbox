'use strict';

const WORKFLOW_COPY = Object.freeze({
  back_in_stock_requested: {
    title: product => `${product} back in stock`,
    body: product => `Good news — ${product} is back in stock. Reply if you'd like help. Reply STOP to opt out.`
  },
  back_in_stock_repeat_buyer: {
    title: product => `${product} back in stock`,
    body: product => `Good news — ${product} is back in stock. Reply if you'd like help. Reply STOP to opt out.`
  },
  back_in_stock: {
    title: product => `${product} back in stock`,
    body: product => `Good news — ${product} is back in stock. Reply if you'd like help. Reply STOP to opt out.`
  },
  reorder_personal_high: {
    title: product => `${product} reorder check-in`,
    body: product => `Hi, it may be time to reorder ${product}. Reply if you'd like help. Reply STOP to opt out.`
  },
  reorder_personal: {
    title: product => `${product} reorder check-in`,
    body: product => `Hi, it may be time to reorder ${product}. Reply if you'd like help. Reply STOP to opt out.`
  },
  winback: {
    title: () => 'Customer check-in',
    body: brand => `Hi, this is ${brand}. We're here if you need any help. Reply STOP to opt out.`
  }
});

function cleanLabel(value, fallback) {
  const cleaned = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 80);
}

/**
 * Produce conservative starter copy, never approved or send-ready copy.
 *
 * There are deliberately no AI calls, medical claims, discount promises,
 * shortened URLs, or unsupported merge fields here. An Admin must still review
 * product wording, brand voice, destination, consent scope and opt-out language.
 */
function prepareDraftCopy({ opportunityType, productName, brandName = 'Vici' } = {}) {
  const template = WORKFLOW_COPY[opportunityType];
  if (!template) throw new Error(`No reviewed starter copy exists for ${opportunityType || 'unknown opportunity type'}.`);
  const product = cleanLabel(productName, 'the requested product');
  const brand = cleanLabel(brandName, 'Vici');
  const copyArgument = opportunityType === 'winback' ? brand : product;
  return {
    title: template.title(copyArgument).slice(0, 160),
    proposedMessage: template.body(copyArgument).slice(0, 1600),
    copyStatus: 'human_review_required',
    reviewRequirements: [
      'verify_product_and_brand_wording',
      'verify_promotional_consent_scope',
      'verify_provider_campaign_scope',
      'verify_opt_out_language',
      'verify_destination_and_offer_terms'
    ]
  };
}

module.exports = { cleanLabel, prepareDraftCopy };
