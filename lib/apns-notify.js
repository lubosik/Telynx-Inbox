'use strict';
/**
 * lib/apns-notify.js — native iPhone alerts over APNs.
 *
 * Three kinds of push live here and they are deliberately NOT the same payload:
 *
 *   sendNativeMessagePush   — "a customer messaged you". Carries the Home
 *                             Screen badge and the conversation `phone`, so a
 *                             tap opens that thread.
 *   sendReleaseNotification — "a new build is available". Carries NEITHER.
 *   sendCampaignReadyNotifications — an authorised campaign review is ready.
 *                             Targets only owned devices for effective
 *                             Owner/Admin approvers and carries no customer
 *                             identity or message copy.
 *                             A release note is not an unread message, so it
 *                             must not overwrite the operator's inbox/missed
 *                             call badge, and it must not carry `phone` because
 *                             the iOS tap handler keys off that field and would
 *                             try to open a conversation that does not exist.
 *
 * Structure: `loadDevices()` reads, `deliver()` writes, and the two senders
 * above only decide what the payload is. That split exists so the delivery
 * behaviour (host per environment, invalid-token cleanup, partial failure) can
 * be tested offline without a database or a network.
 *
 * STORAGE. There are two places a device token can live. `ios_push_devices` is
 * the dedicated table (scripts/ios-push-devices-migration.sql). Until that
 * migration is applied, registration falls back to typed rows in
 * `push_subscriptions` with `endpoint = 'apns://{environment}/{token}'`. Every
 * row carries `storage` so a delete lands in the table it actually came from.
 */

const crypto = require('crypto');
const http2 = require('http2');
const { supabase } = require('../db');
const { sumUnreadCounts } = require('./unread-count');
const { countUnseenMissedCalls } = require('./missed-calls');
const { selectReleaseTargets } = require('./release-targets');

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.vicipeptides.inbox';
const TOKEN_TTL_MS = 50 * 60 * 1000;
const VALID_ENVIRONMENTS = ['sandbox', 'production'];

/**
 * PostgREST caps a response at 1000 rows and does not tell you it did. The
 * previous `.limit(100)` here was the same shape of silent truncation with a
 * lower ceiling: at two registered devices it is invisible, and it stays
 * invisible right up to the day the 101st iPhone stops getting notified for no
 * observable reason. Page explicitly instead, and if the ceiling below is ever
 * genuinely reached, say so in the log rather than sending to a silent subset.
 */
const DEVICE_PAGE_SIZE = 1000;
const MAX_DEVICES = 10000;

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

/**
 * Test hook. The provider token is cached for 50 minutes in a module global, so
 * without this a test that sets different credentials would silently reuse the
 * previous test's token and pass for the wrong reason.
 */
function resetProviderTokenCache() {
  cachedProviderToken = null;
  cachedProviderTokenAt = 0;
}

/** Test hook for the "log the missing configuration once" behaviour. */
function resetMissingConfigurationLog() {
  didLogMissingConfiguration = false;
}

function apnsHost(environment) {
  return environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
}

/**
 * Extra headers may not rewrite the request itself. `apns-collapse-id` is a
 * legitimate per-send header; `:path` and `authorization` are not, and letting
 * a caller override them would turn a payload option into a delivery redirect.
 */
function safeExtraHeaders(extraHeaders = {}) {
  const out = {};
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    const name = String(key).toLowerCase();
    if (name.startsWith(':') || name === 'authorization') continue;
    if (value === undefined || value === null || value === '') continue;
    out[name] = String(value);
  }
  return out;
}

function sendOne(client, row, authorization, payload, extraHeaders = {}) {
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
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
      ...safeExtraHeaders(extraHeaders)
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

async function removeInvalidDevice(row, result, client = supabase) {
  const permanentlyInvalid = result.status === 410 ||
    ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason);
  if (permanentlyInvalid) {
    const table = row.storage === 'compatibility' ? 'push_subscriptions' : 'ios_push_devices';
    await client.from(table).delete().eq('id', row.id);
    console.log(`APNs: removed invalid ${row.environment} device token ...${row.device_token.slice(-8)}`);
    return;
  }

  // A 429, a 503 or a timeout is the provider being busy, not the device being
  // gone. Deleting on those would unregister a perfectly good iPhone.
  if (row.storage === 'compatibility') return;
  await client.from('ios_push_devices').update({
    last_error: `${result.status || 'network'} ${result.reason || 'Unknown'}`.slice(0, 300),
    updated_at: new Date().toISOString()
  }).eq('id', row.id);
}

