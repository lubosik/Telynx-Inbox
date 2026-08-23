# Current State — What We Actually Have Today

**Written:** 11 August 2026
**Purpose:** Ground truth for Phase 2 planning. Everything here was verified against the running code and the live Supabase database, not recalled from memory.
**Status:** Research only. Nothing in this document proposes a build.

---

## 1. The two products

| | **Vici** (`~/telynx-inbox`) | **Shore Academy** (`~/shore-academy-inbox`) |
|---|---|---|
| Client | Vici Peptides — US research-peptide e-commerce | Ocean-safety school — course sales |
| Repo | `Telynx-Inbox` (GitHub) | separate repo |
| Host | Railway (`web-production-2551e`) | Railway |
| Commerce | WooCommerce + ShipStation | none |
| CRM | GoHighLevel (2-way message sync) | GoHighLevel (contact import only) |
| Automations | 5 order-triggered flows | **none, by client instruction** |
| AI | conversation analyser (barely used) | none |
| iOS app | `com.vicipeptides.inbox` | separate bundle ID |
| Risk profile | **high-risk vertical** | low risk |

They are the same product forked, not one product with two tenants. This matters enormously for Phase 2 and is covered in §7.

---

## 2. Stack

**Backend** — Node 20, CommonJS, Express 5, `cookie-session`, Helmet, `express-rate-limit`. Single `server.js` (172 lines) wiring 21 route modules. No framework beyond Express, no ORM, no job queue, no test coverage worth the name (`test/` exists, `node --test`).

**Database** — Supabase Postgres, accessed exclusively through `@supabase/supabase-js` with the service key. No migration tooling: `scripts/*.sql` files are pasted into the Supabase SQL editor by hand. There is a `scripts/run-migration.js` using `pg`, but no `DATABASE_URL` is configured, so in practice migrations are manual.

**Real-time** — Server-Sent Events. `server.js` holds an in-process `Set` of SSE clients; `lib/broadcaster.js` is a 6-line indirection so route modules can broadcast without importing the server. **This is in-memory and single-process** — it will not survive horizontal scaling, and it drops every client on redeploy.

**Frontend (web)** — a single 3,269-line `public/app.jsx`, Babel-compiled to `public/app.js`. React via CDN, no bundler, no component files, no routing library. One file.

**iOS** — native SwiftUI, ~20 files, CallKit + PushKit for voice, APNs for messages. Built via GitHub Actions → TestFlight.

**Telephony** — Telnyx. SMS/MMS via Messaging API, voice via Call Control + WebRTC SDK.

**AI** — OpenRouter, one key, `OPENROUTER_MODEL` env var. Currently pointed at `anthropic/claude-3.5-haiku`, **which 404s in production** (known issue, see §8).

**Background work** — three `setInterval` timers inside the web process: scheduled-SMS queue every 5 min, ShipStation carrier-scan poll every 30 min, legacy delivery-review check every 6 hours. No queue, no locking, no idempotency guard beyond DB status columns. If two instances ever run, messages send twice.

---

## 3. Live data — verified 11 Aug 2026

| Table | Rows | Notes |
|---|---:|---|
| `sms_contacts` | **847** | the addressable list |
| `sms_messages` | 2,283 | inbound + outbound conversation history |
| `sms_orders` | **1,497** | order history with `items` jsonb, `total` numeric |
| `sms_sent_log` | 1,151 | automated flow sends |
| `sms_scheduled` | 602 | flow queue |
| `call_logs` | 115 | with duration + recordings |
| `sms_customer_profiles` | **1** | the AI analyser has effectively never run |
| `sms_campaign_suggestions` | **1** | same |
| `push_subscriptions` | 6 | browser VAPID **plus** iOS devices in compatibility mode |
| `ios_push_devices` | **does not exist** | see §8 |

**The most important number here is 1,497 orders against 847 contacts.** That is roughly 1.8 orders per contact and a genuine repeat-purchase history. It is enough to compute per-customer reorder intervals, product affinity, and AOV. The replenishment and win-back work that Phase 2 will propose has real data underneath it.

**The second most important number is 1.** Two AI tables, one row each. The "AI intelligence" feature that already exists is not in use. Whatever we build must not repeat whatever caused that.

---

## 4. Full schema (live, introspected via PostgREST)

<details>
<summary>Expand</summary>

**`sms_contacts`** — `id`, `phone`, `name`, `first_name`, `last_name`, `email`, `city`, `state`, `country`, `ghl_contact_id`, `woo_customer_id`, `total_messages`, `unread_count`, `first_seen`, `last_seen`, `notes`, `source`, `avatar_url`, `created_at`

**`sms_messages`** — `id`, `telnyx_message_id`, `contact_phone`, `direction`, `body`, `status`, `ghl_contact_id`, `ghl_conversation_id`, `ghl_message_id`, `ai_processed`, `media_urls` (jsonb), `reply_to_message_id`, `reactions` (jsonb), `created_at`

