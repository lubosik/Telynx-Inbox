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
  const { data: subs, error: dbErr } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, subscription');

  if (dbErr) {
    console.error('Push: failed to fetch subscriptions from DB:', dbErr.message);
    return;
  }

  if (!subs?.length) {
    console.log('Push: no subscriptions in DB — skipping');
    return;
  }

  console.log(`Push: sending to ${subs.length} subscription(s)`);
  const msg = JSON.stringify(payload);
  const opts = { TTL: 86400, urgency: 'high' };

  await Promise.allSettled(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, msg, opts);
        console.log('Push: delivered to', row.endpoint.slice(-30));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired at the push service (APNs/FCM). Remove from DB.
          // The client will detect the missing row on next load via /api/push/check
          // and force a fresh browser subscribe.
          await supabase.from('push_subscriptions').delete().eq('id', row.id);
          console.log('Push: removed expired subscription (410/404)', row.endpoint.slice(-30));
        } else {
          console.error('Push send error:', err.statusCode, err.message, err.body?.slice?.(0, 200));
        }
      }
    })
  );
}

module.exports = { sendPushToAll };