/**
 * Read every page of a query. `makeQuery` must build a fresh Supabase builder
 * each call: a PostgREST builder is a one-shot thenable and cannot be re-ranged.
 */
async function pageRows(makeQuery) {
  const rows = [];
  for (let from = 0; from < MAX_DEVICES; from += DEVICE_PAGE_SIZE) {
    const { data, error } = await makeQuery().range(from, from + DEVICE_PAGE_SIZE - 1);
    if (error) return { rows, error };
    rows.push(...(data || []));
    if (!data || data.length < DEVICE_PAGE_SIZE) return { rows, error: null };
  }
  console.warn(`APNs: device list hit the ${MAX_DEVICES}-row ceiling — some devices were not notified.`);
  return { rows, error: null };
}

/**
 * `user_id` is compared with `===` against a caller-supplied string in
 * lib/release-targets.js. Postgres hands a bigint back as a number, so without
 * this the owner filter would match nothing and an owner-scoped send would
 * silently reach no one.
 */
function normaliseUserID(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function normaliseCompatibilityRow(row) {
  const subscription = row?.subscription || {};
  return {
    id: row.id,
    device_token: subscription.deviceToken,
    environment: subscription.environment,
    bundle_id: subscription.bundleId,
    user_id: normaliseUserID(subscription.userId),
    app_build: subscription.appBuild ?? null,
    user_agent: row.user_agent || null,
    storage: 'compatibility'
  };
}

function isUsableDevice(row) {
  return !!row.device_token && VALID_ENVIRONMENTS.includes(row.environment);
}

/**
 * Every enabled iOS device, from whichever storage currently holds them.
 *
 * @returns {Promise<{devices: Array, error: (Error|null)}>} never throws — a
 *          push failure must not interfere with webhook processing.
 */
/**
 * Drop devices belonging to somebody who has been removed from the team.
 *
 * Deactivating a person ends their sessions, but nothing has ever touched push
 * storage — so until this existed, a removed teammate's iPhone kept receiving
 * customer message alerts, sender name and body preview included, until the
 * APNs token expired or they deleted the app. Their access was revoked and
 * their notifications were not.
 *
 * THREE DELIBERATE CHOICES:
 *
 *  - A device with NO user_id is KEPT. Ownership only started being recorded
 *    recently and most live rows predate it. Dropping them would turn a privacy
 *    fix into "nobody is notified at all".
 *  - No query is issued when no device carries an owner, which is the common
 *    case today and keeps the hot path unchanged.
 *  - It FAILS OPEN. A stray notification is recoverable. Silencing every
 *    operator's phone mid-conversation because one database read wobbled is
 *    not, and this runs on the inbound-message path.
 *
 * This filters at DELIVERY. Deactivation also unregisters the person's devices
 * at the source (routes/users.js), so this is the backstop rather than the
 * only line of defence.
 */
async function withoutDeactivatedOwners(devices, client) {
  const owned = devices.filter(row => row.user_id);
  if (!owned.length) return devices;

  const { data, error } = await client
    .from('sms_users')
    .select('id')
    .eq('is_active', false)
    .limit(MAX_DEVICES);

  if (error) {
    console.warn('APNs: could not check for deactivated owners, delivering anyway:', error.message);
    return devices;
  }

  const inactive = new Set((data || []).map(row => normaliseUserID(row.id)).filter(Boolean));
  if (!inactive.size) return devices;

  const kept = devices.filter(row => !row.user_id || !inactive.has(row.user_id));
  const dropped = devices.length - kept.length;
  if (dropped > 0) {
    console.log(`APNs: skipped ${dropped} device(s) belonging to deactivated accounts`);
  }
  return kept;
}

async function loadDevices({ client = supabase } = {}) {
  const dedicatedQuery = columns => () => client
    .from('ios_push_devices')
    .select(columns)
    .eq('enabled', true)
    .order('updated_at', { ascending: false });

  let dedicated = await pageRows(dedicatedQuery(
    'id, device_token, environment, bundle_id, user_id, app_build, user_agent'
  ));
  if (dedicated.error) {
    // The table may exist from before the user_id/app_build columns were added.
    // Retry with the original column list so a half-applied migration degrades
    // to "targeting unavailable" rather than to "no devices at all".
    dedicated = await pageRows(dedicatedQuery('id, device_token, environment, bundle_id'));
  }
  if (!dedicated.error) {
    return {
      devices: await withoutDeactivatedOwners(dedicated.rows
        .map(row => ({ ...row, user_id: normaliseUserID(row.user_id), storage: 'dedicated' }))
        .filter(isUsableDevice), client),
      error: null
    };
  }

  const fallback = await pageRows(() => client
    .from('push_subscriptions')
    .select('id, endpoint, subscription, user_agent')
    .like('endpoint', 'apns://%')
    .order('updated_at', { ascending: false }));
  if (fallback.error) return { devices: [], error: fallback.error };

  return {
    devices: await withoutDeactivatedOwners(
      fallback.rows.map(normaliseCompatibilityRow).filter(isUsableDevice), client),
    error: null
  };
}

/**
 * Send one payload to a set of devices.
 *
 * Devices are grouped by environment because a sandbox token is meaningless to
 * the production host and vice versa: exactly one connection is opened per
 * environment actually present in the set, never one per device.
 *
 * @param {Array}  devices        normalised rows from loadDevices()
 * @param {object} payload        the APNs JSON payload
 * @param {object} [extraHeaders] e.g. { 'apns-collapse-id': '...' }
 * @param {object} [options]      injection points for tests
 * @returns {Promise<{sent: number, failed: number}>} resolves even when every
 *          delivery fails; it never rejects.
 */
async function deliver(devices, payload, extraHeaders = {}, options = {}) {
  const {
    client = supabase,
    connect = http2.connect,
    send = sendOne,
    authorization
  } = options;

  let sent = 0;
  let failed = 0;

  for (const environment of VALID_ENVIRONMENTS.slice().reverse()) {  // production first
    const rows = (devices || []).filter(row => row.environment === environment);
    if (!rows.length) continue;

    let connection = null;
    try {
      connection = connect(apnsHost(environment));
      connection.on('error', err => console.error(`APNs ${environment} connection error:`, err.message));

      const results = await Promise.all(rows.map(async row => ({
        row,
        result: await send(connection, row, authorization, payload, extraHeaders)
      })));

      for (const { row, result } of results) {
        if (result.status === 200) {
          sent += 1;
          if (row.storage !== 'compatibility') {
            await client.from('ios_push_devices').update({
              last_error: null,
              updated_at: new Date().toISOString()
            }).eq('id', row.id);
          }
        } else {
          failed += 1;
          console.error(`APNs: ${environment} delivery failed (${result.status} ${result.reason})`);
          await removeInvalidDevice(row, result, client);
        }
      }
    } catch (error) {
      // Resolve, never throw. This runs inside Telnyx webhook processing and a
      // failed banner must not fail an inbound message.
      failed += rows.length;
      console.error(`APNs: ${environment} delivery aborted:`, error.message);
    } finally {
      try { connection?.close(); } catch { /* already closed */ }
    }
  }

  return { sent, failed };
}

async function currentUnreadCount(client = supabase) {
  const { data, error } = await client
    .from('sms_contacts')
    .select('unread_count');
  if (error) {
    // The alert is still useful if this reconciliation query fails. Omitting
    // `badge` preserves the device's last-known count instead of clearing it.
    console.error('APNs: failed to calculate unread badge count:', error.message);
    return null;
  }

  return sumUnreadCounts(data);
}

function reportMissingConfiguration(what) {
  if (!didLogMissingConfiguration) {
    console.log(`APNs: ${what} disabled — provider credentials are not configured`);
    didLogMissingConfiguration = true;
  }
  return { sent: 0, disabled: true };
}

async function sendNativeMessagePush({ title, body, phone }, options = {}) {
  const client = options.client || supabase;
  const config = configuration();
  if (!config) return reportMissingConfiguration('message notifications');

  const { devices, error } = await loadDevices({ client });
  if (error) {
    // Push failures must never interfere with Telnyx webhook processing.
    console.error('APNs: failed to fetch iOS devices:', error.message);
    return { sent: 0, error: error.message };
  }
  if (!devices.length) return { sent: 0 };

  let authorization;
  try {
    authorization = providerToken(config);
  } catch (tokenError) {
    console.error('APNs: provider token creation failed:', tokenError.message);
    return { sent: 0, error: tokenError.message };
  }

  // The Home Screen badge is one number for the whole app, so it carries unread
  // messages plus missed calls that have not been looked at. Sending only the
  // unread count here would silently wipe the missed-call part every time a
  // message arrived. If the unread query failed, `badge` is omitted entirely so
  // the device keeps its existing count rather than being given a partial one.
  const unreadCount = await currentUnreadCount(client);
  const badgeCount = unreadCount === null
    ? null
    : unreadCount + await countUnseenMissedCalls();
  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': phone || 'vici-inbox'
    },
    phone: phone || ''
  };
  if (badgeCount !== null) payload.aps.badge = badgeCount;

  const { sent } = await deliver(devices, payload, {}, { ...options, client, authorization });

  if (sent > 0) console.log(`APNs: delivered message notification to ${sent} iOS device(s)`);
  return { sent };
}

