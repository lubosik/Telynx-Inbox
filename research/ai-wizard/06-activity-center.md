# 06 — Activity Center

**Written:** 11 August 2026
**Scope:** Design research for a team activity feed ("who on the team did what, when") across the shared SMS + voice inbox.
**Status:** Research only. No code was written. Nothing here is approved for build.
**Companion:** `00-current-state.md` is the ground-truth audit of the product. This document goes deeper on the auth and eventing layers specifically.

---

## 0. The one-paragraph version

The Activity Center as described — *"Dominic just replied to X 10 minutes ago"*, *"Dominic just answered the phone"*, *"we just missed this call"* — **cannot be built at all today, and the blocker is not the feed.** The blocker is that this application has no concept of a user. Two of those three example sentences require knowing which human did something, and the server has never recorded that, anywhere, for any action, since the project started. Closing that gap is a multi-week programme that touches the login screen, the session model, the Postgres schema, the push-notification fan-out, the SIP credential handed to each phone, and a native iOS app that must be re-released through TestFlight. The feed itself is the small part — roughly a week once identity exists. **The honest framing is: this is an authentication project with an activity feed on the end of it.** Section 2 and Section 10 are the ones to read if you read nothing else.

---

## 1. Current-state audit

Everything in this section was read out of the working tree at `/Users/ghost/telynx-inbox` on 11 August 2026. File and line references are exact.

### 1.1 Authentication: a single shared password

`/Users/ghost/telynx-inbox/routes/auth.js` is 22 lines and is the entire authentication system.

```js
// routes/auth.js:3-11
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.INBOX_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});
```

- `routes/auth.js:6` — the session payload is the single boolean `authenticated`. There is no subject, no user id, no email, no role.
- `routes/auth.js:18-20` — `GET /auth/check` returns `{ authenticated: boolean }` and nothing else. A client cannot ask "who am I?" because the server does not know.
- `/Users/ghost/telynx-inbox/server.js:54-61` — `cookie-session` middleware. Cookie `vici_sess`, `httpOnly`, `sameSite: 'strict'`, `maxAge` 30 days. **The signing secret falls back to the string literal `'fallback-secret-change-this'` if `SESSION_SECRET` is unset** (`server.js:56`). That is a live forgery risk independent of this feature and should be fixed regardless.
- `/Users/ghost/telynx-inbox/server.js:63-66` — `requireAuth` is `if (req.session?.authenticated) return next();`. It is the only authorisation primitive in the codebase.
- `/Users/ghost/telynx-inbox/routes/admin.js:20-30` — `requireAdmin` accepts `Authorization: Bearer <INBOX_PASSWORD>`. **It is the same secret as the user login**, so every person who can log in also holds the admin bearer token for endpoints that bulk-send real SMS to real customers. And `routes/admin.js:22` returns `next()` unconditionally when `INBOX_PASSWORD` is unset, i.e. no password configured means no auth at all.

There is no `users` table, no `sessions` table, no roles table, no invite mechanism, and no password hashing anywhere in the repo.

### 1.2 How the iOS app authenticates (this is the hard part of the migration)

- `/Users/ghost/telynx-inbox/ios/ViciInbox/Core/CredentialStore.swift:13-17` — the shared inbox password is written to the iOS Keychain under key `inbox_password`, service `com.vicipeptides.inbox`.
- `CredentialStore.swift:30-33` — stored with `kSecAttrAccessibleAfterFirstUnlock`, deliberately, so a VoIP push can wake the app on a locked phone and reconnect without a human present.
- `/Users/ghost/telynx-inbox/ios/ViciInbox/Core/APIClient.swift:37-42` — the app relies on `URLSession`'s shared `HTTPCookieStorage`; the `vici_sess` cookie is the session, exactly as in the browser.
- `APIClient.swift:48-56` — `login(password:)` posts to `/auth/login` and, on success, persists the password to the Keychain.
- `APIClient.swift:68-73` — `restoreSessionIfNeeded()` **re-authenticates on cold launch by replaying the stored password**. This is the critical detail: the app does not hold a token, it holds a credential, and it re-submits that credential automatically. A CallKit cold launch from a VoIP push depends on this path completing before the call can be answered.

The consequence: any change to the auth scheme requires a coordinated iOS release. There is no server-side switch that can fix a shipped binary.

### 1.3 Real-time transport: SSE, in-process, fan-out-to-all

The transport is **Server-Sent Events**. There are no WebSockets anywhere (`grep` for `WebSocket|socket.io|ws://` across `routes/`, `lib/`, `public/app.jsx`, `server.js` returns nothing). Supabase Realtime is **not** used: `db.js:7` passes `realtime: { transport: ws }` to `createClient`, but no `.channel()` subscription exists in the codebase, so that config is inert.

- `/Users/ghost/telynx-inbox/server.js:15-21` — `const sseClients = new Set()` plus `broadcastSSE(event)`, which serialises to `data: ${JSON.stringify(event)}\n\n` and writes to **every** connected client. Failed writes silently drop the client from the Set.
- `/Users/ghost/telynx-inbox/server.js:22` — `require('./lib/broadcaster').setBroadcast(broadcastSSE)`.
- `/Users/ghost/telynx-inbox/lib/broadcaster.js` — a six-line module-scoped singleton (`setBroadcast` / `broadcast`) that exists purely so route modules can broadcast without a circular import of `server.js`.
- `/Users/ghost/telynx-inbox/routes/sse.js:4-23` — `GET /api/sse`. Sets `text/event-stream`, `no-cache`, `X-Accel-Buffering: no`, flushes headers, adds `res` to the Set, writes `{"type":"connected"}`, then a `:ping` comment **every 15 seconds because Railway drops idle connections at 30s** (`routes/sse.js:14-17`). Cleans up on `req.on('close')`.

Four properties of this transport matter enormously for the Activity Center:

1. **No addressing.** `broadcastSSE` goes to every socket. There is no way to send an event to one user, or to everyone *except* the person who caused it. Suppressing self-authored events is a baseline requirement of every activity feed in Section 3, and it is currently impossible.
2. **No event IDs and no replay.** SSE has a built-in `id:` field and a `Last-Event-ID` request header for resumption. Neither is used. `routes/sse.js:12` writes a bare `data:` line. A client that reconnects after a tunnel drop or a Railway redeploy has a permanent hole in its stream and no way to detect it.
3. **In-process state.** `sseClients` is a `Set` in one Node process. The moment there is a second instance, half the clients miss half the events. Every redeploy disconnects everyone.
4. **iOS does not consume it.** There is no `EventSource` or SSE client in `ios/`. The native app is driven by APNs pushes (`lib/apns-notify.js`) plus request-time fetches. So "real-time" today means one thing on web and a different thing on iPhone.

### 1.4 The events that already flow through the broadcaster

Thirteen distinct `type` values are broadcast today. This is the existing, de facto event taxonomy, and Section 5 builds on it rather than replacing it.

| `type` | Emitted from | Payload fields |
|---|---|---|
| `new_message` | `routes/send.js:76`, `routes/webhook.js:209`, `routes/webhook-send.js:81`, `routes/webhook-ghl.js:116`, `routes/webhook-ghl.js:161`, `routes/intelligence.js:56` | `phone`, `body`, `direction`, `id`, `telnyx_message_id`, `media_urls`, `reply_to_message_id` |
| `status_update` | `routes/webhook.js:48` | `messageId`, `status`, `phone` |
| `reaction_update` | `routes/react.js:80`, `routes/webhook.js:128` | `phone`, `message_id`, `reactions` |
| `opt_out` | `routes/webhook.js:87` | `phone` |
| `contact_added` | `routes/webhook-ghl.js:46`, `routes/webhook-ghl.js:64`, `routes/webhook-woocommerce.js:118` | `phone`, `name` |
| `contact_updated` | `routes/webhook-woocommerce.js:143` | `phone`, `updates` |
| `order_status_updated` | `routes/webhook-woocommerce.js:175`, `routes/admin.js:115`, `flows/shipped.js:379`, `flows/confirmed.js:512`, `sync-woocommerce.js:215` | `phone`, `status`, `order_id` |
| `call_update` | `routes/voice-webhook.js:175` (`event: 'initiated'`), `:227` (`event: 'answered'`), `:252` (`event: 'hangup'`) | `event`, `call_control_id`, `direction`, `contact_phone`, `status`, `duration` |
| `call_recording_saved` | `routes/voice-webhook.js:267` | `call_control_id` |
| `queue_added` | `flows/utils.js:176` | `id`, `order_id`, `flow_type`, `send_at`, `phone` |
| `queue_cancelled` | `flows/utils.js:247`, `routes/activity.js:113` | `id`, `order_id`, `flow_type`, `phone` |
| `message_sent` | `flows/utils.js:267` | `id`, `order_id`, `flow_type`, `phone`, `sent_at` |
| `stats_update` | `flows/utils.js:268` | *(none — a "refetch" nudge)* |

**Not one of these thirteen carries an actor.** Every payload identifies the *contact* the action was about; none identifies the *human* who did it.

### 1.5 The naming collision

`/Users/ghost/telynx-inbox/routes/activity.js` already exists and is mounted at `/api/activity` (`server.js:99`). It is **the automation queue**, not a team feed:

- `GET /api/activity/stats` (`activity.js:7`) — counts of pending / sent today / failed today / cancelled today from `sms_scheduled` and `sms_sent_log`.
- `GET /api/activity/queue` (`activity.js:36`) — pending scheduled flow messages.
- `GET /api/activity/recent` (`activity.js:63`) — recently sent flow messages.
- `DELETE /api/activity/queue/:id` (`activity.js:89`) — cancel a pending automation.

This route also exists only in the Vici fork, not Shore (`00-current-state.md` §7). Before a team feed can be called "activity", one of the two has to be renamed. **Recommendation: rename the existing one.** It is internally called the queue everywhere in the UI and its log prefix is already `[ACTIVITY]` only by accident. Move it to `/api/automations` (`stats`, `queue`, `recent`, `DELETE queue/:id`) and reserve `/api/activity` for the team feed. Do the rename as a standalone commit with the old paths kept as 301-style aliases for one release, because `public/app.js` is a compiled artefact and a missed call site will not fail at build time.

### 1.6 Every place an action happens without an attributable actor

This is the complete list. It is the work item.

| # | Action | Location | What is lost |
|---|---|---|---|
| 1 | **Outbound SMS/MMS sent** | `routes/send.js:10-91` | The headline use case. `sms_messages` rows are inserted at `send.js:39-48` with `direction: 'outbound'` and **no sender column**. "Dominic replied to X" is unrenderable. |
| 2 | **Reaction / tapback sent** | `routes/react.js:31` | No actor. |
| 3 | **Conversation read** | `routes/conversations.js:76-78` | `GET /api/conversations/:phone` silently sets `unread_count = 0`. Somebody read the thread and the server threw that away. This is also *the* signal a collision-avoidance feature needs. |
| 4 | **Automation cancelled** | `routes/activity.js:89-125` | A human intervened to stop a scheduled customer message and there is no record of who. The log line at `activity.js:110` prints flow, order and phone but no user. |
| 5 | **Missed-call badge cleared** | `routes/voice.js:80-86` → `lib/missed-calls.js:69-87` | `markMissedCallsSeen()` clears the badge **for everyone**, globally, with no actor. The comment at `lib/missed-calls.js:10-13` is explicit that "seen" is shared rather than per-device, "matching how `sms_contacts.unread_count` already behaves". |
| 6 | **Call answered** | `routes/voice-webhook.js:217-228`; table in `scripts/voice-migration.sql` | `call_logs` records `answered_at` but has no `answered_by`. "Dominic just answered the phone" is unrenderable. |
| 7 | **Call outcome reported by the phone** | `routes/voice.js:99-165` | The body carries `source: 'ios'`. That is a *platform*, not a person. It is the closest thing to an actor in the codebase and it is not one. |
| 8 | **SIP identity is shared** | `routes/voice.js:11-32`, `lib/voice-credentials.js:10-20` | `GET /api/voice/token` returns **one** login/password pair to **every** iOS device. Telephony-layer attribution is therefore impossible even in principle until per-agent SIP credentials exist. This is the single most underestimated item in the whole programme. |
| 9 | **Contact created / edited** | `routes/contacts.js:92`, `routes/contacts.js:149` | No actor. |
| 10 | **Media uploaded** | `routes/upload.js:22` | No actor. |
| 11 | **Bulk catch-up send** | `routes/catchup.js:56` | Sends real SMS in bulk. No actor. |
| 12 | **CRM/commerce sync triggered** | `routes/sync.js:10, 24, 41, 61, 90` | No actor. |
| 13 | **AI campaign dismissed / sent** | `routes/intelligence.js:27`, `routes/intelligence.js:33` | The approval workflow the AI wizard needs has nothing to attach to. |
| 14 | **Admin backfills** | `routes/admin.js` (all routes) | Bulk-sends to historical customers, authenticated by the shared password. No actor. |
| 15 | **Push registration** | `routes/mobile-push.js:28`, `routes/push.js:12` | `ios_push_devices` has `installation_id` but no `user_id` (`scripts/ios-push-devices-migration.sql`). |
| 16 | **Push delivery** | `push-notify.js:12` `sendPushToAll`, `lib/apns-notify.js:128` `sendNativeMessagePush` | Both fan out to **every** registered device. There is no way to skip the person who caused the event. Per §1.3(1), the same limitation as SSE. |

