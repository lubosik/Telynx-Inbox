'use strict';
/**
 * lib/apns-notify.js — native iPhone alerts over APNs.
 *
 * Five kinds of push live here and they are deliberately NOT the same payload:
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
 *   sendSegmentChangeNotifications — one segment moved.
 *   sendDailyDigestNotifications   — the once-a-day summary of everything that
 *                             moved, delivered at a local hour in each
 *                             account's own zone. Interruption level `active`,
 *                             no badge, and its own feature flag.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ONE OF THEM CONSULTS THE ACCOUNT'S NOTIFICATION PREFERENCE, and it is
 * consulted HERE, in `splitByPreference()`, immediately before the device list
 * goes to Apple. Not at the call sites that decide to notify. There are five
 * senders and there will be more; filtering at the last boundary means a future
 * one cannot forget, and a toggle that does not actually stop the push is worse
 * than no toggle. See lib/notifications/preferences.js for the per-category
 * failure modes and the argument for them.
 * ─────────────────────────────────────────────────────────────────────────────
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
const {
  CATEGORY_FAILURE_MODE,
  partitionDevices,
  readPreferences
} = require('./notifications/preferences');

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

/**
 * Split a device list on one notification category.
 *
 * THE PREFERENCE IS CONSULTED HERE, AT DELIVERY, AND NOT AT THE CALL SITES THAT
 * DECIDE TO NOTIFY. There are five senders in this file and there will be more;
 * filtering at the last boundary before Apple means a future sender cannot
 * forget, and a toggle that does not actually stop the push is worse than no
 * toggle at all.
 *
 * A read failure is per category. Everything that already reached a phone
 * before this table existed fails OPEN, so deploying this code before running
 * the migration cannot silently switch four working features off. Only
 * `daily_digest`, which ships with the migration and has never sent anything,
 * fails CLOSED. A row that EXISTS and says false is honoured in every case;
 * failing open is about an ABSENT answer and never about overriding a given
 * one. The full argument is in lib/notifications/preferences.js.
 *
 * @returns {Promise<{accepted: Array, declined: Array, available: boolean}>}
 */