/** APNs rejects a collapse id longer than 64 bytes. */
function collapseIdentifier(collapseId, belowBuild) {
  const raw = typeof collapseId === 'string' && collapseId.trim()
    ? collapseId.trim()
    : `vici-release-${belowBuild ?? 'note'}`;
  return raw.replace(/[^\x20-\x7e]/g, '').slice(0, 64);
}

/**
 * A device summary safe to return from an admin endpoint. A full APNs device
 * token is a delivery credential: anyone holding it plus provider access can
 * push to that iPhone, so the response carries only the last 8 characters,
 * which is enough to match a device against the register/status logs.
 */
function summariseTarget(row) {
  return {
    id: row.id,
    storage: row.storage || 'dedicated',
    environment: row.environment,
    user_id: row.user_id ?? null,
    app_build: row.app_build ?? null,
    device_token_suffix: String(row.device_token || '').slice(-8)
  };
}

/**
 * Tell operators a new build is available.
 *
 * Differs from a message push in two ways that are not cosmetic:
 *   - NO `aps.badge`. The badge is the unread message + unseen missed call
 *     count. A release note that carried one would overwrite a real count with
 *     a number that means nothing.
 *   - NO top-level `phone`. The iOS notification tap handler keys off `phone`
 *     and would try to open a conversation thread. `screen: 'analytics'` sends
 *     the tap somewhere that exists instead.
 *
 * @param {object}  params
 * @param {string}  [params.userId]      only this user's devices
 * @param {number}  [params.belowBuild]  only devices not already on this build
 * @param {string}  params.title
 * @param {string}  params.body
 * @param {string}  [params.collapseId]  so a retry replaces the banner rather
 *                                       than stacking a second one
 * @param {boolean} [params.dryRun]      resolve the targets and send nothing
 */
