'use strict';

const { normalisePhone } = require('./phone');

function vipVoiceNumber(env = process.env) {
  return normalisePhone(env.VIP_INBOX_PHONE_NUMBER) || null;
}

function inboundCallerLabel(callerName, toNumber, env = process.env) {
  const vipNumber = vipVoiceNumber(env);
  const isVIPLine = Boolean(vipNumber && normalisePhone(toNumber) === vipNumber);
  return {
    isVIPLine,
    displayName: isVIPLine ? `VIP - ${callerName || 'Caller'}` : callerName || null
  };
}

module.exports = { vipVoiceNumber, inboundCallerLabel };
