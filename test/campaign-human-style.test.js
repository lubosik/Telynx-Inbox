'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { traitsFromMessages, loadHumanStyle, renderHumanStyle } = require('../lib/campaigns/human-style');

const dominic = { id: 3, displayName: 'Dominic' };

test('Dominic receives only modest style traits from his supplied example', () => {
  assert.deepEqual(traitsFromMessages([], dominic),
    ['direct', 'concise', 'warm', 'thanks', 'first_name']);
});

test('only author-attributed outbound messages can refine a person\'s style', () => {
  const rows = [
    { sender_user_id: 3, direction: 'outbound', body: 'Hi. Can I help?' },
    { sender_user_id: 3, direction: 'inbound', body: 'Thank you so much!' },
    { sender_user_id: 4, direction: 'outbound', body: 'Thank you so much!' },
    { sender_user_id: null, direction: 'outbound', body: 'Thank you so much!' }
  ];
  const traits = traitsFromMessages(rows, { id: 3, displayName: 'Alex' });
  assert.deepEqual(traits, ['concise', 'question', 'warm']);
});

test('the prompt receives fixed abstract guidance, never customer conversation text', async () => {
  const sensitive = 'Hi Sarah, your order #12345 is ready. Call +15551234567?';
  const client = { from: () => {
    const q = {
      select: () => q, eq: () => q, order: () => q,
      limit: async () => ({ data: [{ sender_user_id: 3, direction: 'outbound', body: sensitive }], error: null })
    };
    return q;
  } };
  const traits = await loadHumanStyle({ client, actor: dominic });
  const prompt = renderHumanStyle(traits).join(' ');
  assert.ok(prompt.length > 0);
  assert.doesNotMatch(prompt, /Sarah|12345|5551234567|order #/);
});

test('missing sender migration does not invent authorship for old messages', async () => {
  const client = { from: () => {
    const q = {
      select: () => q, eq: () => q, order: () => q,
      limit: async () => ({ data: null, error: { code: '42703' } })
    };
    return q;
  } };
  assert.deepEqual(await loadHumanStyle({ client, actor: { id: 9, displayName: 'Alex' } }), []);
});
