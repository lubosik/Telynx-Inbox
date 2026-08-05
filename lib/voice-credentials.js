'use strict';

/**
 * Resolves the SIP credential dedicated to native iOS calling.
 *
 * Keep the legacy pair as a rollback path. The override is selected only when
 * both values are present, so a partially-applied Railway variable update can
 * never combine credentials from different users.
 */
function getIOSVoiceCredentials(env = process.env) {
  const iosLogin = env.TELNYX_IOS_SIP_USERNAME;
  const iosPassword = env.TELNYX_IOS_SIP_PASSWORD;
  const hasCompleteOverride = Boolean(iosLogin && iosPassword);

  return {
    login: hasCompleteOverride ? iosLogin : env.TELNYX_SIP_USERNAME,
    password: hasCompleteOverride ? iosPassword : env.TELNYX_SIP_PASSWORD,
    usingDedicatedIOSCredential: hasCompleteOverride
  };
}

module.exports = { getIOSVoiceCredentials };
