# Phase 2 — Master Implementation Plan

**Written:** 12 August 2026
**Status:** Plan. Nothing built yet. Awaiting approval to execute.
**Inputs:** 6 design documents (~81,000 words) grounded in the live codebase and the live database.

This is the sequencing document. Each phase names the design doc that specifies it in detail.

| Doc | Scope |
|---|---|
| `P2-01-data-model.md` | 17 new tables, 7 migration files, consent ledger, attribution chain |
| `P2-02-segmentation-engine.md` | Segment computation, multi-segment resolution, frequency caps, idempotency |
| `P2-03-backend-integration.md` | ~55 endpoints across 7 modules, the send choke point, AI layer, redirector |
| `P2-04-frontend-plan.md` | esbuild migration, builder wireframes, preview, honest dashboard |
| `P2-05-auth-and-activity.md` | Local auth in 6 stages, activity feed, collision detection |
| `P2-06-safety-and-testing.md` | Test gate, progressive rollout, kill switch, 24 pre-flight checks |

---

## The blocking question — resolve before Phase 4

**After an honest consent backfill, zero of the 847 contacts are marketing-eligible.**

There is no consent record in the system. Contacts arrived via order webhooks and GHL sync, which establishes a transactional relationship, not marketing permission. Transactional messaging is unaffected and continues. But the campaign engine has nobody it can lawfully send to.

This is a business and legal question, not an engineering one. Options: a re-permission campaign to the existing list, consent capture at checkout going forward, or evidence that documented opt-in exists outside this database.

**Everything through Phase 3 is worth doing regardless of the answer.** Phase 4 onward assumes it is resolved. Ask Vici and their counsel now, in parallel with the build.

Second open question, also for the client: Telnyx's written position on Vici's traffic (see `../ai-wizard/03-compliance-and-high-risk.md`).

---

## Phase 0 — Fix what is already broken

**~5 days. No new features. Valuable even if the rest is cancelled.**

Every item is a live defect found while planning, not a hypothetical.

| # | Fix | Where | Why now |
|---|---|---|---|
| 0.1 | `lib/outbound.js sendGuarded()` in front of `sendSMS()` | `telnyx.js:5`, 9 call sites | One choke point covers flows, manual, scripts, campaigns |
| 0.2 | `isOptedOut()` and `alreadySent()` fail **open** | `flows/utils.js:39-41`, `:62-71` | A Supabase blip today means texting someone who said STOP |
| 0.3 | Three scripts send with no opt-out check | `full-sync.js:74`, `backfill-missing.js:169`, `send-processing-sms.js:74` | Unguarded senders |
| 0.4 | Unguarded bulk sender, one endpoint **public** | `routes/catchup.js:95,149`, `routes/webhook-send.js:59` | This is the accident we are building to prevent |
| 0.5 | `OPENROUTER_MODEL` points at a **retired** model | 6 hardcoded copies; no `response.ok` check anywhere | AI is silently dead in all five live flows |
| 0.6 | `AI_FLOWS_ENABLED=false` gate | new | **0.5 alone would re-enable unreviewed AI copy to real customers** |
| 0.7 | `charCount` ignores GSM-7/UCS-2 and concatenation | `public/app.jsx:77-81` | Reports 1 segment for a message that costs 3. Ships in both clients today |
| 0.8 | Stale-reply guard | `routes/send.js`, ~30 lines | Stops you and Dominic double-replying. No identity needed |
| 0.9 | `job_leases` + claim-then-send RPC | new | Railway's overlapping deploys mean two processes run today |
| 0.10 | `test/no-direct-send.test.js` + minimal CI | new, 15 lines + 10-line workflow | Structurally enforces the choke point. No CI exists today |

**0.5 and 0.6 ship together or not at all.** Fixing the model on its own switches AI copy generation back on across five live flows using prompts nobody has read in months.

Also here, free: Vici adopts Shore's better `lib/compliance.js`; Shore adopts Vici's encoding module.

**Deliverable:** the existing system stops being able to text people who opted out, and the cost meter stops lying.

---

## Phase 1 — Identity, server-side

**~5 days. Visible on day two.**

Per `P2-05`. Local password against `sms_users` using the existing 30-day cookie. **Supabase Auth is rejected** — without RLS it only adds hashing, reset email and token rotation, and the cookie already survives cold launch. This dissolves the mailer-cap and `supabase-swift` blockers rather than mitigating them. `auth_user_id` stays nullable as a one-afternoon reversal seam.