async function sendReleaseNotification({
  userId = null,
  belowBuild = null,
  title,
  body,
  collapseId,
  dryRun = false
} = {}, options = {}) {
  const client = options.client || supabase;
  const config = configuration();
  // A dry run is allowed to answer "who would this reach" even where APNs is
  // not configured; it cannot send, so there is nothing to protect.
  if (!config && !dryRun) return reportMissingConfiguration('release notifications');

  const { devices, error } = await loadDevices({ client });
  if (error) {
    console.error('APNs: failed to fetch iOS devices:', error.message);
    return { sent: 0, error: error.message };
  }

  const targets = selectReleaseTargets(devices, {
    userId: normaliseUserID(userId),
    belowBuild
  });

  if (dryRun) {
    return {
      sent: 0,
      dryRun: true,
      targeted: targets.length,
      apnsConfigured: !!config,
      targets: targets.map(summariseTarget)
    };
  }

  if (!targets.length) {
    console.log('APNs: release notification matched no devices — nothing sent');
    return { sent: 0, targeted: 0, targets: [] };
  }

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
      'thread-id': 'vici-release'
    },
    screen: 'analytics'
  };

  const { sent } = await deliver(
    targets,
    payload,
    { 'apns-collapse-id': collapseIdentifier(collapseId, belowBuild) },
    { ...options, client, authorization }
  );

  console.log(`APNs: delivered release notification to ${sent}/${targets.length} iOS device(s)`);
  return { sent, targeted: targets.length, targets: targets.map(summariseTarget) };
}

