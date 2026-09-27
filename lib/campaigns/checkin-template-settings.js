'use strict';

const { VARIANTS, VARIANT_KEYS } = require('./checkin-variants');
const { validateCopy } = require('./copy-validator');

const DEFAULTS = Object.freeze(Object.fromEntries(
  VARIANT_KEYS.map(key => [key, VARIANTS[key].template])
));

function validateTemplates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== VARIANT_KEYS.length
      || Object.keys(input).some(key => !VARIANT_KEYS.includes(key))) {
    throw Object.assign(new Error('Edit and save all four check-in messages together.'), {
      code: 'INVALID_CHECKIN_TEMPLATES', status: 400
    });
  }
  const output = {};
  for (const key of VARIANT_KEYS) {
    const template = input[key];
    if (typeof template !== 'string') {
      throw Object.assign(new Error(`The ${key.replaceAll('_', ' ')} message must be text.`), {
        code: 'INVALID_CHECKIN_TEMPLATE', status: 400
      });
    }
    const clean = template.trim();
    const verdict = validateCopy(clean, { requireOptOut: false });
    const isNamed = VARIANTS[key].requiresProduct;
    const fields = [...clean.matchAll(/{{\s*([a-z_]+)\s*}}/g)].map(match => match[1]);
    const expected = isNamed ? ['first_name', 'last_product'] : ['first_name'];
    const structurallyValid = expected.every(field => fields.includes(field))
      && fields.every(field => expected.includes(field))
      && clean.includes('?')
      && !/\b(?:discount|coupon|offer|code|percent off)\b/i.test(clean);
    if (!verdict.ok || !structurallyValid) {
      const reason = verdict.failures[0]?.reason
        || `Include ${expected.map(field => `{{${field}}}`).join(' and ')}, ask a question, and leave out offers.`;
      throw Object.assign(new Error(`${key.replaceAll('_', ' ')}: ${reason}`), {
        code: 'INVALID_CHECKIN_TEMPLATE', status: 400
      });
    }
    output[key] = clean;
  }
  return output;
}

async function loadCheckInTemplates(client, workspaceID = 'vici') {
  const { data, error } = await client.from('sms_campaign_settings')
    .select('checkin_message_templates')
    .eq('workspace_id', workspaceID)
    .maybeSingle();
  if (error) {
    // An additive migration may not be installed yet. The established copy
    // continues to run; the editor stays unavailable until the schema exists.
    if (['PGRST204', '42703'].includes(error.code)
        && /checkin_message_templates/i.test(error.message || '')) {
      return { available: false, templates: { ...DEFAULTS } };
    }
    throw error;
  }
  if (!data) return { available: false, templates: { ...DEFAULTS } };
  let overrides = {};
  if (data.checkin_message_templates != null) {
    try { overrides = validateTemplates(data.checkin_message_templates); }
    catch (error) {
      // An invalid stored edit cannot silently become an outbound message.
      throw Object.assign(new Error('Saved check-in copy needs review before the next send.'), {
        code: 'INVALID_STORED_CHECKIN_TEMPLATES', cause: error
      });
    }
  }
  return { available: true, templates: { ...DEFAULTS, ...overrides } };
}

module.exports = { DEFAULTS, validateTemplates, loadCheckInTemplates };