Two further structural facts worth stating plainly:

- **Read state is global, not per-user.** `sms_contacts.unread_count` (`scripts/voice-migration.sql`) and `call_logs.seen_at` (`scripts/missed-calls-seen-migration.sql`) are both shared across all humans and all devices, by explicit design decision. A per-user activity feed with per-user read state contradicts that model and will need its own.
- **Migrations are applied by hand.** There is no runner in the deploy path; `scripts/*.sql` are pasted into the Supabase SQL editor. `db.js:25-43` contains an explicit `PGRST204` fallback that strips columns when a migration has not been applied yet, and `lib/missed-calls.js:22-33` has the same defence for error `42703`. Two migrations are already known to have been forgotten (`00-current-state.md` §8). Any new table this feature introduces will need the same defensive treatment or a real migration runner.

### 1.7 Verdict on current state

| Capability | Status |
|---|---|
| Know *that* something happened | ✅ Thirteen SSE event types, live |
| Know *which contact* it happened to | ✅ Every event carries `phone` or `call_control_id` |
| Know *when* it happened | ⚠️ Partially — some rows have timestamps, SSE events have none of their own |
| Know *who did it* | ❌ **Nowhere, for anything** |
| Address an event to one user | ❌ SSE and push are both broadcast-only |
| Replay missed events | ❌ No event IDs, no persistence, no cursor |
| Per-user read state | ❌ Read state is global by design |
| Durable record of who did what | ❌ No audit log of any kind |

---

## 2. The auth prerequisite

### 2.1 Be blunt: this is the project

The request is "show me what the team is doing". The team is currently one indistinguishable blob wearing one password. **Roughly 80% of the effort in delivering the Activity Center is delivering identity, and none of that 80% produces anything the user can see.** That is a bad shape for a project and it needs to be acknowledged before starting, not discovered in week three.

There is also a hard external constraint recorded in project memory: **this Mac cannot build the iOS app** (macOS 13 against an Xcode 26 requirement), and iOS releases go through GitHub Actions to TestFlight. Every auth change requires an iOS binary. That makes the iOS leg of this work slow to iterate and expensive to get wrong, and it is the reason Section 2.6's migration strategy is built around *never* requiring a simultaneous client/server cutover.

### 2.2 The options

**Option A — Supabase Auth.**
We already run Supabase. It provides `auth.users`, password and magic-link sign-in, refresh-token rotation, and an admin invite API.