function campaignReviewPayload(notification) {
  if (notification?.channel !== 'native_push_preparation') return null;
  const title = String(notification?.payload?.aps?.alert?.title || '').trim().slice(0, 120);
  const body = String(notification?.payload?.aps?.alert?.body || '').trim().slice(0, 500);
  const reviewCount = Number(notification?.payload?.reviewCount);
  if (!title || !body || !Number.isSafeInteger(reviewCount) || reviewCount < 1) return null;
  const campaignID = String(notification?.payload?.campaignID || '').trim().slice(0, 128);
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': 'vici-campaign-review'
    },
    screen: 'campaigns',
    reviewCount,
    ...(campaignID ? { campaignID, destination: 'review' } : {})
  };
}

/**
 * Deliver internally prepared campaign-review notifications only to devices
 * owned by the explicitly authorised users in those preparations. Unowned
 * compatibility devices are deliberately excluded: unlike ordinary inbox
 * alerts, a campaign review is permission-sensitive.
 *
 * Real delivery additionally requires the exact lowercase feature flag. A dry
 * run may resolve targets while the flag/APNs credentials remain off.
 */
async function sendCampaignReadyNotifications(notifications = [], {
  dryRun = true
} = {}, options = {}) {
  const env = options.env || process.env;
  const prepared = (notifications || []).filter(row => row?.eventType === 'campaigns.ready_for_review');
  const payload = campaignReviewPayload(prepared[0]);
  if (!payload || prepared.some(row => JSON.stringify(campaignReviewPayload(row)) !== JSON.stringify(payload))) {
    return { sent: 0, targeted: 0, error: 'invalid_campaign_notification_preparation' };
  }

  const userIDs = new Set(prepared.map(row => normaliseUserID(row.userID)).filter(Boolean));
  if (!userIDs.size) return { sent: 0, targeted: 0, error: 'campaign_notification_targets_missing' };
  if (!dryRun && env.CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED !== 'true') {
    return { sent: 0, targeted: 0, disabled: true, reason: 'feature_flag_disabled' };
  }

  const client = options.client || supabase;
  const load = options.loadDevices || loadDevices;
  const { devices, error } = await load({ client });
  if (error) return { sent: 0, targeted: 0, error: 'campaign_notification_device_load_failed' };
  const targets = devices.filter(row => row.user_id && userIDs.has(normaliseUserID(row.user_id)));
  if (dryRun) {
    return {
      sent: 0,
      dryRun: true,
      targeted: targets.length,
      targets: targets.map(summariseTarget)
    };
  }
  if (!targets.length) return { sent: 0, targeted: 0, targets: [] };

  const config = configuration();
  if (!config && !options.authorization) return reportMissingConfiguration('campaign review notifications');
  let authorization = options.authorization;
  if (!authorization) {
    try {
      authorization = providerToken(config);
    } catch (tokenError) {
      console.error('APNs: campaign provider token creation failed:', tokenError.message);
      return { sent: 0, targeted: targets.length, error: 'campaign_notification_token_failed' };
    }
  }

  const collapseID = collapseIdentifier(prepared[0].collapseID || 'vici-campaigns-ready-for-review');
  const deliverNotifications = options.deliver || deliver;
  const result = await deliverNotifications(
    targets,
    payload,
    { 'apns-collapse-id': collapseID },
    { ...options, client, authorization }
  );
  return { ...result, targeted: targets.length, targets: targets.map(summariseTarget) };
}

