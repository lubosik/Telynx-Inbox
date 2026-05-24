const webpush = require('web-push');
const { supabase } = require('./db');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:lubosi@kongwatech.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Send a push notification to every stored subscription.
// Payload: { title, body, url, icon }
async function sendPushToAll(payload) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, subscription');

  if (!subs?.length) return;

  const msg = JSON.stringify(payload);
  const opts = { TTL: 86400, urgency: 'high' };

  await Promise.allSettled(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, msg, opts);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', row.id);
          console.log('Push: removed expired subscription', row.endpoint.slice(-20));
        } else {
          console.error('Push send error:', err.statusCode, err.body?.slice?.(0, 100));
        }
      }
    })
  );
}

module.exports = { sendPushToAll };
