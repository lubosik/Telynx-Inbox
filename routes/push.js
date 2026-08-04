const { supabase } = require('../db');

module.exports = () => {
  const router = require('express').Router();

  // Return the VAPID public key so the browser can subscribe
  router.get('/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  });

  // Store a push subscription from the browser
  router.post('/subscribe', async (req, res) => {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys) return res.status(400).json({ error: 'Invalid subscription' });

    const { error } = await supabase.from('push_subscriptions').upsert({
      endpoint: sub.endpoint,
      subscription: sub,
      user_agent: req.headers['user-agent']?.slice(0, 200) || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });

    if (error) {
      console.error('Push subscribe error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log('Push subscription saved:', sub.endpoint.slice(-30));
    res.json({ ok: true });
  });

  // Remove a subscription (user turned off notifications)
  router.post('/unsubscribe', async (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    res.json({ ok: true });
  });

  // Check if a specific endpoint is still active in the DB.
  // Client calls this on load to detect if a 410 pruned the subscription server-side,
  // so it can force a fresh browser subscribe rather than re-saving a dead endpoint.
  router.post('/check', async (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const { data } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', endpoint)
      .maybeSingle();
    res.json({ active: !!data });
  });

  // Fire a real test push to all subscriptions — confirms server→APNs→device path
  router.post('/test', async (req, res) => {
    const { sendPushToAll } = require('../push-notify');
    try {
      await sendPushToAll({
        title: '🔔 Test notification',
        body: 'Push is working! You will receive real SMS alerts.',
        url: '/',
        icon: '/icons/icon-192.png'
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Debug endpoint — returns subscription count and config status
  router.get('/status', (req, res) => {
    supabase
      .from('push_subscriptions')
      .select('id, endpoint, user_agent, updated_at')
      .not('endpoint', 'like', 'apns://%')
      .then(({ data, error }) => {
        res.json({
          vapid_configured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
          vapid_subject: process.env.VAPID_SUBJECT || '(not set)',
          subscription_count: data?.length ?? 0,
          subscriptions: (data || []).map(s => ({
            id: s.id,
            endpoint_tail: s.endpoint?.slice(-40),
            user_agent: s.user_agent,
            updated_at: s.updated_at
          })),
          error: error?.message || null
        });
      });
  });

  return router;
};
