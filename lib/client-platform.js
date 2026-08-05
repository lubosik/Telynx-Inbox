'use strict';

/**
 * The browser inbox and native iOS app share the authenticated API. Keep SIP
 * credentials native-only so opening the web inbox cannot become a competing
 * inbound-call endpoint.
 */
function isBrowserUserAgent(value) {
  const userAgent = String(value || '');
  return /\b(?:Mozilla|Chrome|Chromium|CriOS|Firefox|FxiOS|Safari|Edg|OPR)\b/i.test(userAgent);
}

function isNativeIOSClient(userAgent, clientMarker) {
  return clientMarker === 'ios' && !isBrowserUserAgent(userAgent);
}

module.exports = { isBrowserUserAgent, isNativeIOSClient };