**`sms_orders`** — `id` (uuid), `contact_phone`, `woo_order_id`, `shipstation_order_id`, `status`, `items` (jsonb), `total` (numeric), `tracking_number`, `carrier`, `shipped_at`, `delivered_at`, `order_sms_sent`, `shipped_sms_sent`, `delivery_sms_sent`, `created_at`

**`sms_scheduled`** — `id`, `order_id`, `phone`, `flow_type`, `message_body`, `send_at`, `status`, `attempts`, `created_at`

**`sms_sent_log`** — `id`, `order_id`, `flow_type`, `phone`, `message_body`, `telnyx_message_id`, `sent_at`

**`call_logs`** — `id`, `call_control_id`, `call_leg_id`, `call_session_id`, `direction`, `contact_phone`, `from_number`, `to_number`, `status`, `duration_seconds`, `recording_id`, `recording_url_mp3`, `recording_url_wav`, `started_at`, `answered_at`, `ended_at`, `seen_at`

**`sms_customer_profiles`** — `id`, `contact_phone`, `ghl_contact_id`, `inferred_interests` (jsonb), `order_signals` (jsonb), `restock_interests` (jsonb), `campaign_recommendations` (jsonb), `sentiment`, `raw_summary`, `last_analysed`, `updated_at`

**`sms_campaign_suggestions`** — `id`, `contact_phone`, `suggestion_type`, `suggestion_text`, `suggested_message`, `status`, `created_at`

**`shipstation_tracking`** — order/shipment IDs, tracking, carrier, `shipment_status`, `voided`, sent flags, timestamps

**`push_subscriptions`** — `id`, `endpoint`, `subscription` (jsonb), `user_agent`, timestamps

**`session`** — `sid`, `sess`, `expire` (legacy, unused since the move to `cookie-session`)

</details>

### What the schema is missing for the wizard

There is **no** concept of:
- a campaign (as an object with a name, audience, schedule, status, approval state)
- a segment (as a saved, re-evaluable definition)
- a message variant or a test arm
- a click
- a conversion or any attribution link
- a user
- an opt-out record — `scripts/add-optout-column.sql` exists but the column is not in the live schema
- a consent record with timestamp, source, and IP (**required to defend a TCPA claim**)

Every one of those is net-new. The wizard is not an addition to an existing campaign system; there is no campaign system.

---

## 5. What works today

**Two-way messaging** — inbound Telnyx webhook → `sms_messages` → SSE broadcast → web + iOS. Outbound via `/api/send` with a 20/min rate limit. MMS, replies (`reply_to_message_id`), and tapback reactions all shipped.

**Voice** — full inbound and outbound calling. Telnyx Call Control webhooks drive `call_logs`; the iOS app registers a WebRTC credential and receives VoIP pushes through CallKit. Call recordings are stored. Missed-call badging with a `seen_at` read model was added most recently.

**Order-triggered flows** (Vici only, `flows/`, ~2,000 lines):
- `confirmed.js` (520) — order placed
- `shipped.js` (469) — carrier scan, not label creation
- `hold.js` (424) — payment-pending sequence
- `failed.js` (319) — failed-payment recovery sequence
- `utils.js` (309) — the scheduled-queue processor

These are hand-written, hard-coded message sequences. They are the closest thing to campaigns we have, and they are the proof that the transactional plumbing works.

**Integrations** — WooCommerce (orders, customers, HMAC-verified webhooks), ShipStation (tracking + polling), GoHighLevel (message and contact sync both directions on Vici; contact-import only on Shore), Telnyx, Web Push (VAPID), APNs.

---

## 6. Authentication — the blocking constraint

`routes/auth.js` is 22 lines:

```js
if (password === process.env.INBOX_PASSWORD) {
  req.session.authenticated = true;
}
```

That is the entire authentication system. There is **no user table, no user ID, no roles, no invite flow, no per-user session**. `server.js` guards routes with `requireAuth`, which only checks the boolean.

The consequences are concrete and they hit both requested features:

- **Activity Center is impossible as specified.** "Dominic just replied to X" cannot be rendered because the server has no way to distinguish Dominic's reply from Lubosi's. Every outbound message, every answered call, every cancelled queue item is currently actor-less. This is not a small gap to close: it is a prerequisite that must ship first, and it touches login on web *and* the two native iOS apps.
- **The wizard's approval workflow has nothing to attach to.** "Campaign approved by X at Y" requires an X.
- **Selling to teams of 5–10 requires it regardless.** A shared password is not a product you can sell to a client who wants to add and remove staff.

Migrating this without locking out the two live users mid-flight needs care. Agent 06 is researching the approach.

---

## 7. The fork problem

Of the files common to both repos, **21 differ**. The divergence is not cosmetic:

| File | Changed lines / total |
|---|---|
| `db.js` | 27 / 49 |
| `routes/webhook.js` | 36 / 248 |
| `routes/send.js` | 25 / 94 |
| `routes/conversations.js` | 21 / 86 |
| `routes/voice.js` | 15 / 229 |
| `lib/apns-notify.js` | 4 / 228 |
| `lib/tapbacks.js` | 0 / 97 |
| `lib/message-status.js` | 0 / 137 |

