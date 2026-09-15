'use strict';

const LOCKED_SMS_TEMPLATE = "{{first_name}}, it's Vin from Vici. Saw you tried to order {{product_name}} but didn't quite finish checking out. Did anything come up at checkout that I can help you with? I've kept it for you here: {{recovery_url}} Reply STOP to opt out.";
const LOCKED_SMS_FALLBACK_TEMPLATE = "Hey, it's Vin from Vici. Saw you tried to order {{product_name}} but didn't quite finish checking out. Did anything come up at checkout that I can help you with? I've kept it for you here: {{recovery_url}} Reply STOP to opt out.";
const ALLOWED_SMS_VARIABLES = new Set(['first_name', 'product_name', 'recovery_url']);
const MAX_SMS_TEMPLATE_LENGTH = 500;

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

function validateSMSTemplate(value) {
  const raw = String(value || '').replace(/\r\n?/g, '\n').trim();
  const template = raw.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, variable) => `{{${variable.trim()}}}`);
  if (!template) return { ok: false, reason: 'The SMS message cannot be empty.' };
  if (template.length > MAX_SMS_TEMPLATE_LENGTH) {
    return { ok: false, reason: `The SMS message must be ${MAX_SMS_TEMPLATE_LENGTH} characters or fewer.` };
  }
  const variables = [...template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]);
  const unsupported = variables.find(variable => !ALLOWED_SMS_VARIABLES.has(variable));
  if (unsupported) return { ok: false, reason: `Unsupported variable: {{${unsupported}}}.` };
  if (variables.filter(variable => variable === 'recovery_url').length !== 1) {
    return { ok: false, reason: 'Include {{recovery_url}} exactly once so the customer can restore the cart.' };
  }
  if (!/reply\s+stop\s+to\s+(?:opt\s*out|unsubscribe)/i.test(template)) {
    return { ok: false, reason: 'Include “Reply STOP to opt out” in every recovery SMS.' };
  }
  return { ok: true, template };
}

function renderSMSTemplate({ template = LOCKED_SMS_TEMPLATE, customerFirstName, items, recoveryURL }) {
  const url = clean(recoveryURL, 600);
  if (!/^https:\/\//.test(url)) throw new Error('A secure recovery URL is required.');
  const validation = validateSMSTemplate(template);
  if (!validation.ok) throw new Error(validation.reason);
  const name = firstName(customerFirstName);
  let rendered = validation.template;
  if (!name) rendered = rendered.replace(/^{{first_name}}\s*,\s*/i, 'Hey, ');
  return rendered
    .replaceAll('{{first_name}}', name || 'there')
    .replaceAll('{{product_name}}', productSummary(items))
    .replace('{{recovery_url}}', url)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderLockedSMS(options) {
  const name = firstName(options?.customerFirstName);
  return renderSMSTemplate({
    ...options,
    template: name ? LOCKED_SMS_TEMPLATE : LOCKED_SMS_FALLBACK_TEMPLATE
  });
}

module.exports = {
  LOCKED_SMS_TEMPLATE,
  LOCKED_SMS_FALLBACK_TEMPLATE,
  MAX_SMS_TEMPLATE_LENGTH,
  firstName,
  productSummary,
  validateSMSTemplate,
  renderSMSTemplate,
  renderLockedSMS
};
