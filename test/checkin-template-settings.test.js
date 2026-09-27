'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validateTemplates, loadCheckInTemplates } =
  require('../lib/campaigns/checkin-template-settings');

test('all four shipped check-in messages pass the same editor validation', () => {
  assert.deepEqual(validateTemplates(DEFAULTS), DEFAULTS);
});

test('check-in edits preserve personalisation and the no-offer question', () => {
  assert.throws(() => validateTemplates({ ...DEFAULTS,
    named_journey: 'Hi {{first_name}}, it is Vin from Vici. How are you?' }),
  /named journey/i);
  assert.throws(() => validateTemplates({ ...DEFAULTS,
    plain_journey: 'Hi {{first_name}}, it is Vin from Vici. Use code SAVE20?' }),
  /plain journey/i);
  assert.throws(() => validateTemplates({ ...DEFAULTS,
    plain_how_it_went: 'Hi {{first_name}}, it is Vin from Vici. How is {{last_product}}?' }),
  /plain how it went/i);
});

test('missing migration retains reviewed defaults and disables only the editor', async () => {
  const client = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: null, error: { code: 'PGRST204', message: 'checkin_message_templates missing' }
    }) }) })
  }) };
  const result = await loadCheckInTemplates(client);
  assert.equal(result.available, false);
  assert.deepEqual(result.templates, DEFAULTS);
});

test('saved copy is returned for future check-ins only after validation', async () => {
  const edited = { ...DEFAULTS,
    plain_journey: "Hi {{first_name}}, it's Vin from Vici. How has your recent order been?" };
  const client = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { checkin_message_templates: edited }, error: null
    }) }) })
  }) };
  const result = await loadCheckInTemplates(client);
  assert.equal(result.available, true);
  assert.equal(result.templates.plain_journey, edited.plain_journey);
});