Shore has files Vici doesn't (`lib/compliance.js`, `lib/ghl-client.js`, `lib/ghl-contact-store.js`, `lib/startup-check.js`). Vici has files Shore doesn't (`flows/`, `intelligence.js`, `routes/activity.js`, `routes/sync.js`, `routes/catchup.js`, `routes/webhook-woocommerce.js`, `routes/webhook-shipstation.js`).

Notably, **Shore has a `lib/compliance.js` that Vici does not** — the low-risk client has the compliance module and the high-risk one doesn't. That is exactly backwards.

**This is the single largest architectural decision facing Phase 2.** The AI wizard is a large feature. Building it twice is not viable, and building it once in Vici means Shore never gets it. Three options, and Phase 2 must pick one explicitly:

1. **Extract a shared core package** before building the wizard. Highest up-front cost, only sane path if we are genuinely selling this to more clients.
2. **Build in Vici, port later.** Fastest to a demo, guarantees a third divergent copy.
3. **Multi-tenant single deployment.** The real product answer, the largest rewrite, and it forces the auth work anyway.

The user's stated ambition — "let's offer it to companies", "roll this out to teams of five to ten" — points hard at (1) or (3). Two forks is already painful at two clients; it is untenable at five.

---

## 8. Known defects and debts

- **`ios_push_devices` does not exist in the live database.** `scripts/ios-push-devices-migration.sql` was never run. The code handles this deliberately: `routes/mobile-push.js:60-70` falls back to writing APNs tokens into `push_subscriptions` as "compatibility storage". So iOS push works, but every device is in the fallback path and the intended table is a dead reference in four files.
- **`OPENROUTER_MODEL` 404s in production.** The configured `anthropic/claude-3.5-haiku` is not resolving. Both AI code paths log the error and return `null`, which is very likely why `sms_customer_profiles` has one row.
- **No opt-out enforcement in Vici.** `scripts/add-optout-column.sql` was written but not applied. There is no STOP handling and no consent record. For a high-risk vertical this is the most serious item on this list.
- **SSE state is in-process.** Single instance only. A redeploy disconnects every client.
- **Background jobs run in the web process.** No locking. A second instance double-sends.
- **`public/app.jsx` is 3,269 lines in one file.** Adding a campaign builder, segment previewer, test suite, and activity feed to that file is not realistic. A frontend restructure is implied by Phase 2 whether we plan for it or not.
- **`routes/activity.js` is a naming collision.** It is the automation queue, not the team feed. One of them has to be renamed before both exist.
- **No CI, no meaningful tests.** Every deploy is a manual verification.
- **Migrations are copy-paste.** At least two have been forgotten (`ios_push_devices`, `add-optout-column`). This will keep happening.

---

## 9. What this means for Phase 2

Ordered by how much they constrain the plan:

1. **Multi-user auth ships before the Activity Center.** Not negotiable — the feature is unbuildable without it. It is also a prerequisite for wizard approvals and for selling to teams.
2. **Decide the fork question before writing wizard code.** Every week we defer this doubles the port cost.
3. **Compliance is a feature, not a checkbox** — and Vici, the high-risk client, currently has less of it than Shore. Opt-out, consent records, and quiet hours are gating for anything that sends at volume.
4. **The data for good campaigns already exists.** 1,497 orders with line items and totals is a real asset. Replenishment timing, product affinity, and RFM are all computable today.
5. **Attribution is greenfield.** There is no click tracking, no conversion link, no campaign object. "See how much money it makes" is the headline promise and none of the plumbing exists.
6. **847 contacts is a small list.** It is plenty for flows, and it is too small for statistically honest A/B tests and holdouts on one-off campaigns. Phase 2 must be truthful about this rather than shipping a dashboard that shows confident fake numbers.
7. **The existing AI feature failed quietly.** One row in two tables. Before building a bigger AI feature, understand why the small one went unused — likely a mix of the model 404 and the fact that suggestions had nowhere to go.

---

## 10. Companion documents

| File | Scope |
|---|---|
| `01-sms-copywriting-craft.md` | Direct-response copywriting principles applied to SMS; scoring rubric; system prompt |
| `02-campaign-flows-and-segmentation.md` | Flow taxonomy, replenishment maths, segmentation, fatigue, revenue projection |
| `03-compliance-and-high-risk.md` | A2P 10DLC, TCPA, carrier policy, whether peptides can legitimately run US SMS |
| `04-competitive-landscape.md` | Attentive, Postscript, Klaviyo et al; where our edge is real and where it isn't |
| `05-attribution-and-testing.md` | Attribution models, holdout maths at our list size, test-suite spec, data model |
| `06-activity-center.md` | Auth prerequisite, prior art, event taxonomy, audit log vs feed |
| `07-source-doc-digest.md` | Digest of the client-supplied SMS Marketing transcript |
</content>
