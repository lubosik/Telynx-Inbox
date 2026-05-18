require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { verifyConnection } = require('./db');

const app = express();

const sseClients = new Set();
function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(data); } catch { sseClients.delete(client); }
  });
}

app.use(helmet({ contentSecurityPolicy: false }));

// Frontend is served by Express on the same origin — CORS only needed for local dev
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests have no Origin header — always allow
    if (!origin) return cb(null, true);
    // Allow Railway URLs, localhost, and whatever APP_URL is set to
    const allowed = [
      'http://localhost:3000',
      process.env.APP_URL,
    ].filter(Boolean);
    if (allowed.includes(origin) || origin.endsWith('.up.railway.app')) return cb(null, true);
    cb(null, true); // permissive — auth is handled by session, not CORS
  },
  credentials: true
}));

// Trust Railway's proxy so secure cookies work behind HTTPS termination
app.set('trust proxy', 1);

// Telnyx needs raw body for signature verification, GHL needs parsed JSON
app.use('/webhook/telnyx', express.raw({ type: 'application/json' }));
app.use('/webhook/ghl', express.json());

// JSON body for all other routes
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

app.use('/webhook', require('./routes/webhook')(broadcastSSE));
app.use('/webhook', require('./routes/webhook-ghl')(broadcastSSE));
app.use('/auth', require('./routes/auth'));
app.use('/api/sse', requireAuth, require('./routes/sse')(sseClients));
app.use('/api/send', requireAuth, sendLimiter, require('./routes/send')(broadcastSSE));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/intelligence', requireAuth, require('./routes/intelligence'));
app.use('/api/sync', requireAuth, require('./routes/sync'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await verifyConnection();
  console.log(`Vici SMS Inbox running on port ${PORT}`);
  console.log(`GHL Location: ${process.env.GHL_LOCATION_ID}`);
  console.log(`Telnyx number: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`GHL token: ${process.env.GHL_AGENCY_TOKEN?.slice(0, 8)}***`);
  console.log(`OR key: ${process.env.OPENROUTER_API_KEY?.slice(0, 8)}***`);
});

module.exports = { app, broadcastSSE };
