require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { verifyConnection, supabase } = require('./db');
const { checkAndSendDeliverySMS, pollShipmentStatuses } = require('./routes/webhook-shipstation');
require('./push-notify'); // initialises VAPID on startup

const app = express();

const sseClients = new Set();
function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(data); } catch { sseClients.delete(client); }
  });
}

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
app.use('/webhook/telnyx', express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce', express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce-customer', express.raw({ type: 'application/json' }));

// Parsed JSON for the rest
app.use('/webhook/ghl', express.json());
app.use('/webhook/shipstation', express.json());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
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

// Webhooks (no auth)
app.use('/webhook', require('./routes/webhook')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-ghl')(broadcastSSE));
app.use('/webhook', express.json(), require('./routes/webhook-send')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-woocommerce')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-shipstation')(broadcastSSE));

// Auth
app.use('/auth', require('./routes/auth'));

// Authenticated API routes
app.use('/api/sse', requireAuth, require('./routes/sse')(sseClients));
app.use('/api/send', requireAuth, sendLimiter, require('./routes/send')(broadcastSSE));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/intelligence', requireAuth, require('./routes/intelligence'));
app.use('/api/sync', requireAuth, require('./routes/sync'));
app.use('/api/contacts', requireAuth, require('./routes/contacts'));
app.use('/api/catchup', requireAuth, require('./routes/catchup'));
app.use('/api/push', requireAuth, require('./routes/push')());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Every 30 minutes — poll ShipStation for real carrier scans.
// Sends shipped SMS only when shipmentStatus === 'shipped' (carrier accepted).
// This is the FIX: prevents SMS firing on label creation (SHIP_NOTIFY).
function startShipmentPoll() {
  const THIRTY_MINUTES = 30 * 60 * 1000;
  // Run once shortly after startup to catch anything queued before restart
  setTimeout(async () => {
    try { await pollShipmentStatuses(broadcastSSE); } catch (err) {
      console.error('[POLL] Startup poll error:', err.message);
    }
  }, 10 * 1000); // 10 seconds after boot

  setInterval(async () => {
    try { await pollShipmentStatuses(broadcastSSE); } catch (err) {
      console.error('[POLL] Poll cron error:', err.message);
    }
  }, THIRTY_MINUTES);
}

// Every 6 hours — send delivery review SMS to customers shipped 5+ days ago
function startDeliveryCheck() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const sent = await checkAndSendDeliverySMS(broadcastSSE);
      if (sent > 0) console.log(`[DELIVERY] Sent ${sent} review SMS`);
    } catch (err) {
      console.error('[DELIVERY] Cron error:', err.message);
    }
  }, SIX_HOURS);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await verifyConnection();
  startShipmentPoll();
  startDeliveryCheck();
  console.log(`Vici SMS Inbox running on port ${PORT}`);
  console.log(`Telnyx number: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`WooCommerce: ${process.env.WC_CONSUMER_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`ShipStation: ${process.env.SS_API_KEY ? 'configured' : 'NOT configured'}`);
});

module.exports = { app, broadcastSSE };