function segmentChangePayload(notification) {
  if (notification?.channel !== 'native_push_preparation') return null;
  const title = String(notification?.payload?.aps?.alert?.title || '').trim().slice(0, 120);
  const body = String(notification?.payload?.aps?.alert?.body || '').trim().slice(0, 500);
  const segmentID = String(notification?.payload?.segmentID || '').trim().slice(0, 128);
  const memberCount = Number(notification?.payload?.memberCount);
  if (!title || !body || !segmentID) return null;
  if (!Number.isSafeInteger(memberCount) || memberCount < 0) return null;
  // House copy rule, enforced at the last boundary before Apple. A dash that
  // slipped past the preparation module must not reach a device.
  if (title.includes('—') || body.includes('—')) return null;
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': 'vici-campaign-segments'
    },
    screen: 'segments',
    segmentID,
    memberCount
  };
}

/**
 * Deliver internally prepared segment-change notifications, only to devices
 * owned by the users named in those preparations.
 *
 * Same discipline as sendCampaignReadyNotifications: unowned compatibility
 * devices are excluded because segment membership is customer data, every
 * preparation in one batch must describe the same segment change, and real
 * delivery needs the exact lowercase feature flag on top of APNs credentials.
 * The flag defaults off.
 */
async function sendSegmentChangeNotifications(notifications = [], {
  dryRun = true
} = {}, options = {}) {
  const env = options.env || process.env;
  const prepared = (notifications || []).filter(row => row?.eventType === 'campaigns.segment_changed');
  const payload = segmentChangePayload(prepared[0]);
  if (!payload || prepared.some(row => JSON.stringify(segmentChangePayload(row)) !== JSON.stringify(payload))) {
    return { sent: 0, targeted: 0, error: 'invalid_segment_notification_preparation' };
  }

  const userIDs = new Set(prepared.map(row => normaliseUserID(row.userID)).filter(Boolean));
  if (!userIDs.size) return { sent: 0, targeted: 0, error: 'segment_notification_targets_missing' };
  if (!dryRun && env.SEGMENT_CHANGE_NOTIFICATIONS_ENABLED !== 'true') {
    return { sent: 0, targeted: 0, disabled: true, reason: 'feature_flag_disabled' };
  }

  const client = options.client || supabase;
  const load = options.loadDevices || loadDevices;
  const { devices, error } = await load({ client });
  if (error) return { sent: 0, targeted: 0, error: 'segment_notification_device_load_failed' };
  const targets = devices.filter(row => row.user_id && userIDs.has(normaliseUserID(row.user_id)));
  if (dryRun) {
    return { sent: 0, dryRun: true, targeted: targets.length, targets: targets.map(summariseTarget) };
  }
  if (!targets.length) return { sent: 0, targeted: 0, targets: [] };

  const config = configuration();
  if (!config && !options.authorization) return reportMissingConfiguration('segment change notifications');
  let authorization = options.authorization;
  if (!authorization) {
    try {
      authorization = providerToken(config);
    } catch (tokenError) {
      console.error('APNs: segment provider token creation failed:', tokenError.message);
      return { sent: 0, targeted: targets.length, error: 'segment_notification_token_failed' };
    }
  }

  const collapseID = collapseIdentifier(prepared[0].collapseID || 'vici-campaign-segments');
  const deliverNotifications = options.deliver || deliver;
  const result = await deliverNotifications(
    targets,
    payload,
    { 'apns-collapse-id': collapseID },
    { ...options, client, authorization }
  );
  return { ...result, targeted: targets.length, targets: targets.map(summariseTarget) };
}

module.exports = {
  sendCampaignReadyNotifications,
  sendSegmentChangeNotifications,
  segmentChangePayload,
  sendNativeMessagePush,
  sendReleaseNotification,
  loadDevices,
  deliver,
  sendOne,
  removeInvalidDevice,
  apnsHost,
  collapseIdentifier,
  campaignReviewPayload,
  summariseTarget,
  resetProviderTokenCache,
  resetMissingConfigurationLog
};
