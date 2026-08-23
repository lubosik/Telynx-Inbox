# P2-03 — Backend Integration Map

**Status:** Design document. Planning only. No application code has been written.
**Date:** 12 August 2026
**Scope:** Where every new feature attaches to the existing Express app — module by module, file by file.

**Inputs read:** `research/phase2/P2-02-segmentation-engine.md` (authoritative on the send gate, leases, claim-then-send, frequency, quiet hours); `research/ai-wizard/00-current-state.md`, `01-sms-copywriting-craft.md` §4–§7, `03-compliance-and-high-risk.md` §8, `05-attribution-and-testing.md` §4 and §7.
**Code read:** `server.js`, `routes/send.js`, `routes/webhook.js`, `routes/conversations.js`, `routes/intelligence.js`, `routes/activity.js`, `routes/sync.js`, `routes/voice.js`, `routes/sse.js`, `routes/catchup.js`, `routes/webhook-send.js`, `routes/react.js`, `lib/broadcaster.js`, `lib/telnyx-api.js`, `lib/message-status.js`, `lib/phone.js`, `intelligence.js`, `telnyx.js`, `flows/utils.js`, `flows/confirmed.js`, `db.js`, `package.json`, `railway.json`, `public/app.jsx` (targeted), and `~/shore-academy-inbox` for the fork comparison.

**Relationship to P2-02.** P2-02 owns *who gets chosen and when*: `evaluate_send_gate()`, `claim_campaign_sends()`, `job_leases`, the frequency budget, quiet hours, replenishment. This document owns *where that code lives in the Express app and how it is called* — routes, module boundaries, the Node-side send primitive, the AI service layer, the redirector, SSE, the fork, and tests. Where I refine P2-02 I say so explicitly in §3.4. I contradict it nowhere.

---

## 0. The seven things that decide this design

1. **There are seven raw `sendSMS()` call sites today and three of them have no opt-out check at all.** `routes/catchup.js:95`, `routes/catchup.js:149` and `routes/webhook-send.js:59` call Telnyx with no suppression check whatsoever, and `webhook-send.js` is a *public* endpoint authenticated by a shared secret. This is a live compliance defect that predates the wizard, and it is the single strongest argument for the choke point in §3.
2. **The choke point must live in `lib/`, not in `flows/`.** P2-02 §5.4 Rule 3 says extend `sendAndLog()`. I agree with the principle and refine the location: `sendAndLog()` lives in `flows/utils.js`, requires an `orderId`, and `flows/` does not exist in the Shore fork. Lifting the primitive to `lib/outbound.js` and making `sendAndLog()` a thin caller gets the same single-path guarantee while also covering the six non-flow call sites and being portable to Shore.
3. **The OpenRouter model is not misconfigured — the slug has been retired.** Verified live on 12 Aug 2026: `anthropic/claude-3.5-haiku` is absent from `GET https://openrouter.ai/api/v1/models`. There are **six** copies of that hardcoded default across `flows/confirmed.js`, `flows/shipped.js` and `intelligence.js`, and **zero** `response.ok` checks anywhere. Every AI feature in the product — including the personalisation inside all five live flows — has been silently falling back to base templates for as long as the slug has been gone. §4.
4. **`routes/activity.js` is the automation queue.** It must be renamed before a team feed can exist. Six references, one release, no downtime. §2.
5. **Campaigns get their own queue table and worker, not `sms_scheduled`.** Not for purity — because `processScheduledQueue()` drains at 50 rows per 5-minute tick (`flows/utils.js:226`), so a 390-recipient blast would starve order confirmations behind it for 40 minutes. §3.2.
6. **The click redirector goes on `go.vicipeptides.com` as a Railway custom domain pointed at this same Express app.** One DNS record from the client, zero new infrastructure, and a 72-hour attribution window makes Safari's ITP cookie cap irrelevant. §5.
7. **`setInterval` survives, exactly as P2-02 concluded.** My addition: rank the jobs by whether the lease protects *correctness* or merely *waste*, because that determines what ships in Phase 0 versus later. §6.

---

## 1. Route inventory

### 1.1 Conventions the existing app already sets, and which the new code follows

- A route module is either a bare `Router` (`module.exports = router`, e.g. `routes/conversations.js:86`) or a factory taking `broadcastSSE` (`module.exports = (broadcastSSE) => {…}`, e.g. `routes/send.js:7`). **Use the bare form and import `lib/broadcaster`'s `broadcast()`** — `routes/activity.js:4` already does this and it is the better pattern; the factory form is legacy.
- Auth is applied at the mount point in `server.js`, never inside the module (`server.js:88-100`). New authed modules follow suit.
- Errors return `{ error: string }` with a 4xx/5xx status; successes return either the bare resource or `{ success: true, … }`. Keep both, do not unify.
- Phones are E.164 everywhere. Normalise on entry with `lib/phone.js`'s `normalisePhone()`, not `flows/utils.js`'s `formatPhone()` — see §8.1.

### 1.2 New mount points in `server.js`

Inserted in `server.js` as follows. Order matters: the public redirector must be registered **before** the static handler at `server.js:109` and the SPA catch-all at `server.js:110`, or `/r/:token` gets served `index.html`.

```js
// ── Public, unauthenticated (BEFORE express.static and the SPA catch-all) ──
app.use('/r',          require('./routes/redirect'));            // click redirector
app.use('/collect',    express.json(), require('./routes/collect')); // storefront beacon

// ── Authenticated API routes (alongside server.js:88-100) ──────────────────
app.use('/api/campaigns',   requireAuth, require('./routes/campaigns'));
app.use('/api/segments',    requireAuth, require('./routes/segments'));
app.use('/api/ai',          requireAuth, aiLimiter, require('./routes/ai'));
app.use('/api/consent',     requireAuth, require('./routes/consent'));
app.use('/api/feed',        requireAuth, require('./routes/feed'));
app.use('/api/attribution', requireAuth, require('./routes/attribution'));

// ── Renamed (see §2) ───────────────────────────────────────────────────────
app.use('/api/automations', requireAuth, require('./routes/automations'));
app.use('/api/activity',    requireAuth, require('./routes/automations')); // deprecated alias, one release
```

`aiLimiter` is a second `express-rate-limit` instance beside `sendLimiter` (`server.js:68-72`), at 30/min — model calls cost money and the wizard is interactive.

### 1.3 `routes/campaigns.js` → `/api/campaigns`

Sits beside `routes/intelligence.js`. All authed. `:id` is a `uuid`.

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/` | `?state=&kind=&page=` | `{ items: Campaign[], page, hasMore }` | 50/page, mirrors `routes/activity.js:36-60` |
| POST | `/` | `{ name, kind, archetype, segment_id?, segment_definition?, flow_type }` | `Campaign` (state `draft`) | `flow_type` must match `^mkt:` per P2-02 §5.4 Rule 1 |
| GET | `/:id` | — | `{ campaign, variants, counts, lint, gate_summary }` | The wizard's read model |
| PATCH | `/:id` | partial `Campaign` | `Campaign` | **409 if `state !== 'draft'`.** Approved campaigns are immutable |
| DELETE | `/:id` | — | `{ success: true }` | Only from `draft`; otherwise cancel |
| GET | `/:id/preview` | `?limit=10` | `{ matched, eligible, exclusions: {reason:count}, sample: RenderedRecipient[], diff_vs_last }` | Doc 05 §7.1. Runs `evaluate_send_gate()` in dry-run over the frozen or live roster |
| POST | `/:id/variants` | `{ slug, body, media_urls? }` | `Variant` with `{ encoding, chars, segments, est_cost_cents, gates, truncation_40 }` | Encoding computed by `lib/gsm.js`, never by the model |
| PATCH | `/:id/variants/:vid` | `{ body }` | same | |
| DELETE | `/:id/variants/:vid` | — | `{ success: true }` | |
| POST | `/:id/test-send` | `{ to?: string[] }` | `{ sent: [{phone, telnyx_message_id}], failed: [] }` | Defaults to the `seed_contacts` set. Real Telnyx path, `channel: 'test'`, never written to `sms_campaign_recipients`, never counted |
| GET | `/:id/checks` | — | `{ checks: [{key, level: 'PASS'\|'WARN'\|'BLOCK', detail}] }` | The doc 05 §7 test suite as one call |
| POST | `/:id/approve` | `{ acknowledgements: string[], bypass_frequency_cap?, bypass_reason? }` | `Campaign` (state `approved`) | Conditional `UPDATE … WHERE state='draft'`; zero rows ⇒ `{ error:'already approved' }`. Freezes the roster (P2-02 §3.1). Requires every `WARN` from `/checks` acknowledged, and refuses on any `BLOCK` |
| POST | `/:id/schedule` | `{ send_at: ISO }` | `Campaign` (state `active`) | Materialises `sms_campaign_recipients` rows at `planned_send_at` |
| POST | `/:id/send` | — | `Campaign` (state `active`) | `send_at = now()`. Same path as schedule |
| POST | `/:id/pause` | — | `Campaign` (state `paused`) | Worker stops claiming |
| POST | `/:id/cancel` | — | `{ sent, in_flight, cancelled }` | Exactly P2-02 §10.5, including the honest three-number report |
| GET | `/:id/report` | — | `{ sent, skipped, deferred, expired, failed, by_reason, clicks, attributed }` | |
| GET | `/:id/recipients` | `?state=&page=` | `{ items, page, hasMore }` | The exclusion ledger, drillable |

**Approval is the only place a human enters the loop, so it is the only place `WARN` acknowledgement can be recorded.** Doc 03 §8 requires who-acknowledged-what-and-when; that record is written here, and `created_by`/`approved_by` stay `NULL` until multi-user auth lands (see §11 R6).

### 1.4 `routes/segments.js` → `/api/segments`

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/` | — | `Segment[]` | |
| POST | `/` | `{ name, definition: SegmentDef }` | `Segment` | `definition` is the JSONB predicate tree, stored verbatim |
| GET | `/:id` | — | `Segment` | |
| PATCH | `/:id` | `{ name?, definition? }` | `Segment` | Editing a segment never mutates a frozen campaign roster |
| DELETE | `/:id` | — | `{ success: true }` | 409 if referenced by a non-terminal campaign |
| POST | `/preview` | `{ definition }` (unsaved) | `{ matched, eligible, exclusions, sample, computed_at, stale }` | **The "who is in this right now" call.** Unsaved definition in the body so the wizard can preview before saving |
| GET | `/:id/preview` | `?limit=` | same | Saved variant |
| GET | `/:id/members` | `?page=` | `{ items, page, hasMore }` | Masked phones (last 4) per doc 05 §7.1 |
| GET | `/vocabulary` | — | `{ fields: FieldSpec[] }` | Drives the UI builder: field name, type, operators, enum values. Prevents the frontend hardcoding a schema that changes |

`stale: true` is returned when `sms_contact_metrics.computed_at < now() − 36h` (P2-02 §10.1). The preview still renders; the UI must show the staleness banner and `/approve` must refuse.

