'use strict';

const LOCKED_SMS_TEMPLATE = "{{first_name}}, it's Vin from Vici. Saw you tried to order {{product_name}} but didn't quite finish checking out. Did anything come up at checkout that I can help you with? I've kept it for you here: {{recovery_url}} Reply STOP to opt out.";
const LOCKED_SMS_FALLBACK_TEMPLATE = "Hey, it's Vin from Vici. Saw you tried to order {{product_name}} but didn't quite finish checking out. Did anything come up at checkout that I can help you with? I've kept it for you here: {{recovery_url}} Reply STOP to opt out.";

function clean(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstName(value) {
  const name = clean(value, 60).split(' ')[0].replace(/[^\p{L}\p{M}'-]/gu, '');
  return name.length >= 2 ? name : '';
}

function itemName(item) {
  return clean(item?.product_name || item?.name || item?.sku || 'your items', 120);
}

function productSummary(items) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return 'your items';
  const quantity = rows.reduce((total, row) => total + Math.max(1, Number(row.quantity) || 1), 0);
  const primary = itemName(rows[0]);
  if (quantity <= 1) return primary;
  return `${primary} and ${quantity - 1} other ${quantity - 1 === 1 ? 'item' : 'items'}`;
}

function renderLockedSMS({ customerFirstName, items, recoveryURL }) {
  const url = clean(recoveryURL, 600);
  if (!/^https:\/\//.test(url)) throw new Error('A secure recovery URL is required.');
  const name = firstName(customerFirstName);
  const template = name ? LOCKED_SMS_TEMPLATE : LOCKED_SMS_FALLBACK_TEMPLATE;
  return template
    .replace('{{first_name}}', name)
    .replace('{{product_name}}', productSummary(items))
    .replace('{{recovery_url}}', url);
}

module.exports = {
  LOCKED_SMS_TEMPLATE,
  LOCKED_SMS_FALLBACK_TEMPLATE,
  firstName,
  productSummary,
  renderLockedSMS
};
