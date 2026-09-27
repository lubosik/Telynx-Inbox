'use strict';

const { isGsm7 } = require('../campaigns/copy-validator');

const DEFAULTS = Object.freeze({
  'failed-msg1': "Hey {{first_name}}! It's Vin from Vici Peptides. Looks like payment didn't go through on {{order_reference}} - don't worry, nothing was charged.\n\nGive it 5 mins and try again here: {{checkout_url}}\n\nIf your bank is flagging it, give them a quick call to let them know about the transaction and try again.\n\nVin",
  'failed-msg2': "Did you call your bank and try again, {{first_name}}?\n\nIf it still didn't work no worries - we also accept Venmo ({{venmo_handle}}) or Zelle ({{zelle_handle}}). Just reply here and I'll sort it.\n\nVin",
  'failed-msg3': "Hey {{first_name}}, {{order_reference}} is still saved. Gonna be honest - I really want to get this order out to you.\n\nUse VICISAVE for 10% off, it's good for today only: {{checkout_url}}\n\nVin",
  'hold-msg1': 'Hey {{first_name}}, Vin here from Vici. Your {{order_description}} is set aside, waiting on ${{balance}}. Our {{method}} address is {{handle}}. Any questions, please reach out. Reply STOP to opt out.',
  'hold-msg2': 'Hey {{first_name}}, Vin again from Vici. Your {{order_description}} is still set aside with ${{balance}} outstanding. Our {{method}} address is {{handle}}. Any questions, please reach out. Reply STOP to opt out.',
  'hold-msg3': 'Hey {{first_name}}, Vin from Vici. Still holding your {{order_description}}. The balance is ${{balance}} and our {{method}} address is {{handle}}. If you would rather cancel, just say and I will sort it. Reply STOP to opt out.'
});

const KEYS = Object.freeze(Object.keys(DEFAULTS));
const LABELS = Object.freeze({
  'failed-msg1': 'Card retry 1', 'failed-msg2': 'Card retry 2',
  'failed-msg3': 'Card retry 3', 'hold-msg1': 'Payment reminder 1',
  'hold-msg2': 'Payment reminder 2', 'hold-msg3': 'Payment reminder 3'
});
const ALLOWED_FIELDS = Object.freeze({
  'failed-msg1': ['first_name', 'order_reference', 'checkout_url'],
  'failed-msg2': ['first_name', 'venmo_handle', 'zelle_handle'],
  'failed-msg3': ['first_name', 'order_reference', 'checkout_url'],
  'hold-msg1': ['first_name', 'order_description', 'balance', 'method', 'handle'],
  'hold-msg2': ['first_name', 'order_description', 'balance', 'method', 'handle'],
  'hold-msg3': ['first_name', 'order_description', 'balance', 'method', 'handle']
});

function validatePaymentTemplates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== KEYS.length
      || Object.keys(input).some(key => !KEYS.includes(key))) {
    throw Object.assign(new Error('Save all six payment reminder messages together.'), {
      code: 'INVALID_PAYMENT_TEMPLATES', status: 400
    });
  }
  const output = {};
  for (const key of KEYS) {
    const value = input[key];
    const text = typeof value === 'string' ? value.trim() : '';
    const allowed = ALLOWED_FIELDS[key];
    const fields = [...text.matchAll(/{{\s*([a-z_]+)\s*}}/g)].map(match => match[1]);
    const required = key.startsWith('hold-')
      ? ['first_name', 'method', 'handle']
      : key === 'failed-msg2' ? ['first_name'] : ['first_name', 'checkout_url'];
    const placeholdersValid = fields.every(field => allowed.includes(field))
      && required.every(field => fields.includes(field))
      && !/{{|}}/.test(text.replace(/{{\s*[a-z_]+\s*}}/g, ''));
    const alteredOffer = /\b(?:coupon|discount|code)\b|\d+%\s*off/i.test(text)
      && (key !== 'failed-msg3' || !/\bVICISAVE\b/.test(text) || !/10%\s*off/i.test(text));
    if (!text || text.length > 1000 || !isGsm7(text.replace(/\n/g, ' ')) || !placeholdersValid
        || /https?:\/\//i.test(text) || alteredOffer
        || (key.startsWith('hold-') && !/reply stop to opt out\.?$/i.test(text))) {
      throw Object.assign(new Error(
        `${LABELS[key]}: Keep the required placeholders, use standard SMS characters, use the generated checkout link, and keep the STOP line on payment reminders. The existing VICISAVE offer cannot be replaced here.`
      ), { code: 'INVALID_PAYMENT_TEMPLATE', status: 400 });
    }
    output[key] = text;
  }
  return output;
}

async function loadPaymentTemplates(client, workspaceID = 'vici') {
  const { data, error } = await client.from('sms_campaign_settings')
    .select('payment_reminder_templates')
    .eq('workspace_id', workspaceID).maybeSingle();
  if (error) {
    if (['PGRST204', '42703'].includes(error.code)
        && /payment_reminder_templates/i.test(error.message || '')) {
      return { available: false, templates: { ...DEFAULTS }, overrides: null };
    }
    throw error;
  }
  if (!data) return { available: false, templates: { ...DEFAULTS }, overrides: null };
  const overrides = data.payment_reminder_templates == null
    ? null : validatePaymentTemplates(data.payment_reminder_templates);
  return { available: true, templates: overrides || { ...DEFAULTS }, overrides };
}

function renderPaymentTemplate(key, overrides, values, fallback) {
  const template = overrides?.[key];
  if (!template) return fallback;
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_match, field) => String(values[field] ?? ''));
}

module.exports = { DEFAULTS, KEYS, validatePaymentTemplates,
  loadPaymentTemplates, renderPaymentTemplate };