### 1.5 `routes/ai.js` → `/api/ai`

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/draft` | `{ campaign_id?, brief, segment_id?, sample_contact_phone?, variant_count? }` | `{ drafts: [{approach, body, validation, critique}], ai_available: true, attempts, cost_cents }` |
| POST | `/critique` | `{ body, context? }` | `{ validation, scores: {D1..D7}, total, band, top_edit, truncation_40 }` |
| POST | `/lint` | `{ body }` | `{ encoding, chars, billable, segments, gates, warns, ucs2_culprits: [{char,name,index}], autofix_preview }` |
| POST | `/autofix-encoding` | `{ body }` | `{ body, diff: [{from,to,index}] }` |
| GET | `/prompts` | — | `Prompt[]` (key, version, active, updated_at) |
| GET | `/prompts/:key` | — | `{ key, version, body, model_role, temperature, max_tokens, source: 'db'\|'file' }` |
| PUT | `/prompts/:key` | `{ body, model_role?, temperature?, max_tokens? }` | `Prompt` (new version, activated) |
| POST | `/prompts/:key/rollback` | `{ version }` | `Prompt` |
| GET | `/health` | — | `{ ai_available, model_ids, last_error, checked_at }` |

**`/lint` and `/autofix-encoding` make no model call.** They are pure functions over `lib/gsm.js` and `lib/compliance-lint.js` and must return 200 even when OpenRouter is down. This is what keeps the wizard usable in an outage (§4.6).

### 1.6 `routes/consent.js` → `/api/consent`

Net-new, and per `00-current-state.md` §8 this is the most overdue item in the repo — Vici has no opt-out column and no consent record today.

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/suppressions` | `?q=&page=` | `{ items, page, hasMore }` | |
| POST | `/suppressions` | `{ phone, reason, scope }` | `Suppression` | Manual add |
| GET | `/suppressions/:phone` | — | `{ suppressed, reason, since, scope, source }` | |
| DELETE | `/suppressions/:phone` | — | **405 Method Not Allowed, always** | Doc 03 §8.9 item 6: suppression is append-only and one-way. The route exists so the refusal is explicit and logged, not so the frontend discovers a 404 |
| POST | `/suppressions/:phone/reinstate` | `{ consent_event: {…}, actor, note }` | `Suppression` | The *only* way out: a new consent event supersedes, the suppression row stays |
| GET | `/events/:phone` | — | `ConsentEvent[]` | The TCPA audit trail, doc 03 §8.8 |
| POST | `/events` | `{ phone, consent_type, consent_scope, disclosure_text, source_url, ip, user_agent, affirmative_action }` | `ConsentEvent` | Called by the storefront opt-in form and by manual entry |
| GET | `/export/:phone` | — | `{ contact, consent_events, suppressions, messages }` | Portability, per doc 04's finding that every incumbent's export is deliberately lossy |

### 1.7 `routes/feed.js` → `/api/feed` (the *team* activity feed)

Deliberately thin. Per `00-current-state.md` §6 there is no actor, so until multi-user auth lands the feed is an **audit log with `actor: null`** — worth building because campaign events are inherently interesting even without a name attached, and worth building *now* because retrofitting event emission after the fact means backfilling nothing.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/` | `?since=&types=&page=` | `{ items: Event[], page, hasMore, cursor }` |
| GET | `/stats` | — | `{ today: {sent, campaigns_active, opt_outs, clicks} }` |
| POST | `/:id/seen` | — | `{ success: true }` |

Events are written by `lib/events.js` (§8.7) from the campaign, consent and send paths. Not from `flows/` — transactional flow activity is already served by `/api/automations`.

### 1.8 `routes/redirect.js` → `/r` (public, unauthenticated)

| Method | Path | Response |
|---|---|---|
| GET | `/:token` | `302` to destination, `Set-Cookie: vk_click` |
| HEAD | `/:token` | `302`, always flagged `is_bot` |
| GET | `/health` | `{ ok: true }` — so uptime checks do not burn tokens |

Full design in §5.

### 1.9 `routes/collect.js` → `/collect` (public, unauthenticated)

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/` | `{ click_id, session_id, landing_url }` | `204 No Content` |

Called by the storefront JS snippet (doc 05 §4.1 step 3). Rate-limited at 60/min per IP. Writes `sms_sessions`. Returns 204 with no body so it can be sent with `navigator.sendBeacon`.

### 1.10 `routes/attribution.js` → `/api/attribution` (authed)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/campaign/:id` | `?grade=` | `{ tiers: {click_attributed, associated, incremental}, rows }` |
| GET | `/order/:woo_order_id` | — | `Attribution[]` — every claim on one order, nothing merged |
| POST | `/declare` | `{ woo_order_id, campaign_id?, channel, note, actor }` | `Attribution` (grade E) — the operator declaring a reply-driven sale, doc 05 §5.1 |
| POST | `/reconcile` | `{ since? }` | `{ inserted, refunded_out }` — manual trigger for the nightly job |

**There is no new conversion webhook.** WooCommerce already posts to `/webhook/woocommerce` with HMAC-verified raw bodies (`server.js:40`, `routes/webhook-woocommerce.js`). Adding a second webhook means a second HMAC path, a second raw-body registration and a second thing to configure in the client's Woo admin. Instead, extend the existing order handler to read `meta_data._vk_click_id` and write the Grade A attribution row. That is ~15 lines inside a file that already runs on every order. §5.5.

### 1.11 Endpoints deliberately not built

| Not building | Why |
|---|---|
| `POST /api/campaigns/:id/resend-to-non-responders` | Doc 03 §8.9 item 7 |
| Bulk contact import with an "assume consent" flag | Doc 03 §8.9 item 8 |
| `DELETE /api/consent/suppressions/:phone` (functional) | Doc 03 §8.9 item 6 |
| Per-campaign A/B significance endpoints | P2-02 §11: MDE at n=847 is +245% relative lift. The `/checks` measurability pre-flight replaces it |
| A separate campaign scheduler API | Scheduling is a state transition on the campaign, not a resource |

---

## 2. The naming collision

`routes/activity.js` is the **automation queue**: pending and sent scheduled flow messages, read from `sms_scheduled` and `sms_sent_log`, with a cancel action. It is not, and never was, a team activity feed. Both cannot exist under `/api/activity`.

### 2.1 Recommendation

Rename the existing module to **`routes/automations.js`**, mounted at `/api/automations`. The new team feed takes `/api/feed`, not `/api/activity` — do not reuse the freed name. Reusing it means a stale cached bundle or an old iOS build hits the *new* semantics at the *old* path and gets a nonsense payload. A permanently retired path costs nothing.

`automations` is the right word: the UI tab is about what the automated flows are about to do, which is what the client calls it.

### 2.2 Every reference that must change

| File | Line(s) | Current | Becomes |
|---|---|---|---|
| `routes/activity.js` | file | module | renamed to `routes/automations.js`; log prefix `[ACTIVITY]` → `[AUTOMATIONS]` at lines 30, 56, 82, 110, 122 |
| `server.js` | 99 | `app.use('/api/activity', requireAuth, require('./routes/activity'))` | `app.use('/api/automations', …require('./routes/automations'))` plus a deprecated alias line |
| `public/app.jsx` | 1728 | `api('GET', '/api/activity/stats')` | `/api/automations/stats` |
| `public/app.jsx` | 1729 | `api('GET', \`/api/activity/queue?flow=…\`)` | `/api/automations/queue?…` |
| `public/app.jsx` | 1730 | `api('GET', \`/api/activity/recent?flow=…\`)` | `/api/automations/recent?…` |
| `public/app.jsx` | 1776 | `api('GET', \`/api/activity/recent?flow=…&page=1\`)` | `/api/automations/recent?…` |
| `public/app.jsx` | 1779 | `api('GET', '/api/activity/stats')` | `/api/automations/stats` |
| `public/app.jsx` | 1791 | `api('DELETE', \`/api/activity/queue/${…}\`)` | `/api/automations/queue/${…}` |
| `public/app.jsx` | 1458, 1704, 1740, 1795 | `// ─── Activity Tab Components`, `function ActivityTab`, `[Activity] load error`, `[Activity] cancel error` | rename to `AutomationsTab` etc. Cosmetic but do it in the same commit or the next reader is misled again |
| `public/app.jsx` | 2278, 3082-3083, 3185-3186, 3247-3251 | `mainTab === 'activity'` | `'automations'` — 6 string literals, one tab label |
| `public/app.js` | built artefact | — | regenerated by `npm run build` (`package.json:7`) |
| `ios/` | — | — | **verify with a grep before shipping.** No `/api/activity` reference was found in the read, but the iOS app is deployed separately through TestFlight and cannot be redeployed in lockstep. This is the entire reason for the alias below |

### 2.3 Doing it without breaking the running app

Three commits, each independently deployable and safe:

1. **Commit 1 — additive.** `git mv routes/activity.js routes/automations.js`. In `server.js`, mount the *same module* at both `/api/automations` and `/api/activity`. Deploy. Nothing observable changes; both paths work. The old `public/app.js` bundle in a user's browser keeps working through the alias.
2. **Commit 2 — frontend.** Update the eight `public/app.jsx` call sites and the tab literals, run `npm run build`, deploy. Now the web app uses the new path; the alias still covers any cached bundle and any iOS build.
3. **Commit 3 — removal, one release later.** Delete the alias line from `server.js` after confirming (a) `grep -rn "api/activity" ios/ public/` is clean and (b) the deployed iOS build has been checked. Add `[DEPRECATED]` logging to the alias in commit 1 so commit 3 has evidence rather than hope:

```js
app.use('/api/activity', requireAuth, (req, _res, next) => {
  console.warn(`[DEPRECATED] /api/activity${req.path} ua=${req.get('user-agent')}`);
  next();
}, require('./routes/automations'));
```

If that log line is silent for a week, commit 3 is safe. If it is not, you have found the caller you would otherwise have broken.

Do not rename the SSE event types (`queue_added`, `queue_cancelled`, `message_sent` — `flows/utils.js:176, 247, 267`, `routes/activity.js:112`). They are consumed by `public/app.jsx:1756`. Renaming events and renaming routes in the same change means a failure has two possible causes.

---

## 3. The send path

This is the highest-risk area in the plan. It is also where the largest existing defect lives.

### 3.1 What exists today, exhaustively

Seven places call Telnyx:

| # | Call site | Opt-out check | Dedup | Notes |
|---|---|---|---|---|
| 1 | `flows/utils.js:96` via `sendAndLog()` | ✅ `:84-87` | ✅ `alreadySent()` + unique index, `23505` caught at `:107-113` | The only well-guarded path |
| 2 | `routes/send.js:27` | ✅ `:23-25` | ❌ | Manual operator send |
| 3 | `routes/react.js:58` | ✅ `:44` | ❌ | Tapback echo |
| 4 | `routes/intelligence.js:41` | ✅ `:38` | ❌ | AI suggestion send |
| 5 | `routes/catchup.js:95` | ❌ **none** | partial | Backfill "order confirmed" |
| 6 | `routes/catchup.js:149` | ❌ **none** | partial | Backfill "shipped" |
| 7 | `routes/webhook-send.js:59` | ❌ **none** | ❌ | **Public endpoint**, shared-secret auth, called by GoHighLevel |