Stages 1–3 are server-only and touch no iOS code. They end with real names appearing against actions.

Then collision detection — ships **before** the activity feed, because at two users it prevents an actual failure while the feed only reports one.

---

## Phase 2 — iOS auth

**~3 days plus a two-week soak.**

Five files, ~40 lines, **no voice code touched.**

The Phase 1 research assumed a stale session could stop the phone ringing. It cannot: the cold-launch push path reads SIP credentials synchronously from the Keychain (`AppDelegate.swift:96-106` → `TelnyxVoiceManager.swift:475`), with no cookie and no network call.

The real risk is self-inflicted. Three hard rules:
1. No 401 handler may call `signOut()`.
2. `CredentialStore.clearAll()` (`SessionModel.swift:66`) is reachable only from an explicit user tap.
3. Same for `disablePushNotificationsAndWait()`.

Do **not** provision per-agent SIP credentials. Extra registrations change Telnyx call-forking, which drives the "Answered Elsewhere" handling. `answered_by_user_id` ships NULL; revisit at 4+ people on calls.

Cutover (stage 6) is gated on a device-activity query plus a two-week soak. **The lockout risk is ordering, not code.**

---

## Phase 3 — Schema and build tooling

**~4 days. Can run parallel with Phases 1–2.**

Per `P2-01`: 7 migration files, 17 new tables. Each SQL file records itself into `schema_migrations`, plus a loud startup check and `/api/health/migrations` — two migrations have already been forgotten, so tracking is part of the deliverable.

Rejected as premature at this scale: 11 proposed tables including the multi-tenant org structure, materialised segment membership, and a banned-words list.

`scripts/add-optout-column.sql` is **rejected, not applied** — a boolean on a table upserted from six code paths is one careless write from resurrecting a suppressed contact. Consent becomes three tables: an append-only hash-chained ledger, trigger-derived current state, and operational suppressions. Absence of a grant is a **block**, not a pass.

Frontend: swap Babel for **esbuild**. It replaces rather than joins, so dependencies fall by two. `--jsx=transform` is mandatory (the automatic runtime breaks the CDN React global), and esbuild must sit in `dependencies` because Nixpacks sets `NODE_ENV=production`. No Vite, no router, no TypeScript.

---

## Phase 4 — Segments, read-only

**~5 days. Requires the consent question resolved.**

Per `P2-02`. Segment rules stored as a **JSON tree evaluated in Node** — never generated SQL. An LLM writing SQL against a service key is unacceptable, and JS evaluation guarantees preview and send agree.

Membership overlaps freely. Conflicts resolve at send time via a priority ladder (transactional 100 → back-in-stock 90 → replenishment 70 → promo 20), with losers **deferred and recorded**, never silently dropped. Deferral plus per-flow expiry ships at the same time, or low-priority messages starve forever.

`lifecycle_stage` stays single-valued — it is a routing key, not an audience.

**A viability gate sits here.** Measure whether Vici's 166 repeat buyers actually reorder on a predictable cycle. If the coefficient of variation is mostly ≥0.75, replenishment collapses as a concept and Phase 7 is rescoped. Do this before building the machinery that assumes it.

---

## Phase 5 — Click redirector

**~2 days. Must ship before Phase 6, not with the dashboard.**

Click data cannot be backfilled. Every day this is late is a day of attribution permanently lost.

`go.vicipeptides.com` as a Railway custom domain on the same Express app — one DNS record from the client, no new infrastructure. Responds 302 first, records after.

**Trap:** it must mount before the SPA catch-all at `server.js:110`, or the store's subdomain serves your inbox login page to their customers.

Conversions extend the existing HMAC-verified `/webhook/woocommerce` handler (~15 lines). Attribution ships Grade B (phone identity) first; Grade A needs a store-side snippet we do not control.

---

## Phase 6 — Campaign builder and the test gate

**~10 days. The bulk of the visible work.**

Per `P2-04` and `P2-06`. Six steps, AI as a panel inside Compose rather than a step of its own, phone preview as a persistent rail from step 2.

**The test gate, as you specified it:**
- Managed `sms_test_numbers`. Dominic's `+16317426316` is the only US number today — a UK number validates rendering but never touches A2P 10DLC, so it cannot satisfy the gate alone. **Budget a second US SIM (~$15/mo).**
- Gating signal is a human tapping "I received it and it looks right", not a delivery receipt, so a dead phone cannot deadlock you.
- A content hash over body, media, links, sender, merge fields and segment definition invalidates a prior test. Audience drift is checked separately (10% warn, 30% block).
- **No override. Any role, including owner.** Compliance costs 30 seconds and 1.5 cents.

