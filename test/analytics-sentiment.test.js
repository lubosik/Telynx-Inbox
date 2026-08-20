'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLocalSentiment } = require('../lib/analytics/sentiment');

test('scores clear customer praise without relying on punctuation', () => {
  assert.equal(classifyLocalSentiment('That is amazing, thank you so much').score, 2);
  assert.equal(classifyLocalSentiment('Thanks for the help').score, 1);
});

test('scores complaints and severe frustration', () => {
  assert.equal(classifyLocalSentiment('Where is my order? It has not arrived').score, -2);
  assert.equal(classifyLocalSentiment('Where the hell is my order?').score, -2);
});

test('neutral operational text remains neutral', () => {
  const result = classifyLocalSentiment('6316');
  assert.equal(result.eligible, true);
  assert.equal(result.score, 0);
  assert.equal(result.label, 'neutral');
});

test('mixed emotional cues remain unclassified instead of forced', () => {
  const result = classifyLocalSentiment('Thanks, but this issue is terrible');
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'ambiguous_mixed');
});

test('empty, media-only, and tapback text are excluded', () => {
  assert.equal(classifyLocalSentiment('').eligible, false);
  assert.equal(classifyLocalSentiment(null).eligible, false);
  assert.equal(classifyLocalSentiment('Loved "Thanks"').eligible, false);
});
