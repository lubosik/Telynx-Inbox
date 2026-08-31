require('dotenv').config();
const express      = require('express');
const cookieSession = require('cookie-session');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const { supabase, verifyConnection } = require('./db');
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
app.use('/webhook/woocommerce-product', express.raw({ type: 'application/json' }));
// Voice Call Control webhook — must be raw before the global express.json() runs
app.use('/webhooks/voice',              express.raw({ type: 'application/json' }));

// Parsed JSON for the rest
app.use('/webhook/ghl',        express.json());
app.use('/webhook/shipstation', express.json());
// Image uploads arrive as base64 JSON — needs a higher limit than the default 100kb
// ── ONE OPPORTUNITY PORTFOLIO, NOT THREE ──────────────────────────────────
//
// The detector reads every paid order, every contact and the live WooCommerce
// catalogue, so a rebuild is expensive and the service caches it for six
// hours. There were three separate instances: the scheduled refresh below made
// its own, the campaigns router made its own, and the proposals router would
// have made a third.
//
// So the scheduled rebuild every six hours warmed a cache that no HTTP request
// ever read, and the first person to open the opportunities screen after a TTL
// expiry paid for a full cold rebuild anyway. The background job was pure
// waste and the screen was slow for no reason.
//
// Lazy, because constructing it must not require database or WooCommerce
// credentials at module load: the route tests build these routers without any.
let sharedOpportunityPortfolio = null;
function opportunityPortfolio() {
  if (!sharedOpportunityPortfolio) {
    const { createOpportunityPortfolioService } = require('./lib/campaigns/opportunity-portfolio');
    sharedOpportunityPortfolio = createOpportunityPortfolioService({ env: process.env });
  }
  return sharedOpportunityPortfolio;
}

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

// ── Public well-known documents (no auth) ─────────────────────────────────
// `/.well-known/apple-app-site-association` is what iOS fetches to decide
// whether an ${APP_URL}/accept-invite?token=... link may open the native app
// instead of Safari.
//
// THIS MOUNT'S POSITION IS THE FIX. Before this line existed the path fell
// through to the SPA catch-all at the bottom of this file and Apple received
// index.html with HTTP 200 — valid-looking, entirely wrong, and silent: no
// error, no log, universal links simply never worked. It must stay above
// express.static and above `app.get('/{*splat}')`, and it is deliberately
// above the `/api` gate and outside its prefix, because Apple fetches it
// anonymously and a 401 reads to it exactly like a missing document.
// test/apple-site-association.test.js asserts both orderings against this file.
app.use('/.well-known', require('./routes/well-known')());

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
app.use('/api/referrals',     requireAuth, require('./routes/referrals')());
app.use('/api/do-not-contact', requireAuth, require('./routes/do-not-contact')());
app.use('/api/intelligence',  requireAuth, require('./routes/intelligence'));
app.use('/api/sync',          requireAuth, require('./routes/sync'));
app.use('/api/contacts',      requireAuth, require('./routes/contacts'));
app.use('/api/catchup',       requireAuth, require('./routes/catchup'));
app.use('/api/push',          requireAuth, require('./routes/push')());
app.use('/api/mobile-push',   requireAuth, require('./routes/mobile-push')());
app.use('/api/activity',      requireAuth, require('./routes/activity'));
app.use('/api/voice',         requireAuth, require('./routes/voice'));
app.use('/api/analytics',     requireAuth, require('./routes/analytics')());
app.use('/api/assistant',     requireAuth, require('./routes/assistant')({ services: { opportunities: opportunityPortfolio() } }));
app.use('/api/campaigns',     requireAuth, require('./routes/campaigns')({
  opportunityPortfolio: opportunityPortfolio()
}));
// Its own mount rather than a path under /api/campaigns: a proposal is not a
// campaign, and keeping the two apart means no literal proposal path can ever
// be shadowed by GET /api/campaigns/:id.
app.use('/api/campaign-proposals', requireAuth, require('./routes/campaign-proposals')({
  // Wiring the detector in is what makes POST /draft work at all. Without it
  // the handler refused every request with "No cohort opportunity detector is
  // wired to this server yet", which is exactly what it said and nobody read.
  //
  // Findings are keyed by `key` (one_time_lapsed, one_time_above_typical_spend
  // and so on), and the reader hands back the whole finding, so the proposal
  // is drafted from measured evidence rather than from a count somebody typed.
  opportunityReader: async id => {
    const wanted = String(id || '');
    if (!wanted) return null;
    const payload = await opportunityPortfolio().current();
    const finding = (payload.findings || []).find(entry => entry.key === wanted);
    if (!finding) return null;

    // NOT the raw finding. The detector emits {key, evidence, sizing, ...} and
    // the drafter reads {id, kind, cohort: {label, size, segmentKey}, ...} —
    // two different shapes for the same idea, and handing over the wrong one
    // would have produced a proposal full of `undefined` that still looked
    // like it worked. opportunity-contract.js owns the conversion and is the
    // same one the daily cycle uses, so both paths agree by construction.
    const { opportunityFromFinding } = require('./lib/campaigns/opportunity-contract');
    const adapted = opportunityFromFinding(finding, {
      detectorVersion: payload.detectorVersion || null,
      detectedAt: payload.computedAt || null
    });
    // A finding that is real but is not an audience — "repeat buyers shop
    // across products" is a fact about the shop, not a list of people to text.
    // Refusing by returning null gives the caller a 404 that names it.
    return adapted.ok ? adapted.opportunity : null;
  }
}));
app.use('/api/segments',      requireAuth, require('./routes/segments')());
app.use('/api/users',         requireAuth, require('./routes/users')());
app.use('/api/invitations',   requireAuth, require('./routes/invitations')());
app.use('/api/audit',         requireAuth, require('./routes/audit')());