async function splitByPreference(devices, category, client) {
  const owners = (devices || []).map(row => row.user_id).filter(Boolean);
  if (!owners.length) return { accepted: devices || [], declined: [], available: true };
  const preferences = await readPreferences({ client, userIDs: owners });
  if (!preferences.available) {
    console.warn(`APNs: notification preferences unreadable (${preferences.reason}); `
      + `${category} falls ${CATEGORY_FAILURE_MODE[category] === 'open' ? 'open' : 'closed'}.`);
  }
  const split = partitionDevices(devices, category, preferences);
  if (split.declined.length) {
    console.log(`APNs: ${split.declined.length} device(s) have ${category} switched off`);
  }
  return { ...split, available: preferences.available };
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

  // "Do not alert me about customer messages" is honoured here. It fails OPEN
  // on an unreadable preference: this runs on the inbound webhook path and a
  // customer waiting because one phone stayed dark is not recoverable.
  const wantsMessages = await splitByPreference(devices, 'new_customer_messages', client);
  if (!wantsMessages.accepted.length) return { sent: 0, suppressed: wantsMessages.declined.length };

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
  const missedCount = unreadCount === null ? 0 : await countUnseenMissedCalls();

  // THE `missed_calls` TOGGLE, MADE REAL.
  //
  // There is no server-sent missed-call alert to suppress: an incoming call
  // arrives as a Telnyx VoIP push and CallKit presents it, which is iOS's
  // business and not ours. What this server DOES own is the badge, and the
  // badge is the only honest thing the toggle can control. So the device list
  // is split and each half gets its own badge: one counting unread plus unseen
  // missed calls, one counting unread alone. The Settings screen says exactly
  // that rather than implying a switch it does not have.
  //
  // Two deliveries at most, and only when somebody has actually turned it off.
  const wantsMissedCalls = await splitByPreference(
    wantsMessages.accepted, 'missed_calls', client);

  const basePayload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': phone || 'vici-inbox'
    },
    phone: phone || ''
  };
  const payloadWithBadge = badge => (badge === null
    ? basePayload
    : { ...basePayload, aps: { ...basePayload.aps, badge } });

  const groups = [
    { rows: wantsMissedCalls.accepted, badge: unreadCount === null ? null : unreadCount + missedCount },
    { rows: wantsMissedCalls.declined, badge: unreadCount }
  ].filter(group => group.rows.length);

  let sent = 0;
  for (const group of groups) {
    const result = await deliver(
      group.rows, payloadWithBadge(group.badge), {}, { ...options, client, authorization });
    sent += result.sent;
  }

  if (sent > 0) console.log(`APNs: delivered message notification to ${sent} iOS device(s)`);
  return { sent, suppressed: wantsMessages.declined.length };
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

  const selected = selectReleaseTargets(devices, {
    userId: normaliseUserID(userId),
    belowBuild
  });
  // Release announcements predate this table, so an unreadable preference
  // delivers rather than silently switching an existing feature off.
  const releaseWanted = await splitByPreference(selected, 'new_releases', client);
  const targets = releaseWanted.accepted;

  if (dryRun) {
    return {
      sent: 0,
      dryRun: true,
      targeted: targets.length,
      // A dry run answers "who would this reach", so it must report the people
      // who opted out rather than making them look like devices that vanished.
      optedOut: releaseWanted.declined.length,
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

  // `passive`, per D1 of docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md. A
  // new TestFlight build must never light the screen: a push cannot install a
  // build, so the honest urgency of this notification is "next time you look at
  // your phone". `sound` is dropped for the same reason; a passive
  // notification that made a noise would be a contradiction.
  const payload = {
    aps: {
      alert: { title, body },
      'thread-id': 'vici-release',
      'interruption-level': 'passive',
      'relevance-score': 0.1
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
  const owned = devices.filter(row => row.user_id && userIDs.has(normaliseUserID(row.user_id)));
  // Review alerts predate this table, so an unreadable preference delivers. An
  // explicit `false` is still honoured, which is the part that matters.
  const wanted = await splitByPreference(owned, 'campaign_proposals', client);
  const targets = wanted.accepted;
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
  const owned = devices.filter(row => row.user_id && userIDs.has(normaliseUserID(row.user_id)));
  // ONE SUBJECT, ONE TOGGLE. The per-segment push and the daily digest are two
  // deliveries of the same news, so both are governed by `daily_digest`. Two
  // switches for one thing is how somebody ends up receiving what they turned
  // off.
  const wanted = await splitByPreference(owned, 'daily_digest', client);
  const targets = wanted.accepted;
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

/**
 * The daily digest payload, validated the same way the other two are.
 *
 * INTERRUPTION LEVEL `active`, NEVER `time-sensitive`, per D1 of
 * docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md. Apple's HIG reserves Time
 * Sensitive for things relevant in the moment; a summary of yesterday's
 * arithmetic is not one, it is equally true an hour later, and asking Apple to
 * break a Focus the person set deliberately is precisely how an app earns a
 * global mute. Time Sensitive stays with incoming messages and calls.
 *
 * RELEVANCE SCORE 0.9, per D1. It does not make the notification louder; it
 * decides which item leads a Scheduled Summary if the digest lands in one, and
 * a once-a-day summary that arrives inside a summary should be the headline of
 * it.
 *
 * NO BADGE. D7 asks for `badge = pending proposals` and this deliberately does
 * not do it. iOS gives the app one badge number and it already means "unread
 * customer messages plus missed calls nobody has looked at", reconciled on
 * every message push and persisted on the client. A digest carrying a proposal
 * count would overwrite a live operational count with an unrelated one, which
 * is the same rule the release notification already follows and documents.
 *
 * `category` is what carries the two actions and the hidden-previews
 * placeholder. Both are registered on the CLIENT, in
 * MessageNotificationManager, because `hiddenPreviewsBodyPlaceholder` is a
 * property of a UNNotificationCategory and has no payload equivalent.
 */
function dailyDigestPayload(notification) {
  if (notification?.channel !== 'native_push_preparation') return null;
  const title = String(notification?.payload?.aps?.alert?.title || '').trim().slice(0, 120);
  const body = String(notification?.payload?.aps?.alert?.body || '').trim().slice(0, 500);
  const digestDay = String(notification?.payload?.digestDay || '').trim().slice(0, 10);
  if (!title || !body || !/^\d{4}-\d{2}-\d{2}$/.test(digestDay)) return null;
  // House copy rule, enforced at the last boundary before Apple. A dash that
  // slipped past the preparation module must not reach a device.
  if (title.includes('—') || body.includes('—')) return null;
  const whole = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': 'segment-digest',
      category: 'SEGMENT_DIGEST',
      'interruption-level': 'active',
      'relevance-score': 0.9
    },
    screen: 'segments',
    digestDay,
    materialSegmentCount: whole(notification?.payload?.materialSegmentCount),
    proposalCount: whole(notification?.payload?.proposalCount),
    failedSegmentCount: whole(notification?.payload?.failedSegmentCount)
  };
}

/**
 * Deliver internally prepared daily digests, only to devices owned by the
 * accounts named in those preparations.
 *
 * Same discipline as the campaign and segment senders, and for the same
 * reasons. Unowned compatibility devices are excluded: a digest names segments
 * and counts, which is customer data in aggregate, and a device nobody owns is
 * a device nobody consented on behalf of.
 *
 * THREE INDEPENDENT BRAKES, ALL OF WHICH MUST BE OFF FOR ANYTHING TO SEND:
 *   1. `DAILY_DIGEST_NOTIFICATIONS_ENABLED` must be exactly the lowercase
 *      string `true`. It defaults off.
 *   2. APNs provider credentials must be configured.
 *   3. The recipient must not have switched `daily_digest` off, and that
 *      preference fails CLOSED when it cannot be read.
 *
 * Unlike the other two senders this one takes preparations for SEVERAL
 * accounts at once and does not require them to share a payload: two people
 * five hours apart receive their digests on different ticks, and a batch with
 * one entry is the normal case.
 */
async function sendDailyDigestNotifications(notifications = [], {
  dryRun = true
} = {}, options = {}) {
  const env = options.env || process.env;
  const prepared = (notifications || []).filter(row => row?.eventType === 'notifications.daily_digest');
  if (!prepared.length) return { sent: 0, targeted: 0, error: 'invalid_digest_preparation' };
  const payloads = new Map();
  for (const row of prepared) {
    const payload = dailyDigestPayload(row);
    const userID = normaliseUserID(row.userID);
    if (!payload || !userID) return { sent: 0, targeted: 0, error: 'invalid_digest_preparation' };
    payloads.set(userID, { payload, collapseID: row.collapseID });
  }

  if (!dryRun && env.DAILY_DIGEST_NOTIFICATIONS_ENABLED !== 'true') {
    return { sent: 0, targeted: 0, disabled: true, reason: 'feature_flag_disabled' };
  }

  const client = options.client || supabase;
  const load = options.loadDevices || loadDevices;
  const { devices, error } = await load({ client });
  if (error) return { sent: 0, targeted: 0, error: 'digest_device_load_failed' };
  const owned = devices.filter(row => row.user_id && payloads.has(normaliseUserID(row.user_id)));
  const wanted = await splitByPreference(owned, 'daily_digest', client);
  const targets = wanted.accepted;

  if (dryRun) {
    return {
      sent: 0,
      dryRun: true,
      targeted: targets.length,
      optedOut: wanted.declined.length,
      targets: targets.map(summariseTarget)
    };
  }
  if (!targets.length) return { sent: 0, targeted: 0, targets: [] };

  const config = configuration();
  if (!config && !options.authorization) return reportMissingConfiguration('daily digest notifications');
  let authorization = options.authorization;
  if (!authorization) {
    try {
      authorization = providerToken(config);
    } catch (tokenError) {
      console.error('APNs: digest provider token creation failed:', tokenError.message);
      return { sent: 0, targeted: targets.length, error: 'digest_token_failed' };
    }
  }

  // One delivery per account, because each account's digest is its own payload
  // and its own collapse id. Two people never share a banner.
  const deliverNotifications = options.deliver || deliver;
  let sent = 0;
  let failed = 0;
  for (const [userID, entry] of payloads) {
    const rows = targets.filter(row => normaliseUserID(row.user_id) === userID);
    if (!rows.length) continue;
    const result = await deliverNotifications(
      rows,
      entry.payload,
      { 'apns-collapse-id': collapseIdentifier(entry.collapseID || 'vici-daily-digest') },
      { ...options, client, authorization }
    );
    sent += result.sent;
    failed += result.failed;
  }
  return { sent, failed, targeted: targets.length, targets: targets.map(summariseTarget) };
}

module.exports = {
  dailyDigestPayload,
  sendCampaignReadyNotifications,
  sendDailyDigestNotifications,
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
  splitByPreference,
  summariseTarget,
  resetProviderTokenCache,
  resetMissingConfigurationLog
};
