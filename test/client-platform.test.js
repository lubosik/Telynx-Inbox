'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isBrowserUserAgent, isNativeIOSClient } = require('../lib/client-platform');

test('recognises common desktop and mobile browser user agents', () => {
  assert.equal(isBrowserUserAgent('Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'), true);
  assert.equal(isBrowserUserAgent('Mozilla/5.0 AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36'), true);
  assert.equal(isBrowserUserAgent('Mozilla/5.0 EdgiOS/127.0 Mobile/15E148 Safari/605.1.15'), true);
});

test('allows the native iOS networking user agent', () => {
  assert.equal(isBrowserUserAgent('ViciInbox/9 CFNetwork/1498.700.2 Darwin/23.6.0'), false);
});

test('a missing user agent is not itself classified as a browser', () => {
  assert.equal(isBrowserUserAgent(undefined), false);
  assert.equal(isBrowserUserAgent(''), false);
});

test('requires the native iOS marker before releasing SIP credentials', () => {
  const nativeUA = 'Vici Inbox/12 CFNetwork/3860.600.12 Darwin/25.5.0';
  assert.equal(isNativeIOSClient(nativeUA, 'ios'), true);
  assert.equal(isNativeIOSClient(nativeUA, undefined), false);
  assert.equal(isNativeIOSClient(nativeUA, 'web'), false);
});

test('a browser cannot obtain SIP credentials by spoofing the iOS marker', () => {
  const browserUA = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0 Safari/537.36';
  assert.equal(isNativeIOSClient(browserUA, 'ios'), false);
});
