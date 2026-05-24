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

  return router;
};
