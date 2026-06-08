require('dotenv').config();
const express      = require('express');
const cookieSession = require('cookie-session');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const { verifyConnection }    = require('./db');
const { checkAndSendDeliverySMS, pollForCarrierScans } = require('./routes/webhook-shipstation');
const { processScheduledQueue } = require('./flows/utils');
require('./push-notify'); // initialises VAPID on startup

const app = express();

const sseClients = new Set();
function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(data); } catch { sseClients.delete(client); }
  });
}
require('./lib/broadcaster').setBroadcast(broadcastSSE);

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = ['http://localhost:3000', process.env.APP_URL].filter(Boolean);
    if (allowed.includes(origin) || origin.endsWith('.up.railway.app')) return cb(null, true);
    cb(null, true);
  },
  credentials: true
}));

app.set('trust proxy', 1);

// Raw body for HMAC signature verification on these webhooks
app.use('/webhook/telnyx',              express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce',         express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce-customer', express.raw({ type: 'application/json' }));

// Parsed JSON for the rest
app.use('/webhook/ghl',        express.json());
app.use('/webhook/shipstation', express.json());
app.use(express.json());

// Cookie-session: signed client-side cookie — survives Railway restarts/redeploys.
// Session only stores { authenticated: true } so cookie stays tiny (<100 bytes).
app.use(cookieSession({
  name:   'vici_sess',
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-this',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000  // 30 days
}));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.status(401).json({ error: 'Unauthorised' });
}

const sendLimiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: { error: 'Too many messages, slow down' }
});

// ── Webhooks (no auth) ────────────────────────────────────────────────────
app.use('/webhook', require('./routes/webhook')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-ghl')(broadcastSSE));
app.use('/webhook', express.json(), require('./routes/webhook-send')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-woocommerce')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-shipstation')(broadcastSSE));

// ── Auth ──────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));

// ── Admin (backfill endpoints, protected by INBOX_PASSWORD) ──────────────
app.use('/admin', require('./routes/admin')());

// ── Authenticated API routes ──────────────────────────────────────────────
app.use('/api/sse',           requireAuth, require('./routes/sse')(sseClients));
app.use('/api/send',          requireAuth, sendLimiter, require('./routes/send')(broadcastSSE));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/intelligence',  requireAuth, require('./routes/intelligence'));
app.use('/api/sync',          requireAuth, require('./routes/sync'));
app.use('/api/contacts',      requireAuth, require('./routes/contacts'));
app.use('/api/catchup',       requireAuth, require('./routes/catchup'));
app.use('/api/push',          requireAuth, require('./routes/push')());
app.use('/api/activity',      requireAuth, require('./routes/activity'));
app.use('/api/voice',         requireAuth, require('./routes/voice'));

// Voice webhooks (public — Telnyx calls this directly)
app.use('/webhooks/voice', express.raw({ type: '*/*' }), require('./routes/voice-webhook'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Background jobs ────────────────────────────────────────────────────────

// Every 5 minutes — process scheduled SMS queue (failed/hold sequences + delivery check-ins)
function startScheduledQueue() {
  const FIVE_MINUTES = 5 * 60 * 1000;
  // Run once 15s after boot to catch anything queued before restart
  setTimeout(async () => {
    try { await processScheduledQueue(); }
    catch (err) { console.error('[QUEUE] Startup run error:', err.message); }
  }, 15 * 1000);

  setInterval(async () => {
    try { await processScheduledQueue(); }
    catch (err) { console.error('[QUEUE] Cron error:', err.message); }
  }, FIVE_MINUTES);
}

// Every 30 minutes — poll ShipStation for carrier scans
// Sends shipped SMS only when shipmentStatus === 'shipped' (not on label creation)
function startShipmentPoll() {
  const THIRTY_MINUTES = 30 * 60 * 1000;
  setTimeout(async () => {
    try { await pollForCarrierScans(); }
    catch (err) { console.error('[POLL] Startup poll error:', err.message); }
  }, 10 * 1000);

  setInterval(async () => {
    try { await pollForCarrierScans(); }
    catch (err) { console.error('[POLL] Poll cron error:', err.message); }
  }, THIRTY_MINUTES);
}

// Every 6 hours — delivery review SMS for legacy orders (5 days after shipping)
function startDeliveryCheck() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const sent = await checkAndSendDeliverySMS();
      if (sent > 0) console.log(`[DELIVERY] Sent ${sent} review SMS`);
    } catch (err) {
      console.error('[DELIVERY] Cron error:', err.message);
    }
  }, SIX_HOURS);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await verifyConnection();
  startScheduledQueue();
  startShipmentPoll();
  startDeliveryCheck();
  console.log(`Vici SMS Inbox running on port ${PORT}`);
  console.log(`Telnyx: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`WooCommerce: ${process.env.WC_CONSUMER_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`ShipStation: ${process.env.SS_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`Flows: failed/hold/confirmed/shipped/delivered ACTIVE`);
});

module.exports = { app, broadcastSSE };
