'use strict';
/**
 * routes/mobile-push.js — APNs device registration for the native iPhone app.
 *
 * Two storages, one behaviour. `ios_push_devices` is the dedicated table
 * (scripts/ios-push-devices-migration.sql); until that migration is applied,
 * every write falls back to a typed row in `push_subscriptions` with
 * `endpoint = 'apns://{environment}/{token}'`. Anything done to one storage has
 * to be done to the other, or it only works on whichever half is live —
 * which is exactly how stale-token cleanup came to be a no-op in production.
 */

const { supabase } = require('../db');

const TOKEN_PATTERN = /^[0-9a-f]{64,256}$/i;
const BUNDLE_ID = 'com.vicipeptides.inbox';
const BUILD_PATTERN = /^\d{1,9}$/;
/** `user_id` is a bigint column; a non-numeric id would fail the insert. */
const NUMERIC_ID_PATTERN = /^\d{1,19}$/;
/** Rows to read per page when the compatibility fallback has to scan. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

let didWarnAboutNonNumericActor = false;

function legacyEndpoint(token, environment) {
  return `apns://${environment}/${token}`;
}

/**
 * The build the app reports about itself. Optional: an older client that does
 * not send it must keep registering, so an absent or malformed value becomes
 * null rather than a 400. lib/release-targets.js then falls back to the
 * User-Agent, and treats an unknown build as "include", not "skip".
 */
function normaliseAppBuild(value) {
  const text = String(value ?? '').trim();
  return BUILD_PATTERN.test(text) ? text : null;
}

/**
 * The owner of this device, taken ONLY from the authenticated session.
 *
 * Never from the request body. A client-supplied user id is a trivial
 * impersonation vector: anyone who can register a device could claim to be
 * another operator and receive pushes addressed to them.
 */
function actorUserID(req) {
  const id = req?.actor?.id;
  if (id === null || id === undefined || id === '') return null;
  const text = String(id).slice(0, 64);
  if (!NUMERIC_ID_PATTERN.test(text) && !didWarnAboutNonNumericActor) {
    didWarnAboutNonNumericActor = true;
    console.warn('APNs: actor id is not numeric — ios_push_devices.user_id is bigint, so device ownership will only persist in compatibility storage');
  }
  return text;
}

async function registerInExistingPushTable(row) {
  return supabase.from('push_subscriptions').upsert({
    endpoint: legacyEndpoint(row.device_token, row.environment),
    subscription: {
      type: 'ios-apns',
      deviceToken: row.device_token,
      installationId: row.installation_id,
      environment: row.environment,
      bundleId: row.bundle_id,
      // The column is already jsonb, so ownership and build ride along here
      // with no migration. lib/apns-notify.js normalises these back out.
      userId: row.user_id,
      appBuild: row.app_build
    },
    user_agent: row.user_agent,
    updated_at: row.updated_at
  }, { onConflict: 'endpoint' });
}

/**
 * APNs rotates a device token. The prior row for the same app install has to
 * go, or it keeps receiving alerts until APNs eventually 410s it — which can
 * take weeks, and every send in between is wasted or delivered to a device the
 * operator has signed out of.
 *
 * This mirrors the dedicated-table cleanup into compatibility storage. Without
 * it the cleanup only ran against `ios_push_devices`, which does not exist in
 * production, so the error was logged, swallowed, and nothing was ever removed.
 */