Nowhere is there a quiet-hours check, a frequency check, or a rendered-body content check. Not for campaigns, not for flows, not for manual sends. The five live `flows/` are the *best*-guarded path in the codebase and they still send at 05:30 if a webhook arrives then.

**Nothing above should be read as an argument to rewrite the flows.** It is an argument that the guard belongs in one place that all seven paths already have to go through anyway.

### 3.2 Do campaigns reuse `sms_scheduled`? No. Here is the argument.

I considered reusing `sms_scheduled` and `processScheduledQueue()` because it is the smaller change on the surface. It is the wrong call, for five reasons in descending order of force:

1. **Head-of-line blocking on transactional traffic.** `processScheduledQueue()` selects `.limit(50)` per 5-minute tick (`flows/utils.js:226`) and sends sequentially. A 390-recipient campaign occupies eight ticks — forty minutes — during which an order confirmation queued behind it waits. Order confirmations are the thing the client actually judges the system on. A marketing blast must never be able to delay one.
2. **The dedup key does not exist.** `alreadySent()` (`flows/utils.js:62-71`) and the unique index behind it key on `(order_id, flow_type)`. A campaign has no order. You would have to synthesise `order_id = 'CAMPAIGN_<uuid>_<phone>'`, which is precisely the sentinel-row hack already used for opt-outs at `flows/utils.js:44-53` and already identified as a mistake (P2-02 §12 item 7). Doing it a second time makes the send log permanently ambiguous about what is an order and what is not.
3. **`checkOrderRecovered()` makes a WooCommerce HTTP call per job** (`flows/utils.js:277-292`). Campaign rows must skip it, which means a `if (job.flow_type.startsWith('mkt:'))` branch inside the loop that currently sends every one of Vici's transactional messages. Every branch added to that function is a chance to break a live flow.
4. **The columns are wrong.** Campaign rows need `arm`, `variant_id`, `link_token`, `coupon_code`, `consumes_budget`, `priority`, `claimed_by`, `claim_expires_at`, `skip_reason`, `pre_period_revenue_cents`. Adding ten columns to `sms_scheduled` changes the table five live flows write to.
5. **P2-02 §5.4 Rule 1 already forbids it** by database constraint: a `CHECK` on `sms_scheduled.flow_type` rejecting the `mkt:` prefix.

**Decision:** campaigns use `sms_campaign_recipients` and a new worker `jobs/campaign-sender.js`. `sms_scheduled` and `processScheduledQueue()` are not modified at all.

### 3.3 The shared choke point: `lib/outbound.js`

Two queues, one primitive. Every outbound message in the system — manual, transactional, campaign, test — passes through exactly one function.

```js
// lib/outbound.js
/**
 * The ONLY function in this codebase permitted to import ../telnyx.
 * Enforced by test/no-direct-send.test.js.
 */
async function sendGuarded({
  to,            // string, will be normalised
  body,          // string, already rendered — no placeholders remain
  mediaUrls,     // string[] | null
  channel,       // 'transactional' | 'conversational' | 'marketing' | 'test'
  flowType,      // 'confirmed-new' | 'mkt:replenishment' | 'manual' | …
  campaignId,    // uuid | null
  recipientId,   // bigint | null — sms_campaign_recipients.id
  orderId,       // string | null — transactional dedup key
  actorId,       // string | null — until auth lands
  now            // Date, injectable for tests
}) → {
  ok: boolean,
  disposition: 'sent' | 'blocked' | 'deferred' | 'failed',
  reason: string | null,        // gate reason, or Telnyx error class
  deferUntil: Date | null,
  messageId: string | null,     // telnyx_message_id
  smsMessageId: number | null   // sms_messages.id
}
```

**What it does, in order:**

1. `normalisePhone(to)` → hard fail on null.
2. `channel === 'test'` → skip the gate entirely, send, do not log to any ledger, return. Test sends go to the operator's own seeded devices and must not be able to be blocked by the operator's own frequency cap.
3. Call `supabase.rpc('evaluate_send_gate', { p_phone, p_flow: flowType, p_campaign: campaignId, p_now: now })` — P2-02 §5.1. One round trip, one authoritative disposition.
4. `disposition === 'block'` → write the skip to the appropriate ledger, emit `lib/events.js`, return without touching Telnyx.
5. `disposition === 'defer'` → return `deferUntil`; the *caller* decides whether it can reschedule. Campaign worker reschedules; a manual send returns 409 to the operator with the local time it would be allowed.
6. `disposition === 'allow'` → re-lint the **rendered** body via `lib/compliance-lint.js` (P2-02 §5.2 check 7 runs inside the RPC on stored content; this is the belt-and-braces post-substitution pass), then `sendSMS()`, then write `sms_messages`, then classify any error per P2-02 §10.3.

**Which rules apply per channel** — this table is the thing that prevents breaking the live flows:

| Gate check (P2-02 §5.2) | transactional | conversational | marketing | test |
|---|---|---|---|---|
| 1 consent record | warn-only in Phase 0 | warn-only | **block** | skip |
| 2 suppression list | **block** | **block** | **block** | skip |
| 3 valid E.164 | **block** | **block** | **block** | block |
| 4 undeliverable | attempt anyway | attempt anyway | **block** | skip |
| 5 campaign active | n/a | n/a | **block** | skip |
| 6 duplicate guard | **block** | skip | **block** | skip |
| 7 content gate | **block** (shorteners, segments) | **warn** | **block** (full, incl. dosing) | warn |
| 8 recent purchaser | skip | skip | **block** | skip |
| 9 FL/OK/OR 3-per-24h | **block + alert** | **block + alert** | **defer** | skip |
| 10 frequency cap | skip (does not consume) | skip | **defer** | skip |
| 11 marketing cooldown | skip | skip | **defer** | skip |
| 12 transactional anti-collision | skip | skip | **defer** | skip |
| 13 quiet hours | **defer** | **allow** | **defer** | skip |

Two deliberate calls in that table:

- **`conversational` is exempt from quiet hours.** An operator replying at 22:10 to a customer who texted at 22:08 is legal (established conversation, prior express invitation) and refusing it would make the inbox useless. `routes/send.js` and `routes/react.js` use `channel: 'conversational'`.
- **Transactional *is* subject to quiet hours as a deferral**, per P2-02 §4.5 — a 05:30 shipping text is a bad experience and deferring it to 08:15 costs nothing. This is the one behaviour change to the live flows in this whole plan, and it is the one P2-02 already scheduled for Phase 0.

### 3.4 A refinement of P2-02 §5.4 Rule 3, stated plainly

P2-02 says: *"Both workers funnel through a single `sendGuarded()` … Today that role is played by `sendAndLog()` … Extend it with the gate rather than writing a second send path."*

I am implementing the same guarantee with the primitive moved:

- `sendAndLog()` lives in `flows/utils.js`. `flows/` does not exist in the Shore fork. Putting the compliance gate there means Shore cannot have it without acquiring a `flows/` directory it has no use for.
- `sendAndLog(phone, message, orderId, flowType)` requires an `orderId`. Marketing sends have none, and manual sends have none.
- Six of the seven current Telnyx call sites are not `sendAndLog()`. If the gate lives inside it, three endpoints — including a public one — keep sending with no suppression check at all. That is the defect this whole section exists to close.

So: `lib/outbound.js` holds the gate. `sendAndLog()` keeps its exact signature and becomes a wrapper that supplies `channel: 'transactional'` and `orderId`. **No caller of `sendAndLog()` changes.** This is the same single-path property P2-02 asked for, extended to the six paths P2-02's table did not enumerate.

### 3.5 Introducing it without breaking the five live flows

Five steps, each shippable alone. The rule throughout: **do not open `flows/confirmed.js`, `flows/shipped.js`, `flows/hold.js` or `flows/failed.js` at any point.**

**Step 1 — build it, ship it dead (zero behaviour change).**
Create `lib/suppression.js`, `lib/gsm.js`, `lib/compliance-lint.js`, `lib/outbound.js`. Ship the SQL for `evaluate_send_gate()` returning `allow` for everything except the two rules that exist today (opt-out, invalid phone). Deploy. Nothing calls it. Test coverage lands here.

**Step 2 — reroute `sendAndLog()` internals only.**
Replace lines `flows/utils.js:84-135` with a call to `sendGuarded({ channel:'transactional', orderId, flowType, … })`. Keep the `alreadySent()` pre-check at `:90` where it is — it is a friendly-path optimisation and the unique index remains the real guard. Keep the `23505` handling at `:107-113`. Signature unchanged, return value unchanged (`boolean`), log format unchanged.

The five callers — `flows/confirmed.js:456`, `flows/confirmed.js:494`, `flows/failed.js:285`, `flows/hold.js:408`, `flows/shipped.js:350`, plus `flows/utils.js:252` inside the queue processor — are **not edited**. Verify with `git diff --stat`: if any file under `flows/` other than `utils.js` appears, the change is wrong.

**Step 3 — reroute the six unguarded call sites.**
`routes/send.js:27` and `routes/react.js:58` → `channel:'conversational'`. `routes/intelligence.js:41` → `channel:'marketing'`. `routes/catchup.js:95,149` → `channel:'transactional'`. `routes/webhook-send.js:59` → `channel:'conversational'`.

**This step changes behaviour**, and the change is the point: catchup and the GHL webhook gain opt-out enforcement they have never had. Flag it to the client before deploying — a message that used to send may now be refused, and that is correct. Expect a small number of refusals on first run; those are the compliance incidents that were happening silently.

**Step 4 — enforce it forever.** Add `test/no-direct-send.test.js` (§10). Fifteen lines, runs in CI, fails any future PR that imports `../telnyx` from anywhere but `lib/outbound.js`. Without this, the property decays within two months.

**Step 5 — turn the remaining gate rules on, one per deploy.** Quiet hours first (largest blast radius, deferral not drop). Then FL/OK/OR. Then frequency. Then consent-record blocking, last, because it requires the Phase 0 grandfather backfill to have run. Each rule ships behind a row in a `gate_rules` config table so it can be disabled without a deploy if it misfires — with the exception of suppression and the dosing block, which per doc 03 §8 have no override path at all.

### 3.6 The campaign worker

`jobs/campaign-sender.js`. Not in `routes/`, not in `flows/` — a new `jobs/` directory alongside them, because these are timer bodies, not request handlers, and mixing them into `routes/` is how `routes/webhook-shipstation.js` ended up exporting `pollForCarrierScans()` to `server.js:9`.

```
processCampaignSends():
  reap()                                    // claimed AND claim_expires_at < now() → pending
  markUnknown()                             // sending AND > 15min → unknown + alert
  rows = rpc('claim_campaign_sends', { p_holder: HOLDER, p_limit: BATCH })
  for row of rows:                          // sequential; parallelise 5-wide only if needed
    if lateness(row) > maxLateness(row.flow_type): row → 'expired'; continue
    row → 'sending'                         // written BEFORE the Telnyx call
    r = sendGuarded({ channel:'marketing', recipientId: row.id, … })
    row → r.disposition mapped to state; record reason / defer_until / telnyx id
    circuitBreaker.record(r)                // ≥10 consecutive failures or >25%/20 → pause campaign
    broadcastProgress(row.campaign_id)      // throttled, §7.3
```

