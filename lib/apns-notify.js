const crypto = require('crypto');
const http2 = require('http2');
const { supabase } = require('../db');

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.vicipeptides.inbox';
const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedProviderToken = null;
let cachedProviderTokenAt = 0;
let didLogMissingConfiguration = false;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function privateKeyPEM() {
  if (!process.env.APNS_KEY_P8_BASE64) return null;
  try {
    return Buffer.from(process.env.APNS_KEY_P8_BASE64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function configuration() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = privateKeyPEM();
  if (!keyId || !teamId || !privateKey) return null;
  return { keyId, teamId, privateKey };
}

function providerToken(config, now = Date.now()) {
  if (cachedProviderToken && now - cachedProviderTokenAt < TOKEN_TTL_MS) {
    return cachedProviderToken;
  }

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({
    iss: config.teamId,
    iat: Math.floor(now / 1000)
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363'
  });
  cachedProviderToken = `${signingInput}.${base64url(signature)}`;
  cachedProviderTokenAt = now;
  return cachedProviderToken;
}

function apnsHost(environment) {
  return environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
}

function sendOne(client, row, authorization, payload) {
  return new Promise((resolve) => {
    let responseBody = '';
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${row.device_token}`,
      authorization: `bearer ${authorization}`,
      'apns-topic': row.bundle_id || BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400)
    });

    request.setEncoding('utf8');
    request.on('response', headers => {
      request.on('data', chunk => { responseBody += chunk; });
      request.on('end', () => {
        let reason = '';
        try { reason = JSON.parse(responseBody)?.reason || ''; } catch {}
        finish({ status: Number(headers[':status'] || 0), reason });
      });
    });
    request.on('error', error => finish({ status: 0, reason: error.message }));
    request.setTimeout(10_000, () => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      finish({ status: 0, reason: 'RequestTimeout' });
    });
    request.end(JSON.stringify(payload));
  });
}

async function removeInvalidDevice(row, result) {
  const permanentlyInvalid = result.status === 410 ||
    ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason);
  if (permanentlyInvalid) {
    await supabase.from('ios_push_devices').delete().eq('id', row.id);
    console.log(`APNs: removed invalid ${row.environment} device token ...${row.device_token.slice(-8)}`);
    return;
  }

  await supabase.from('ios_push_devices').update({
    last_error: `${result.status || 'network'} ${result.reason || 'Unknown'}`.slice(0, 300),
    updated_at: new Date().toISOString()
  }).eq('id', row.id);
}

async function sendNativeMessagePush({ title, body, phone }) {
  const config = configuration();
  if (!config) {
    if (!didLogMissingConfiguration) {
      console.log('APNs: message notifications disabled — provider credentials are not configured');
      didLogMissingConfiguration = true;
    }
    return { sent: 0, disabled: true };
  }

  const { data: devices, error } = await supabase
    .from('ios_push_devices')
    .select('id, device_token, environment, bundle_id')
    .eq('enabled', true)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) {
    // A deploy before the migration must never interfere with Telnyx webhook
    // processing or with the existing browser push path.
    console.error('APNs: failed to fetch iOS devices:', error.message);
    return { sent: 0, error: error.message };
  }
  if (!devices?.length) return { sent: 0 };

  let authorization;
  try {
    authorization = providerToken(config);
  } catch (tokenError) {
    console.error('APNs: provider token creation failed:', tokenError.message);
    return { sent: 0, error: tokenError.message };
  }

  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': phone || 'vici-inbox'
    },
    phone: phone || ''
  };

  let sent = 0;
  for (const environment of ['production', 'sandbox']) {
    const rows = devices.filter(row => row.environment === environment);
    if (!rows.length) continue;
    const client = http2.connect(apnsHost(environment));
    client.on('error', err => console.error(`APNs ${environment} connection error:`, err.message));
    try {
      const results = await Promise.all(rows.map(async row => ({
        row,
        result: await sendOne(client, row, authorization, payload)
      })));
      for (const { row, result } of results) {
        if (result.status === 200) {
          sent += 1;
          await supabase.from('ios_push_devices').update({
            last_error: null,
            updated_at: new Date().toISOString()
          }).eq('id', row.id);
        } else {
          console.error(`APNs: ${environment} delivery failed (${result.status} ${result.reason})`);
          await removeInvalidDevice(row, result);
        }
      }
    } finally {
      client.close();
    }
  }

  if (sent > 0) console.log(`APNs: delivered message notification to ${sent} iOS device(s)`);
  return { sent };
}

module.exports = { sendNativeMessagePush };
