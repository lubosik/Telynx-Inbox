'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { vipVoiceNumber, inboundCallerLabel } = require('../lib/vip-voice-line');

const env = { VIP_INBOX_PHONE_NUMBER: '+19177254009' };

test('VIP voice line labels the line called without changing customer tier', () => {
  assert.equal(vipVoiceNumber(env), '+19177254009');
  assert.deepEqual(inboundCallerLabel('Jane Doe', '+19177254009', env), {
    isVIPLine: true, displayName: 'VIP - Jane Doe'
  });
  assert.deepEqual(inboundCallerLabel('Jane Doe', '+12125553184', env), {
    isVIPLine: false, displayName: 'Jane Doe'
  });
  assert.equal(inboundCallerLabel(null, '+19177254009', env).displayName, 'VIP - Caller');
});

test('VIP number is not invented when configuration is absent', () => {
  assert.equal(vipVoiceNumber({}), null);
  assert.deepEqual(inboundCallerLabel('Jane', '+19177254009', {}), {
    isVIPLine: false, displayName: 'Jane'
  });
});

test('iPhone calling uses server-issued VIP line and history displays actual line provenance', () => {
  const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(source('routes/voice.js'), /vipCallerNumber: vipVoiceNumber\(\)/);
  assert.match(source('ios/ViciInbox/Voice/TelnyxVoiceManager.swift'), /CredentialStore\.get\(\.vipCallerNumber\)/);
  assert.match(source('ios/ViciInbox/UI/DialerView.swift'), /VIP calling line unavailable/);
  assert.match(source('ios/ViciInbox/Core/MobileModels.swift'), /direction == "inbound" \? toNumber : fromNumber/);
  assert.match(source('ios/ViciInbox/UI/WorkspaceViews.swift'), /log\.businessLineNumber/);
  assert.match(source('ios/ViciInbox/UI/WorkspaceViews.swift'), /VIP customers can text or call this number/);
});
