'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOptOutRequest, normaliseRequest } = require('../lib/opt-out-language');

test('standard opt-out keywords tolerate punctuation and case', () => {
  for (const text of ['STOP', 'Stop all!', 'UNSUBSCRIBE.', 'opt-out', 'Quit', 'REVOKE']) {
    assert.equal(isOptOutRequest(text), true, text);
  }
});

test('clear natural-language revocations are recognised', () => {
  const examples = [
    'Please stop texting me',
    "Don't message me again.",
    'Remove me from your marketing list',
    'Take me off the SMS list please',
    'I hereby revoke my consent to texts',
    'I do not want any more messages from this business',
    'Unsubscribe me please',
    // Both phrasings were honoured by the keyword regex this module replaced.
    'stop texting',
    'Stop the messages'
  ];
  for (const text of examples) assert.equal(isOptOutRequest(text), true, text);
});

test('support requests containing stop or cancel do not become opt-outs', () => {
  const examples = [
    'Please do not stop my shipment',
    'Can you cancel order 123?',
    'The tracking stopped moving',
    'Do not contact the carrier yet',
    'I want to unsubscribe from emails but keep texts',
    'No more delays please',
    'Where is my order?'
  ];
  for (const text of examples) assert.equal(isOptOutRequest(text), false, text);
});

test('only a trusted provider opt-out classification is passed to the classifier', () => {
  assert.equal(isOptOutRequest('unrelated text', 'STOP'), true);
  assert.equal(isOptOutRequest('unrelated text', 'DELIVERED'), false);
});

test('normalisation is deterministic and does not retain punctuation', () => {
  assert.equal(normaliseRequest("  Don’t—TEXT me!!! "), "don't text me");
});
