const { supabase } = require('../db');

const TOKEN_PATTERN = /^[0-9a-f]{64,256}$/i;
const BUNDLE_ID = 'com.vicipeptides.inbox';

module.exports = () => {
  const router = require('express').Router();

  router.post('/register', async (req, res) => {
    const { deviceToken, installationId, environment } = req.body || {};
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
    }
    const { error } = await supabase.from('ios_push_devices')
      .upsert(row, { onConflict: 'device_token' });
    if (error) {
      console.error('APNs device registration failed:', error.message);
      return res.status(500).json({ error: 'Could not register this device for notifications' });
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
    if (error) return res.status(500).json({ error: 'Could not unregister this device' });
    res.json({ ok: true });
  });

  router.get('/status', async (_req, res) => {
    const { data, error } = await supabase.from('ios_push_devices')
      .select('environment, enabled, updated_at, last_error');
    res.json({
      apns_configured: !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_P8_BASE64),
      device_count: data?.filter(row => row.enabled).length || 0,
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