// Voice webhooks (public — Telnyx calls this directly)
app.use('/webhooks/voice', require('./routes/voice-webhook'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── The invitation landing page (no auth) ─────────────────────────────────
// `/accept-invite?token=...` is the Universal Link in the invitation email. On
// an iPhone with the app installed iOS intercepts it and this never runs; on
// every other device, and on the first tap before the app exists, it must land
// on something that explains itself.
//
// It is served explicitly rather than left to the SPA catch-all. The React app
// no longer has an accept-invitation screen — new teammates are not meant to
// see the web inbox at all — so the catch-all would drop an invitee on a login
// form with no account and no explanation. public/accept-invite.html is a
// self-contained page that says they need the iPhone app and points at
// TestFlight.
//
// PLACEMENT: after the /.well-known mount, before express.static and before the
// catch-all, and deliberately not under /api so the policy enforcer never sees
// it. The invitee has no session and must not need one. Getting this ordering
// wrong is the same class of bug that made apple-app-site-association return
// index.html with HTTP 200; test/apple-site-association.test.js asserts it.
//
// The token is NOT read, logged or validated here. It is a live single-use
// credential, the page only inspects its shape for display, and
// POST /auth/invitation/accept remains the only thing that verifies it.
app.get('/accept-invite', (req, res) => {
  // Keyed to a single-use invitation token, so no intermediary should hold a
  // copy and no shared device should re-serve it from cache.
  res.set('Cache-Control', 'no-store, private');
  res.sendFile(path.join(__dirname, 'public', 'accept-invite.html'));
});

// ── The password reset page (no auth) ─────────────────────────────────────
// `/reset-password?token=...` is the other Universal Link this app claims in
// lib/apple-site-association.js. On an iPhone with the app installed iOS hands
// it to ResetPasswordView and this never runs; everywhere else, and before the
// app is installed, this is what answers the claimed path. A claimed path that
// nothing answers opens the app and does nothing, which is worse than not
// claiming it.
//
// UNLIKE THE INVITATION PAGE, THIS ONE FINISHES THE JOB. public/accept-invite
// .html deliberately refuses to accept an invitation in the browser and sends
// the invitee to the app. A forgotten password is the one moment somebody
// cannot get into the app at all, so "finish this in the app" would be a closed
// loop: the page posts to POST /auth/password-reset/confirm itself.
//
// PLACEMENT: alongside /accept-invite, after the /.well-known mount, before
// express.static and before the catch-all, and deliberately not under /api so
// the policy enforcer never sees it. Whoever opens this link has no session and
// must not need one.
//
// The token is NOT read, logged or validated here. It is a live single-use
// credential; the page inspects its shape in the browser only to avoid showing
// a form that cannot succeed, and POST /auth/password-reset/confirm remains the
// only thing that verifies it.
app.get('/reset-password', (req, res) => {
  // Keyed to a single-use reset token, so no intermediary should hold a copy
  // and no shared device should re-serve it from cache.
  res.set('Cache-Control', 'no-store, private');
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// ── The email-change confirmation page (no auth) ──────────────────────────
// `/confirm-email-change?token=...` is the third mailed, token-bearing link in
// this service. lib/apple-site-association.js carries the universal-link claim
// for it as a STAGED claim, published once APPLE_CLAIM_EMAIL_CHANGE is set,
// which happens after an iOS build that routes the path is in the field. Until
// then, and on every device that is not an iPhone with the app installed, this
// is what answers it.
//
// LIKE THE PASSWORD RESET PAGE, THIS ONE FINISHES THE JOB. Somebody confirming
// an address already has an account and may be reading their mail on a laptop.
// public/accept-invite.html deliberately sends an invitee to the app because a
// new teammate is not meant to use the web inbox at all; refusing to complete a
// confirmation here would instead strand a pending change that is already
// blocking the person's next attempt. The page posts the token to
// POST /auth/email-change/confirm itself.
//
// THIS ROUTE MUST EXIST BEFORE THE CLAIM IS PUBLISHED. A claimed path that
// nothing answers on the web sends anybody without the app to the SPA login
// screen with no explanation; test/email-change-link.test.js asserts the page
// is served before the switch can be turned on, and test/claimed-links.test.js
// asserts it again for whatever is actually published.
//
// PLACEMENT: alongside /accept-invite and /reset-password, after the
// /.well-known mount, before express.static and before the catch-all, and
// deliberately not under /api so the policy enforcer never sees it. Whoever
// opens this link has no session and must not need one.
//
// The token is NOT read, logged or validated here. It is a live single-use
// credential; the page inspects its shape in the browser only to avoid a
// pointless round trip, and POST /auth/email-change/confirm remains the only
// thing that verifies it.
app.get('/confirm-email-change', (req, res) => {
  // Keyed to a single-use confirmation token, so no intermediary should hold a
  // copy and no shared device should re-serve it from cache.
  res.set('Cache-Control', 'no-store, private');
  res.sendFile(path.join(__dirname, 'public', 'confirm-email-change.html'));
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

// Campaign delivery. Registered only when CAMPAIGNS_LIVE_SEND_ENABLED is
// exactly "true", so with the flag off there is no timer, no claim, and no
// provider client in the process at all. The database refuses to hand out work
// regardless; this keeps the loop from existing in the first place.
//
// Claim recovery runs on its own slower timer even when sending is disabled,
// because rows abandoned by an earlier run should still be resolved after the
// feature is switched back off.
function startCampaignDelivery() {
  let deliverBatch, liveSendEnabled, recoverExpiredClaims, sendSMS;
  try {
    ({ deliverBatch, liveSendEnabled, recoverExpiredClaims } =
      require('./lib/campaigns/delivery-worker'));
    ({ sendSMS } = require('./telnyx'));
  } catch (err) {
    // A campaign feature that is off for this workspace must never be able to
    // stop the inbox, the dialler or order SMS from starting.
    console.error('[CAMPAIGN SEND] Delivery loop not started:', err.message);
    return;
  }

  const TWO_MINUTES = 2 * 60 * 1000;
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  setInterval(async () => {
    try { await recoverExpiredClaims({ client: supabase }); }
    catch (err) { console.error('[CAMPAIGN SEND] Claim recovery error:', err.message); }
  }, FIFTEEN_MINUTES);

  if (!liveSendEnabled(process.env)) {
    console.log('[CAMPAIGN SEND] Live sending is off; no delivery loop started.');
    return;
  }

  console.log('[CAMPAIGN SEND] Live sending is ON. Delivery loop running every 2 minutes.');
  setInterval(async () => {
    try {
      const summary = await deliverBatch({ client: supabase, send: sendSMS });
      if (summary.claimed > 0) {
        console.log(
          `[CAMPAIGN SEND] claimed=${summary.claimed} accepted=${summary.accepted} `
          + `uncertain=${summary.uncertain} skipped=${summary.skipped}`
        );
      }
    } catch (err) {
      console.error('[CAMPAIGN SEND] Delivery error:', err.message);
    }
  }, TWO_MINUTES);
}

// Where the revenue actually is, recomputed on a schedule so the picture on
// the Growth tab is not a month old.
//
// Read-only by construction: it counts customers and reports what has already
// happened. It writes no row, creates no draft, touches no send gate and calls
// no messaging provider, so unlike the delivery loop there is no flag to keep
// it off. A failure logs and returns; a customer-base analysis may never be
// able to interrupt the inbox, the dialler or order SMS.
function startOpportunityRefresh() {
  try {
    const {
      startOpportunityPortfolioRefresh
    } = require('./lib/campaigns/opportunity-portfolio');
    // The SAME instance the routes read, so the refresh warms their cache
    // rather than a private one nobody looks at.
    startOpportunityPortfolioRefresh({ service: opportunityPortfolio(), env: process.env });
  } catch (err) {
    console.error('[OPPORTUNITIES] Refresh loop not started:', err.message);
  }
}

// THE CLOCK THAT MAKES SEGMENTATION AUTOMATIC.
//
// Recomputes every automatic segment once a day, runs the opportunity
// detector, decides what is significant, and delivers one summary push per
// person at a local hour in that person's own time zone.
//
// NOT A DAILY `setInterval`. It ticks every five minutes and decides from the
// wall clock plus a persisted claim whose UNIQUE constraint is the actual
// guard, so a Railway redeploy cannot move the fire time. See the header of
// lib/notifications/daily-schedule.js.
//
// Registered unconditionally, like the opportunity refresh. With every flag off
// it recomputes, decides materiality and records the whole pass, and nothing
// reaches a phone. The recompute is a real production write and is the correct
// behaviour of this product; the flags gate delivery, not arithmetic.
/**
 * Keep do-not-disturb status fresh enough to send.
 *
 * lib/campaigns/eligibility.js refuses any recipient whose DND status is older
 * than 24 hours and fails CLOSED, which is right: not knowing whether somebody
 * has asked not to be disturbed is not the same as knowing they have not.
 *
 * Nothing refreshed that timestamp except a human running
 * scripts/sync-dnd-only.js. It was last run on 25 August; by the 30th all 221
 * recipients of a ready campaign read `dnd_unknown`, the dry run said zero
 * eligible, and the Submit button was greyed out with nothing on screen
 * pointing at the cause.
 *
 * Every six hours, so a single failed run still leaves three chances inside
 * the 24-hour window. Registered unconditionally and wrapped like every other
 * background job here: it may never take down the process that also carries
 * the inbox, the dialler and order SMS.
 */
function startDoNotDisturbSync() {
  let syncDoNotDisturb;
  try {
    ({ syncDoNotDisturb } = require('./lib/ghl-dnd-sync'));
  } catch (err) {
    console.error('[DND] Sync not started:', err.message);
    return;
  }

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const run = async () => {
    try {
      const result = await syncDoNotDisturb({ client: supabase });
      console.log(`[DND] Refreshed ${result.written} contacts`
        + ` (${result.partial} incomplete, ${result.failed} failed)`);
    } catch (err) {
      console.error('[DND] Sync error:', err.message);
    }
  };

  // Once at boot, because a deploy is exactly when the timestamp is most
  // likely to be stale, then on the interval.
  run();
  setInterval(run, SIX_HOURS);
}

/**
 * The automatic 21-day check-in.
 *
 * Ticks every six hours rather than weekly. The sweep decides for itself
 * whether this window has already been covered, so a frequent tick costs three
 * cheap queries and buys two things a weekly timer cannot: a deploy no longer
 * skips a week by resetting the clock, and a sweep that failed gets retried
 * within hours instead of on the next Tuesday.
 *
 * Registered unconditionally. The gate is the standing authorisation in
 * sms_campaign_settings.checkin_automation_enabled, read on every run, so the
 * owner can switch this off from the app without a deploy.
 */
function startCheckInAutomation() {
  let runCheckInSweep, createCampaignService, logAudit;
  try {
    ({ runCheckInSweep } = require('./lib/campaigns/check-in-automation'));
    ({ createCampaignService } = require('./lib/campaigns/service'));
    ({ logAudit } = require('./lib/audit/log'));
  } catch (err) {
    console.error('[CHECK-IN] Automation not started:', err.message);
    return;
  }

  const SIX_HOURS = 6 * 60 * 60 * 1000;

  /**
   * The consent-bearing approval row.
   *
   * actorType 'system' on purpose. Writing the owner's name here so the
   * records look uniform would be a false claim of human review, and the audit
   * log's whole value is being true about who authorised messaging whom.
   */
  const audit = async ({ campaign, recipientCount, audienceHash, messageHash }) => {
    const fingerprint = `campaign-approved:${campaign.id}:${campaign.revision}`;
    const result = await logAudit({
      eventType: 'campaign.approved',
      actorType: 'system',
      entityId: campaign.id,
      summary: `Automatic 21-day check-in approved “${String(campaign.title || '').slice(0, 160)}” `
        + `revision ${campaign.revision} for ${recipientCount} recipients`,
      previousState: { status: 'review_required', revision: campaign.revision },
      newState: { status: 'approval_pending', revision: campaign.revision },
      metadata: {
        revision: campaign.revision,
        recipient_count: recipientCount,
        audience_digest: audienceHash,
        message_digest: messageHash,
        message_length: String(campaign.final_message || '').length,
        approved_by_automation: 'checkin_21d'
      },
      fingerprint
    });
    if (!result.recorded && result.reason !== 'duplicate') {
      throw Object.assign(new Error('Check-in approval audit was not recorded.'), {
        code: 'CAMPAIGN_APPROVAL_AUDIT_REQUIRED'
      });
    }
    return { ...result, fingerprint };
  };

  const run = async () => {
    try {
      const summary = await runCheckInSweep({
        client: supabase,
        service: createCampaignService({ client: supabase, env: process.env }),
        audit
      });
      // Silent when there is nothing to say. "Disabled" and "already swept" are
      // the answer almost every tick, and logging them buries the one line that
      // matters.
      if (summary.reason === 'scheduled') {
        const total = summary.scheduled.reduce((sum, row) => sum + row.recipients, 0);
        console.log(
          `[CHECK-IN] Scheduled ${summary.scheduled.length} campaign(s), `
          + `${total} recipients, for ${summary.sendAt}`
        );
      } else if (summary.failures?.length) {
        console.error(`[CHECK-IN] ${summary.failures.length} draft(s) could not be scheduled`);
      }
    } catch (err) {
      console.error('[CHECK-IN] Sweep error:', err.message);
    }
  };

  // Not at boot. A restart loop would otherwise retry a failing sweep every
  // few seconds, and nothing here is urgent to the minute.
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, SIX_HOURS);
}

function startDailySegmentationCycle() {
  try {
    const { startDailyCycle } = require('./lib/daily-scheduler');
    startDailyCycle({ client: supabase, env: process.env });
  } catch (err) {
    console.error('[DAILY] Segmentation cycle not started:', err.message);
  }
}

// A rejected promise nobody handled is the most common way a scheduled job goes
// quiet: the work stops, no error surfaces, and the only symptom is a digest
// that never arrives. Node's default for an unhandled rejection is to CRASH the
// process, which on a service that also carries the inbox, the dialler and
// order SMS is the wrong trade. Log it loudly with the stack and keep serving.
//
// This is a backstop, not a strategy. Every background job in this file already
// catches its own errors; this exists so that the one that forgets is visible
// rather than fatal.
process.on('unhandledRejection', reason => {
  console.error('[FATAL-GUARD] Unhandled promise rejection:',
    reason?.stack || reason?.message || reason);
});

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
  startCampaignDelivery();
  startOpportunityRefresh();
  startDoNotDisturbSync();
  startDailySegmentationCycle();
  startCheckInAutomation();
  startRecordingRetentionJob();
  console.log(`Vici SMS Inbox running on port ${PORT}`);
  console.log(`Telnyx: ${process.env.TELNYX_PHONE_NUMBER}`);
  console.log(`WooCommerce: ${process.env.WC_CONSUMER_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`ShipStation: ${process.env.SS_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`Flows: failed/hold/confirmed/shipped/delivered ACTIVE`);
});

module.exports = { app, broadcastSSE };