`BATCH` is 25 on a normal tick and **25 total on the first tick after boot**, per P2-02 §10.4's boot rate-limit. Wrapped in `withLease('campaign-sender', 10, …)` and a module-level `let running = false`.

---

## 4. AI integration

### 4.1 Diagnosis of the `OPENROUTER_MODEL` 404 — resolved

`.env` sets `OPENROUTER_MODEL=anthropic/claude-3.5-haiku`. On 12 August 2026 I fetched OpenRouter's live catalogue:

```
GET https://openrouter.ai/api/v1/models
→ anthropic/* present: claude-opus-5, claude-opus-5-fast, claude-sonnet-5,
  claude-fable-5, claude-opus-4.8, claude-opus-4.7, claude-sonnet-4.6,
  claude-opus-4.6, claude-opus-4.5, claude-haiku-4.5, claude-sonnet-4.5,
  claude-opus-4.1, claude-opus-4, claude-sonnet-4, claude-3-haiku
  plus floating aliases ~claude-haiku-latest, ~claude-sonnet-latest, ~claude-opus-latest
→ anthropic/claude-3.5-haiku: ABSENT
```

**The slug has been retired.** This is not a key problem, not a billing problem and not a rate limit. It is a dead model id, and it will stay dead.

Three compounding defects made it invisible:

1. **Six hardcoded copies of the same broken default.** `intelligence.js:50`, `intelligence.js:152`, `flows/confirmed.js:221`, `flows/confirmed.js:303`, `flows/shipped.js:86`, plus a sixth in `flows/shipped.js`. Changing the env var fixes all six only because they all read the same var; but there is no single place to add a check.
2. **Zero `response.ok` checks.** `grep -rn "response.ok" flows/*.js intelligence.js` returns nothing. A 404 body parses as JSON, has no `.choices`, and lands at `intelligence.js:60-63` which logs 200 characters and returns `null`.
3. **Every call site fails open, silently.** `routes/webhook.js:240` fires `analyseConversation()` in a detached `setTimeout(...).catch(console.error)`. `flows/confirmed.js:446-454` catches and falls back to the base template. That posture is *correct* for the send path — P2-02 §10.2 is right that no LLM may block a send — but combined with no alerting it means **the AI has been dead across the entire product, including the personalisation inside all five live flows, for as long as the slug has been retired, and the only symptom was `sms_customer_profiles` having one row.**

### 4.2 The fix

**Immediate (one line, ship today):**
```
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
```
Set it in `.env` and in Railway. That alone restores flow personalisation and the conversation analyser.

**Do not use the floating aliases** (`~anthropic/claude-haiku-latest`). A floating alias changes the model under a running system with no deploy and no changelog, which is how you get a copy-quality regression you cannot bisect. Pin explicitly and upgrade deliberately.

**Structural (with the wizard):** replace the single var with three roles.

| Role | Env var | Recommended | Used for |
|---|---|---|---|
| `classify` | `AI_MODEL_CLASSIFY` | `anthropic/claude-haiku-4.5` | conversation analysis, flow personalisation, intent tagging |
| `draft` | `AI_MODEL_DRAFT` | `anthropic/claude-sonnet-4.6` | campaign copy generation |
| `critique` | `AI_MODEL_CRITIQUE` | `anthropic/claude-sonnet-4.6` | rubric scoring |

`OPENROUTER_MODEL` remains supported as the fallback for all three so nothing breaks during the transition.

**The check that would have caught this on day one** — 12 lines in `lib/ai/client.js`, run once at boot from `server.js:160`'s listen callback, alongside `verifyConnection()`:

```js
async function verifyModels() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const ids = new Set((await r.json()).data.map(m => m.id));
  for (const [role, id] of Object.entries(MODELS)) {
    if (!ids.has(id)) console.error(`[AI] MODEL NOT FOUND: ${role}=${id} — this role will fail`);
    else console.log(`[AI] ${role} → ${id} OK`);
  }
}
```

It must log at `error` level and appear in the boot banner beside the existing `WooCommerce: configured` / `ShipStation: configured` lines (`server.js:167-169`). Unlike `verifyConnection()` at `db.js:17`, it must **not** `process.exit(1)` — a dead model is a degraded product, not a dead one.

### 4.3 The AI service layer

```
lib/ai/
  client.js      — the only fetch to OpenRouter in the codebase
  prompts.js     — prompt loading, DB-first with file fallback
  brand.js       — per-client brand context injection
  validate.js    — deterministic validator (wraps lib/gsm + lib/compliance-lint)
  draft.js       — generate → validate → repair loop
  critique.js    — rubric scoring
prompts/
  draft-system.md       — seeded from doc 01 §7.2, verbatim
  critique-system.md    — seeded from doc 01 §7.3, verbatim
  repair-system.md      — new; takes validator failures and one draft
  classify-system.md    — the current intelligence.js SYSTEM_PROMPT, extracted
```

**`lib/ai/client.js`** — one function, and it is the second choke point in this document:

```js
async function complete({
  role,          // 'classify' | 'draft' | 'critique'
  system,        // string
  user,          // string
  maxTokens,     // number
  temperature,   // number
  timeoutMs,     // default 20_000 for draft/critique, 8_000 for classify
  json           // boolean — if true, parse and validate, retry once on parse failure
}) → { ok, content, parsed, model, usage, cost_cents, error }
```

It must: check `response.ok` and surface the status; use `AbortController` for the timeout (the pattern already exists at `flows/confirmed.js:209`); retry once on 429 and 5xx with 1s jitter, never on 4xx; write one row to `ai_calls (role, model, prompt_key, prompt_version, tokens_in, tokens_out, cost_cents, latency_ms, ok, error, created_at)`; and **never throw** — callers get `{ ok:false }`.

Migrating the six existing call sites to `client.complete()` is a follow-up, not a prerequisite. Do the wizard first, then collapse `intelligence.js`'s two and `flows/`'s four in a separate PR whose only job is deleting duplication. Touching four flow files is a change that deserves its own blast radius.

### 4.4 The deterministic-validator revision loop

Doc 01 §7.1 principle 1 is the strongest recommendation in the research corpus: *"The single biggest quality win available is a deterministic post-generation validator in a revision loop, not a better prompt."* Build for that literally.

```
draft({ brief, brand, contact_facts, variantCount = 3 }):
  1. system = prompts.get('draft-system') + brand.block(BRAND_KEY)
     user   = brief + JSON.stringify(contact_facts)     // structured, named fields
  2. r1 = client.complete({ role:'draft', … })          // model call 1
  3. for each draft d in r1:
       v = validate(d)                                  // ZERO model calls
     if every d passes hard gates and scores ≥ 70: goto 6
  4. repair = prompts.get('repair-system')
     r2 = client.complete({ role:'draft', system: repair,
            user: failing drafts + their exact validator output })   // model call 2
  5. re-validate; take the better of (r1[i], r2[i]) per slot
  6. c = critique(best)                                 // model call 3, separate prompt,
                                                        // fed the computed metrics as ground truth
  7. return { drafts, validation, critique, attempts, cost_cents }
```

**Hard cap: three model calls per `/api/ai/draft` request.** Doc 01 §7.4 says cap at two generation attempts and surface the best with its critique rather than looping. Enforce it in code as a constant, not a config value — an unbounded loop against a paid API triggered by a UI button is how a $4 feature becomes a $400 one.

`validate()` returns exactly what doc 01 §5.4 asks for and it is all computed, never modelled:

```js
{
  encoding: 'GSM-7' | 'UCS-2',
  chars, billable, segments, est_cost_cents,
  truncation_40: string,               // the reader-visible preview, verbatim
  ucs2_culprits: [{ char, name, index }],
  gates: { G1..G9: { pass: boolean, detail: string } },
  warns: [{ code, detail }]            // doc 03 §8.3 W1..W15
}
```

The critique call receives `validate()`'s output as stated ground truth with an explicit instruction not to recompute — doc 01 §7.3. Models cannot count characters and will confidently claim otherwise.

### 4.5 Where prompts live, so they are editable without a deploy

**Both. DB is authoritative, files are the seed and the disaster fallback.**

```sql
CREATE TABLE ai_prompts (
  key           text NOT NULL,          -- 'draft-system' | 'critique-system' | …
  version       int  NOT NULL,
  body          text NOT NULL,
  model_role    text NOT NULL DEFAULT 'draft',
  temperature   numeric(3,2) NOT NULL DEFAULT 0.7,
  max_tokens    int  NOT NULL DEFAULT 1200,
  is_active     boolean NOT NULL DEFAULT false,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
);
CREATE UNIQUE INDEX ux_ai_prompts_active ON ai_prompts(key) WHERE is_active;
```

`lib/ai/prompts.js`:

```js
getPrompt(key)  → { body, version, model_role, temperature, max_tokens, source }
                  // active DB row; on miss or DB error, read prompts/<key>.md,
                  // return source:'file', version:0. Cached 60s in-process.
setPrompt(key, body, meta, actor)  → inserts version = max+1, flips is_active atomically
listVersions(key) → Prompt[]
rollback(key, version) → activates an existing version
```

Rationale, since this is a decision people argue about:

- **Files alone** means every wording tweak is a git commit, a Railway build and a two-minute deploy. Prompt iteration is the highest-frequency edit in an AI product; making it a deploy guarantees it stops happening.
- **DB alone** means an empty or corrupted table bricks the feature, and the prompt is invisible to code review and absent from git history.
- **Both** gives fast iteration, versioning, rollback, and a filesystem fallback that cannot be deleted by a bad `UPDATE`. The file is also what seeds a new deployment — which is exactly how Shore gets the same prompts (§9).

Never partially interpolate. The prompt body is stored whole. Brand context is a *separate appended block*, so a client editing their voice cannot accidentally delete the encoding rules or the grounding instruction.

### 4.6 Per-client brand context