async function removeStaleCompatibilityRegistrations(installationId, deviceToken) {
  // Preferred: let Postgres do the matching on the jsonb key. Nothing is read
  // into memory, so there is no row cap to trip over.
  const direct = await supabase.from('push_subscriptions')
    .delete()
    .eq('subscription->>installationId', installationId)
    .not('endpoint', 'like', `%/${deviceToken}`);
  if (!direct.error) return null;

  // Fallback for a PostgREST that rejects the arrow operator in a filter. Read
  // in pages: an unpaged read is silently capped at 1000 rows, and a stale row
  // past the cap would never be cleaned up.
  const stale = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase.from('push_subscriptions')
      .select('id, endpoint, subscription')
      .like('endpoint', 'apns://%')
      .range(from, from + PAGE_SIZE - 1);
    if (error) return error;
    for (const row of data || []) {
      if (row.subscription?.installationId !== installationId) continue;
      if (row.subscription?.deviceToken === deviceToken) continue;
      stale.push(row.id);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  if (!stale.length) return null;

  // bounded: prior registrations of one installationId — one iPhone's own
  // rotated tokens, a handful at most, never the whole table.
  const { error } = await supabase.from('push_subscriptions').delete().in('id', stale);
  return error || null;
}

module.exports = () => {
  const router = require('express').Router();

  router.post('/register', async (req, res) => {
    const { deviceToken, installationId, environment, appBuild } = req.body || {};
    if (!TOKEN_PATTERN.test(deviceToken || '')) {
      return res.status(400).json({ error: 'Invalid APNs device token' });
    }
    if (!['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'Invalid APNs environment' });
    }

    const row = {
      device_token: deviceToken.toLowerCase(),
      installation_id: typeof installationId === 'string' ? installationId.slice(0, 100) : null,
      environment,
      bundle_id: BUNDLE_ID,
      enabled: true,
      user_id: actorUserID(req),
      app_build: normaliseAppBuild(appBuild),
      user_agent: req.headers['user-agent']?.slice(0, 200) || 'Vici Inbox iOS',
      last_error: null,
      updated_at: new Date().toISOString()
    };
    if (row.installation_id) {
      // APNs may rotate a token. Remove the prior token for this app install so
      // it cannot continue receiving alerts until APNs eventually returns 410.
      const { error: cleanupError } = await supabase.from('ios_push_devices')
        .delete()
        .eq('installation_id', row.installation_id)
        .neq('device_token', row.device_token);
      if (cleanupError) {
        console.error('APNs stale device cleanup failed:', cleanupError.message);
      }
      const compatibilityCleanupError = await removeStaleCompatibilityRegistrations(
        row.installation_id, row.device_token
      );
      if (compatibilityCleanupError) {
        console.error('APNs stale compatibility cleanup failed:', compatibilityCleanupError.message);
      }
    }
    const dedicatedRow = { ...row };
    // A bigint column cannot take a non-numeric id. Drop it rather than fail the
    // whole registration; compatibility storage still records the owner.
    if (dedicatedRow.user_id && !NUMERIC_ID_PATTERN.test(dedicatedRow.user_id)) {
      dedicatedRow.user_id = null;
    }
    const { error } = await supabase.from('ios_push_devices')
      .upsert(dedicatedRow, { onConflict: 'device_token' });
    if (error) {
      // Keep rollout independent of a manual SQL-editor step. The existing
      // browser push table can safely hold typed APNs records; browser delivery
      // explicitly filters the apns:// namespace.
      const { error: fallbackError } = await registerInExistingPushTable(row);
      if (fallbackError) {
        console.error('APNs device registration failed:', fallbackError.message);
        return res.status(500).json({ error: 'Could not register this device for notifications' });
      }
      console.log(`APNs: registered ${environment} device in compatibility storage ...${row.device_token.slice(-8)}`);
      return res.json({ ok: true, storage: 'compatibility' });
    }
    console.log(`APNs: registered ${environment} device ...${row.device_token.slice(-8)}`);
    res.json({ ok: true });
  });

  router.post('/unregister', async (req, res) => {
    const { deviceToken, installationId } = req.body || {};
    const hasToken = TOKEN_PATTERN.test(deviceToken || '');
    const hasInstallation = typeof installationId === 'string' && installationId.length > 0;
    if (!hasToken && !hasInstallation) {
      return res.status(400).json({ error: 'Missing APNs device identity' });
    }
    let query = supabase.from('ios_push_devices').delete();
    query = hasInstallation
      ? query.eq('installation_id', installationId.slice(0, 100))
      : query.eq('device_token', deviceToken.toLowerCase());
    const { error } = await query;

    // Also remove any compatibility record. This covers sign-out both before
    // and after the dedicated table migration.
    let fallbackError = null;
    if (hasToken) {
      ({ error: fallbackError } = await supabase.from('push_subscriptions')
        .delete().like('endpoint', `apns://%/${deviceToken.toLowerCase()}`));
    } else {
      const { data: legacyRows, error: readError } = await supabase.from('push_subscriptions')
        .select('id, subscription').like('endpoint', 'apns://%');
      fallbackError = readError;
      const matchingIDs = (legacyRows || [])
        .filter(row => row.subscription?.installationId === installationId.slice(0, 100))
        .map(row => row.id);
      if (!fallbackError && matchingIDs.length) {
        // bounded: rows for a single installationId — one device's own duplicate
        // registrations, a handful at most, never the whole table.
        ({ error: fallbackError } = await supabase.from('push_subscriptions')
          .delete().in('id', matchingIDs));
      }
    }
    if (error && fallbackError) return res.status(500).json({ error: 'Could not unregister this device' });
    res.json({ ok: true });
  });

  router.get('/status', async (_req, res) => {
    let { data, error } = await supabase.from('ios_push_devices')
      .select('environment, enabled, updated_at, last_error');
    let storage = 'dedicated';
    if (error) {
      storage = 'compatibility';
      const fallback = await supabase.from('push_subscriptions')
        .select('subscription, updated_at').like('endpoint', 'apns://%');
      error = fallback.error;
      data = (fallback.data || []).map(row => ({
        environment: row.subscription?.environment,
        enabled: true,
        updated_at: row.updated_at,
        last_error: null
      }));
    }
    res.json({
      apns_configured: !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_P8_BASE64),
      device_count: data?.filter(row => row.enabled).length || 0,
      storage,
      devices: (data || []).map(row => ({
        environment: row.environment,
        enabled: row.enabled,
        updated_at: row.updated_at,
        last_error: row.last_error
      })),
      error: error?.message || null
    });
  });

  router.post('/test', async (req, res) => {
    const { sendNativeMessagePush } = require('../lib/apns-notify');
    try {
      const result = await sendNativeMessagePush({
        title: 'Vici Inbox test',
        body: 'Native iPhone notifications are connected.',
        phone: typeof req.body?.phone === 'string' ? req.body.phone : ''
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports.normaliseAppBuild = normaliseAppBuild;
module.exports.actorUserID = actorUserID;