Preview separates three questions: text rendering, lock-screen truncation (the real headline), and carrier behaviour — and states in the UI that only the third needs a real send.

Merge fields block unless a fallback is declared, with a junk-name detector: `Hi 3055551234,` is worse than `Hi,`.

---

## Phase 7 — Sending engine

**~7 days.**

Campaigns get their own queue and worker, **not** `sms_scheduled`. Decisive argument: `processScheduledQueue()` drains 50 rows per 5-minute tick, so one 390-recipient blast would delay order confirmations by 40 minutes.

`setInterval` survives to ~50k sends/day. No job queue needed.

24 ordered pre-flight checks. Rollout in tranches of **25 / 75 / 250 / rest** with 15–20 minute gates; abort on absolute counts at this n (3 hard failures or 2 opt-outs kills tranche 1). Health classification uses keyword matching, not the LLM — it fails open and the model has been dead.

Kill switch: a DB flag with a 10-second in-process TTL at the `sendSMS` egress, three scopes (`campaigns` / `automated` / `all`, defaulting to `automated` so you can still reply to angry customers). **Never use Telnyx `send_at`** — it puts messages beyond our reach. Bounded worst case ~10 extra messages.

Caps: 1,000 recipients/campaign, 1,200 campaign messages/day, $25/campaign, 1 msg/sec, 5 recipients on the test path.

Environment: a fail-closed non-production allowlist keyed on a positive-assertion `OUTBOUND_ENV`. A global dry-run flag was rejected because it fails open.

Phase ends with a full rehearsal including a deliberate mid-flight kill-switch press, verified against Telnyx logs.

---

## Phase 8 — Attribution dashboard

**~5 days.**

Three tiers: click-attributed, associated, incremental-or-not-yet-measurable. Plus the **measurability pre-flight** — "this is send 4 of ~27 before we can prove this works."

Four devices stop honesty reading as failure: descending-confidence layout with a real number at the top, tier 3 headlined by a progress bar rather than a blank, texture encoding, and a "what we know today / what we will know" split.

This is the product's main differentiating claim (see `../ai-wizard/04-competitive-landscape.md` — Klaviyo gates holdouts at 400,000 profiles; Attentive appears to have none).

---

## Phase 9 — Activity feed

**~4 days.**

Six event types at launch, grouped at write time. Feed and compliance audit log are separate tables with different retention and mutability. The audit log is append-only and is the artifact handed to a lawyer defending a TCPA claim.

Sixteen actor-less sites resolve honestly: 7 get real columns, 3 go to the audit log, 5 stay NULL forever with stated reasons, 1 is blocked externally. **Nothing is backfilled to a fake "Team" user** — NULL is the honest value.

---

## Totals

| Phase | Days | Gated on |
|---|---:|---|
| 0 — Fix what is broken | 5 | nothing |
| 1 — Identity (server) | 5 | nothing |
| 2 — iOS auth | 3 + soak | Phase 1 |
| 3 — Schema + esbuild | 4 | nothing (parallel) |
| 4 — Segments | 5 | **consent question** |
| 5 — Click redirector | 2 | Phase 3 |
| 6 — Builder + test gate | 10 | Phases 3, 4 |
| 7 — Sending engine | 7 | Phase 6 |
| 8 — Dashboard | 5 | Phase 5 running ≥2 weeks |
| 9 — Activity feed | 4 | Phase 1 |

**~50 working days for Vici**, with Phases 1–3 partly parallel. Shore trails by roughly a week per phase and takes only Phases 0–3 and 9 — it has no campaigns by client instruction.

Shore's SQL runs twice regardless (separate Supabase projects, separate repos with no common ancestor). But `routes/auth.js` is byte-identical, so new files are written with no repo-specific dependencies and porting is a copy. No monorepo migration.

---

## What I would do first, if the answer is "start Monday"

**Phase 0.** It is a week, it fixes live compliance defects, it fixes a cost bug shipping in both clients today, and it delivers the stale-reply guard — which is the thing you and Dominic would actually notice on day one.

None of it depends on the consent question, the Telnyx question, or approval of anything downstream.
</content>