```sql
CREATE TABLE brand_profiles (
  key             text PRIMARY KEY,     -- 'vici' | 'shore', from env BRAND_KEY
  display_name    text NOT NULL,        -- 'Vici Peptides'
  short_domain    text,                 -- 'go.vicipeptides.com'
  products        jsonb NOT NULL,       -- [{sku, name, aliases[]}]
  voice_notes     text,                 -- operator-authored, free text
  banned_phrases  text[],               -- brand-specific, on top of the global lint
  use_case        text NOT NULL,        -- registered 10DLC use case
  optout_language text NOT NULL,        -- 'Reply STOP to opt out'
  timezone        text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`lib/ai/brand.js` exports `block(key) → string`, appending to the system prompt:

```
## Brand
You are writing for Vici Peptides. Registered 10DLC use case: <use_case>.
Products you may reference by name: <products>. Never name a product not in this list.
Short domain for all links: go.vicipeptides.com.
Required opt-out phrasing: "Reply STOP to opt out".
Voice: <voice_notes>
Never use: <banned_phrases>
```

One row per deployment today, because Vici and Shore are separate deployments. **This table is the tenancy seam.** When multi-tenancy arrives, `BRAND_KEY` becomes a per-request lookup and the prompt layer needs no change at all. That is the cheapest possible hedge against the unresolved fork question and it costs one table now.

Vici and Shore differ in exactly the ways this table captures: different products (peptides vs. courses), different voice, different banned phrases (Vici blocks all dosing language per P2-02 §5.3; Shore does not need to), different use case, different short domain.

### 4.7 Keeping the wizard usable when the model is unavailable

Not a graceful-degradation afterthought — the failure mode that already killed the existing AI feature.

1. **No LLM call is ever in the send path.** P2-02 §10.2, adopted without qualification. The model drafts; a human approves; the approved body is stored on the variant; rendering is pure substitution. An OpenRouter outage delays authoring and can never affect sending.
2. **The wizard is a form that happens to have an AI button.** Segment → write body → lint → preview → test send → approve → schedule. Every step except one works with zero AI.
3. **`/api/ai/lint`, `/api/ai/autofix-encoding`, `/api/campaigns/:id/checks` and `/api/campaigns/:id/preview` make no model call** and must return 200 during an outage. The encoding validator, the compliance lint, the segment count, the exclusion ledger, the cost projection and the measurability pre-flight are all deterministic — which is to say, **the majority of the wizard's actual value is AI-free.** Say that in the UI.
4. **`/api/ai/draft` returns 503 with `{ ai_available:false, reason }`**, never a hang and never an empty draft. The editor stays open with the lint panel live.
5. **`GET /api/ai/health`** is polled by the wizard on open and surfaces a banner. Silent degradation is what produced one row in `sms_customer_profiles`.
6. **Cost control:** `ai_calls` gets a daily rollup; a `AI_DAILY_CAP_CENTS` env var (default 500) trips `/api/ai/draft` to 503 with `reason:'daily_cap'`. At haiku-4.5 and sonnet-4.6 pricing, a three-call draft request runs to a fraction of a cent, so the cap is a runaway-loop guard, not a budget.

---

## 5. The click redirector

### 5.1 Where it lives

Doc 05 §4.2 is unambiguous: the redirector must be on a subdomain of the **store's** registrable domain, so a cookie set with `Domain=.vicipeptides.com` is readable by the storefront. `telynx.link/abc` cannot do session stitching and reads as phishing in a text message.

**Recommendation: `go.vicipeptides.com` as a Railway custom domain on the existing `web-production-2551e` service, serving `routes/redirect.js` out of the same Express app.**

The alternatives and why not:

| Option | Verdict |
|---|---|
| Separate Railway service for the redirector | A second deploy, a second env config, a second thing to monitor, and it needs the same database anyway. Buys isolation we do not need at 390 clicks per campaign |
| Cloudflare Worker on the store's zone | Genuinely better for latency and gives an A record rather than a CNAME (dodging Safari's ITP cap). But it is new infrastructure, a new deploy pipeline, and a second place compliance logic could drift to. Revisit if click volume ever justifies it |
| Path on the existing app domain (`app.…/r/x`) | Fails the first-party cookie requirement entirely. Not an option |

**Cost of the recommendation: one CNAME record the client adds to their DNS.** That is the whole change.

**The Safari caveat is neutralised by the window, not by cleverness.** WebKit ITP caps CNAME-cloaked cookies at 7 days. Doc 05 §4.6 sets the default attribution window at 72 hours. 72 < 168, so the cap never binds. Doc 05 §4.2 already noted that the honest window and the technically-clean window coincide; take the win and do not extend the window past 7 days without revisiting this.

### 5.2 Routing, and the trap in `server.js`

`server.js:110` is `app.get('/{*splat}', …)` serving `public/index.html`. Two consequences:

1. **`app.use('/r', …)` must be registered before `express.static` at `server.js:109`,** or the SPA swallows every click.
2. **`go.vicipeptides.com/anything-else` currently serves the inbox SPA.** That is a real problem: the client's customers would find a login screen on the store's own subdomain. Add a host guard to the catch-all:

```js
const REDIRECT_HOSTS = (process.env.REDIRECT_HOSTS || '').split(',').filter(Boolean);
app.get('/{*splat}', (req, res) => {
  if (REDIRECT_HOSTS.includes(req.hostname)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

`helmet` (`server.js:24`) and the permissive `cors` (`server.js:26-34`) already apply globally and are fine here. The redirector sets no CORS-relevant headers; `/collect` needs `Access-Control-Allow-Origin` for the store's origin, which the existing wildcard-ish handler already grants.

### 5.3 The redirect chain

```
SMS body contains:  go.vicipeptides.com/r/8f2Kq9
  ↓ GET /r/8f2Kq9
  ↓ 302 Location: https://vicipeptides.com/products/bpc-157
                    ?vk=<click_uuid>&utm_source=sms&utm_medium=sms
                    &utm_campaign=<slug>&utm_content=<variant_slug>
    Set-Cookie: vk_click=<click_uuid>; Domain=.vicipeptides.com; Path=/;
                Max-Age=259200; Secure; SameSite=Lax
  ↓ storefront JS reads ?vk= (or the cookie), stores it, POSTs /collect
```

**Exactly one hop.** Doc 05 §7.4 asserts ≤ 3 and doc 03 §7.2 flags multi-hop chains as a spam-evasion signature. One is the correct number; the destination URL is stored fully resolved at campaign build time and validated by `/checks` before approval, so no runtime resolution is needed.

`?vk=` is appended as a cookie-independent fallback (doc 05 §4.2). `/checks` asserts the destination preserves query parameters — some storefronts strip them, which silently zeroes Grade A attribution and is otherwise undetectable.

### 5.4 Recording the click without slowing the redirect

Target: **p99 under 30 ms of server time**, and no database write on the critical path.

```js
router.get('/:token', (req, res) => {
  const hit = tokenCache.get(req.params.token);       // in-process Map
  if (!hit) return res.redirect(302, FALLBACK_URL);   // never a 404 to a customer
  res.redirect(302, buildDest(hit, clickId));          // ← response sent HERE
  recordClick(hit, clickId, req).catch(() => {});      // ← everything else after
});
```

Responding first and doing the work after is **already the house pattern** — `routes/webhook.js:18` does `res.sendStatus(200)` before any processing, for the same reason.

**The token cache.** `sms_campaign_recipients.link_token` rows are immutable once written, so the cache needs no invalidation, only a bound. A `Map` capped at 20,000 entries holding `{ recipient_id, campaign_id, contact_phone, dest_url, delivered_at, campaign_slug, variant_slug }`, warmed for a campaign when it transitions to `active` and evicted oldest-first. A cold miss falls through to one indexed lookup on the unique index over `link_token` — sub-millisecond at this scale. The same bounded-`Map` pattern already exists at `lib/message-status.js:11` with the eviction loop at `:114-120`; copy it rather than adding an LRU dependency.

**A missing token never 404s.** It redirects to the store homepage and logs. A customer who clicks a link from a text and gets an error page is worse than a customer who lands on the homepage, and a 404 on the store's own subdomain is a support call.

**Bot filtering** (doc 05 §4.4), applied inside `recordClick`, never on the hot path:

| Signal | Available at redirect time? | v1 |
|---|---|---|
| `clicked_at − delivered_at < 3s` | ✅ `delivered_at` is in the cached row | **Yes** |
| Scanner user agents (`curl`, `python-requests`, `HeadlessChrome`, `Slackbot`, `facebookexternalhit`, `Bitly`, `Barracuda`, `Proofpoint`, `Mimecast`) | ✅ one regex | **Yes** |
| `HEAD`, or `GET` without `Accept: text/html` | ✅ | **Yes** |
| >1 distinct token from one campaign, one IP, 10s | ✅ in-process counter | **Yes** |
| No `sms_sessions` row within 60s | ⏱ needs a deferred pass | Nightly, as a secondary flag only |
| Datacenter ASN | ❌ needs an IP-to-ASN dataset | **Deferred.** Store `ip` (INET); backfill `ip_asn` later. Say so rather than pretending |

Every click is written, bots included, with `is_bot` and `bot_reason`. Bots are excluded from every rate denominator and from attribution, never from the ledger — you cannot audit a filter whose rejects you discarded.

### 5.5 The conversion path — no new webhook

`server.js:40` already registers `express.raw()` for `/webhook/woocommerce` and `routes/webhook-woocommerce.js` already verifies the HMAC and upserts `sms_orders`. Adding a second webhook duplicates all of that and adds a second thing to configure in the client's WooCommerce admin.

Extend the existing order handler instead:

```
on order created/updated (existing handler):
  … existing sms_orders upsert (unchanged) …
  clickId = order.meta_data.find(m => m.key === '_vk_click_id')?.value
  if (clickId) attribution.recordGradeA({ woo_order_id, click_id: clickId, … })
```

Grades B through D are **not** computed here. They run in the nightly reconciler (§6.3) as the window-bounded SQL in doc 05 §4.5, with Grade A's unique constraint and `ON CONFLICT DO NOTHING` preventing any downgrade. Doing identity matching inline on a webhook means a slow join in the path of an order confirmation SMS — exactly the head-of-line problem from §3.2 in a different disguise.

Refunds: the same nightly pass marks attributions whose `sms_orders.status` moved to `refunded`/`cancelled` and subtracts them from rollups (doc 05 §4.5). Attributed revenue that is not net of refunds is inflated by the refund rate, which for this vertical is not trivial.

---

## 6. Background jobs

### 6.1 Honest assessment of `setInterval`

P2-02 §1.3 settled this and I agree with it completely: **keep `setInterval`; add the `job_leases` table and the claim-then-send RPC; revisit at ~50k sends/day.** A job queue is new infrastructure, a new failure surface and a deployment change, for a workload of 847 contacts.

Three points worth restating because they are the ones that get argued:

- **Two processes genuinely run today.** Railway performs overlapping deploys and `server.js:120-123` fires a catch-up run 15 seconds after boot. Every deploy opens a window where two processes call `processScheduledQueue()` against the same `pending` rows. This is not theoretical.
- **The only reason it has not bitten is `sms_sent_log`'s unique index** on `(order_id, flow_type)` and the `23505` catch at `flows/utils.js:107-113`. That guard is real, it works, and **it does not exist for marketing sends**, which have no `order_id`. Building campaigns on the same pattern without building the equivalent guard is the single most likely way to send a customer the same promotional text twice.
- **`pg_advisory_lock` is the trap.** Session-scoped, and every Supabase call goes over PostgREST against a pooled connection. It will pass testing and fail in production. Use the `job_leases` table.

### 6.2 My addition: rank the jobs by what the lease actually protects

Not every job needs the lease for the same reason, and this determines what must ship in Phase 0 versus what can wait.

| Job | Lease protects | Ships |
|---|---|---|
| `processScheduledQueue` (existing, `server.js:117-129`) | **Correctness** — double-send, mitigated today only by the unique index | Phase 0 |
| `processCampaignSends` (new) | **Correctness** — double-send with *no* natural unique key | With the worker; the claim RPC is the primary guard, the lease is defence in depth |
| `pollForCarrierScans` (existing, `server.js:133-144`) | **Correctness** — it can trigger a shipped SMS | Phase 0 |
| `checkAndSendDeliverySMS` (existing, `server.js:147-157`) | **Correctness** — it sends | Phase 0 |
| `nightlyMetricsRecompute` (new) | **Waste only** — idempotent `UPSERT` | With the job |
| `nightlyReplenishmentPredictor` (new) | **Waste only** — idempotent | With the job |
| `dailyMaterialiser` (new) | **Correctness** — creates recipient rows; guarded by the `(campaign_id, phone)` unique index but the lease avoids the noise | With the job |
| `attributionReconcile` (new) | **Waste only** — `ON CONFLICT DO NOTHING` | With the job |
| `unknownReconcile` (new) | **Waste only** — read-mostly | With the worker |

The three existing timers are all in the correctness column. **They are the Phase 0 work, and they are worth doing even if the wizard is never built.**

### 6.3 Where the jobs live

`server.js` currently inlines three timer bodies across `:114-157`. Adding six more there makes the entry point unreadable. Extract:

```
jobs/
  index.js              — startJobs(); the only thing server.js calls
  lease.js              — withLease(job, ttlMinutes, fn), HOLDER, re-entrancy flags
  campaign-sender.js    — processCampaignSends()  every 1 min
  metrics.js            — nightlyMetricsRecompute()  03:00 ET
  replenishment.js      — predictor 03:30 ET, materialiser 09:00 ET
  attribution.js        — attributionReconcile()  hourly + refund pass nightly
```

`server.js:114-157` collapses to `require('./jobs').startJobs()` inside the listen callback at `:160-170`. **`jobs/index.js` re-registers the three existing timers unchanged** — same intervals, same functions, same startup offsets — now wrapped in `withLease`. Moving code and changing behaviour in one commit is how a working flow silently stops firing; move first, wrap second, in separate commits.

There is no cron library. `setInterval` plus a "have we run since the last 03:00 ET boundary?" check against `job_leases.acquired_at` is enough for two daily jobs and adds no dependency.

### 6.4 If a real queue ever is needed

At ~50k sends/day, or the moment a second permanent instance exists, or when retries need exponential backoff across hours. Two options, priced:

1. **A second Railway service running the same repo with `WORKER=1`.** `jobs/index.js` runs there; the web service skips it. ~$5/month, half a day of work, no new vendor, no new SDK, and the lease design already makes it safe. **This is the recommendation when the time comes.**
2. **Upstash QStash.** HTTP-push to existing Express routes, no persistent connection (which matters on Railway), free to 500 messages/day then ~$10/month. Worth it only if per-message retry semantics with backoff are genuinely needed, which they are not today — P2-02 §6 Layer 3's deliberate at-most-once policy means we specifically *do not want* automatic retries on `sending` rows.

Neither is needed now. Do not build for either.

---

## 7. Real-time

### 7.1 What exists

An in-process `Set` at `server.js:15`, a 6-line broadcaster indirection at `lib/broadcaster.js`, and `routes/sse.js` with a 15-second keepalive. Broadcast-to-all, no event IDs, no replay, no actor, no topics. It drops every client on redeploy and it is single-instance only.

### 7.2 Does SSE remain adequate? Yes, for now — with four changes

SSE is the right transport here. Two users, one-directional server-to-client, and it already works through Railway. WebSockets buy nothing. Supabase Realtime is already a configured dependency (`db.js:7` passes `realtime: { transport: ws }`) and entirely unused — it is the natural escape hatch when a second instance appears, since it moves fan-out out of process with no new vendor. **Not yet.**

**Change 1 — event IDs and replay.** SSE's built-in resume is free and currently unused. Add a monotonic counter and a bounded ring buffer of the last 200 events:

```js
let seq = 0;
const ring = [];                                   // {id, data}, capped at 200
function broadcastSSE(event) {
  const id = ++seq;
  const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  ring.push({ id, frame }); if (ring.length > 200) ring.shift();
  sseClients.forEach(c => { try { c.write(frame); } catch { sseClients.delete(c); } });
}
```

`routes/sse.js` reads `Last-Event-ID` on connect and replays anything newer from the ring before adding the client. The browser sends that header automatically on reconnect. This fixes the redeploy gap for free — the ring does not survive a restart, but the *reconnect* case (network blip, phone waking) is the common one and it is fully covered.

**Change 2 — an actor field on every event.** Add `actor: null` now, everywhere. Doc 06's finding is that 16 action sites have no attributable actor and auth is the prerequisite. Adding the field before the values exist means the frontend, the iOS app and the feed schema are all shaped correctly, and the auth work becomes a matter of filling it in rather than changing every event and every consumer.

**Change 3 — throttle campaign progress. This is the one that matters.** A 390-recipient send emitting one event per recipient is 390 broadcasts to every connected client, and `public/app.jsx:2412` dispatches every one of them into a `CustomEvent` the React tree listens to. That is a UI freeze on a phone. Coalesce:

```js
// at most one per campaign per 2s, plus a guaranteed final frame
broadcastProgress(campaignId) → { type:'campaign_progress', campaign_id,
                                  sent, failed, skipped, deferred, total, done }
```

Per-recipient detail is fetched on demand from `GET /api/campaigns/:id/recipients`. Nobody watches 390 rows update live.

**Change 4 — a `topic` field, filtered server-side.** Every event gains `topic: 'inbox' | 'automations' | 'campaigns' | 'voice' | 'feed'`. `GET /api/sse?topics=inbox,campaigns` stores the requested set on the client entry and `broadcastSSE` skips non-matching clients. Ten lines, and it stops the iOS app receiving campaign progress it has no screen for. Default to all topics when the parameter is absent so existing clients — including deployed iOS builds — are unaffected.

### 7.3 What reaches the UI, and how

| Event | Emitted from | Topic |
|---|---|---|
| `campaign_progress` (throttled) | `jobs/campaign-sender.js` | `campaigns` |
| `campaign_state` (approved / active / paused / cancelled / complete) | `routes/campaigns.js` | `campaigns` |
| `campaign_send_result` (per-recipient, **only for test sends**) | `routes/campaigns.js` | `campaigns` |
| `feed_event` | `lib/events.js` | `feed` |
| `opt_out` (existing, `routes/webhook.js:87`) | unchanged | `inbox` |
| `queue_added` / `queue_cancelled` / `message_sent` (existing) | unchanged | `automations` |
| `new_message` / `status_update` / `reaction_update` (existing) | unchanged | `inbox` |

Existing event type names are not changed. See §2.3.

---

## 8. Reusable libraries

New modules under `lib/`. Signatures given because they are the contract between the workstreams.

### 8.1 `lib/phone.js` — extend, do not duplicate

There are already two phone normalisers: `lib/phone.js:14` `normalisePhone()` and `flows/utils.js:15` `formatPhone()`. They differ — `normalisePhone` accepts `digits.length >= 11` as international, `formatPhone` returns `null` for an 11-digit non-US number. Two normalisers means two definitions of "the same contact", and every join in the attribution model is on phone.

**`lib/phone.js` becomes canonical.** `formatPhone` stays exported from `flows/utils.js` as a re-export so no flow file changes, marked deprecated. Add:

```js
normalisePhone(raw) → string | null              // existing, unchanged
isE164(s) → boolean                              // ^\+[1-9]\d{7,14}$
maskPhone(s) → string                            // '+1••••••1234', for previews and logs
```

Doc 05 §4.3 also asks for a DB `CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')` on the new tables so bad data cannot enter. Do that.

### 8.2 `lib/gsm.js` — encoding and segment counting

Pure, no I/O, no dependencies. The highest value-per-line module in the plan, and per doc 01 §4.5 a single curly apostrophe silently triples a message's cost.

```js
classify(text)      → 'GSM-7' | 'UCS-2'
countUnits(text)    → number       // septets w/ extension chars ×2, or UTF-16 code units
segments(text)      → { encoding, units, segments, perSegment }
                                   // GSM-7: ≤160 → 1, else ceil(units/153)
                                   // UCS-2: ≤70  → 1, else ceil(units/67)
culprits(text)      → [{ char, codepoint, name, index }]   // what forced UCS-2
transliterate(text) → { text, diff: [{from,to,index}] }    // ' → ', — → ' - ', … → ...
truncate40(text)    → string       // the reader-visible notification preview
estimateCost(text, recipients, rates) → { segments, total_cents, breakdown }
```

`rates` is passed in, never hardcoded — doc 01 §4.6 marks carrier pass-through fees `[UNVERIFIED]` and volatile, and instructs pulling them live.

**Who adopts it:** `lib/outbound.js` (segment count on every send, for `sms_campaign_costs`); `routes/ai.js` `/lint`; `routes/campaigns.js` variant endpoints; `lib/ai/validate.js`; and — the point doc 01 §8 makes explicitly — **the existing flows**, whose hand-written templates in `flows/confirmed.js`, `flows/shipped.js`, `flows/hold.js` and `flows/failed.js` have never been checked for encoding. Run `culprits()` over all of them once as a script before anything else; that is a five-minute job with a real chance of finding a live 3× cost multiplier.

### 8.3 `lib/suppression.js` — the gate wrapper

Thin Node wrapper over P2-02's `evaluate_send_gate()` SQL function. Deliberately thin: the logic lives in Postgres because it must be atomic with the reads it depends on.

```js
evaluate({ phone, flowType, campaignId, channel, now }) →
  { disposition: 'allow'|'block'|'defer', reason, deferUntil, localTime, timezoneSource }

isSuppressed(phone) → boolean                    // fast path, replaces flows/utils.js:29
suppress(phone, { reason, scope, source, rawText }) → void   // replaces flows/utils.js:44
explain(phone, flowType) → { checks: [{name, pass, detail}] } // for the UI
```

**Adopt Shore's design here, do not invent one.** `~/shore-academy-inbox/lib/compliance.js` already stores opt-outs in a real `sms_optouts` table with a documented rationale, while Vici still uses the sentinel-row hack at `flows/utils.js:44-53` (`order_id = 'OPTOUT_<digits>'` in `sms_sent_log`). The low-risk client has the better implementation. Port Shore's, extend it to P2-02's `sms_suppressions` with scope and provenance, and have `isSuppressed()` read both during the migration exactly as P2-02 §11 Phase 0 specifies.

**Who adopts it:** `lib/outbound.js` only. Everything else goes through `sendGuarded`.

### 8.4 `lib/outbound.js` — the send choke point

Signature in §3.3. Additionally:

```js
sendGuarded(opts) → SendResult                   // the one function
renderBody(template, facts) → { body, unresolved: string[] }
                                                 // BLOCKS if unresolved is non-empty
```

`renderBody` exists here rather than in the AI layer because P2-02 §10.2's corollary is a send-path property: never send a message with an unfilled placeholder. `Hi {{first_name}},` → `Hi ,` is doc 05 §7.1's "single most common embarrassing bug", and the only place it can be caught for certain is immediately before the wire.

**Who adopts it:** all seven current call sites (§3.5 steps 2–3), plus `jobs/campaign-sender.js`.

### 8.5 `lib/compliance-lint.js` — the linter

Pure functions over text plus a brand profile. No I/O, no model.

```js
lint(body, { brand, channel, campaignType }) →
  { blocks: [{code, detail, span}], warns: [{code, detail, span}], passes: string[] }

gates(body, { brand, facts }) → { G1..G9: {pass, detail} }   // doc 01 §5.1
normalise(text) → string        // homoglyphs, zero-width, leetspeak — doc 03 §8.5
hasShortener(body) → { found: boolean, domain: string|null }
links(body) → [{ url, host, index }]
```

Rules from doc 03 §8.5, seeded from a `compliance_rules` table so a regex can be tuned without a deploy — **except** the ones doc 03 §8 marks as having no override path (suppression, exclusive-opt-out language, non-standard opt-out substitution, the dosing block per P2-02 §5.3), which are compiled constants in the file.

Two things it deliberately does not do, per doc 01 §6.2 item 9: **no banned-words list beyond the WARN tokens**, and no claim that avoiding the word "free" affects delivery. Doc 01 is explicit that the word lists trace to vendor blogs citing vendor blogs and that effort belongs on the branded domain, campaign-type match and opt-out plumbing instead.

**One unresolved input:** the INDEX flags a genuine contradiction between doc 03 (SHAFT-C as a live carrier standard) and doc 04 (no SHAFT list in the CTIA PDF at all). P2-02 §13 item 6 also flags it. The linter's SHAFT rules ship at **WARN**, never BLOCK, until that is resolved.

**Who adopts it:** `lib/ai/validate.js`, `routes/ai.js`, `lib/outbound.js` (post-substitution pass), `routes/campaigns.js` `/checks`.

### 8.6 `lib/segments.js` — segment evaluation

```js
compile(definition) → { sql, params, fields }    // JSONB predicate tree → parameterised SQL
evaluate(definition, { limit, offset }) → { matched, rows, computed_at, stale }
count(definition) → { matched, eligible, exclusions: {reason: count} }
vocabulary() → FieldSpec[]                       // drives the UI builder and validation
diff(definition, sinceCampaignId) → { added, removed, overlap }
```

`compile()` never string-concatenates a value. Field names come from a whitelist derived from `vocabulary()`; values are always parameters. An operator-authored segment builder is a SQL injection surface and it is the only one this plan adds.

**Who adopts it:** `routes/segments.js`, `routes/campaigns.js` preview, `jobs/replenishment.js` materialiser.

### 8.7 `lib/events.js` — the activity emitter

```js
emit({ type, topic, actor, subject, subject_type, meta }) → void
                          // writes sms_activity_events, then broadcasts via lib/broadcaster
recent({ since, types, limit }) → Event[]
```

Fire-and-forget, never throws, never blocks a caller. An audit log that can fail a send is worse than no audit log.

**Who adopts it:** `routes/campaigns.js` (all state transitions), `routes/consent.js`, `lib/outbound.js` (blocks and failures only, not every send — 390 rows per campaign in the feed is noise), `jobs/campaign-sender.js` (start, pause, complete).

### 8.8 `lib/attribution.js`

```js
mintToken() → string                             // base62 of 64 random bits, never sequential
recordClick({ token, ip, userAgent, method, accept, now }) → { clickId, isBot, botReason }
recordGradeA({ wooOrderId, clickId, orderTotalCents, orderedAt }) → Attribution|null
reconcile({ since }) → { inserted, refundedOut } // grades B–D + refund pass
rollup(campaignId) → { click_attributed, associated, incremental_or_unmeasurable }
```

`rollup` returns doc 05 §8.1's three tiers as three separate numbers. There is no single-number accessor, deliberately — the API shape is what stops a future dashboard from quietly reporting one inflated figure.

### 8.9 `lib/ai/*`

Covered in §4.3.

---

## 9. The fork

Shore Academy (`~/shore-academy-inbox`) has no `flows/`, no `intelligence.js`, no commerce integration, and a client who has explicitly asked for no automations. It also has four modules Vici lacks — `lib/compliance.js`, `lib/ghl-client.js`, `lib/ghl-contact-store.js`, `lib/startup-check.js` — and in the compliance case Shore's is better than Vici's.

**No monorepo migration is proposed.** `00-current-state.md` §7 correctly identifies extract-shared-core and multi-tenant as the strategic answers, and both are large. What follows is the incremental path that makes either of them cheap later without doing either now.

### 9.1 What is Vici-only, shared, and shared-with-a-seam

| Component | Vici | Shore | Notes |
|---|---|---|---|
| `lib/gsm.js` | ✅ | ✅ | **Pure.** Identical byte-for-byte. Port immediately, before anything else |
| `lib/compliance-lint.js` | ✅ | ✅ | Pure + a brand profile. Different `banned_phrases`, same code |
| `lib/phone.js` | ✅ | ✅ | Already identical in both repos |
| `lib/suppression.js` | ✅ | ✅ | Shore already has the better version; Vici adopts it, then both share the extension |
| `lib/outbound.js` | ✅ | ✅ | Shore has 4 raw `sendSMS` sites with the same shape of problem |
| `lib/ai/*` + `prompts/*` | ✅ | ✅ | Brand profile carries the difference in voice and products |
| `lib/events.js` | ✅ | ✅ | Pure plumbing |
| `routes/ai.js`, `routes/consent.js`, `routes/feed.js` | ✅ | ✅ | Thin routers over shared libs |
| `routes/segments.js`, `lib/segments.js` | ✅ | ⚠️ **seam** | Shore has no orders. The predicate vocabulary must come from a **facts provider**, not be hardcoded to `sms_orders` |
| `routes/campaigns.js` | ✅ | ⚠️ partial | Shore gets draft / lint / preview / test-send / approve / **send-now**. No schedule, no worker |
| `jobs/campaign-sender.js` | ✅ | ❌ | "No automations" means no scheduled sending. Shore sends manually from an approved campaign |
| `jobs/replenishment.js`, `jobs/metrics.js` | ✅ | ❌ | Needs order history Shore does not have |
| `routes/redirect.js`, `lib/attribution.js` | ✅ | ⚠️ later | Shore sells courses; clicks are meaningful, conversions are not wired. Ship the redirector, defer attribution |
| `flows/*` | ✅ | ❌ | Never ports |

### 9.2 The mechanism: `lib/core/` plus a one-directional sync

Concretely, and small enough to do in an afternoon:

**1. A `lib/core/` directory with an enforced import rule.** Files in `lib/core/` may import from `lib/core/`, from Node builtins, and from exactly three project modules: `../../db`, `../../telnyx`, `../../core.config`. Nothing else. Enforced by a test (§10), not by convention:

```
lib/core/gsm.js
lib/core/phone.js
lib/core/compliance-lint.js
lib/core/suppression.js
lib/core/outbound.js
lib/core/events.js
lib/core/segments.js          (with the facts-provider seam)
lib/core/ai/*
lib/core/prompts/*.md
```

Existing `lib/*.js` files stay where they are. Only new shared code goes in `lib/core/`, plus `lib/compliance.js` when it is unified. No mass move.

**2. `core.config.js` at the repo root** — the single file that differs between deployments:

```js
module.exports = {
  brandKey:      process.env.BRAND_KEY,          // 'vici' | 'shore'
  tables:        { contacts:'sms_contacts', messages:'sms_messages', … },
  features:      { flows:true, commerce:true, campaigns:true,
                   scheduledSends:true, replenishment:true, attribution:true },
  factsProvider: require('./lib/facts-vici')     // or ./lib/facts-shore
};
```

`factsProvider` is the seam that makes segmentation portable: it exposes `contactFacts(phone)` and `segmentFields()`. Vici's reads `sms_orders`; Shore's returns the message- and consent-derived subset. `lib/core/segments.js` never names a commerce table.

**3. `scripts/sync-core.sh`** — 20 lines:

```
rsync -a --delete lib/core/ ../shore-academy-inbox/lib/core/
cd ../shore-academy-inbox && npm test
```

One-directional, Vici → Shore. It is a copy, and I am not going to pretend otherwise. But it is a *disciplined, mechanical, tested* copy of a directory with no cross-imports, which is materially different from the current situation where 21 files have diverged by hand.

**4. A CI check that the copy has not drifted.** `test/core-parity.test.js` in Shore hashes every file in `lib/core/` and compares against a committed manifest. If someone edits Shore's copy directly, the test fails and names the file. That is the guard that keeps this from becoming fork number three.

**5. The upgrade path, when it earns it.** `lib/core/` has no imports outside itself and `core.config.js`. Turning it into a private npm package or a git submodule is then a `package.json` change and a `require` path change — no restructuring, because the restructuring already happened. And if multi-tenancy is chosen instead, `brand_profiles` (§4.6) and `core.config.js` are already the per-tenant boundary.

**Total cost now:** one directory convention, one config file, one shell script, one parity test. Perhaps a day. **Cost of not doing it:** every module in §8 gets written twice, and the 21-file divergence becomes a 35-file divergence.

### 9.3 Two convergence wins to take immediately

- **Vici adopts Shore's `lib/compliance.js`** and the `sms_optouts` / `sms_suppressions` table, retiring the sentinel-row hack. This is Phase 0 work P2-02 already scheduled, and doing it by porting Shore's file rather than writing a new one means the two repos converge instead of diverging further.
- **Shore adopts Vici's `lib/gsm.js`** the day it exists. Shore sends SMS too, and a curly apostrophe costs Shore exactly as much as it costs Vici.

---

## 10. Testability

`package.json:8` is `node --test test/*.test.js` and `test/` has five files, all of which test pure functions in `lib/` (`message-status`, `call-status`, `client-platform`, `unread-count`, `voice-credentials`). That is a working foundation, and the pattern it establishes — pure logic in `lib/`, tested with `node:test` and no framework — is exactly the pattern the new modules should follow. There is no test runner to choose and no infrastructure to build.

**There is no CI running these tests.** `.github/workflows/` contains only `ios-build.yml` and `ios-testflight.yml`. That is the cheapest gap to close in this entire document.

### 10.1 The minimum worthwhile set, ranked by value per line

**1. `test/no-direct-send.test.js` — 15 lines. Do this first.**

```js
// Walk every .js file except lib/outbound.js and node_modules.
// Assert none of them contain require('../telnyx') or require('./telnyx').
```

This is the highest-value test in the plan. The choke point in §3 is a *structural* property, and structural properties decay the moment someone in a hurry adds a seventh call site. This test makes that impossible for as long as it runs, and it costs nothing to maintain because it has no fixtures.

Add a sibling: `test/core-imports.test.js`, asserting nothing in `lib/core/` imports outside the three allowed paths (§9.2).

**2. `test/outbound.test.js` — the suppression matrix.** The single most important behavioural test. Inject a fake supabase whose `rpc('evaluate_send_gate')` returns a scripted disposition, and a fake `sendSMS` that records calls. Assert:

- `sendGuarded` never calls `sendSMS` when the disposition is `block` — for every channel, table-driven over §3.3's grid.
- `deferred` returns `deferUntil` and does not send.
- `channel:'conversational'` is not blocked by quiet hours; `channel:'marketing'` is deferred by them.
- `channel:'transactional'` does not consume the frequency budget.
- `renderBody` with an unresolved placeholder blocks, and the block reason names the placeholder.
- A Telnyx `40300` writes a suppression row; a `429` returns `deferred`, not `failed`.

Making this testable is the reason `sendGuarded` takes `now` and gets its supabase and telnyx handles by module import that a test can stub — design for the test rather than reaching for a mocking framework.

**3. `test/gsm.test.js` — table-driven, ~30 cases, no I/O.** Every row of doc 01 §4.5's worked table is a test case with a known answer: plain 160 chars → GSM-7, 1 segment; the same plus one 😀 → UCS-2, 162 units, 3 segments; one curly apostrophe swapped in → UCS-2, 3 segments; `👍🏽` → 4 UTF-16 units; the family emoji → 8. Plus the 160/161 discontinuity and every extension-table character counting double. Free to write, catches the exact bug that costs real money.

**4. `test/compliance-lint.test.js`.** Fixtures for each hard block in doc 03 §8.5, each with a positive and a leetspeak/homoglyph evasion case (the normaliser is the part that silently fails). Plus the nine hard gates from doc 01 §5.1 against Draft A and Draft B from §5.3 — the research already provides the expected outputs, including "Draft A scores 0 for four independent reasons".

**5. `test/segments.test.js` — SQL compilation only.** Assert that `compile()` produces parameterised SQL, that an unknown field name throws rather than interpolating, and that a value containing `'; DROP` lands in the params array and never in the SQL string.

### 10.2 What is explicitly not worth testing yet

- End-to-end campaign sends against a live Supabase. High maintenance, slow, and the claim RPC's correctness is a Postgres property better verified once by hand with two concurrent `psql` sessions than by a flaky integration suite.
- The redirector's latency. Measure it in production with a timing log; a synthetic benchmark of an in-process `Map` lookup proves nothing.
- Anything in `public/app.jsx`. There is no bundler and no test setup; adding one is a frontend restructure, which is a separate decision.

### 10.3 CI

`.github/workflows/test.yml`, ten lines: on push and PR, Node 20, `npm ci`, `npm test`. No secrets, no database — every test above is pure or uses injected fakes. This is the difference between a structural guarantee and a comment expressing hope.

---

## 11. Risk register

Ranked by expected damage. The five live `flows/` and the voice/CallKit path are the things that must not break.

| # | Risk | Likelihood | Impact | Mitigation |
|---:|---|---|---|---|
| **R1** | **A change to `flows/utils.js` breaks one of the five live order flows.** `sendAndLog()` is called from six places across four flow files and is the only guarded send path in the product | Medium | **Severe** — the client judges the system on order confirmations | Signature and return type frozen (§3.4). Only `flows/utils.js` is edited; a `git diff --stat` showing any other `flows/` file means the change is wrong. `test/outbound.test.js` covers the transactional channel before the reroute ships. Deploy the reroute alone, with nothing else in the commit, and watch one real order through end to end before continuing |
| **R2** | **Quiet-hours enforcement silently stops a transactional message.** New behaviour on a live path (§3.5 step 5) | Medium | High | It is a **deferral, never a drop** — the row is rescheduled, not discarded. Ship it alone. Log every deferral at `info` with the computed local time and timezone source for the first week. Cap deferral at each flow's `max_lateness` (P2-02 §10.4) so nothing sits forever |
| **R3** | **Campaign sends starve or duplicate.** No natural unique key; two processes run during every Railway deploy | Medium | **Severe** — a duplicate marketing SMS is a compliance incident at $500–$1,500 statutory exposure | P2-02's five layers, all of them: unique indexes, the `claim_campaign_sends` RPC (**must** be a Postgres function — `supabase-js` cannot express `FOR UPDATE SKIP LOCKED`), the at-most-once state machine, `unknown` reconciliation, and the job lease. Verify the claim RPC by hand with two concurrent sessions before the first real send |
| **R4** | **The `/api/activity` rename breaks a deployed iOS build.** iOS ships through TestFlight and cannot be redeployed in lockstep | Low | High | The three-commit sequence in §2.3 with a deprecated alias and a `[DEPRECATED]` log line. Remove the alias only after a week of silence in the logs. Grep `ios/` before commit 1 |
| **R5** | **The redirector or `/collect` is mounted after the SPA catch-all** at `server.js:110`, so every click 200s with `index.html` and attribution is silently zero | Medium | High | Mount order is explicit in §1.2. Add a smoke assertion to `/checks`: mint a throwaway token and assert `GET /r/<token>` returns 302 (doc 05 §7.4 already requires this). It fails loudly at approval time instead of silently after the send |
| **R6** | **Approval and the audit trail have no actor.** Auth is `req.session.authenticated`, a boolean (`server.js:63-66`) | Certain | Medium, rising | Write `actor: null` into every event, approval and audit row from day one, with the columns present. Doc 06 is right that auth ships before the Activity Center; this design does not block on it, but every record it writes is shaped to accept a name later without a migration of history |
| **R7** | **Turning the AI back on changes copy in the five live flows.** They have been silently falling back to base templates; fixing `OPENROUTER_MODEL` re-enables generation in `flows/confirmed.js`, `flows/shipped.js`, `flows/hold.js` and `flows/failed.js` at once | **High** — this happens the moment the env var is fixed | Medium | Know that this is what the one-line fix does. Before flipping it, read the four generation prompts and run each through `lib/gsm.js` and `lib/compliance-lint.js`. Consider shipping the fix behind `AI_FLOWS_ENABLED=false` for a week so the wizard gets a working model while the flows stay on templates until their prompts have been reviewed |
| **R8** | **Segment builder SQL injection.** Operator-authored predicates compiled to SQL — the only injection surface this plan adds | Low | **Severe** — service-key access to the whole database | `compile()` whitelists field names from `vocabulary()` and parameterises every value. `test/segments.test.js` asserts it. No raw-SQL escape hatch in the API, ever |
| **R9** | **SSE floods the UI during a campaign send.** 390 per-recipient events dispatched into the React tree at `public/app.jsx:2412` | High if unthrottled | Medium | Throttled `campaign_progress` (§7.2 change 3). Per-recipient detail is pull-only |
| **R10** | **Stale metrics drive a send.** The nightly recompute fails and yesterday's values look fine | Medium | Medium — this is doc 02's named worst-case trust failure | P2-02 §10.1's 36-hour staleness guard, surfaced as `stale:true` on every preview and enforced as a refusal at `/approve`, not merely a banner |
| **R11** | **Voice / CallKit regression.** `routes/voice.js` and `routes/voice-webhook.js` share the app, the SSE bus and `sms_contacts` | Low | High — CallKit failures are user-visible and hard to debug remotely | Nothing in this plan touches `routes/voice*.js`, `lib/voice-credentials.js`, `lib/call-status.js`, `lib/missed-calls.js` or `lib/pending-calls.js`. The only shared surfaces are the SSE topic field (defaulting to all topics, so existing clients are unaffected) and the FL/OK/OR cap, which counts outbound `call_logs` **read-only**. Keep `test/call-status.test.js` and `test/voice-credentials.test.js` green in CI |
| **R12** | **A forgotten migration.** Two are already outstanding (`ios_push_devices`, `add-optout-column`) because migrations are pasted by hand | **High** — the historical base rate is 2 for 2 on non-urgent migrations | Medium | Add a `schema_migrations` table and a boot check that logs a loud `[SCHEMA] MISSING: <name>` for any unapplied file in `scripts/`. The `db.js:34-43` PGRST204 fallback shows the codebase already anticipates this failure; make it visible at boot rather than at first write |
| **R13** | **Telnyx refuses Vici's traffic.** Its forbidden-use list bans "substances not legally approved for sale" (doc 03 §2.2) | Unknown | **Existential for the campaign feature** | Not an engineering risk and not mitigable in code. P2-02 §13 item 5 lists it as blocking. Ask Telnyx in writing before Phase 2. Everything in §1–§8 except the campaign *sender* remains useful regardless |
| **R14** | **Cost overrun on AI.** An interactive endpoint calling a paid API | Low | Low | Three-call hard cap as a code constant, `aiLimiter` at 30/min, `ai_calls` logging, `AI_DAILY_CAP_CENTS` |

---

## 12. What here is genuinely large, and what is not

The brief asked for the smallest change that works and for large proposals to be flagged. Being explicit:

**Small — a day or less each, low risk, valuable standalone:**
`lib/gsm.js` and its tests. `test/no-direct-send.test.js`. The CI workflow. The `OPENROUTER_MODEL` one-liner and `verifyModels()`. The `/api/activity` rename. Wrapping the three existing timers in `withLease`. The `lib/core/` convention and sync script. Adding event IDs and the actor field to SSE.

**Medium — a few days each, contained:**
`lib/outbound.js` and the seven-call-site reroute. `routes/segments.js` plus `lib/segments.js`. The redirector and `/collect`. `routes/consent.js` and the suppression migration. The AI service layer and prompt store.

**Genuinely large, flagged as such:**

1. **The campaign engine end to end** — `sms_campaigns`, `sms_campaign_recipients`, `evaluate_send_gate()`, `claim_campaign_sends()`, the worker, the reaper, the state machine. P2-02 §11 Phase 2 estimates four days and that is optimistic given the correctness bar. This is the largest single item and it is unavoidable if campaigns ship at all.
2. **Attribution** — clicks, sessions, the grade cascade, refund reconciliation, the three-tier rollup. It is greenfield in every direction and its value is capped by doc 05's finding that per-campaign measurement is impossible at n=847. **Consider shipping only clicks and Grade A in v1** and deferring grades B–D until there is something worth grading.
3. **`public/app.jsx` is 3,269 lines in one file.** A campaign builder, segment previewer, test-suite panel and activity feed do not fit in it. This document is scoped to the backend and deliberately does not solve it, but every route in §1 has a frontend counterpart and that work is real. A frontend restructure is implied by Phase 2 whether or not it is planned for.
4. **Multi-user auth** is a prerequisite for the Activity Center and for a defensible approval record, and it touches web plus two native iOS apps. Nothing in this document blocks on it, and everything in this document is shaped to accept it — but R6 stays open until it lands.

### Reconciliations for whoever builds this

Two naming conflicts between the source documents, resolved here so they are not discovered in code review:

- **`sms_campaign_recipients` columns.** Doc 05 §4.5 uses `contact_phone`, `arm`, `send_status`; P2-02 §6 uses `phone`, `state`, `flow_type`, `planned_send_at`, `claimed_by`. **Follow P2-02** — it owns the table and its worker. Add doc 05's attribution columns (`arm`, `variant_id`, `link_token`, `coupon_code`, `pre_period_revenue_cents`, `pre_period_orders`) onto P2-02's shape.
- **Campaign lifecycle.** Doc 05 uses `status` with `draft/testing/scheduled/sending/sent/cancelled`; P2-02 uses `state` with `draft/approved/active/paused/cancelled`. **Follow P2-02's `state`**, adding `complete` as the terminal success value. The route inventory in §1.3 already assumes this.
