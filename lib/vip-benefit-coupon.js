'use strict';

const { fetchAllRows } = require('./fetch-all-rows');
const { buildCustomerFacts } = require('./campaigns/segment-facts');
const { classifyVIPCustomer, VIP_SEGMENT_KEY } = require('./vip-customers');
const { findCouponByCode, updateCoupon } = require('./woocommerce-coupons');

function vipCouponPatch(emails) {
  const allowed = [...new Set(emails.map(email => String(email || '').trim().toLowerCase())
    .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))].sort();
  if (!allowed.length) throw new Error('VIP15 cannot be restricted because no VIP billing emails are available.');
  return {
    discount_type: 'percent', amount: '15', minimum_amount: '0', maximum_amount: '0',
    product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [],
    individual_use: false, exclude_sale_items: false, usage_limit: null,
    usage_limit_per_user: null, limit_usage_to_x_items: null,
    date_expires: null, date_expires_gmt: null, email_restrictions: allowed
  };
}

async function vipBenefitAudience(client) {
  const [contacts, orders, segments, members] = await Promise.all([
    fetchAllRows(client, 'sms_contacts', 'id,phone,name,first_name,last_name,email'),
    fetchAllRows(client, 'sms_orders', 'id,woo_order_id,contact_phone,status,total,created_at'),
    fetchAllRows(client, 'sms_campaign_segments', 'id,segment_key', {
      filter: query => query.eq('workspace_id', 'vici').eq('segment_key', VIP_SEGMENT_KEY).is('archived_at', null)
    }),
    fetchAllRows(client, 'sms_campaign_segment_members', 'id,segment_id,contact_phone,membership_source', {
      filter: query => query.eq('workspace_id', 'vici').eq('membership_source', 'forced_include')
    })
  ]);
  const ids = new Set(segments.map(segment => segment.id));
  const manual = new Set(members.filter(member => ids.has(member.segment_id)).map(member => member.contact_phone));
  const facts = buildCustomerFacts({ contacts, orders }, { now: new Date() }).facts;
  const byPhone = new Map(facts.map(fact => [fact.contactPhone, fact]));
  return contacts.filter(contact => classifyVIPCustomer(byPhone.get(contact.phone) || {}, {
    manuallyIncluded: manual.has(contact.phone)
  }).customer_tier === 'vip');
}

// Owner-approved VIP15 terms. Billing-email restriction is enforced by WooCommerce;
// it is NOT authenticated identity proof. Do not describe it as sign-in-only.
async function syncVIPBenefitCoupon({ client, lookup = findCouponByCode, update = updateCoupon }) {
  const audience = await vipBenefitAudience(client);
  const patch = vipCouponPatch(audience.map(contact => contact.email));
  const coupon = await lookup('VIP15');
  if (!coupon) throw new Error('VIP15 does not exist. Create the VIP benefit coupon before scheduling welcomes.');
  const changed = Object.entries(patch).some(([key, value]) => {
    if (key === 'amount' || key.endsWith('_amount')) return Number(coupon[key] || 0) !== Number(value);
    if (Array.isArray(value)) return JSON.stringify([...(coupon[key] || [])].sort()) !== JSON.stringify([...value].sort());
    return (coupon[key] ?? null) !== value;
  });
  const saved = changed ? await update(coupon.id, patch) : coupon;
  if (Number(saved.amount) !== 15 || saved.discount_type !== 'percent') throw new Error('VIP15 verification failed after saving.');
  return { couponID: saved.id, changed, vipCount: audience.length,
    restrictedEmails: patch.email_restrictions.length,
    withoutEmail: audience.filter(contact => !contact.email).length };
}

module.exports = { vipCouponPatch, vipBenefitAudience, syncVIPBenefitCoupon };
