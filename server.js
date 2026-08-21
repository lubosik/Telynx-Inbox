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
const { startRecordingRetentionJob } = require('./lib/private-recordings');
const { requireAuth, resolveActor } = require('./lib/authz');
const { collapseDuplicateSlashes, rejectMiscasedApiPaths } = require('./lib/request-normalise');
const { createPolicyEnforcer, assertPolicyPermissionsExist } = require('./lib/enforce-policy');
const { syncLegacySharedRole } = require('./routes/auth');
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

// Route matching is case-sensitive from here on. Express defaults to
// case-INSENSITIVE, which meant `GET /API/users` reached the /api handlers.
// The policy enforcer now lower-cases before matching so those requests are
// still authorised correctly; this is the second layer, so a future mount that
// forgets the gate cannot be reached by casing either.
app.set('case sensitive routing', true);

// Collapse repeated slashes before routing.
//
// `app.use('/api', ...)` does not match `//api/conversations`, so neither the
// authorisation gate NOR the real handler runs — the request falls through to
// the SPA catch-all and returns index.html with HTTP 200. That is not a data
// leak, but a client asking for JSON gets a page of HTML and is told it
// succeeded, which is exactly the failure mode the gate exists to remove.
// Normalise instead of special-casing, so it is fixed for every route at once.
app.use(collapseDuplicateSlashes);
app.use(rejectMiscasedApiPaths);

// Raw body for HMAC signature verification on these webhooks
app.use('/webhook/telnyx',              express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce',         express.raw({ type: 'application/json' }));
app.use('/webhook/woocommerce-customer', express.raw({ type: 'application/json' }));
// Voice Call Control webhook — must be raw before the global express.json() runs
app.use('/webhooks/voice',              express.raw({ type: 'application/json' }));

// Parsed JSON for the rest
app.use('/webhook/ghl',        express.json());
app.use('/webhook/shipstation', express.json());
// Image uploads arrive as base64 JSON — needs a higher limit than the default 100kb
app.use('/api/upload', express.json({ limit: '8mb' }));
app.use(express.json());

// Cookie-session: signed client-side cookie — survives Railway restarts/redeploys.
// Session only stores { authenticated: true } so cookie stays tiny (<100 bytes).
// A signed cookie is only as good as its secret. The previous fallback value
// was committed to this repository, so an unset SESSION_SECRET meant anyone who
// could read the source could mint a valid session. Refuse to start instead:
// a service that will not boot is recoverable, a forgeable session is not.
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Refusing to start — without it the session cookie signature is forgeable from this repository.');
  process.exit(1);
}

app.use(cookieSession({
  name:   'vici_sess',
  secret: process.env.SESSION_SECRET,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000  // 30 days
}));

// requireAuth now lives in lib/authz.js. It proves there is a signed session;
// resolveActor turns that session into a database-backed identity; the policy
// enforcer decides what that identity may do. Nothing authority-bearing is ever
// read out of the cookie, so there is no role field for a client to forge.

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

// ── Authorisation for every /api request ──────────────────────────────────
// Session -> actor (read from the database, uncached) -> route policy.
//
// DEFAULT DENY: an /api path with no entry in lib/route-policy.js answers 403
// POLICY_MISSING, so a new endpoint cannot ship open by omission. That also
// stops an unmatched /api request falling through to the SPA catch-all below
// and returning index.html with HTTP 200.
//
// Mounted on '/api' ONLY. It must never become a bare app.use(): every webhook
// above runs unauthenticated by design, and guarding them globally would stop
// inbound SMS, delivery receipts, Woo order flows, shipping updates and
// inbound calls, all at once and silently.
app.use('/api', requireAuth, resolveActor, createPolicyEnforcer());

// ── Authenticated API routes ──────────────────────────────────────────────
app.use('/api/sse',           requireAuth, require('./routes/sse')(sseClients));
app.use('/api/send',          requireAuth, sendLimiter, require('./routes/send')(broadcastSSE));
app.use('/api/upload',        requireAuth, require('./routes/upload'));
app.use('/api/react',         requireAuth, sendLimiter, require('./routes/react')(broadcastSSE));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/intelligence',  requireAuth, require('./routes/intelligence'));
app.use('/api/sync',          requireAuth, require('./routes/sync'));
app.use('/api/contacts',      requireAuth, require('./routes/contacts'));
app.use('/api/catchup',       requireAuth, require('./routes/catchup'));
app.use('/api/push',          requireAuth, require('./routes/push')());
app.use('/api/mobile-push',   requireAuth, require('./routes/mobile-push')());
app.use('/api/activity',      requireAuth, require('./routes/activity'));
app.use('/api/voice',         requireAuth, require('./routes/voice'));
app.use('/api/analytics',     requireAuth, require('./routes/analytics')());
app.use('/api/users',         requireAuth, require('./routes/users')());
app.use('/api/invitations',   requireAuth, require('./routes/invitations')());
app.use('/api/audit',         requireAuth, require('./routes/audit')());

// Voice webhooks (public — Telnyx calls this directly)
app.use('/webhooks/voice', require('./routes/voice-webhook'));

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

  // Fail startup rather than serve a build whose permission keys do not exist
  // in the database, which would deny every endpoint for every role including
  // Owner. Both calls require scripts/rbac-migration.sql to have been applied,
  // so the deploy order is migration first, then code — and getting it wrong
  // crash-loops loudly instead of quietly serving a broken authorisation layer.
  try {
    await assertPolicyPermissionsExist();
    const legacy = await syncLegacySharedRole();
    console.log(`Accounts: route policy validated; shared login role = ${legacy.role}${legacy.changed ? ' (updated from env)' : ''}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  startScheduledQueue();
  startShipmentPoll();
  startDeliveryCheck();
  startRecordingRetentionJob();
  console.log(`Vici SMS Inbox running on port ${PORT}`);
  console.log(`Telnyx: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`WooCommerce: ${process.env.WC_CONSUMER_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`ShipStation: ${process.env.SS_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`Flows: failed/hold/confirmed/shipped/delivered ACTIVE`);
});

module.exports = { app, broadcastSSE };