- Default access-token (JWT) lifetime is **1 hour**, configurable; Supabase advises against exceeding 1 hour and against going below 5 minutes ([Supabase: User sessions](https://supabase.com/docs/guides/auth/sessions)).
- Refresh tokens "never expire but can only be used once", with a **10-second reuse interval** by default to tolerate races, which Supabase recommends leaving alone ([same](https://supabase.com/docs/guides/auth/sessions)).
- Time-boxed session limits and per-user session caps are **Pro plan and above** ([same](https://supabase.com/docs/guides/auth/sessions)).
- There is a maintained Swift SDK: `supabase-swift` requires **iOS 16+, Swift 6.1+, Xcode 16.4+** and ships Auth, PostgREST, Realtime, Storage and Functions modules ([supabase/supabase-swift](https://github.com/supabase/supabase-swift)). Session storage is pluggable via a `storage:` option; the default persistence mechanism is not stated on the README ([UNVERIFIED] whether the default is Keychain — must be checked before relying on it, because our VoIP cold-launch path needs `kSecAttrAccessibleAfterFirstUnlock` semantics specifically, and a `UserDefaults` default would be both wrong and insecure).
- RBAC has an official pattern: `app_role` / `app_permission` enums, `user_roles` and `role_permissions` tables, and a `custom_access_token_hook` PL/pgSQL function that injects the role into the JWT before issuance ([Supabase RBAC guide](https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac)).
- **The invite trap:** the built-in email sender is limited to **2 emails per hour** across the whole project, and "you can only change this with a custom SMTP setup" ([Supabase auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)). Inviting a client's five support agents in one sitting is impossible without wiring custom SMTP first. Other documented limits: token refresh 1,800/hour per IP, verification 360/hour per IP, 60-second windows between per-user signup-confirmation and password-reset requests.

**Option B — hand-rolled users table.**
A `users` table with argon2id hashes, plus server-side sessions. Full control, no new vendor, no new SDK on iOS (the existing cookie flow keeps working, only the credential changes). Costs: we own password reset, invite tokens, rate limiting, breach response, and MFA forever. For a two-person team this is genuinely tempting; for a product sold to client teams it is a slow-accruing liability.

**Option C — external IdP (Clerk / WorkOS / Auth0 / Stytch).**
Buys orgs, invites, roles and hosted UI. Costs a new vendor, a new SDK on iOS, and it makes the Postgres side awkward because our authorisation data would live in two places. [UNVERIFIED] — 2026 pricing for each of these at ~10 seats was not retrievable in this session (web search budget exhausted); if this option is seriously considered, price it before deciding. As a category, per-seat IdPs are poor value at 10 users and good value at 200.

### 2.3 Recommendation

**Take Option A: Supabase Auth for identity, with our own `users` / `organisations` / `memberships` tables layered on top, and keep every Postgres query going through the service key exactly as it does today.**

Rationale, in priority order:

1. **We already run Supabase.** No new vendor, no new bill, no new failure domain.
2. **Refresh-token rotation is the part you do not want to write yourself**, and it is the part the iOS app most needs, because the app must survive weeks of backgrounding and still answer a VoIP call at 3am.
3. **Password reset and invite email are solved** (subject to the SMTP caveat below).
4. **We do not have to adopt RLS.** This is the key architectural point. Supabase Auth can be used purely as an identity provider: the Express backend verifies the JWT, extracts `sub`, and continues to use the service-role key for all data access with authorisation enforced in Express middleware. That means **zero changes to the 21 existing route modules' data access** — they keep working exactly as written. Adopting RLS at the same time would triple the blast radius, and RLS is not required to ship this.
5. **We keep our own `users` table anyway**, keyed on `auth.users.id`, because the activity log needs a stable foreign key with a display name and an avatar, and because we may want to leave Supabase Auth one day without rewriting the log.

Two conditions attach to this recommendation:

- **Wire custom SMTP before the first invite is sent.** 2 emails/hour makes the built-in sender unusable for onboarding a client's staff ([rate limits](https://supabase.com/docs/guides/auth/rate-limits)).
- **Verify `supabase-swift`'s default session storage before committing the iOS leg.** If it is not Keychain with after-first-unlock accessibility, we keep our own `CredentialStore` and store the refresh token there instead, reusing the code already at `ios/ViciInbox/Core/CredentialStore.swift`.

### 2.4 JWT verification in Express

Verify locally, do not round-trip. Supabase now supports asymmetric signing keys, which lets the backend validate a token against a published JWKS without calling the auth server on every request. [UNVERIFIED] — the exact current migration path from the legacy shared HS256 secret to asymmetric keys was not retrievable this session; confirm against the Supabase signing-keys docs before implementation. The middleware shape either way:

```
requireAuth:
  1. Read bearer token from Authorization, else the session cookie (dual-auth window, §2.6)
  2. Verify signature + exp locally
  3. Load membership row for (sub, org) — cache for ~60s in-process
  4. Attach req.actor = { userId, orgId, role, displayName }
  5. 401 on failure
```

`req.actor` is the object the entire Activity Center depends on. Every one of the sixteen actor-less call sites in §1.6 becomes a one-line change once it exists.

### 2.5 Proposed schema

```sql
-- ─── Identity ────────────────────────────────────────────────────────────────

create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- 'vici', 'shore'
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         citext not null unique,
  display_name  text   not null,             -- 'Dominic' — what the feed renders
  avatar_url    text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create type public.app_role as enum ('owner', 'admin', 'agent');

create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id)         on delete cascade,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  role        public.app_role not null default 'agent',
  invited_by  uuid references public.users(id),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, org_id)
);
create index memberships_org_idx  on public.memberships (org_id);
create index memberships_user_idx on public.memberships (user_id);

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  email       citext not null,
  role        public.app_role not null default 'agent',
  token_hash  text   not null unique,        -- sha256 of the emailed token; never store the token
  invited_by  uuid   references public.users(id),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index invitations_org_pending_idx
  on public.invitations (org_id)
  where accepted_at is null and revoked_at is null;
```

**On a `sessions` table:** do not build one. Supabase Auth already manages sessions and refresh-token rotation server-side, and expired rows are cleaned up 24 hours after expiry ([Supabase: User sessions](https://supabase.com/docs/guides/auth/sessions)). A second session store would be a source of drift with no benefit. What we *do* need, and what a naive `sessions` table is usually a proxy for, is a **device registry** — because the push layer must become per-user:

```sql
create table public.user_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  platform        text not null check (platform in ('ios','web')),
  apns_token      text unique,               -- iOS
  push_endpoint   text unique,               -- web VAPID
  installation_id text,
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index user_devices_user_idx on public.user_devices (user_id) where revoked_at is null;
```

This table is what makes "notify everyone except the person who did it" possible, and it retires the compatibility hack noted in `00-current-state.md` §8 where APNs tokens are being written into `push_subscriptions`.

**Roles.** Three is right for this product; do not build a permission matrix yet.

| Role | Can |
|---|---|
| `owner` | Everything, including billing and deleting the org. One per org (Lubosi). |
| `admin` | Invite/remove agents, change settings, run backfills, approve campaigns. (Dominic.) |
| `agent` | Read and reply to conversations, make and take calls. **Cannot** run admin backfills or change settings. |

The immediate concrete win: `routes/admin.js`'s bulk-send backfills stop being reachable by anyone who knows the shared password.

### 2.6 Migration without locking out the two live users

The requirement is that at no point do Lubosi and Dominic lose access, and at no point is a server deploy coupled to an App Store release. The pattern is **dual-auth with a shadow window**.

**Stage 1 — Add, do not switch (server only, no client change).**
Ship the tables. Ship `POST /auth/login` accepting `{ email, password }` *in addition to* the existing `{ password }`. Ship JWT verification in `requireAuth` *in addition to* the cookie check. Create the two real accounts. **Nothing breaks; both clients still work unchanged.**

**Stage 2 — Attribute the shared password (server only).**
Add `INBOX_PASSWORD_ATTRIBUTED_TO` mapping the legacy shared login to a placeholder user (`legacy@…`, display name "Team"). Start writing the activity log now. Legacy-session actions attribute to "Team", real logins attribute to the real person. **The feed becomes useful the moment the first person logs in properly, and degrades gracefully rather than failing for anyone who has not.**

**Stage 3 — Migrate the humans.**
Lubosi and Dominic each log in once with email + password on web. Their sessions upgrade. Web is done. This is a two-minute task per person and needs no release.

**Stage 4 — iOS release.**
Ship a build that logs in with email + password, stores the **refresh token** (not the password) in the existing `CredentialStore`, and — critically — keeps the legacy password path as a fallback for one release so a failed rollout does not brick the phones. `restoreSessionIfNeeded()` (`APIClient.swift:68-73`) becomes "refresh the access token; if that fails and a legacy password is present, fall back". Test the VoIP cold-launch path explicitly: a refresh must be able to complete before CallKit needs the SIP credential.

**Stage 5 — Per-agent SIP credentials.**
Provision one Telnyx SIP credential per user; `GET /api/voice/token` (`routes/voice.js:11-32`) returns the caller's own. Now `call_logs.answered_by` can be populated from the SIP identity on the answering leg. Until this stage lands, "Dominic answered" can only be inferred from whichever device posted `POST /api/voice/logs` (`routes/voice.js:99`), which is weaker but is a legitimate interim signal.

**Stage 6 — Retire the shared password.**
Delete the `{ password }` branch. Rotate `SESSION_SECRET` off the fallback literal. Split `INBOX_PASSWORD` off the admin bearer token in `routes/admin.js`.

The whole point of this ordering is that **stages 1–3 deliver a working, attributed activity feed on web without touching iOS at all.** Given that the iOS build pipeline is the slowest and riskiest part of the estate, that sequencing is not optional.

---

## 3. Prior art

Nine products were surveyed against primary developer documentation. Two resisted retrieval entirely: **Height** (`height.app/api-docs` returned `ECONNRESET` across five attempts) and Front's collision-detection help article. Those gaps are marked, not guessed at.

The single most important structural finding, before any product detail: **every mature product in this set ships two or three separate surfaces, not one.** A per-object timeline, a personal notification inbox, and an admin audit log. They have different schemas, different retention, different audiences and different read-state models. The request as phrased — "an Activity Center where each user can see what everyone has been doing" — describes all three at once, and building it as one surface is the single most likely way this feature fails.

### 3.1 Front — the closest analogue

Front ships **three distinct things**, which is the pattern to copy:

1. **Events** — the developer-facing stream, "allows you to see the activity in your Front instance" ([dev.frontapp.com/reference/events](https://dev.frontapp.com/reference/events))
2. **Audit log** — admin-facing settings-change log; tracks "who made changes, what changes were made, and when" ([help.front.com/en/articles/2925696](https://help.front.com/en/articles/2925696))
3. Per-conversation timeline, backed by the same Events records

Events is conversation activity; the audit log is configuration activity. **They do not share a data model.**

**The full `type` enum** (37 values, from the OpenAPI spec at [dev.frontapp.com/reference/get-event](https://dev.frontapp.com/reference/get-event)):

```
assign, unassign, archive, reopen, trash, restore, reminder, comment,
mention, inbound, outbound, out_reply, move, forward, tag, untag,
sending_error, message_bounce_error, conversations_merged, link_added,
link_removed, custom_field_updated, macro_triggered, topic_identified,
ticket_status_update, call_started, call_abandoned, call_queued,
call_on_hold, call_parked, call_resumed, call_connected, call_missed,
call_hangup, call_transferred, call_transcript_added,
call_voicemail_transcript_added
```

Four things to steal:

1. **Polymorphic actor and target with an identical envelope.** Both `source` and `target` are `{ _meta: { type }, data: <entity> }`. `source._meta.type` is one of `api, oauth_client, rule, teammate, imap, gmail, reminder, inboxes, recipient` — **nine actor kinds** ([get-event](https://dev.frontapp.com/reference/get-event)). We have exactly this problem: `flows/utils.js` sends messages with no human involved, and the feed must say "Automation sent…" rather than attributing to a person or to nobody.
2. **Telephony is first-class in the same feed.** Fourteen of the 37 types are call events, including `call_missed` and `call_connected` — precisely the two the user named.
3. **Errors are first-class events, not exceptions logged elsewhere.** `sending_error` and `message_bounce_error` sit in the same enum as `assign`.
4. **`out_reply` is distinct from `outbound`.** A reply is semantically different from a broadcast. Our `new_message` conflates both.

**Filtering** on `GET /events`: `q.before`, `q.after`, `q.types[]`, `q.inboxes[]`, `sort_by` (only `created_at`), `sort_order`, cursor `page_token` — and **`limit` maxes out at 15** ([list-events](https://dev.frontapp.com/reference/list-events)). That cap implies Front expects the endpoint to be polled or streamed, never bulk-exported.

**Audit log retention: 365 days.** Admin-only. Export is capped at 3,000 rows per CSV, 10 downloads per resource type per 10 minutes, and — notably user-hostile — the export **ignores your applied UI filters** ([help.front.com/en/articles/2925696](https://help.front.com/en/articles/2925696)). Available on all paid tiers, which makes Front the outlier; everyone else gates audit logs behind Enterprise ([changelog](https://community.front.com/product-updates/keep-track-of-admin-activity-with-audit-logs-2380)).

The stated business rationale in Front's changelog is **delegation safety** — audit logs "make delegating admin tasks safer" — not compliance ([same](https://community.front.com/product-updates/keep-track-of-admin-activity-with-audit-logs-2380)). That framing is very close to the user's actual ask.

`[UNVERIFIED]` — Front's collision-detection behaviour. The help article 404s on both `help.frontapp.com` and `help.front.com`.

### 3.2 Missive — the most explicit design philosophy

Missive is the only product here with a literal, named **"Activity feed"**, and its docs contain the clearest statement of intent found anywhere in this research.

**It carries exactly three things**: mentions, reactions, and calendar reminders ([missiveapp.com/docs/core-features/activity-feed.md](https://missiveapp.com/docs/core-features/activity-feed.md)). That is it. It is a *personal notification feed*, not a team audit trail. System events — assignments, label changes, closes, snoozes, merges, subject changes, rule actions — go **inline in the conversation stream**, "not as separate pages", and can be suppressed wholesale via Settings > Preferences > Appearance ([conversations.md](https://missiveapp.com/docs/core-features/conversations.md)).

**On read state, verbatim:**

> "Activities are marked as read when you open the Activity feed. The unread dot on the bell disappears immediately on open, but individual activity items keep their unread styling until you close the panel."

> "There's no per-item read/unread toggle in the Activity feed, and that's by design. **The feed isn't meant to be another inbox to manage with its own read states.**"

([activity-feed/faq.md](https://missiveapp.com/docs/core-features/activity-feed/faq.md))

**Badge behaviour is asymmetric and deliberate:** only calendar reminders increment the app icon badge, by 1, "regardless of how many there are". Mentions and reactions appear in the feed but never touch the badge ([activity-feed.md](https://missiveapp.com/docs/core-features/activity-feed.md)). This independently validates the recommendation in §9.3.

**Retention: 30 days.** "Older entries are automatically removed" ([same](https://missiveapp.com/docs/core-features/activity-feed.md)).

**Noise control:** a type filter (All / Mentions / Reactions / Calendar reminders), plus per-type **Display** and **Unread** toggles where "unchecking Display hides it from the All view, but you can still see those activities by switching to that type's specific filter" ([faq.md](https://missiveapp.com/docs/core-features/activity-feed/faq.md)) — hidden but not deleted.

Missive's REST API has **no events endpoint at all** ([endpoints.md](https://missiveapp.com/docs/developers/rest-api/endpoints.md)). The activity feed is a product surface, not a data product.

### 3.3 Linear — the reference implementation for the split

Three separate things again: **issue activity** (per-issue timeline, `IssueHistory`), **Inbox** (notification centre), **Audit log** (Enterprise security log).

**The most useful documented fact in this entire research, for our noise problem:**

> "changes made to an issue's properties in the **first 3 minutes** are considered part of the issue creation process, and won't be added to the activity log."

([linear.app/developers/graphql](https://linear.app/developers/graphql))

That single rule kills the classic four-line wall of "Bosi created the issue / Bosi set assignee / Bosi set priority / Bosi added label". Linear also groups multiple property changes by the same actor within a short window into one `IssueHistory` row (window duration `[UNVERIFIED]` — the Apollo Studio schema page is a JS app that would not render).

**Inbox semantics** ([linear.app/docs/inbox](https://linear.app/docs/inbox)): auto-subscription on create/assign/mention; **2,000 open-item cap**; read/unread (`U`), mark-all-read (`Alt U`), delete-read (`Shift Backspace`); snooze until a time, distinct from proactively scheduled reminders; **no subscription customisation** — "all notifications will arrive there"; quick search by title, issue ID, notification type, assignee, team, project, priority.

**Zero read state on issue activity. Full inbox semantics on notifications.** Activity is a log; Inbox is a queue.

**Audit log** ([linear.app/docs/audit-log](https://linear.app/docs/audit-log)): Enterprise only, **workspace owners only**, **90-day retention**, records IP address and country, streams to a webhook for SIEM ingestion, and — a very practical noise control — the UI offers a one-click option to **exclude session-creation events**, i.e. hide the login noise.

**Linear's changelog is the best public commentary on feed noise anywhere in this set** ([linear.app/changelog](https://linear.app/changelog)):

- *21 May 2026* — "Fixed double-notifying on Slack when an issue is deduplicated — **the duplicate-relation event is now the only user-facing event**." An explicit policy: when one logical action produces two candidate events, designate a single canonical one.
- *21 May 2026* — "**Grouped agent-authored inbox replies into a dedicated Agents section.**" As AI agents began generating activity, Linear segregated them rather than interleaving. Directly relevant to our automation flows.
- *2 July 2026* — "Fixed new project and initiative update notifications **appearing as separate inbox entries for the same parent**." Roll up by parent entity.
- *2 July 2026* — "Fixed issue activity history no longer **briefly reordering or regrouping while loading**." Client-side grouping over streaming data visibly thrashes. Argues for server-side grouping.

**Webhook payload** ([linear.app/developers/webhooks](https://linear.app/developers/webhooks)): `action` is only `create | update | remove`; specificity lives in `type` + **`updatedFrom`**, which carries *only the previous values of properties that changed* while `data` carries the current entity. Also two separate timestamps — `createdAt` (when it happened) and `webhookTimestamp` (when we told you) — which is essential for replay correctness.

### 3.4 Intercom — the two-dimensional taxonomy

Intercom puts system events **into the message array itself**. Every message and every state change is a `conversation_part`, discriminated by `part_type`:

```
comment, note, note_and_reopen, assignment, open, close,
away_mode_assignment, participant_added, participant_removed,
conversation_rating_changed, conversation_rating_remark_added,
snoozed, unsnoozed, assign_and_unsnooze, timer_unsnooze,
message_strategy_assignment
```

([conversation-part-model](https://developers.intercom.com/docs/references/1.4/rest-api/conversations/conversation-part-model); `message_strategy_assignment` from the [Conversations FAQ](https://www.intercom.com/help/en/articles/8838326-conversations-faqs))

**The sharpest idea here: a two-dimensional event taxonomy.** Intercom disambiguates *how* an assignment happened by combining `part_type` with `author.type` ([FAQ](https://www.intercom.com/help/en/articles/8838326-conversations-faqs)):

| Assignment method | `part_type` | `author.type` |
|---|---|---|
| Workflow / default assignment | `assignment` | `bot` |
| "Pull Conversation" button | `message_strategy_assignment` | `admin` |
| Balanced assignment | `message_strategy_assignment` | `bot` |

`(type, actor_kind)` rather than one flat enum. **This means we do not need `message.sent` and `message.sent_by_automation` as separate types** — see §5.1, where this changes the recommendation.

Note also the **compound types** `note_and_reopen` and `assign_and_unsnooze`: two simultaneous state changes collapsed into one atomic event at write time.

**Workspace Activity Logs** ([listactivitylogs](https://developers.intercom.com/docs/references/2.9/rest-api/api.intercom.io/admins/listactivitylogs)) carry a 60+ value `activity_type` enum, including `admin_login_success`, `admin_login_failure`, `admin_impersonation_start`, `seat_change`, `role_change`, `app_data_export`. Naming is inconsistent (`seat_change` vs `seat_revoke`) — a warning about convention drift over a decade.

**The field to copy is `activity_description`** — a pre-rendered human-readable sentence stored on the row alongside the machine-readable `activity_type`. The UI does not own a giant switch statement, and old events keep rendering after you rename things. Intercom's `metadata` is also notable: a **sparse, typed, nullable declared grab-bag** rather than free-form JSON — every possible key is in the schema with a type.

**Webhook topic naming is `entity.actor.verb`**: `conversation.admin.replied`, `conversation.user.replied`, `conversation.admin.assigned`, `conversation.admin.snoozed`, `conversation.read`, plus `call.started`, `call.ended`, `call.recording_available` ([webhook-models](https://developers.intercom.com/docs/references/webhooks/webhook-models)). **This is a genuinely good convention** because it makes actor-kind filterable by prefix: `conversation.admin.*` versus `conversation.user.*`.

Intercom also maintains **denormalised counters** off the event stream — `count_reopens`, `count_assignments`, `count_conversation_parts`, `time_to_admin_reply`, `median_time_to_reply`, `first_contact_reply` ([conversation-model](https://developers.intercom.com/docs/references/2.2/rest-api/conversations/conversation-model)) — so a list view can show "3 reassignments" without touching the event table.

### 3.5 Help Scout — and the cautionary tale

There is **no separate event table**. State changes are threads of type `lineitem`: "a change of state on the conversation… A line item won't have a body, to/cc/bcc lists, or attachments" ([threads/list](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/)).

Thread `type` enum: `beaconchat, chat, customer, forwardchild, forwardparent, lineitem, message, note, phone`. Exactly one of nine is the system-event type.

Every thread carries an `action` object with `action.type` (machine), **`action.text`** ("Human friendly description of the action. Applicable for thread type `lineitem` only"), and **`action.associatedEntities`** — a named-key map of `workflow`, `user`, `inbox`, `originalConversation` IDs ([same](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/)). That map is a better target model than a single `target_id`/`target_type` pair when an event touches three things at once ("moved conversation X from inbox A to inbox B by workflow W").

Also: **`state: hidden` is a first-class thread state** in the schema (`bounced, draft, hidden, published, review`), not a UI filter. And `userUpdatedAt` moves only on *human* updates, distinct from any system touch — useful for "last real activity" sorting without automation polluting the list.

**The cautionary tale, and it is the clearest warning in this research:**

> "A single conversation can contain up to **100 threads**, and if you try to create a conversation with more than 100 threads or add a thread to a conversation that has 99 threads or more, the API will return HTTP 412 Precondition failed."

([same](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/))

Because Help Scout put system events in the same table as messages, they inherited a hard cap of 100 **combined**. That is a concrete argument against merging events into `sms_messages` — which is exactly the shortcut someone will propose in implementation, because it looks cheaper.

`[UNVERIFIED]` — Traffic Cop (collision detection). The docs article 404'd. Help Scout appears to have no global activity feed product at all.

### 3.6 Crisp — the idempotency key

Events live inside the message stream as `type: "event"`, discriminated by a colon-namespaced `namespace`, and the vocabulary is deliberately tiny — nine values against Front's 37 ([docs.crisp.chat/references/rest-api/v1](https://docs.crisp.chat/references/rest-api/v1/)):

```
state:resolved, user:blocked, reminder:scheduled, thread:started,
thread:ended, participant:added, participant:removed,
call:started, call:ended
```

Three fields on the message object are directly relevant to us:

1. **`fingerprint`** — "Unique message fingerprint (**useful to avoid duplicates**)". A client-supplied idempotency key on every row. This is the single most directly stealable field in the whole survey, and §6.2 now adopts it.
2. **`automated`** — a boolean separating bot-generated from human-generated, rather than encoding it in the type enum. Combined with Intercom's `author.type`, this is the second mainstream approach to the same problem.
3. **`read` / `delivered`** — stored as *the channel in which it was read*, not a boolean.

Crisp's RTM API naming is `domain:object:verb`, with a clean and instructive split between `session:set_*` (someone did this) and `session:sync:*` (the client reported this) ([rtm-api/v1](https://docs.crisp.chat/references/rtm-api/v1/)) — exactly the distinction that stops passive telemetry flooding a human-readable feed.

### 3.7 Zendesk — two tiers, and grouping by transaction

**Tier 1, account-level audit log** ([audit_logs](https://developer.zendesk.com/api-reference/ticketing/account-configuration/audit_logs/)). The `action` enum is **only five values**: `create, destroy, exported, login, update`. Specificity lives in `source_type` plus a free-text `change_description`. A two-column taxonomy of `(action, source_type)` — the polar opposite of Slack.

Every row is **flat and fully denormalised**: `id, action, action_label, actor_id, actor_name, change_description, created_at, ip_address, source_id, source_label, source_type, url`. No nested objects, no metadata blob, every field a scalar. `actor_name`, `action_label`, `source_label` and `change_description` are human-readable strings stored **on the row**, so the log still reads correctly after a user is renamed or deleted.

**Enterprise only. Retention: indefinite** — the longest of any product surveyed ([same](https://developer.zendesk.com/api-reference/ticketing/account-configuration/audit_logs/), [support article](https://support.zendesk.com/hc/en-us/articles/4408828001434-Viewing-the-audit-log-for-changes-to-your-account)). End-user activities are explicitly excluded. Export is emailed asynchronously rather than downloaded inline.

**Tier 2, per-ticket audits** ([ticket_audits](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/)) — **and this is the most important structural idea in the whole survey.**

Zendesk has **two levels**: an *audit* (one user action, one submit) containing an **array of events** (the individual field changes and side effects that action produced). One agent clicking "Solve & reply" produces **one audit** containing a `Comment` event, several `Change` events, and one or more `Notification` events.

**That is grouping by construction.** There is no need to collapse consecutive same-actor events in the UI, because the model already batched them at write time, at the transaction boundary. Linear achieves the same result with a time window; Zendesk does it with a database transaction. Both beat UI-side collapsing.

The event `type` enum is 34 values ([ticket-audit-events-reference](https://developer.zendesk.com/documentation/ticketing/reference-guides/ticket-audit-events-reference/)) including `Create, Change, Comment, VoiceComment, Notification, SmsNotification, Error, ChatStartedEvent, ChatEndedEvent, OfferedToEvent`. Crucially, **`Change` is generic** — one type covering every field update, with `field_name`, `previous_value`, `value` in the payload. Adding a new ticket field requires zero new event types.

### 3.8 Slack — the maximalist end

**600+ action names**, Enterprise Grid only — not "the enterprise tier of the normal product" but a structurally different SKU ([docs.slack.dev/admins/audit-logs-api](https://docs.slack.dev/admins/audit-logs-api/)).

**The envelope is the best-designed in the set**, and §6.4 adopts its shape:

```json
{
  "id": "0123a45b-6c7d-8900-e12f-3456789gh0i1",
  "date_create": 1650415188,
  "action": "public_channel_created",
  "actor":   { "type": "user", "user": { "id": "...", "name": "...", "email": "..." } },
  "entity":  { "type": "channel", "channel": { "id": "...", "name": "..." } },
  "context": { "location": {...}, "ua": "Mozilla/5.0...", "ip_address": "1.23.45.678", "session_id": null, "app": {...} }
}
```

**Three-way separation — `actor` / `entity` / `context`.** Who, what, and from-where are cleanly orthogonal. Most homegrown schemas conflate `context` into `metadata`. `details` is reserved specifically for **previous values**, separate from `entity` (current state) — the same split as Linear's `updatedFrom` vs `data`.

Query params on `/logs`: `latest`, `oldest`, `limit` (**max 9999**), `action` (comma-separated), `actor`, `entity` ([methods-actions-reference](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference/)). **Time window, action type, actor, target entity** is the canonical filter set — every product here with real filtering has exactly these four, and none has free-text search.

Four details worth noting:

- **Slack ships `/schemas` and `/actions` discovery endpoints** so consumers enumerate valid action names at runtime rather than hardcoding a list that goes stale. At 600 actions that is mandatory; even at 40 it removes a class of client breakage.
- **Slack audits access to the audit log itself** — `audit_logs_records_searched`, `audit_logs_export_csv_started`. Meta-auditing is a real requirement in this space.
- **Destination state is encoded in the action name**: `role_change_to_admin`, `role_change_to_guest`, `role_change_to_owner`, `role_change_to_user` as four distinct actions rather than one with a payload. Filtering becomes a string match, at the cost of enum explosion.
- **Plural bulk actions**: `list_row_deleted` *and* `list_rows_deleted` as separate actions. That is Slack's answer to bulk-operation dedupe — emit one plural event instead of N singular ones. Also `*_enqueued` / `*_added` pairs that log both intent and completion for long-running operations, which most feeds get wrong by logging only one.

No read/unread model. It is a machine-consumption API for SIEM ingestion, not a human feed. Retention not documented `[UNVERIFIED]`.

### 3.9 GitHub — "why am I seeing this"

GitHub's notification `reason` field is the best published example of the property that makes a feed filterable and tierable: `approval_requested, assign, author, ci_activity, comment, invitation, manual, member_feature_requested, mention, review_requested, security_advisory_credit, security_alert, state_change, subscribed, team_mention` ([GitHub REST: Notifications](https://docs.github.com/en/rest/activity/notifications)).

The thread object carries `unread`, `updated_at`, `last_read_at` (nullable), and a `subject`. **`reason` mutates**: if you authored a thread and are later @mentioned, the reason upgrades to reflect the stronger relationship ([same](https://docs.github.com/en/rest/activity/notifications)).

**Store *why* an event reached a user, separately from *what* the event was.** It is what lets a user say "only things aimed at me" without enumerating event types in the UI.

### 3.10 Height

`[UNVERIFIED]` — unreachable across five attempts (`ECONNRESET` on both `height.app/api-docs` and `api.height.app`). Treat as a gap in this report, not as a product without an activity feed. Worth checking later: whether `GET /activities` exists as a workspace-global endpoint (unusual in being global-first rather than object-scoped), and whether activities carry `oldValue`/`newValue` pairs or a rendered string.

### 3.11 Cross-cutting synthesis

**Retention, ranked:**

| Product | Surface | Retention |
|---|---|---|
| Zendesk | Audit log | **Indefinite** |
| Front | Audit log | **365 days** |
| Linear | Audit log | **90 days** |
| Missive | Activity feed | **30 days** |
| Slack / Front Events / Intercom | — | not documented `[UNVERIFIED]` |

**The pattern: compliance logs get long retention; notification feeds get short retention.** Missive's 30 days is enough for a personal feed. If you build one table for both, you inherit the longer requirement and the bigger bill. This is the strongest external support for the two-table recommendation in §6.1.

**Three schools of event-type design:**

1. **Explosive enum** — Slack (600+), Front (37). Every action its own string, including destination states. Filtering is a string match; the enum grows forever.
2. **CRUD × entity** — Zendesk audit logs (5 actions), Linear webhooks (3 actions). Specificity in `source_type` plus a rendered description. Never needs new enum members.
3. **Hybrid, two-dimensional** — Intercom `(part_type, author.type)`, Crisp `(type, namespace)` + `automated`. A modest enum crossed with an actor-kind axis.

**For a shared inbox, (3) is the right fit**: enough types to render distinct UI, plus an actor-kind axis that lets you filter out automation without doubling the enum. §5 adopts it.

**Where grouping actually happens — and it is never the UI:**

| Mechanism | Product |
|---|---|
| Transaction boundary (one audit → N events) | Zendesk |
| Time window + same actor | Linear (`IssueHistory`) |
| Creation grace period (3 minutes) | Linear |
| Compound event types (`assign_and_unsnooze`) | Intercom |
| Plural bulk actions (`list_rows_deleted`) | Slack |
| Designated canonical event on dedupe | Linear (changelog, 21 May 2026) |
| Reaction grouping | Missive |

**Every one of these is a write-time decision.** Nobody in this set documents runtime collapsing of consecutive events, and Linear's 2 July 2026 bug fix ("no longer briefly reordering or regrouping while loading") is direct evidence of why: client-side grouping over streaming data visibly thrashes.

Also notable by its absence: **nobody in this set documents the "X and 3 others replied" social-feed collapsing pattern.** It exists in social products, not in work tools. Do not assume it is the right answer here.

**The read-state fork — pick a side consciously:**

- **Missive:** no per-item read state, explicitly — "The feed isn't meant to be another inbox to manage with its own read states."
- **Linear:** full inbox semantics on *notifications* (read/unread, snooze, delete, bulk-mark, 2,000 cap) and **zero** read state on *activity*.

Both are coherent. **What is incoherent is a half-inbox: unread counts on an activity feed with no way to clear them per item.** The watermark model in §7.3 is the Missive side of this fork, chosen deliberately.

### 3.12 UI patterns worth copying

**The canonical activity line**, consistent across every product `[UNVERIFIED as rendering description]`:

```
[20-24px round avatar]  **Actor Name**  regular-weight verb phrase  [inline object chip]        2h
```

Avatar far left, small and circular, replaced by a monochrome glyph for system/automation actors. Actor name in semibold — the only bolded text in the line. Verb phrase in regular weight, muted foreground. Object as an inline coloured chip, not plain text. Relative timestamp right-aligned and muted, absolute on hover.

**The documented anchor for this is the pre-rendered string.** Zendesk stores `action_label`, `change_description`, `actor_name`, `source_label` on the row; Intercom stores `activity_description`; Help Scout stores `action.text`. **Three independent products converged on: pre-render the sentence server-side and store it.** §6.2 now adopts this.

**Placement — three distinct patterns are in use:**

- **(a) Inline in the message stream** — Missive, Help Scout, Crisp, Intercom. Interleaved chronologically, visually de-emphasised: no bubble, no card, single line, smaller type, muted colour. Help Scout enforces this structurally — a lineitem "won't have a body, to/cc/bcc lists, or attachments", so it renders as a bare line by construction.
- **(b) A dedicated panel** — Linear's issue activity below the description.
- **(c) A separate admin page** — Front, Zendesk and Linear audit logs. **Tabular, not feed-like:** four to six columns, fixed row height, no avatars, filter chips above, CSV export. Deliberately a different visual language, because the job is search-and-prove, not scan-and-catch-up.

**Colour.** The one documented instance of colour coding on a feed is Missive's unread dot: "blue for mentions or reactions, orange for calendar reminders" ([activity-feed.md](https://missiveapp.com/docs/core-features/activity-feed.md)). Two colours, on one dot, encoding *urgency class* rather than event type. Nothing suggests per-event-type colour in the feed body. The broader pattern is that colour comes from the **object** (a label chip in its own colour), with red reserved for genuinely destructive or error events. If five things are red, nothing is.

**Iconography.** Where an avatar is inappropriate, products substitute a glyph — and Front's nine-value `source._meta.type` enum is effectively an icon spec.

**Noise controls actually shipped**, ranked by how well documented they are:

| Control | Product |
|---|---|
| Global preference to hide all system events from the stream | Missive |
| Per-type Display toggle (hides from All, keeps type-filtered view) | Missive |
| Type filter dropdown | Missive |
| "Show edits only" toggle | Front audit log |
| Exclude session-creation events | Linear audit log |
| Show/hide read; show/hide snoozed | Linear Inbox |
| Segregate agent-authored items into their own section | Linear Inbox |
| 3-minute creation grace period | Linear activity |
| Transaction-level batching | Zendesk |
| Plural bulk actions | Slack |
| Compound event types | Intercom |
| `state: hidden` as a first-class schema state | Help Scout |

---

## 4. The noise problem

### 4.1 The failure mode, stated precisely

An activity feed fails when the cost of scanning it exceeds the value of what is found. For a two-to-ten person team, that threshold is *much* lower than product intuition suggests, because in a small team **most events are things you already know about** — you were in the room, or you are the one who did it. A ten-person team generates roughly ten times the events and roughly three times the useful signal.

The specific way this feature dies: it launches, everyone watches it for four days, it fills with `message_sent` rows from the automation queue, and by week three nobody opens it. It becomes wallpaper, and — worse — it becomes wallpaper that *looks* like a working feature, so nobody removes it.

### 4.2 Aggregation, from a primary source

Knock's batch function is the best-documented published implementation of feed aggregation and its vocabulary is worth adopting wholesale ([Knock: batch function](https://docs.knock.app/designing-workflows/batch-function)):

- **Batch window** — a fixed duration, a dynamic duration, or a **sliding window** where "subsequent workflow triggers that are detected by the already-open batch window will add the configured default window duration onto the already-open batch window", bounded by a maximum extension. Sliding is the correct choice for a burst of replies: the batch stays open while the burst continues, then closes once it stops.
- **Batch key** — the grouping attribute. Without one, everything for a recipient batches together; with one, triggers group separately per key, and keys are commonly templated from event data plus actor, e.g. `{{data.eventType}}-{{actor.id}}` ([same](https://docs.knock.app/designing-workflows/batch-function)).
- **Rendered payload** — `total_activities`, `total_actors`, an `activities` array (10 by default, up to 100 on Enterprise), and an `actors` array of up to 10 unique actors ([same](https://docs.knock.app/designing-workflows/batch-function)). This is exactly the data needed to render "Dominic and 2 others sent 14 messages".
- **Max batch size** — optionally 2 to 1000 activities; hitting the cap closes the batch immediately even if time remains ([same](https://docs.knock.app/designing-workflows/batch-function)).
- Knock does not publish universally recommended window lengths, noting only that ~30 seconds suits development and production windows depend on event frequency ([same](https://docs.knock.app/designing-workflows/batch-function)).

**Our batch key should be `(actor_id, verb, target_type, target_id)`** with a **5-minute sliding window capped at 30 minutes**. That collapses "Dominic sent 9 messages to Sarah over 6 minutes" into one line, which is what a human would say.

### 4.2b Group at write time, not render time

This is the strongest single finding from the prior-art survey (§3.11) and it overrides intuition. **Every documented grouping mechanism in every product surveyed happens at write time:**

- **Zendesk** groups by *transaction boundary* — one agent action produces one audit containing an array of events ([ticket_audits](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/)).
- **Linear** groups by *time window plus same actor*, and additionally applies a **3-minute creation grace period** where "changes made to an issue's properties in the first 3 minutes are considered part of the issue creation process, and won't be added to the activity log" ([linear.app/developers/graphql](https://linear.app/developers/graphql)).
- **Intercom** ships *compound event types* — `note_and_reopen`, `assign_and_unsnooze` — collapsing two simultaneous state changes into one atomic event.
- **Slack** emits *plural bulk actions* (`list_rows_deleted`) instead of N singular ones.
- **Linear** designates a *single canonical user-facing event* when one logical action would otherwise produce two ([changelog, 21 May 2026](https://linear.app/changelog)).

Nobody documents runtime collapsing of consecutive events. Linear's 2 July 2026 fix — "issue activity history no longer briefly reordering or regrouping while loading" — is direct evidence of the failure mode: **client-side grouping over streaming data visibly thrashes as pages arrive.**

Two concrete rules for us:

1. **The collapsed form is the stored form.** `batch_count` on the row (§6.2), incremented in place. The client renders what it is given and never regroups.
2. **Adopt a creation grace period for conversations.** When a contact is created and immediately messaged, that is one event ("Dominic started a conversation with Sarah"), not three. Linear's 3 minutes is a reasonable starting value.

### 4.3 The rules I would actually apply

Four filters, applied in order. An event must survive all four to reach the feed.

1. **Did a human do it?** If the actor is the automation queue or a webhook, it does not go in the team feed. It goes in the automation view (`routes/activity.js`, soon `/api/automations`) which already exists and already does this job well. **This one rule removes the largest single source of volume**: `flows/utils.js:267` fires `message_sent` on every queued send, and those are the least interesting events in the system to a teammate.
2. **Would a teammate change their behaviour knowing it?** "Dominic replied to Sarah" → yes, I will not also reply. "Dominic opened a conversation" → no. "Contact updated from WooCommerce" → no.
3. **Is it about a person or about a record?** Record-keeping changes (`contact_updated`, `order_status_updated`, `status_update`) are audit-log material. They are not team-awareness material.
4. **Is it the reader's own action?** Suppress. This requires per-user addressing (§1.3) and is the single most-missed detail in feed implementations.

### 4.4 Concrete inclusion list for *this* product

**In the team feed (the whole list):**

- Outbound message sent by a human, collapsed per conversation per 5 minutes
- Inbound reply received on a conversation **nobody has responded to yet** (not every inbound — see below)
- Call answered, with who
- Call missed, with duration since
- Call ended, with duration
- Conversation assigned / unassigned
- Conversation resolved / reopened
- Automation cancelled by a human (rare, high-consequence, always show)
- Campaign approved / sent
- Contact opted out
- Send failure / bounce
- User invited, user joined, user removed

That is thirteen. It should not grow much past twenty.

**Explicitly NOT in the team feed:**

- Every inbound message (that is the inbox itself — the feed must not become a second, worse inbox)
- Message delivery-status transitions (`status_update`, `routes/webhook.js:48`) — extremely high volume, zero team-awareness value, pure audit
- Reactions/tapbacks (`reaction_update`) — audit at most
- Conversation opened / read
- Contact created or updated by sync (`contact_added`, `contact_updated`)
- Order status changes (`order_status_updated`) — belongs on the contact record
- Automation queue add/send (`queue_added`, `message_sent`) — belongs in the automations view
- `stats_update` — a UI refresh nudge, not an event at all
- Login events — audit log only, never the feed. Nobody needs a notification that a colleague opened the app, and it is the fastest way to make a small team feel surveilled.

### 4.5 Severity tiers

Three tiers, and the tier determines the delivery channel — which is the whole point of having tiers.

| Tier | Meaning | Feed | Push | Badge |
|---|---|---|---|---|
| **Act** | Something needs a human now | Yes, pinned to top | Yes | Yes |
| **Aware** | Useful to know, no action | Yes | No | No |
| **Audit** | Recorded, not surfaced | No | No | No |

Only three things are **Act**: a missed call, an unanswered inbound after a threshold, and a send failure. Everything else in §4.4 is **Aware**. Everything in the "NOT" list is **Audit**.

### 4.6 Live stream or digest?

**Live for Act, live-but-quiet for Aware, and a daily digest for the accountability use case.** The user's stated goal has two halves that pull in opposite directions: *awareness* ("Dominic just answered the phone") is inherently real-time and belongs in the feed; *accountability* ("what did the team actually do this week") is inherently retrospective and is served far better by a summary than by scrolling 400 lines. A Friday-afternoon digest — messages sent per person, calls answered per person, average first-response time, calls missed — answers the accountability question completely and generates one notification per week instead of four hundred.

`[UNVERIFIED]` — I was unable to retrieve credible research on activity-feed read rates or the NN/g alert-fatigue material in this session. The recommendations above are reasoned from the primary sources cited and from the structure of the product, not from published engagement data. If someone wants to challenge the "don't log everything" position, that is the evidence gap to fill.

---

## 5. Event taxonomy

**Naming convention: `entity.actor.verb`**, lower snake case — borrowed directly from Intercom's webhook topics (`conversation.admin.replied` vs `conversation.user.replied`), which is the best convention found in the survey because **it makes actor-kind filterable by prefix match** rather than by enumerating types ([Intercom webhook models](https://developers.intercom.com/docs/references/webhooks/webhook-models)). Type names borrow from Front where they fit ([Front Events API](https://dev.frontapp.com/reference/events)).

**Actor types:** `user` (a human), `system` (automation, flow, cron), `contact` (the customer), `integration` (Telnyx, GHL, WooCommerce, ShipStation). Polymorphic, exactly as Front does it with its nine-value `source._meta.type`.

**Use a two-dimensional taxonomy: `(verb, actor_type)`, not a flat enum.** This is the §3.11 school-3 recommendation, following Intercom's `(part_type, author.type)` and Crisp's `automated` boolean. It means we do **not** need separate `…_by_automation` variants of every event — `message.sent` with `actor_type = 'system'` is an automation send, and `WHERE actor_type = 'user'` is the single filter that removes the entire automation firehose from the feed. The tables below list the human-actor form; the system-actor form of the same verb is implied.

**Tier key:** **A** = Act, **W** = Aware, **X** = Audit only.

### 5.1 Messaging

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `message.sent` | `user` | conversation (`contact_phone`) | `message_id`, `contact_phone`, `preview` (first 80 chars), `has_media`, `is_reply` | Feed + timeline | W |
| `message.sent` *(actor_type = `system`)* | `system` | conversation | `message_id`, `contact_phone`, `flow_type`, `scheduled_id` | Automations view only | X |
| `message.received` | `contact` | conversation | `message_id`, `contact_phone`, `preview`, `has_media` | Timeline; feed **only if** unanswered past threshold | W |
| `message.delivery_failed` | `integration` | message | `message_id`, `contact_phone`, `error_code`, `error_detail` | Feed + timeline | **A** |
| `message.status_changed` | `integration` | message | `message_id`, `from`, `to` | — | X |
| `message.reacted` | `user` \| `contact` | message | `message_id`, `reaction` | Timeline | X |
| `contact.opted_out` | `contact` | contact | `contact_phone`, `keyword` | Feed + timeline | **A** |

`message.sent` carries the actor discriminator rather than splitting into two verbs (§5 preamble). The noisiest event in the system — automation sends from `flows/utils.js:267` — is excluded by `WHERE actor_type = 'user'`, one predicate that also removes every other system-generated event at the same time.

Worth also adopting Front's **`out_reply` vs `outbound` distinction** ([Front Events API](https://dev.frontapp.com/reference/events)): a reply into an existing conversation is a different act from opening a new one. Our `send.js` already knows this, because `reply_to_message_id` is on the row (`routes/send.js:30-32`). Rendering "Dominic replied to Sarah" versus "Dominic messaged Sarah" costs nothing and reads better.

### 5.2 Conversation lifecycle

Assignment and resolution **do not exist in the product today** — there is no assignee column and no resolved state. These events presuppose that feature. They are listed because assignment is what makes a feed useful above about four people (§8).

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `conversation.assigned` | `user` | conversation | `contact_phone`, `assignee_id`, `previous_assignee_id` | Feed + timeline | **A** if assignee is me, else W |
| `conversation.unassigned` | `user` | conversation | `contact_phone`, `previous_assignee_id` | Timeline | W |
| `conversation.resolved` | `user` | conversation | `contact_phone`, `duration_open_seconds` | Feed + timeline | W |
| `conversation.reopened` | `user` \| `contact` | conversation | `contact_phone`, `reason` | Feed + timeline | W |
| `conversation.read` | `user` | conversation | `contact_phone` | Presence only, never the feed | X |

`conversation.read` is listed to be explicit that it should be **captured but never displayed as a feed line**. It is the raw material for collision avoidance (§8) and for a "Dominic has seen this" tick, and it would be intolerable noise as a feed entry. This is the event currently being discarded at `routes/conversations.js:76-78`.

### 5.3 Voice

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `call.started` | `contact` \| `user` | call | `call_control_id`, `direction`, `contact_phone` | Timeline | X |
| `call.answered` | `user` | call | `call_control_id`, `contact_phone`, `answered_by`, `ring_duration_seconds` | Feed + timeline | W |
| `call.missed` | `contact` | call | `call_control_id`, `contact_phone`, `ring_duration_seconds` | Feed + timeline | **A** |
| `call.ended` | `user` \| `contact` | call | `call_control_id`, `contact_phone`, `duration_seconds`, `ended_by` | Feed + timeline | W |
| `call.recording_saved` | `integration` | call | `call_control_id`, `recording_url` | Timeline | X |

`call.answered.answered_by` is the field that requires per-agent SIP credentials (§1.6 row 8, §2.6 stage 5). Until then it is nullable and the feed renders "Call answered" without a name. **Shipping it nullable is correct** — it is still better than today, and it avoids blocking the whole feature on Telnyx credential provisioning.

`call.missed` deserves special handling: it is the one event the user named that is genuinely urgent, it already has a `seen_at` read model (`scripts/missed-calls-seen-migration.sql`), and that read model is global. It is the natural first candidate for per-user read state.

### 5.4 Campaigns and automation

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `campaign.created` | `user` | campaign | `campaign_id`, `name`, `audience_size` | Feed | W |
| `campaign.approved` | `user` | campaign | `campaign_id`, `name`, `approved_by` | Feed | W |
| `campaign.rejected` | `user` | campaign | `campaign_id`, `name`, `reason` | Feed | W |
| `campaign.sent` | `user` \| `system` | campaign | `campaign_id`, `name`, `recipient_count` | Feed | W |
| `automation.cancelled` | `user` | scheduled message | `scheduled_id`, `flow_type`, `contact_phone`, `order_id` | Feed | W |
| `automation.queued` | `system` | scheduled message | `scheduled_id`, `flow_type`, `send_at` | Automations view | X |

`automation.cancelled` is low-volume and high-consequence — a human reached in and stopped a customer message. It is one of the strongest accountability signals available and should always be shown. It maps to `routes/activity.js:89-125` today.

### 5.5 Contacts and settings

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `contact.created` | `user` | contact | `contact_phone`, `name`, `source` | Feed if `user`, else nothing | W |
| `contact.created_by_sync` | `integration` | contact | `contact_phone`, `source` | — | X |
| `contact.updated` | `user` \| `integration` | contact | `contact_phone`, `changed_fields` (names only, not values, in the feed) | — | X |
| `settings.changed` | `user` | setting | `setting_key`, `old_value`, `new_value` | Feed | W |
| `integration.connected` / `.disconnected` | `user` | integration | `provider` | Feed | W |

`settings.changed` is the classic audit event and the one where storing old and new values matters most — mirroring Slack's optional `details` field carrying previous values ([Slack Audit Logs API](https://docs.slack.dev/admins/audit-logs-api/)).

### 5.6 Identity

| Event | Actor | Target | Payload | Surface | Tier |
|---|---|---|---|---|---|
| `user.invited` | `user` | invitation | `email`, `role`, `invited_by` | Feed | W |
| `user.joined` | `user` | user | `user_id`, `display_name` | Feed | W |
| `user.role_changed` | `user` | user | `user_id`, `from_role`, `to_role` | Feed | W |
| `user.removed` | `user` | user | `user_id`, `removed_by` | Feed | W |
| `user.logged_in` | `user` | session | `ip`, `user_agent`, `device_id` | **Audit log only** | X |
| `user.login_failed` | — | — | `email_attempted`, `ip`, `user_agent` | **Audit log only** | X |
| `user.logged_out` | `user` | session | `device_id` | **Audit log only** | X |

Login events are audit-only, deliberately and firmly. Section 4.4 covers why.

---

## 6. Data model

### 6.1 Two tables, not one

The user-facing feed and the compliance audit log have contradictory requirements, and conflating them produces something that is bad at both jobs:

| | **Activity feed** | **Audit log** |
|---|---|---|
| Audience | Every teammate | Owner/admin, auditors, counsel |
| Retention | 90 days is generous | Years (see §6.6) |
| Mutability | Deletable, editable, prunable | **Append-only, immutable** |
| Volume | Curated (13 event types) | Everything |
| Fields | Display-oriented | `ip`, `user_agent`, `session_id`, before/after values |
| Latency | Real-time push | Write-and-forget |
| Failure mode | Drop it, who cares | **Must never silently drop** |

Slack's audit entries carry IP, user agent and session ID in `context` ([Slack Audit Logs API](https://docs.slack.dev/admins/audit-logs-api/)) — fields that are essential in an audit record and pure noise in a feed. Build both. They are cheap.

**The published retention numbers settle this argument** (§3.11): Zendesk retains audit logs **indefinitely**, Front for **365 days**, Linear for **90 days** — while Missive's user-facing activity feed retains **30 days** and deletes the rest. Every product that ships both has a roughly 3× to 12× gap between them. One table means inheriting the longest requirement for the noisiest data.

Front makes the same split structurally: Events (conversation activity) and Audit log (configuration activity) "are not the same feature and do not share a data model" ([Front](https://help.front.com/en/articles/2925696)). Zendesk ships two entirely separate APIs, `/audit_logs` and `/ticket_audits`, with different schemas and different plan gating.

### 6.2 The activity table

```sql
create type public.activity_actor_type as enum ('user','system','contact','integration');
create type public.activity_tier       as enum ('act','aware','audit');

create table public.activity_events (
  id             bigint generated always as identity primary key,
  org_id         uuid        not null references public.organisations(id) on delete cascade,

  -- Actor: polymorphic, per Front's `source` model
  actor_type     public.activity_actor_type not null,
  actor_user_id  uuid        references public.users(id) on delete set null,
  actor_label    text,                       -- 'Automation', 'WooCommerce', '+1555…'

  verb           text        not null,       -- 'message.sent', 'call.missed', §5
  tier           public.activity_tier not null default 'aware',

  -- Target: polymorphic, denormalised on purpose
  target_type    text        not null,       -- 'conversation' | 'call' | 'campaign' | 'contact' | 'user'
  target_id      text,                       -- contact_phone | call_control_id | uuid
  contact_phone  text,                       -- promoted: the timeline query's hot path

  -- Pre-rendered sentence. Zendesk (`change_description`), Intercom
  -- (`activity_description`) and Help Scout (`action.text`) all converged on
  -- storing this. The UI owns no enum-to-copy switch, and a row written in 2026
  -- still renders correctly after we rename a verb in 2027.
  description    text        not null,       -- 'replied to Sarah M.'

  payload        jsonb       not null default '{}'::jsonb,

  -- Idempotency, per Crisp's `fingerprint` ("useful to avoid duplicates").
  -- Webhooks retry; Telnyx delivers duplicates; our own retry logic will too.
  fingerprint    text,

  -- Aggregation (§4.2)
  batch_key      text,
  batch_count    integer     not null default 1,
  batch_until    timestamptz,

  created_at     timestamptz not null default now()
);

create unique index activity_fingerprint_idx
  on public.activity_events (org_id, fingerprint)
  where fingerprint is not null;
```

**Design notes.**

- `id` is `bigint identity`, not a uuid. It is the cursor (§7.3), and a monotonic integer cursor is both smaller and correctly ordered. Do not use a random uuid as a feed cursor.
- **`description` is the highest-value column here** and the one most likely to be argued away as denormalisation. Three independent products store a pre-rendered human string next to the machine enum (§3.12), and the reasons are cumulative: no giant switch statement in `public/app.jsx`, correct rendering of historical rows after a rename, correct rendering after the referenced contact or user is deleted, and a feed that works in a plain-text digest email (§4.6) with no client at all.
- **`fingerprint` is the cheapest insurance in the schema.** Our webhook handlers already deal with provider retries, and `insertSmsMessage` (`db.js:27`) has no idempotency guard today. Set it to something stable and derived — `sha256(verb || target_id || telnyx_message_id)` — and duplicate events become impossible rather than merely unlikely.
- `contact_phone` is **promoted out of the JSONB** even though it duplicates `target_id` for conversations. It is the single most-queried field (the per-conversation timeline) and it wants a plain btree index, not a GIN lookup. This is the canonical case for promoting a JSONB field to a real column.
- `actor_user_id` is `on delete set null`, with `actor_label` as the fallback display string. **A removed user must not erase or break history.** If Dominic leaves, the feed should still read "Dominic replied…", so `actor_label` and `description` are written at insert time and never updated. Zendesk makes the same choice, storing `actor_name` on the row.
- `batch_count` / `batch_until` implement the sliding window from §4.2 in-row: within the window, `UPDATE … SET batch_count = batch_count + 1, batch_until = now() + interval '5 minutes'` rather than inserting. **This makes `activity_events` mutable, which is precisely why it cannot double as the audit log.**
- **Do not merge these events into `sms_messages`.** It will be proposed, because it looks cheaper and Help Scout, Crisp and Intercom all do exactly that. Help Scout is also the cautionary tale: because system events share the thread table, a conversation hits a hard cap of **100 threads combined** and further writes return HTTP 412 ([Help Scout threads](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/)). Our automation flows are chatty enough that a long-running contact would hit a similar wall.

### 6.3 Indexes

```sql
-- Global feed: newest first, per org
create index activity_org_recent_idx
  on public.activity_events (org_id, id desc);

-- Feed excluding audit-tier rows (the default view) — partial, so it stays small
create index activity_org_visible_idx
  on public.activity_events (org_id, id desc)
  where tier <> 'audit';

-- Per-conversation timeline
create index activity_conversation_idx
  on public.activity_events (org_id, contact_phone, id desc)
  where contact_phone is not null;

-- Per-actor ("what has Dominic done?") — the accountability query
create index activity_actor_idx
  on public.activity_events (org_id, actor_user_id, id desc)
  where actor_user_id is not null;

-- Open batch lookup on write
create unique index activity_open_batch_idx
  on public.activity_events (org_id, batch_key)
  where batch_until > now();     -- NOTE: not immutable; see below

-- Payload search, only if it proves necessary
-- create index activity_payload_idx on public.activity_events using gin (payload jsonb_path_ops);
```

Two caveats to flag now rather than at implementation time:

- **The open-batch partial index above will not build**, because `now()` is not immutable and Postgres rejects non-immutable expressions in index predicates. The real implementation is either a plain index on `(org_id, batch_key, batch_until desc)` with the time test in the `WHERE` clause, or a nullable `batch_closed` boolean. Flagging it because it is the kind of thing that gets copy-pasted.
- **Use `jsonb_path_ops` rather than the default GIN opclass** if payload search is ever needed — it is substantially smaller and faster for containment (`@>`) queries, which is the only kind we would run. Do not add it speculatively.

### 6.4 The audit table

```sql
create table public.audit_log (
  id           bigint generated always as identity primary key,
  org_id       uuid        not null,
  occurred_at  timestamptz not null default now(),

  actor_type   public.activity_actor_type not null,
  actor_user_id uuid,
  actor_label  text        not null,

  action       text        not null,       -- same vocabulary as activity_events.verb
  entity_type  text        not null,
  entity_id    text,

  before       jsonb,                      -- prior values on a change
  after        jsonb,

  ip           inet,
  user_agent   text,
  session_id   text,
  request_id   text                        -- correlate with app logs
);

create index audit_org_time_idx   on public.audit_log (org_id, occurred_at desc);
create index audit_actor_time_idx on public.audit_log (actor_user_id, occurred_at desc);
create index audit_entity_idx     on public.audit_log (entity_type, entity_id, occurred_at desc);
```

Deliberately **no foreign keys**. An audit record must survive the deletion of everything it references. This is the opposite of the choice made in `activity_events` and it is intentional.

### 6.5 Enforcing append-only

We connect with the Supabase **service-role key** (`db.js:4-8`), which bypasses RLS. So RLS is not the enforcement mechanism here — grants and triggers are.

```sql
-- 1. Trigger: refuse mutation regardless of role
create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- 2. Grants: belt and braces for any non-superuser role
revoke update, delete, truncate on public.audit_log from public, authenticated, anon, service_role;
grant insert, select on public.audit_log to service_role;
```

The trigger is the load-bearing one, because the service role is powerful enough to route around grants. Neither stops a Postgres superuser with SQL-editor access, which is the honest limit of in-database immutability: **if tamper-evidence is genuinely required, the audit log has to be shipped off-box** (append-only object storage, or a log drain) and the Postgres copy treated as a convenience index. That is a Phase 3 concern, not a Phase 1 one, but it should be a conscious deferral rather than an oversight.

### 6.6 Retention

**Activity feed: 90 days, hard — and 30 would be defensible.** Nobody scrolls a feed to March. Missive, the only product here shipping a feature by this exact name, retains **30 days** and states plainly that "older entries are automatically removed" ([Missive](https://missiveapp.com/docs/core-features/activity-feed.md)). A nightly `DELETE FROM activity_events WHERE created_at < now() - interval '90 days'` is the entire implementation.

**Audit log: long, and driven by the vertical.** We send SMS and place calls for businesses, which puts us adjacent to TCPA record-keeping. From primary sources: do-not-call requests "must be honored for **5 years** from the time the request is made" (47 CFR 64.1200(d)(6)), entities must "record the request and place the subscriber's name, if provided, and telephone number on the do-not-call list at the time the request is made" (64.1200(d)(3)), and "all requests to revoke prior express consent … must be honored within a reasonable time not to exceed **ten business days** from receipt" (64.1200(a)(10)) ([47 CFR 64.1200, Cornell LII](https://www.law.cornell.edu/cfr/text/47/64.1200)).

That is not legal advice, and it is about consent records rather than audit logs specifically. But it sets the floor: **any event bearing on consent, opt-out, or what was sent to whom should be retained for at least 5 years.** Practically, that argues for splitting retention by `action` class rather than applying one window: consent/opt-out/send events long, everything else shorter.

For calibration against comparable products (§3.11): **Zendesk retains audit logs indefinitely**, **Front for 365 days**, **Linear for 90 days**. Retention for Slack Audit Logs, Front's Events API and Intercom's activity logs is not published `[UNVERIFIED]`. Indefinite retention on a table growing at our volume (§6.7) costs effectively nothing, so **the default should be "keep it" and the exception should be justified**, which is the opposite of the activity feed's default.

Note also, from `00-current-state.md` §8: **Vici currently has no opt-out enforcement and no consent record at all.** The audit log proposed here is a prerequisite for fixing that, which is a second, independent argument for building it.

### 6.7 Volume, honestly

The live numbers, from `00-current-state.md` §3 (introspected 11 August 2026): **2,283 messages, 1,151 automated sends, 115 call logs, 847 contacts — lifetime, over roughly fifteen months.**

That is on the order of **150 messages and 8 calls per month**. If activity events run at three times message volume, the feed generates **around 500 events per month**. At a 500-byte average row, `activity_events` grows by roughly **3 MB per year**.

**Therefore: do not partition. Do not use pg_partman. Do not build a retention job in Phase 1.** A single unpartitioned table will serve this product past 50 million rows, which at current volume is several thousand years, and at 100× growth across 20 clients is still decades. The declarative-partitioning machinery is well documented ([PostgreSQL: Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)) and the migration path is available later — `PARTITION BY RANGE (created_at)`, `ATTACH`/`DETACH PARTITION ... CONCURRENTLY` for online partition rotation, remembering that **every unique or primary key must include the partition key**. Note it in a comment on the table and move on.

Anyone who proposes partitioning this table in Phase 1 is optimising a problem three orders of magnitude away, and the engineering time is better spent on the auth migration, which is the actual hard part.

### 6.8 The two queries

**Global feed (keyset, newest first):**

```sql
select * from public.activity_events
where org_id = $1
  and tier <> 'audit'
  and ($2::bigint is null or id < $2)   -- cursor
order by id desc
limit 50;
```

**Per-conversation timeline:**

```sql
select * from public.activity_events
where org_id = $1
  and contact_phone = $2
  and ($3::bigint is null or id < $3)
order by id desc
limit 50;
```

Both are index-only-ish scans against §6.3. Both use **keyset pagination, not `OFFSET`** — `OFFSET` forces the database to fetch and discard N rows, and, more importantly for a live feed, it produces duplicates and gaps when rows are inserted between page fetches ([use-the-index-luke.com: "We need tool support for keyset pagination"](https://use-the-index-luke.com/no-offset)). An activity feed is the single worst case for `OFFSET`, because rows are inserted at the head continuously while the user is paging. Note that the existing `routes/activity.js:38-47` and `routes/voice.js:37-44` both use `OFFSET`-style `.range()` pagination; do not copy that pattern here.

Both translate directly to `supabase-js`: `.lt('id', cursor).order('id', { ascending: false }).limit(50)`.

---

## 7. Real-time delivery

### 7.1 What has to change in the broadcaster

Three changes, in order of necessity:

1. **Addressed delivery.** `sseClients` becomes a `Map<userId, Set<res>>` rather than a bare `Set`. `broadcast(event, { excludeUserId })` becomes possible, which is what suppresses self-authored events (§4.3 rule 4). This is a small change to `server.js:15-21` and `routes/sse.js` and it unlocks most of the feed's usability.
2. **Event IDs and replay.** Write the `activity_events.id` as the SSE `id:` field. SSE clients automatically send `Last-Event-ID` on reconnect; `routes/sse.js` reads it and replays everything newer before resuming the live stream. This closes the redeploy/tunnel-drop hole described in §1.3(2) and it is nearly free, because the id is already the feed cursor from §6.8.
3. **Persist first, broadcast second.** Today the broadcast *is* the event. Once `activity_events` exists, the row is the source of truth and the SSE frame is a cache-invalidation hint. That inversion is what makes backfill correct.

**Carry two timestamps on every frame**, following Linear's webhook envelope: `createdAt` (when it happened) and a transmission timestamp (when we sent it) ([Linear webhooks](https://linear.app/developers/webhooks)). During a replay after reconnect these differ by minutes, and a client that sorts or renders "2 minutes ago" off the wrong one shows nonsense.

Also worth stealing from Slack: a **discovery endpoint** listing valid verbs and their display metadata ([Slack `/actions` and `/schemas`](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference/)). At 13 event types this is not mandatory, but `public/app.js` is a compiled artefact deployed separately from the server, so a hardcoded client-side verb list *will* go stale relative to the backend at some point.

### 7.2 Multi-device

Multi-device follows naturally once delivery is addressed: one user, N sockets, all in the same `Set`. Two rules:

- **Read state is per-user, not per-device.** A feed item read on the phone is read on the laptop. This matches how the product already treats read state globally (`lib/missed-calls.js:10-13`) — we are narrowing the scope from "everyone" to "this person", not introducing per-device state.
- **Suppress by user, not by device.** If Dominic replies from his phone, his laptop should not show "Dominic replied" either.

Push (`push-notify.js:12`, `lib/apns-notify.js:128`) must move from send-to-all to send-to-user's-devices, which is what `user_devices` (§2.5) is for.

### 7.3 The backfill contract

```
GET  /api/activity?cursor=<id>&limit=50           → page backwards through history
GET  /api/activity/since?after=<id>               → catch up forwards after reconnect
GET  /api/activity/conversation/:phone?cursor=<id>
POST /api/activity/read      { up_to_id }         → per-user read watermark
GET  /api/sse                (Last-Event-ID header) → live, with automatic replay
```

**Read state as a watermark, not per-row flags.** One `bigint` per user (`last_read_activity_id`) rather than a join table with a row per user per event. Unread count is `count(*) where id > watermark and tier <> 'audit'`. At our volume this is trivially fast, it is one column instead of a table, and it degrades sensibly — the semantics are "everything above this line is new", which is exactly how a chronological feed reads.

This is a deliberate choice of the **Missive side of the read-state fork** (§3.11). Missive states it outright: "There's no per-item read/unread toggle in the Activity feed, and that's by design. The feed isn't meant to be another inbox to manage with its own read states" ([Missive FAQ](https://missiveapp.com/docs/core-features/activity-feed/faq.md)). Their behaviour is worth copying precisely: the unread dot clears the moment the panel opens, but individual items keep their unread styling until it closes — so you can still see what was new while you are looking at it.

The alternative is Linear's model: full inbox semantics (per-item read/unread, snooze, delete, a 2,000-item cap) on *notifications*, and zero read state on *activity* ([Linear Inbox](https://linear.app/docs/inbox)). Both are coherent. **The incoherent option — and the one a half-finished implementation lands on by default — is a half-inbox: unread counts on a feed with no way to clear them per item.**

### 7.4 iOS transport

**Do not add SSE to the iOS app.** It already has APNs and a working CallKit/PushKit stack, and a long-lived HTTP connection on a phone is a battery and reliability problem that iOS actively fights. The right shape:

- **Foreground:** poll `/api/activity/since?after=<lastSeenId>` on view appearance and on `willEnterForeground`. At our event volume this returns an empty array almost every time and costs nothing.
- **Background:** silent APNs push carrying only the tier and a badge count, never the content. The app fetches on wake.
- **Never** push an `aware`-tier event (§9).

### 7.5 The elephant: SSE is still single-process

Addressed delivery and replay do not fix the fact that `sseClients` lives in one Node process (§1.3(3)). The moment there are two Railway instances, the feed silently halves. With replay implemented (§7.1.2) the failure becomes *recoverable* — a client on the wrong instance can still catch up by polling — which is a meaningful improvement, but it is a mitigation, not a fix. The real fix is Postgres `LISTEN`/`NOTIFY` or Supabase Realtime as the cross-instance bus. **Not Phase 1**, but the replay endpoint should be built first precisely because it makes the single-process limitation survivable.

---

## 8. Presence and collision

### 8.1 What the two-person case actually needs

At two people, an activity feed is a *worse* solution to the real problem than collision detection is. The genuine daily pain in a two-person shared inbox is not "what did Dominic do yesterday", it is "**am I about to reply to something Dominic is already replying to, right now**". That is a presence problem, and it is solved by a much smaller feature.

This is worth saying plainly to the user: **if the goal is "the team works well together", collision detection is higher value per unit of effort than the activity feed, and it does not require the full auth programme** — it needs only a per-session identifier, which could be a display name chosen at login, well short of real accounts.

### 8.2 The three mechanisms, in order of value

1. **Viewing indicator** — "Dominic is viewing" on the conversation. Prevents most double-work. Cheap.
2. **Composing indicator** — "Dominic is replying…". Prevents the expensive case: two agents sending near-duplicate messages to a customer. This is the one that actually saves face with a client.
3. **Stale-reply guard** — on submit, if a newer message exists in the thread since the composer opened it, warn before sending. `[UNVERIFIED]` — this is understood to be the shape of Help Scout's "Traffic Cop", but the source article 404'd and it could not be confirmed. The mechanism stands on its own merits regardless: it is a server-side check with no presence infrastructure at all, it cannot produce a false negative from a dropped heartbeat, and it is by far the cheapest of the three to build. **Build this one first.**

### 8.3 Implementation

Supabase Realtime Presence is available and is the obvious candidate — `track()` / `untrack()`, with `sync`, `join` and `leave` events, and state stored as a merged map of client keys to payloads ([Supabase: Presence](https://supabase.com/docs/guides/realtime/presence)). Two warnings from that document apply directly:

- Presence is for "slow-changing state such as online/offline status, active document, or current page". Calling `track()` at high frequency "will flood the channel and cause performance problems"; use Broadcast for high-frequency updates ([same](https://supabase.com/docs/guides/realtime/presence)).
- `join`/`leave` can fire during state reconciliation without any real user movement, so the UI must be idempotent and must not animate on every event ([same](https://supabase.com/docs/guides/realtime/presence)).

Maximum clients per channel, payload size and message-rate limits are not stated in that document `[UNVERIFIED]`; at 10 users it is irrelevant.

**However — adopting Supabase Realtime means adding a second real-time transport alongside SSE**, on both web and (worse) iOS. For 10 users, presence over the existing SSE channel plus a TTL map is a fraction of the work:

```
POST /api/presence/heartbeat { conversation_phone, state: 'viewing'|'composing' }   every 10s
GET  /api/presence/:phone  →  [{ user_id, display_name, state, since }]
```

An in-memory `Map` with a **30-second TTL** (three missed heartbeats) and a broadcast on transition. It is perhaps 80 lines. It dies on redeploy, which for presence is completely acceptable — stale presence self-heals within 30 seconds. The same single-process caveat as §7.5 applies, and matters less here.

**Typing/composing debounce:** fire on first keystroke, refresh the TTL every 10 seconds while typing, clear after 30 seconds of inactivity or on send/blur. `[UNVERIFIED]` — I could not retrieve published production values for typing-indicator timeouts this session; 10s/30s is the widely used shape and is safe at our scale, but is not cited.

### 8.4 Assignment

Assignment is the structural fix that presence only papers over, and it is what makes a feed useful past about four people. Front makes `assign` / `unassign` first-class events ([Front Events API](https://dev.frontapp.com/reference/events)), and Linear's entire Inbox model is built on implicit subscription driven by assignment and mention ([Linear: Inbox](https://linear.app/docs/inbox)).

It does not exist here at all: there is no assignee column on `sms_contacts` and no concept of ownership anywhere in the schema (`00-current-state.md` §4).

Minimum viable version: `sms_contacts.assigned_to uuid references users(id)`, `assigned_at`, plus a filter in the conversation list. That alone converts the feed from "a log of everything" to "things relevant to me", which is the difference between a feature people use and wallpaper. **Recommendation: build assignment before, or at the same time as, the feed** — not after.

---

## 9. iOS considerations

### 9.1 Where it goes

**Not a tab.** `RootView.swift` already has a tab bar carrying a missed-call badge (`ios/ViciInbox/UI/RootView.swift:50`), and adding a fifth destination for a peripheral-awareness surface is the wrong trade. **A button in the inbox navigation bar, opening a sheet**, with a dot (not a count) when there is unread `act`-tier activity.

### 9.2 What pushes and what does not

This is the decision that determines whether the app gets deleted from a home screen.

**Push:**
- Missed call (already effectively covered by CallKit)
- Send failure on a message this user sent
- A conversation assigned **to this user**
- Contact opted out

**Never push:**
- Any `aware`-tier event. All of it. "Dominic replied to Sarah" is a notification about someone else's competence and it will be muted within a week, taking the useful notifications with it.
- Anything the receiving user caused
- Anything from the automation queue
- Login events

The rule: **a push is a request for action from this specific person.** If a reasonable person would not act on it within the hour, it belongs in the feed, silently.

### 9.3 Badge counts

The existing badge is a **single number for the whole app**, combining unread messages and unseen missed calls — this is explicit in `lib/apns-notify.js:175-192` and `ios/ViciInbox/App/MessageNotificationManager.swift:27-35`. **Do not add activity items to that number.** It currently means "things waiting for you", and diluting it with "things that happened" destroys the one signal that works. Use a dot on the activity entry point instead.

Missive independently arrived at the same rule and is worth quoting as precedent: only calendar reminders increment their app icon badge, by 1, "regardless of how many there are", while mentions and reactions appear in the feed and **never touch the badge** ([Missive](https://missiveapp.com/docs/core-features/activity-feed.md)). Their unread dot encodes urgency class in two colours — blue for mentions and reactions, orange for reminders — rather than counting anything ([same](https://missiveapp.com/docs/core-features/activity-feed.md)).

Note also that badge computation currently runs on every outbound message push (`lib/apns-notify.js:114-126`, `lib/missed-calls.js:41-62`), so anything added there has a per-message cost.

### 9.4 The constraint nobody should forget

Per §2.1: the iOS app cannot be built on the current machine, and releases go via GitHub Actions to TestFlight. **Every iOS change in this programme is slow and hard to roll back.** Design the server so that iOS is optional at every stage — the feed should be fully functional on web with the iPhone showing nothing new, and the iOS work should be a single release at the end rather than three iterative ones. Stages 1–3 of §2.6 are structured exactly this way.

---

## 10. Scope recommendation

### 10.1 The blunt version

**What was asked for is a three-week auth migration wearing a one-week feature as a hat.** The feature is genuinely good and worth building. But if it is scoped as "add an activity feed", it will be estimated at a week, and it will take a month, and most of that month will produce nothing demonstrable. Scope it as "add multi-user accounts, and then an activity feed", and the estimate becomes honest and the intermediate value becomes visible — because accounts are independently valuable for selling to 5–10 person teams, which is the stated commercial goal anyway.

There is also a real question worth putting to the user directly: **at two people, is the activity feed the right feature at all?** Section 8.1 argues it is not — collision detection and assignment solve more daily pain for less work. The feed's value scales with headcount; at 2 users it is close to zero, at 10 it is real. If the team is genuinely growing to 5–10 imminently, build it. If that is aspirational, build assignment and collision detection first and revisit.

### 10.2 Phases

**Phase 0 — Identity. (2–3 weeks. No user-visible feature.)**
Stages 1–4 of §2.6. Tables from §2.5. JWT verification middleware producing `req.actor`. Web login. iOS release. `user_devices` and per-user push. Rename `routes/activity.js` → `/api/automations` (§1.5). Fix the `SESSION_SECRET` fallback and split the admin bearer token off `INBOX_PASSWORD`.
*Exit criterion: the server can name the human behind every authenticated request, and both live users are on real accounts.*

**Phase 1 — Minimum genuinely useful feed. (1 week.)**
`activity_events` (§6.2–6.3). A `logActivity()` helper called from the human-driven call sites in §1.6. **Six event types only**: `message.sent`, `call.answered`, `call.missed`, `call.ended`, `automation.cancelled`, `contact.opted_out`. Addressed SSE with self-suppression and `Last-Event-ID` replay (§7.1). A right-rail feed on web. Read watermark. Nothing on iOS.
*Exit criterion: "Dominic replied to Sarah · 10m" and "Missed call from +1555… · 2m" both render correctly, and Dominic does not see his own actions.*

**Phase 2 — Make it not-noise. (1 week.)**
Batching (§4.2, 5-minute sliding window on `(actor, verb, target)`). Tiers. Per-conversation timeline interleaved into the thread. Filter by teammate and by event type. The Friday digest (§4.6).

**Phase 3 — Collaboration. (1–2 weeks.)**
Assignment (§8.4). Stale-reply guard, then viewing/composing presence (§8.2). Per-agent SIP credentials so `call.answered.answered_by` is populated (§2.6 stage 5).

**Phase 4 — Compliance. (1 week.)**
`audit_log` (§6.4), immutability (§6.5), retention by action class (§6.6), an owner-only audit view. Note this phase is *also* the natural home for the missing opt-out and consent records flagged in `00-current-state.md` §8, and is arguably more urgent than Phase 2 or 3 for the high-risk client.

### 10.3 Effort and confidence

| Phase | Estimate | Confidence |
|---|---|---|
| 0 — Identity | 2–3 weeks | **Low.** The iOS leg is the unknown. |
| 1 — Feed MVP | 1 week | High |
| 2 — Noise control | 1 week | High |
| 3 — Collaboration | 1–2 weeks | Medium. SIP provisioning is unscoped. |
| 4 — Compliance | 1 week | Medium |

**Total to a genuinely good feature: 6–8 weeks.** Only weeks 4–5 produce anything the user can see.

### 10.4 Risks, ranked

1. **The iOS auth migration is the highest-risk item in the programme.** The app re-authenticates by replaying a stored password on cold launch (`APIClient.swift:68-73`), and that path is load-bearing for answering VoIP calls from a locked phone. Breaking it means the phone stops ringing, which is a production incident for a live client. Compounded by the fact that the app cannot be built on the current machine. *Mitigation: keep the legacy password path as a fallback for one full release; ship stages 1–3 without touching iOS at all.*
2. **The feature is unbuildable-as-specified until Phase 0 lands**, and Phase 0 shows the user nothing. *Mitigation: say this up front. Ship web-only attribution (§2.6 stage 3) as the first visible milestone.*
3. **The fork.** Everything here lands in Vici. Shore gets none of it, and the auth layer is exactly the kind of cross-cutting change that makes the fork more expensive every week (`00-current-state.md` §7). *This programme is a forcing function for that decision, and choosing to build it twice should be an explicit choice, not a default.*
4. **The feed becomes wallpaper.** Mitigated by shipping six event types, not twenty-five. *Add events only when someone asks for a specific one.*
5. **Migrations are applied by hand and two have already been forgotten** (`00-current-state.md` §8). This feature adds four tables. *Mitigation: a real migration runner is now overdue; at minimum, replicate the `PGRST204`/`42703` defensive patterns already in `db.js:25-43` and `lib/missed-calls.js:22-33`.*
6. **Call attribution is blocked on Telnyx SIP provisioning**, which is external and unscoped. *Mitigation: ship `answered_by` nullable; "Call answered" without a name is still better than nothing.*
7. **Single-process SSE** silently halves the feed if the service ever scales to two instances (§7.5). *Mitigation: build the replay endpoint in Phase 1 so the failure is recoverable rather than silent.*
8. **Surveillance perception.** In a two-person team, a feed that logs everything one person does reads differently than it does at fifty. *Mitigation: no login events in the feed, no "opened conversation" events, and the owner should tell Dominic it exists before he discovers it.*

---

## 11. Open questions for the user

1. Is 5–10 people imminent, or aspirational? The answer changes whether this is the right next feature at all (§10.1).
2. Do client staff get accounts in *our* system, or does the client administer their own team? The invitation model differs (§2.5).
3. Is per-agent call attribution worth provisioning individual Telnyx SIP credentials, or is "someone answered" enough for now (§2.6 stage 5)?
4. Accountability or awareness? If the real goal is "what did Dominic do this week", a weekly digest is a fraction of the work and a better answer (§4.6).
5. Compliance timing — Phase 4 contains the audit log, and `00-current-state.md` §8 says Vici has no opt-out enforcement and no consent record today. Should that be pulled forward ahead of Phases 2 and 3?

---

## 12. Sources

**Prior art — Front**
- [Events API reference](https://dev.frontapp.com/reference/events) · [Get event (full `type` enum, `source`/`target` unions)](https://dev.frontapp.com/reference/get-event) · [List events (filters, `limit` max 15)](https://dev.frontapp.com/reference/list-events)
- [Audit log help article (365-day retention, export limits)](https://help.front.com/en/articles/2925696)
- [Audit logs changelog (plan availability, "delegation safety" framing)](https://community.front.com/product-updates/keep-track-of-admin-activity-with-audit-logs-2380)

**Prior art — Missive**
- [Activity feed (three event types, 30-day retention, badge behaviour)](https://missiveapp.com/docs/core-features/activity-feed.md)
- [Activity feed FAQ ("not meant to be another inbox")](https://missiveapp.com/docs/core-features/activity-feed/faq.md)
- [Conversations (system events inline in the stream)](https://missiveapp.com/docs/core-features/conversations.md)
- [REST API endpoints (no events endpoint)](https://missiveapp.com/docs/developers/rest-api/endpoints.md)

**Prior art — Linear**
- [Inbox (read/unread, snooze, 2,000-item cap, filters)](https://linear.app/docs/inbox)
- [Audit log (Enterprise, owners only, 90-day retention, exclude session events)](https://linear.app/docs/audit-log)
- [GraphQL docs (3-minute creation grace period)](https://linear.app/developers/graphql)
- [Webhooks (`updatedFrom`, `createdAt` vs `webhookTimestamp`)](https://linear.app/developers/webhooks)
- [Changelog (dedupe policy, agent-section grouping, regrouping-while-loading fix)](https://linear.app/changelog)

**Prior art — Intercom**
- [Conversation part model (`part_type` enum)](https://developers.intercom.com/docs/references/1.4/rest-api/conversations/conversation-part-model)
- [Conversation model (denormalised counters, timing statistics)](https://developers.intercom.com/docs/references/2.2/rest-api/conversations/conversation-model)
- [List activity logs (`activity_type` enum, `activity_description`)](https://developers.intercom.com/docs/references/2.9/rest-api/api.intercom.io/admins/listactivitylogs)
- [Webhook models (`entity.actor.verb` naming)](https://developers.intercom.com/docs/references/webhooks/webhook-models)
- [Conversations FAQ (`(part_type, author.type)` assignment matrix)](https://www.intercom.com/help/en/articles/8838326-conversations-faqs)

**Prior art — Help Scout, Crisp, Zendesk, Slack, GitHub**
- [Help Scout — List threads (`lineitem`, `action.text`, 100-thread cap)](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/)
- [Crisp — REST API v1 (`fingerprint`, `automated`, event namespaces)](https://docs.crisp.chat/references/rest-api/v1/) · [RTM API v1](https://docs.crisp.chat/references/rtm-api/v1/)
- [Zendesk — Audit Logs API (5-value `action`, denormalised rows, indefinite retention)](https://developer.zendesk.com/api-reference/ticketing/account-configuration/audit_logs/)
- [Zendesk — Ticket Audits (audit-contains-events, transaction grouping)](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/)
- [Zendesk — Ticket audit events reference (34-value `type` enum)](https://developer.zendesk.com/documentation/ticketing/reference-guides/ticket-audit-events-reference/)
- [Zendesk — Viewing the audit log](https://support.zendesk.com/hc/en-us/articles/4408828001434-Viewing-the-audit-log-for-changes-to-your-account)
- [Slack — Audit Logs API (envelope: actor/entity/context)](https://docs.slack.dev/admins/audit-logs-api/) · [Actions reference (600+ actions, `/schemas` and `/actions`)](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference/)
- [GitHub REST API — Notifications (`reason` values, thread schema)](https://docs.github.com/en/rest/activity/notifications)

**Technique and platform**
- [Knock — Batch function (batch windows, batch keys, `total_activities` / `total_actors`)](https://docs.knock.app/designing-workflows/batch-function)
- [Supabase — User sessions (JWT and refresh-token lifetimes)](https://supabase.com/docs/guides/auth/sessions)
- [Supabase — Auth rate limits (2 emails/hour built-in sender)](https://supabase.com/docs/guides/auth/rate-limits)
- [Supabase — Custom claims and RBAC](https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac)
- [Supabase — Realtime Presence](https://supabase.com/docs/guides/realtime/presence)
- [supabase/supabase-swift](https://github.com/supabase/supabase-swift)
- [supabase/supa_audit (archived Feb 2025)](https://github.com/supabase/supa_audit)
- [PostgreSQL — Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [use-the-index-luke.com — Keyset pagination vs OFFSET](https://use-the-index-luke.com/no-offset)
- [47 CFR § 64.1200 (Cornell LII) — do-not-call record retention, revocation timeframe](https://www.law.cornell.edu/cfr/text/47/64.1200)

**Could not be retrieved this session.** All corresponding claims are marked `[UNVERIFIED]` in the body, and none of them is load-bearing for a Phase 0 or Phase 1 decision.

| Gap | Why it failed | Matters for |
|---|---|---|
| **Agent-collision docs** — Front, Intercom, Help Scout Traffic Cop, Missive, Zendesk | Front's article 404s on both `help.frontapp.com` and `help.front.com`; Help Scout's Traffic Cop article 404s; Intercom's returned unrelated content | §8. The stale-reply guard recommendation stands on its own mechanics regardless. |
| **Height** — activity model, API shape | `ECONNRESET` across five attempts on `height.app/api-docs` and `api.height.app` | §3.10. A gap, not a finding. |
| **NN/g alert-fatigue research; feed read-rate data** | Web-search budget exhausted; direct URL 404'd | §4.6. The noise recommendations are reasoned from primary sources and product structure, not from engagement data. |
| **2026 pricing** — Clerk, WorkOS, Auth0, Stytch at ~10 seats | Web-search budget exhausted | §2.2 Option C. Price before choosing it. |
| **Retention** — Slack Audit Logs, Front Events API, Intercom activity logs | Not published on the retrieved pages | §6.6. Four comparable figures were obtained; these three would refine, not change, the recommendation. |
| **Supabase asymmetric JWT signing-key migration path** | Web-search budget exhausted | §2.4. **Confirm before implementing the verification middleware.** The only gap here with real implementation impact. |
| **`supabase-swift` default session storage** | Not stated on the README | §2.3. **Confirm before committing the iOS leg** — the VoIP cold-launch path needs `kSecAttrAccessibleAfterFirstUnlock` semantics specifically. |
