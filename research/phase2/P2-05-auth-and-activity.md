# P2-05 — Authentication, Identity, and the Activity Center: Implementation Plan

**Written:** 12 August 2026
**Status:** Implementation plan. No code written. Supersedes the *recommendations* of `research/ai-wizard/06-activity-center.md` §2 where they conflict; adopts its research wholesale everywhere else.
**Schema authority:** `research/phase2/P2-01-data-model.md`. Where this document specifies SQL it extends P2-01's tables and follows its conventions (§2). Two additive columns are proposed against P2-01 §3.3 and are called out explicitly in §1.6.
**Safety authority:** `research/phase2/P2-06-safety-and-testing.md`. The campaign approval gate and test-send gate in §5 are that document's, not this one's.
**Applies to:** `/Users/ghost/telynx-inbox` (Vici) and `/Users/ghost/shore-academy-inbox` (Shore Academy). See §10.

---

## 0. The three findings that change the plan

Doc 06 was written against a read of the code. This document was written against a closer read of the same code, and three of its conclusions do not survive.

**Finding 1 — the VoIP cold-launch path never touches the HTTP session.** Doc 06 §1.2 and §10.4 rank "the iOS auth migration could stop the phone ringing" as the highest risk in the programme, on the basis that `restoreSessionIfNeeded()` (`ios/ViciInbox/Core/APIClient.swift:70-74`) is load-bearing for answering a call on a locked phone. It is not. The push path is `AppDelegate.swift:96-106` → `TelnyxVoiceManager.handleVoIPPush(payload:)` (`:348`) → `handleVoIPPush(metadata:)` (`:390`) → `startSDKForPush(metadata:)` (`:475`), and that last function reads `CredentialStore.cachedSIPCredentials` **synchronously from the Keychain at `:476`**. There is no network call, no `/auth/check`, no `/api/voice/token`, and no cookie anywhere in it. The code says so itself at `TelnyxVoiceManager.swift:311-313`: *"Push-woken launches do not use this method; startSDKForPush reads the Keychain synchronously so CallKit can be reported immediately."* Section 3 works through the consequences. The short version: an expired session cannot stop a phone ringing, and the only thing that can is a code path we would be adding ourselves.

**Finding 2 — Supabase Auth buys us almost nothing here, and the two flagged blockers are the evidence.** Doc 06 §2.3 recommends Supabase Auth as an identity provider only, keeping the service-role key and skipping RLS, and then attaches two conditions: wire custom SMTP because the built-in mailer is capped at 2 emails/hour, and verify `supabase-swift`'s session storage against the cold-launch path. Having read the code, the honest observation is that once you strip RLS, strip client-side Supabase, and keep the service key, the *entire* remaining value of Supabase Auth is password hashing, a reset email, and refresh-token rotation. We do not need refresh rotation — `cookie-session` already gives a 30-day cookie that survives cold launch and Railway redeploys (`server.js:54-61`). The reset email is the thing that is capped. Password hashing is one npm package. §1 argues the revision in full: **do not adopt Supabase Auth in v1.** Keep P2-01's `sms_users.auth_user_id uuid unique` nullable column as the seam, and adopt Supabase Auth later if and when SSO or self-serve signup is actually required. This dissolves both blockers rather than mitigating them.

**Finding 3 — Shore and Vici are on different Supabase projects.** Vici is `cckzshsvchhsfsnbycoj.supabase.co`; Shore is `hbwwvhslumwdyhgnilrr.supabase.co`. Every migration in this plan runs twice against two databases no matter what is decided about code sharing. That reframes §10: the question is not "how do we avoid doing the SQL twice" (we cannot) but "how do we avoid *writing* the code twice", and the answer is easier than expected because `routes/auth.js` is **byte-identical** between the two repos today.

Net effect on the estimate: doc 06's 6–8 weeks, with only weeks 4–5 visible, becomes **4–5 weeks with something visible in week one**. §11.

---

## 1. The auth decision, finalised

### 1.1 What the code actually requires

Five constraints fall out of the read, and they are what the decision has to satisfy.

| # | Constraint | Evidence |
|---|---|---|
| C1 | Every data access already goes through the service-role key and will continue to. RLS is out of scope. | `db.js:4-8`; P2-01 §2 (`alter table … disable row level security` on every new table) |
| C2 | The session transport that works on both clients today is a signed cookie. iOS relies on `URLSession`'s shared `HTTPCookieStorage`. | `server.js:54-61`; `APIClient.swift:37-42` |
| C3 | The iOS binary cannot be built on this Mac. Every client change is a GitHub Actions → TestFlight round trip. | project memory; `.github/workflows/ios-testflight.yml` in both repos |
| C4 | `sms_users.auth_user_id` is already specified as **nullable** and unique, precisely so the Supabase Auth decision can be deferred. | P2-01 §3.3 |
| C5 | Exactly one user row must exist with no external identity at all: the `is_legacy_shared` "Team" placeholder. | P2-01 §3.3 |

C4 and C5 together are the tell. P2-01 already designed the identity table so that Supabase Auth is optional. Taking the option costs a dependency; declining it costs a `password_hash` column.

### 1.2 The revision, stated plainly

**Adopt local password authentication against `sms_users`, carried by the existing `cookie-session` cookie. Do not adopt Supabase Auth in v1.**

The session payload changes from `{ authenticated: true }` to `{ authenticated: true, uid: <bigint>, role: <text>, v: 1 }`. Nothing else about the transport changes: same cookie name, same secret, same `maxAge`, same `sameSite`, same middleware. That last point is not cosmetic — P2-06 §7.3 step 4 warns that changing the cookie `name`, `secret`, or `sameSite` at `server.js:54-61` invalidates every existing session, including the one on a phone that is currently able to take calls. This plan changes none of the three.

### 1.3 Why, weighed honestly

**What Supabase Auth would have given us, and what it actually costs here:**

| Feature | Value to this product | Verdict |
|---|---|---|
| Refresh-token rotation | The single strongest argument in doc 06 §2.3, and it is aimed at a problem we do not have. The 30-day cookie already survives weeks of backgrounding and cold launch. Rotation matters when access tokens are short-lived; ours is not a token. | Not needed |
| Password reset by email | Real, but capped at **2 emails/hour project-wide** without custom SMTP. At 2–10 users the alternative — an admin sets a temporary password — is not a worse product, it is a smaller one. P2-01 §11.6 makes the identical argument for dropping `invitations`. | Deferred (§6) |
| Password hashing | `argon2` or `bcrypt`, one dependency, one column. | Trivially replaceable |
| Hosted UI, MFA, SSO | Genuinely valuable at 50+ seats or the first enterprise buyer. | Not now |
| RLS integration | Explicitly out of scope (C1). | Zero value |

**What adopting it would have cost:**

- A `supabase-swift` dependency in **two** iOS apps, added blind. Doc 06 flags that its default session storage is undocumented and that our path needs `kSecAttrAccessibleAfterFirstUnlock` specifically (`CredentialStore.swift:30-33`). Under C3, "add an SPM dependency and find out on the device" is a multi-day TestFlight loop per attempt, times two apps.
- A second session concept living alongside the cookie, with two expiry models to reason about on the one code path (voice) where being wrong is a production incident for a live client.
- Custom SMTP wired before the first invite, which is real work that buys us an email we can send by other means.
- An unresolved implementation question doc 06 marks as the only gap with real impact: the current migration path from the legacy HS256 shared secret to asymmetric signing keys (doc 06 §12, "Confirm before implementing the verification middleware"). That is unresolved research standing between us and a login screen.

**What we take on by declining it:** password storage (one library, one column), password reset (admin-set, §6), brute-force rate limiting (`express-rate-limit` is already a dependency and already configured at `server.js:68-72`), and MFA whenever it is asked for. At two users growing to ten, with an owner who can reset a colleague's password over the phone in ten seconds, that is the smaller liability.

**The reversal path, so this is not a one-way door.** `sms_users.auth_user_id uuid unique` stays in the schema, unused and null. Adopting Supabase Auth later means: create `auth.users` rows, populate `auth_user_id`, add a second branch to the login handler that accepts a Supabase JWT, and delete `password_hash`. It is one afternoon, and it is the same afternoon P2-01 R12 quotes for retrofitting `org_id`. The cost of being wrong here is bounded and known.

### 1.4 The two flagged blockers, closed

**Mailer cap (2 emails/hour).** Dissolved. No transactional email is sent by the auth system in v1. Onboarding is admin-created accounts with a temporary password delivered out of band (§6.1). When email invites are eventually wanted, wire custom SMTP *then* — it is a self-contained change with no dependency on anything in this plan.

**`supabase-swift` session storage.** Dissolved. No `supabase-swift`. iOS keeps `CredentialStore` (`ios/ViciInbox/Core/CredentialStore.swift`), which is 87 lines, already uses `kSecAttrAccessibleAfterFirstUnlock` deliberately (`:30-33`), and is already proven against the cold-launch path in production. The only change is the *contents* of one Keychain key. §3.

### 1.5 What "identity" means concretely after this

```
requireAuth(req, res, next):
  1. if (!req.session?.authenticated) → 401
  2. if (req.session.uid) → load sms_users row (60s in-process cache, keyed by uid)
       - if row missing or is_active = false → destroy session, 401
       - req.actor = { userId, role, displayName, isLegacyShared: false }
  3. else (legacy shared-password session, no uid)
       - req.actor = LEGACY_ACTOR   // the is_legacy_shared "Team" row, cached at boot
  4. next()
```

`req.actor` is never null inside an authenticated route. That single invariant is what makes all sixteen call sites in §4 a one-line change each. Branch 3 is what makes the migration non-breaking: a session cookie minted before this deploy has no `uid`, and it keeps working, attributed to "Team".

A parallel `requireRole('admin')` composes on top and is a five-line function. §5.

### 1.6 Two additive columns against P2-01 §3.3

P2-01's `sms_users` needs two columns it does not currently specify. Both are additive, neither conflicts with anything in that document, and both belong in `scripts/P2-03-identity.sql` alongside the rest of the table.

```sql
alter table sms_users add column if not exists password_hash    text;
alter table sms_users add column if not exists password_set_at  timestamptz;
```

`password_hash` is nullable because the `is_legacy_shared` "Team" row must never be loggable-into (P2-01 §3.3, C5 above) and because an admin-created account exists before its password is set. `password_set_at` is what the audit log records on a reset (§9) and what a future "password is 400 days old" nudge would read. A `NULL` hash means **cannot log in**, enforced in the handler, not just by the absence of a value.

Everything else this plan needs already exists in P2-01: `role` with its `check (role in ('owner','admin','agent'))`, `is_active`, `is_legacy_shared`, `phone` (load-bearing for the test-send gate, P2-06 §2.1), `last_seen_at`, and the whole of `sms_user_devices`.

### 1.7 Two independent defects to fix in the same change

Neither is caused by this work; both are cheap to fix while the file is open, and both are made worse by adding real accounts.

1. **`server.js:56` falls back to the string literal `'fallback-secret-change-this'` when `SESSION_SECRET` is unset.** With a boolean-only session this is a forgery risk. With `{ uid, role }` in the session it becomes a **privilege-escalation** risk: a forged cookie asserts a role. Change the fallback to a hard `process.exit(1)` at boot with a named error, matching Shore's `lib/startup-check.js` pattern. Do this in Stage 1, before any role is ever read from a session.
2. **`routes/admin.js:20-29` accepts `Authorization: Bearer <INBOX_PASSWORD>` — the same secret as the user login — and at `:23` returns `next()` unconditionally when `INBOX_PASSWORD` is unset.** Those endpoints bulk-send real SMS to real customers. Split it onto its own `ADMIN_API_TOKEN`, and change the no-password branch from allow to **deny**. Stage 6, or earlier if convenient; it is orthogonal to everything else here.

---

## 2. The migration, stage by stage

Six stages, retaining doc 06 §2.6's shape and its central property: **stages 1–3 deliver an attributed feed on web with no iOS release.** What changes is that stage 4 shrinks from "adopt a token SDK" to "change three lines and one Keychain key".

The two live users are Lubosi (owner) and Dominic (client, admin). Neither may be logged out at any point. Calling must never break.

### Stage 1 — Add the tables and the dual-path login. Server only.

**SQL:** `scripts/P2-03-identity.sql`, per P2-01 §9.2 file 03, plus §1.6's two columns.

```sql
-- (P2-01 §3.3 sms_users, §3.4 sms_user_devices, actor columns on
--  sms_messages / sms_scheduled / call_logs — reproduced there, not here)

alter table sms_users add column if not exists password_hash   text;
alter table sms_users add column if not exists password_set_at timestamptz;

-- C5: the placeholder that legacy sessions attribute to. No password, ever.
insert into sms_users (email, display_name, role, is_legacy_shared, password_hash)
values ('legacy@vici.local', 'Team', 'admin', true, null)
on conflict (email) do nothing;

-- The two real humans. Hashes set by scripts/set-password.js, never in SQL.
insert into sms_users (email, display_name, role) values
  ('lubosi@…',  'Lubosi',  'owner'),
  ('dominic@…', 'Dominic', 'admin')
on conflict (email) do nothing;

insert into schema_migrations (filename) values ('P2-03-identity.sql')
  on conflict do nothing;
notify pgrst, 'reload schema';
```

**Code changes:**

| File | Change |
|---|---|
| `routes/auth.js:3-11` | `POST /login` accepts `{ email, password }` **and** the existing `{ password }`. Email branch: look up `sms_users` by lower(email), require `is_active`, require non-null `password_hash`, `argon2.verify`, then set `req.session = { authenticated: true, uid, role, v: 1 }`. Password-only branch: unchanged, sets `{ authenticated: true }` with no `uid`. |
| `routes/auth.js:18-20` | `GET /check` returns `{ authenticated, user: { id, displayName, role } \| null }`. Additive; the existing `authenticated` key keeps its meaning, so both shipped clients keep working. |
| `server.js:63-66` | `requireAuth` gains the §1.5 actor resolution. Still returns 401 on the same condition it does today — the 401 surface does not move. |
| `server.js:56` | `SESSION_SECRET` fallback → boot failure (§1.7). |
| `lib/actor.js` *(new)* | `resolveActor(session)`, the 60-second cache, and `LEGACY_ACTOR`. |
| `scripts/set-password.js` *(new)* | CLI: `node scripts/set-password.js <email>`, prompts, writes `password_hash` + `password_set_at`. Never a route in v1. |
| `package.json` | `+ argon2` (or `bcrypt` if the Railway build image makes native compilation awkward — check before choosing). |

**Verification:** `GET /auth/check` with an existing browser cookie returns `authenticated: true, user: null`. `POST /auth/login {password}` still 200s. `POST /auth/login {email,password}` 200s and the subsequent `/auth/check` returns the user object. `POST /webhooks/voice` still returns 200 unauthenticated (P2-06 §7.3 step 1). `GET /api/voice/token` still 401s without a session and 200s with one (step 2).

**Rollback:** revert the deploy. The tables are inert — nothing reads them yet. `git revert` on one commit; the SQL can stay applied.

**What the two users experience:** nothing. No visible change on web or iPhone. Both are still on the shared password.

**Lockout risk:** none, provided the cookie config at `server.js:54-61` is untouched. That is the one line-range in this stage that must not be edited. Call it out in the PR description.

### Stage 2 — Attribute everything, start writing the feed. Server only.

**SQL:** `scripts/P2-07-activity-and-audit.sql` (P2-01 §3.16, §3.17, §9.2 file 07). No changes to it from this document.

**Code changes:**

- `lib/activity.js` *(new)* — `logActivity({ actor, verb, tier, target, description, payload, fingerprint, batchKey })`. Persist first, broadcast second (doc 06 §7.1.3). Wrapped in `try/catch` that logs and swallows: **a feed write must never fail a send.**
- `lib/audit.js` *(new)* — `logAudit({ actor, action, entity, before, after, req })`. Deliberately *not* swallowing for the consent-bearing subset; see §9.3.
- The six launch call sites from §7.1 gain one `logActivity()` line each.
- `routes/send.js:39-48` gains `actor_user_id: req.actor.userId` in the `insertSmsMessage` payload. **This column must not go into `db.js:25`'s `MIGRATION_COLUMNS`** — P2-01 §4.2 states the rule for the compliance columns and the same reasoning applies here for a weaker reason (a silently dropped actor is a lie in the feed). If the column is missing, the send should fail loudly; that is what tells you the migration was not applied.
- Rename `routes/activity.js` → `routes/automation.js`, mounted at `/api/automation` per P2-01 §2. Keep `/api/activity/*` as aliases to the same router for one release, because `public/app.js` is a compiled artefact and a missed call site will not fail at build time. The shipped iOS app calls `/api/activity/stats`, `/queue`, `/recent`, and `DELETE /queue/:id` (`APIClient.swift:205-224`) — **the aliases are what stop this stage requiring an iOS release.** Do not drop them until the iOS app that calls `/api/automation` is the minimum shipped version.

**Verification:** send a message from web on the shared password. Confirm one `sms_activity_events` row with `actor_label = 'Team'`, `actor_user_id` = the legacy row's id, `verb = 'message.sent'`, and a populated `description`. Confirm `sms_messages.actor_user_id` is set. Confirm the iOS app's automations tab still loads (it is hitting the aliases).

**Rollback:** revert. The feed table can keep its rows; nothing renders them yet.

**What the users experience:** still nothing visible. The feed is accumulating rows attributed to "Team".

**This is the stage that makes the whole thing degrade gracefully.** Every action from here on is attributed to *something*, so no history is lost while people are still on the shared password.

### Stage 3 — Migrate the two humans. No deploy.

Lubosi runs `node scripts/set-password.js` twice. Each person logs in once on web with email and password. Their next request carries `uid`, and everything they do from that moment is attributed to them by name.

The web login form gains an email field. The password-only form stays, unlabelled or behind a "use shared password" link, and keeps working.

**Verification:** Dominic sends a message from the web app. The row reads "Dominic replied to …". Lubosi's browser, still on the old cookie, keeps working and attributes to "Team" until he logs in.

**Rollback:** there is nothing to roll back. If email login misbehaves, both users still have the shared password.

**What the users experience:** the first visible change of the whole programme. One login, and the feed starts saying their name.

**Lockout risk:** the only one in the stage is a typo in an email address, which is recoverable by re-running the script or by using the shared password. Do not disable the shared-password branch here. That is stage 6.

### Stage 4 — iOS release. Both apps.

This is the stage doc 06 ranks as most dangerous. Under the §1.2 revision it is a small diff. Full treatment in §3; the change list is:

| File (× 2 apps) | Change |
|---|---|
| `Core/CredentialStore.swift` | Add `case inboxEmail = "inbox_email"` to the `Key` enum (`:12-17`). Add it to the `clearAll()` array (`:79`). Nothing else. |
| `Core/APIClient.swift:48-58` | `login(password:)` → `login(email:password:)`. Post `{email, password}`. On success store both. |
| `Core/APIClient.swift:70-74` | `restoreSessionIfNeeded()`: if `isAuthenticated()` → true. Else if email+password present → `login(email:password:)`. **Else if only a legacy password is present → `login(password:)` against the still-live legacy branch.** Three lines, one fallback. |
| `UI/LoginView.swift` | Add an email field above the password field. |
| `App/SessionModel.swift:42-54` | `signIn(email:password:)`. Body otherwise unchanged. |

**The fallback at `restoreSessionIfNeeded()` is what makes a bad rollout survivable.** A device that upgrades and never sees the new login screen still has `inbox_password` in its Keychain and still logs in. Keep that branch for one full release after stage 6 removes the server-side legacy path — at which point it becomes dead code that fails harmlessly, not a lockout.

**What is deliberately NOT changed:** `TelnyxVoiceManager.swift` (all 935 lines), `AppDelegate.swift`, `CallKitCoordinator.swift`, the `kSecAttrAccessible` value, and the cookie handling in `APIClient.init()` (`:35-43`). The voice stack is untouched by this stage. That is the point of the design.

**Verification:** P2-06 §7.3 in full, steps 1–7, on a device that was **already logged in before the upgrade** — not a fresh install. Step 4 exists precisely because a fresh install re-authenticates and hides the bug.

**Rollback:** TestFlight allows expiring a build and re-promoting the previous one. The previous binary posts `{password}` to a login handler that still accepts it, because stage 6 has not run. **Do not run stage 6 until the new build has been the only build in the field for at least two weeks.**

**Lockout risk:** the real one is not the code, it is ordering. If stage 6 ships before stage 4 reaches every device, an un-upgraded phone can no longer authenticate. It still takes calls (§3.2) but stops logging them and stops syncing messages. Gate stage 6 on a check of `sms_user_devices.last_seen_at` for every enabled device.

### Stage 5 — Per-agent SIP credentials. Optional; see §4.3.

Deferred. `call_logs.answered_by_user_id` ships nullable per P2-01 §4.5, and the feed renders "Call answered" without a name until this is done. §4.3 argues it is not worth doing at two users.

### Stage 6 — Retire the shared password.

Delete the `{ password }` branch from `routes/auth.js`. Split `ADMIN_API_TOKEN` off `INBOX_PASSWORD` and flip `routes/admin.js:23` from allow-on-missing to deny-on-missing (§1.7). Set `sms_users.is_active = false` on nothing — the "Team" row stays, forever, because historical `sms_activity_events` and `sms_messages` rows point at it.

**Preconditions, all of them:** every human has a password set and has logged in at least once; every enabled row in `sms_user_devices` has a `last_seen_at` after the stage-4 release date; the stage-4 build has been the only build in the field for two weeks.

**Rollback:** re-add the branch. Keep `INBOX_PASSWORD` set in Railway for a further month after this stage so the rollback is a deploy, not a scramble.

### Stage summary

| Stage | Deploy | iOS release | Visible to users | Lockout risk | Calling risk |
|---|---|---|---|---|---|
| 1 Tables + dual login | Server | No | No | None | None |
| 2 Attribution + feed writes | Server | No | No | None | None |
| 3 Humans migrate | None | No | **Yes — names appear** | None | None |
| 4 iOS login change | — | **Yes ×2** | Yes — email field | Low (fallback) | **See §3** |
| 5 Per-agent SIP | Server | No | Marginal | None | Medium — deferred |
| 6 Retire shared password | Server | No | No | **Real if mis-ordered** | Indirect |

---

## 3. iOS auth changes

Two apps, two bundle identifiers, two Keychain services, two TestFlight pipelines:

| | Vici | Shore |
|---|---|---|
| Bundle ID | `com.vicipeptides.inbox` (`ios/project.yml:47`) | `com.theshoreacademy.inbox` |
| Keychain service | `com.vicipeptides.inbox` (`CredentialStore.swift:10`) | `com.theshoreacademy.inbox` (`CredentialStore.swift:12`) |
| Cookie | `vici_sess` (`server.js:55`) | `shore_sess` (`server.js:52`) |
| CallKit name | "Vici Inbox" | "Shore Academy" |
| Backend | `web-production-2551e.up.railway.app` | `web-production-6fd6a.up.railway.app` |

Separate Keychains and separate cookies mean the two apps cannot interfere with each other. Each needs its own TestFlight round trip.

**One latent bug worth fixing while in there:** Shore's `APIClient.swift:235` still sends the header `X-Vici-Client: ios`. It works, because Shore's `routes/voice.js:13` reads `x-vici-client` too — the header name was never renamed on either side. Leave both as-is or rename both in the same commit; renaming one silently disables calling on Shore with a 403 from `routes/voice.js:14-17`.

### 3.1 The VoIP question, answered

**Conclusion: a stale or expired session cannot stop a VoIP call from ringing or from being answered. The path is fully decoupled from HTTP authentication.**

Traced end to end:

1. `AppDelegate.pushRegistry(_:didReceiveIncomingPushWith:for:completion:)` — `AppDelegate.swift:96-106`. Synchronous, main queue.
2. `TelnyxVoiceManager.handleVoIPPush(payload:)` — `:348-366`. Parses the payload, routes cleanup pushes, calls through.
3. `handleVoIPPush(metadata:)` — `:390-471`. Calls `startSDKForPush(metadata:)` **first**, then reports to CallKit.
4. `startSDKForPush(metadata:)` — `:475-494`. Line `:476` is `guard let creds = CredentialStore.cachedSIPCredentials`. Keychain, synchronous, `kSecAttrAccessibleAfterFirstUnlock`. Then `telnyxClient.processVoIPNotification(...)`.
5. `CallKitCoordinator.reportIncomingCall(...)` — the phone rings.
6. User answers → `callKitAnswer(action:)` at `:851-860` → `telnyxClient.answerFromCallkit(answerAction:)`.

No step calls `APIClient`. No step reads a cookie. The author left the reason in a comment at `:311-313`.

Two adjacent paths are also more robust than doc 06 assumes:

- **Foreground reconnect.** `resolveCredentials()` (`:310-318`) tries `fetchSIPCredentials(allowCachedFallback: false)` and, on any failure including a 401, falls through to `CredentialStore.cachedSIPCredentials`. A dead session degrades to "cannot pick up a credential rotation", not "cannot connect".
- **`fetchSIPCredentials(allowCachedFallback: true)`** (`APIClient.swift:244-279`) returns cached credentials on session-restore failure (`:245-248`), transport failure (`:260-263`), and non-200 (`:264-267`). Three separate fallbacks to the same Keychain value.

**What does actually break when the session is stale:**

| Symptom | Mechanism | Severity |
|---|---|---|
| Call log rows go missing | `logCall` (`APIClient.swift:283-296`) does `_ = try? await post(...)`. A 401 is a *successful* HTTP round trip, so `try?` does not catch it and the 401 is discarded silently. `logCompletedCall` (`TelnyxVoiceManager.swift:604-631`) never learns. | Medium — silent data loss, and it looks like a webhook problem |
| SIP credential rotation stops propagating | `resolveCredentials()` falls back to cache indefinitely | Low — only matters when rotating |
| Inbox/messages stop syncing | Every `decodedGET` throws `.unauthorised` | High but **visible**, which is the saving grace |
| Push registration goes stale | `MessageNotificationManager.enableAndSync()` 401s | Medium |

None of those stops the phone ringing.

### 3.2 The one thing that would stop the phone ringing — and we would be adding it

`SessionModel.signOut()` (`SessionModel.swift:56-68`) does, in order: `disablePushNotificationsAndWait()` (which tells Telnyx to stop pushing to this device), `unregisterFromBackend()`, `voice.disconnect()`, `APIClient.logout()`, and then **`CredentialStore.clearAll()`** at `:66`, which per `CredentialStore.swift:78-80` deletes `sip_user`, `sip_password`, and `caller_number`.

After that call, `startSDKForPush` at `:476` returns `false`, `handleVoIPPush` reports the call to CallKit and immediately ends it (`:462-467`), and the phone does not ring. That is correct behaviour for a deliberate sign-out and catastrophic for anything else.

**Therefore, three hard rules for the stage-4 diff. These are the whole of the risk.**

1. **No authentication failure may ever call `signOut()`.** Not a 401, not a failed `restoreSessionIfNeeded()`, not an expired cookie, not a "user not found". A 401 surfaces a "signed out — tap to sign in" banner in the UI and *nothing else happens*. The Keychain is not touched.
2. **`CredentialStore.clearAll()` must be reachable only from an explicit user tap on Sign Out.** Add a comment saying so above `:78`, because it is the kind of thing that gets reused for convenience later.
3. **`disablePushNotificationsAndWait()` must never be called from a non-interactive path**, for the same reason: it is the other half of "the phone stops ringing", and it takes effect at Telnyx, server-side, where a client-side rollback cannot undo it.

Add these three as an explicit checklist item in the PR template for `ios/`.

### 3.3 Token storage, refresh, and expiry — the honest answers

Because there is no token, most of the question dissolves. For completeness:

- **Storage.** `CredentialStore`, service-scoped per app, `kSecAttrAccessibleAfterFirstUnlock`. Two new-or-changed keys: `inbox_email` (new) and `inbox_password` (now holds the user's own password, not the shared one). Both `kSecClassGenericPassword`. The SIP credentials keep their own three keys, untouched.
- **Refresh.** None. The cookie has a 30-day `maxAge` (`server.js:60`) and `cookie-session` re-issues `Set-Cookie` on every response that touches the session, so an app used at least once a month never expires. If it does expire, `restoreSessionIfNeeded()` replays the stored credential exactly as it does today — the mechanism does not change, only the payload.
- **Expiry while backgrounded.** iOS holds no live connection to the backend (there is no `EventSource` anywhere in `ios/`), so nothing detects the expiry until the next request. The next request is either a foreground refresh (`SessionModel.refreshConnection()`, `:72-78`), which re-logs in silently, or a `logCall` (which silently fails, per §3.1). Neither wakes the user, and neither breaks CallKit.
- **VoIP push on a locked phone with a stale session.** Rings, connects, works. Only the post-call `POST /api/voice/logs` is lost. §4.3 proposes a small fix for that independently of auth.

### 3.4 One improvement worth making while the file is open

`logCall` (`APIClient.swift:283-296`) swallows 401s and drops the row. Change it to attempt `restoreSessionIfNeeded()` once on a 401 and retry, then give up. Six lines, and it converts the highest-frequency silent failure in the whole app into a self-healing one. Do it in the stage-4 release; it is unrelated to auth correctness but it is in the same file and the same TestFlight cycle.

---

## 4. Attributing the sixteen actor-less sites

Doc 06 §1.6 catalogued sixteen. P2-01 §4 and §8 already specify the columns for most. This table is the complete resolution: what column, where the actor comes from, and whether it is backfillable.

| # | Site | Column | Actor source | Backfillable? |
|---|---|---|---|---|
| 1 | Outbound SMS/MMS — `routes/send.js:39-48` | `sms_messages.actor_user_id` (P2-01 §4.2) | `req.actor.userId` | **No.** 2,283 historical rows stay NULL, which honestly means "unknown". Do not backfill to "Team" — it asserts a fact. |
| 2 | Reaction/tapback — `routes/react.js:31` | none | — | **Nullable forever.** Audit tier only (doc 06 §4.4). Not worth a column. |
| 3 | Conversation read — `routes/conversations.js:76-78` | none in Postgres | `req.actor.userId` → in-memory presence map (§8) | **No, and deliberately not persisted.** This is the collision-detection signal, not a feed event. See §8. |
| 4 | Automation cancelled — `routes/activity.js:89-125` | `sms_scheduled.cancelled_by` + `cancelled_at` (P2-01 §4.3) | `req.actor.userId` | No. 602 rows; historical cancellations stay NULL. |
| 5 | Missed-call badge cleared — `routes/voice.js:80-86` → `lib/missed-calls.js` | none | — | **Nullable forever.** The badge is global by explicit design (`lib/missed-calls.js:10-13`). Making it per-user is a separate feature and is not worth doing at two users. |
| 6 | Call answered — `routes/voice-webhook.js:217-228` | `call_logs.answered_by_user_id` (P2-01 §4.5) | **Unknowable today.** §4.3. | No. Ships NULL. |
| 7 | Call outcome from the phone — `routes/voice.js:99-165` | `call_logs.initiated_by_user_id` (P2-01 §4.5) | `req.actor.userId` on the `POST /api/voice/logs` request | No. **This is the strongest interim signal available** and it is free once stage 1 lands. Note `body.source === 'ios'` (`:108`) is a platform, not a person, and stays that way. |
| 8 | Shared SIP identity — `routes/voice.js:11-32`, `lib/voice-credentials.js:10-20` | — | — | §4.3. |
| 9 | Contact created/edited — `routes/contacts.js:92`, `:149` | none | — | **Nullable forever** for the column; log to `sms_audit_log` instead. No feed event (doc 06 §4.4 excludes it). |
| 10 | Media uploaded — `routes/upload.js:22` | none | — | **Nullable forever.** The upload is only meaningful as part of the message that carries it, which is attributed at #1. |
| 11 | Bulk catch-up send — `routes/catchup.js:56` | `sms_messages.actor_user_id` per message | `req.actor.userId` | No. Vici only; Shore has no `catchup.js`. **Also gains a `requireRole('admin')` (§5).** |
| 12 | CRM/commerce sync — `routes/sync.js:10,24,41,61,90` | none | — | **Nullable forever** for the column; `sms_audit_log` row with `actor_type='user'` for the human who pressed the button, since the sync itself is `integration`. Vici only. |
| 13 | AI campaign dismissed/sent — `routes/intelligence.js:27,33` | superseded by `sms_campaigns.created_by` / `approved_by` (P2-01 §3.10) | `req.actor.userId` | N/A — the current tables have 1 row each and P2-01 §4.7 says do not build on them. Vici only. |
| 14 | Admin backfills — `routes/admin.js` | `sms_audit_log` only | the `ADMIN_API_TOKEN` bearer → `actor_type='system'`, `actor_label='admin-api'` | No. **Machine-to-machine; there is no human to name**, and pretending otherwise would be worse than an honest `system`. |
| 15 | Push registration — `routes/mobile-push.js:28`, `routes/push.js:12` | `sms_user_devices.user_id` (P2-01 §3.4) | `req.actor.userId` at registration time | **Partly.** P2-01 §9.2 file 03 copies the 6 existing `push_subscriptions` rows in with `user_id = null`. They self-heal on the next registration after stage 4. |
| 16 | Push delivery — `push-notify.js:12`, `lib/apns-notify.js:~140` | query becomes `where user_id <> $excludeUserId` | `req.actor.userId` of the causing action | N/A — a code change, not a column. **Requires `user_id` to be populated, so it is gated on stage 4.** Until then, keep fanning out to all. |

**Summary: seven of sixteen get a real actor column; three are resolved to the audit log instead; five are nullable forever with a stated reason; one (#6) is blocked externally.** That is a better outcome than doc 06 implies, because P2-01 already put most of the columns in place.

### 4.1 What NOT to do

Do not backfill any actor column to the "Team" placeholder. `NULL` in `sms_messages.actor_user_id` on a row from March 2026 means "we did not record this", which is true. `actor_user_id = <Team>` means "the shared account did this", which is an inference dressed as a fact and will be read as one in a year. P2-01 §9.4 makes exactly this argument about the consent backfill and it applies verbatim here.

The distinction that matters: the **feed** attributes to "Team" going forward, because a feed row needs a subject and "Team" is honest about the ambiguity. The **columns** stay NULL for history, because a NULL is honest about the absence.

### 4.2 The `db.js` interaction

`db.js:25` lists `MIGRATION_COLUMNS = ['media_urls', 'reply_to_message_id', 'reactions']` and strips them on `PGRST204`. P2-01 §4.2 rules that `consent_event_id` and `suppression_checked_at` must never join that list. **`actor_user_id` must not either.** The reasoning is weaker but the same in kind: a silently-dropped actor produces a feed that is wrong rather than absent, and the failure is invisible. If the column is missing, let the insert throw — the loud failure is the signal that `P2-03-identity.sql` was not applied.

### 4.3 The voice problem: per-agent SIP credentials

`GET /api/voice/token` (`routes/voice.js:11-32`) returns one login/password pair from `lib/voice-credentials.js:10-20` to every iOS device. Both devices register to Telnyx as the same SIP user. When a call arrives, Telnyx forks it to every registration and the first to answer wins. **Telnyx cannot tell us which one**, because at the SIP layer there is only one identity.

Fixing it means: provisioning N Telnyx SIP credentials, storing the mapping on `sms_users`, returning the caller's own from `/api/voice/token`, and reading the answering leg's SIP user off the `call.answered` webhook. Estimate: 3–5 days including Telnyx-side provisioning that is unscoped and external.

**Recommendation: do not do it now. Ship `answered_by_user_id` nullable.**

1. At two users, "a call was answered" plus "Dominic's phone posted the call log" (#7, free from stage 1) resolves the question in practice for essentially every call. The residual ambiguity is two people answering different calls in the same minute, which at ~8 calls/month is a rounding error.
2. Every added SIP credential is another registration that Telnyx forks calls to, and the fork behaviour is the mechanism behind the "Answered Elsewhere" cleanup pushes the app already special-cases (`TelnyxVoiceManager.swift:361-388`). Changing the number of registrations changes the timing of a path that took real work to get right. That is a live-calling regression risk with no user-visible payoff.
3. Doc 06 §5.3 is right that "Call answered" without a name is still better than nothing, and the feed reads acceptably.

**Revisit at four or more people taking calls**, which is the point where #7's inference stops resolving the ambiguity. Until then this is the correct thing to leave undone, and `call_logs.answered_by_user_id` sits in the schema (P2-01 §4.5) waiting.

One cheap improvement that is *not* blocked: make `POST /api/voice/logs` (`routes/voice.js:99`) write `initiated_by_user_id = req.actor.userId` on both the reconciliation branch (`:134-139`) and the upsert branch (`:145-158`). Two lines, and combined with §3.4's retry it gives an ~honest answer to "whose phone handled this call" for every call after stage 4.

---

## 5. Roles and permissions

Three roles, already specified as a `check` constraint on `sms_users.role` (P2-01 §3.3). No permission matrix, no `role_permissions` table, no `memberships` (P2-01 §11.6 defers those, correctly).

| Role | Who | Cannot |
|---|---|---|
| `owner` | Lubosi. One per deployment. | — |
| `admin` | Dominic. Client-side lead. | Change another user's role to `owner`; deactivate the owner |
| `agent` | Support staff, none yet | Everything in the admin column below |

### 5.1 Route mapping

`requireRole(...roles)` composes after `requireAuth` at the mount point in `server.js:88-100`, so the enforcement is visible in one file rather than scattered through routers.

| Route | Min role | Note |
|---|---|---|
| `/api/sse`, `/api/conversations`, `/api/send`, `/api/react`, `/api/upload`, `/api/contacts`, `/api/voice`, `/api/push`, `/api/mobile-push` | `agent` | The daily job. Unchanged behaviour. |
| `/api/activity` (new feed), `/api/automation` (renamed) | `agent` | Read for all; `DELETE /api/automation/queue/:id` is `agent` too — cancelling a bad automated message is a support action, and it is fully audited. |
| `/api/sync` | `admin` | Vici only. Triggers a bulk external sync. |
| `/api/catchup` | `admin` | Vici only. **Sends real SMS in bulk** (`routes/catchup.js:56`). |
| `/api/intelligence` | `admin` | Vici only. |
| `/api/campaigns/*` (future) | see §5.2 | |
| `/api/users/*` (new, §6) | `admin`; role changes `owner` | |
| `/api/settings/*` (future `sms_settings`) | `admin` | Every write audited (P2-01 §3.17). |
| `/admin/*` | `ADMIN_API_TOKEN` bearer | Not a role. Machine-to-machine. §1.7. |

**The immediate concrete win** is the same one doc 06 §2.5 names: after stage 1, `/api/catchup` and `/admin/backfill/*` stop being reachable by everyone who knows the shared password.

### 5.2 What campaigns require

Per P2-06, campaigns need identity for three separate gates. The role model must satisfy all three and it does:

1. **Test-send gate** (P2-06 §2.5). A campaign cannot be sent until a test send of the exact content hash has been *acknowledged*. Acknowledgement is attributed to a `sms_users` row via `sms_campaign_test_sends.sent_by` (P2-01 §3.13), and the test can only target a number in `sms_users.phone` (P2-01 §3.3). **P2-06 §2.6 is explicit: this gate has no override — not by an operator, not by an admin, not by an env var, not by a feature flag.** No role bypasses it, including `owner`. Do not add one, and do not add a "force" query parameter that someone will find in six months.
2. **Approval gate.** `sms_campaigns.approved_by` + `approved_at` (P2-01 §3.10). Minimum role `admin`. Deliberately not a workflow engine — P2-01 §11.16 rejects approval chains and escalation for a two-person team.
3. **Two-person rule** (P2-06 §5.6). For the **first five campaigns**, the user who acknowledged the test and the user who authorised the send must be different `sms_users.id`. After five, same-user is permitted and both events remain recorded. This is a check in the send handler comparing two ids, not a role.

**One correction to P2-06 §5.6.** It proposes a 15-line stopgap: an operator dropdown on the login screen writing `req.session.operator`, honestly labelled as attribution rather than authentication. That was the right call when auth was scoped at 6–8 weeks. Under this plan stage 1 is roughly a week and produces a real `req.actor.userId`, so **the stopgap should be skipped** and campaign work should wait for stage 1 rather than build against a session field that has to be migrated later. If campaign work must start sooner, build it reading `req.actor.userId` and let the legacy path resolve to the "Team" row — which is strictly better than a dropdown, because it cannot be lied to.

### 5.3 What is deliberately absent

No per-conversation permissions. No inbox-scoped roles. No "agent can only see their own assignments" — there are no assignments (doc 06 §8.4). No custom roles. No API keys per user. Add the first one that someone asks for by name.

---

## 6. Invites, onboarding, and removal

### 6.1 Adding a person

No email invitations in v1, consistent with P2-01 §11.6 ("at two users, an admin creating an account directly is not a worse product, it is a smaller one") and with the mailer cap being irrelevant if no mail is sent.

The flow, three steps:

1. Admin opens Settings → Team → Add person. Enters email, display name, role, and phone (E.164). Server inserts an `sms_users` row with `password_hash = null`, and writes `user.invited` to the feed and `sms_audit_log`.
2. Server returns a one-time temporary password, generated server-side, displayed **once** in the UI and never stored in plaintext. The admin passes it to the person by whatever channel they already use. `password_set_at` stays null.
3. First login with the temporary password forces a password change before any other request succeeds. `password_set_at` is written; `user.joined` goes to the feed.

`phone` is not optional. P2-06 §2.1 restricts test sends to numbers in `sms_users.phone`, which is what makes a test send to a consent-less number defensible. An account without a phone cannot participate in the campaign test loop.

**When email invites become worth building** — roughly when a client is onboarding staff without a direct channel to the admin — wire custom SMTP first, then add `sms_invitations` with the `token_hash` shape from doc 06 §2.5. It is self-contained and blocks nothing in this plan.

### 6.2 Removing a person

Removal is `is_active = false`, never a delete. `sms_activity_events.actor_user_id` is `on delete set null` (P2-01 §3.16) and `sms_audit_log.actor_user_id` has no FK at all (P2-01 §3.17) — but `actor_label` is written at insert time on both, so history keeps reading "Dominic replied…" regardless. Deleting the row would still be wrong, because `sms_campaigns.approved_by` and `sms_campaign_test_sends.sent_by` are the exhibits in §9.

`POST /api/users/:id/deactivate`, `admin` only, does all of the following atomically:

1. `update sms_users set is_active = false where id = $1`.
2. **Session revocation.** This is the one thing `cookie-session` makes hard: the cookie is stateless and self-contained, so there is nothing server-side to delete. The mechanism is the `is_active` check in `requireAuth` (§1.5 step 2), which loads the user row on every request. **The 60-second cache is therefore a 60-second revocation window.** That is acceptable for this product and it must be documented rather than discovered — and the deactivate handler should explicitly invalidate that user's cache entry, which reduces it to zero on the instance handling the request. On a second Railway instance it stays 60 seconds. State it in the UI: "access ends within a minute".
3. **Device de-registration.** `update sms_user_devices set revoked_at = now(), enabled = false where user_id = $1`. Both the APNs rows and the web VAPID rows.
4. **Push suppression.** `lib/apns-notify.js` and `push-notify.js` select from `sms_user_devices` with `revoked_at is null and enabled` (P2-01 §3.4's partial index is exactly this predicate), so step 3 is sufficient. Verify the query, do not assume it.
5. **Voice.** Nothing to do at the Telnyx layer today, because the SIP credential is shared (§4.3). Note this honestly: **a removed person's phone can still take calls until they sign out or the app is deleted.** The mitigations are to rotate `TELNYX_IOS_SIP_USERNAME`/`PASSWORD` (which forces every device to pick up the new pair on the next foreground connect via `resolveCredentials()`, `TelnyxVoiceManager.swift:310-318`) or to build §4.3. For a friendly departure, rotation is enough; for a hostile one, rotation is required and should be in the runbook.
6. `user.removed` to the feed, and a `sms_audit_log` row with `before`/`after` on `is_active`.

**Reactivation** is `is_active = true` plus a password reset. The devices stay revoked and re-register on next launch.

### 6.3 Password reset

`POST /api/users/:id/reset-password`, `admin` only, same one-time-password mechanic as §6.1 step 2. Writes `password_set_at = null` and forces a change on next login. Audited with the actor who performed it.

Self-service reset by email is deferred with invites (§6.1). At this size the owner resetting a password over a phone call is faster than an email round trip anyway.

---

## 7. The activity feed, scoped

### 7.1 The launch event types

Six, per doc 06 §10.2 Phase 1, with one substitution. All write to `sms_activity_events` (P2-01 §3.16). Verb naming is `entity.verb`; actor kind lives in `actor_type`, not in the verb (doc 06 §5 preamble).

| Verb | Tier | Actor | `target_type` / `target_id` | `contact_phone` | `payload` | Emitted from |
|---|---|---|---|---|---|---|
| `message.sent` | `aware` | `user` | `conversation` / phone | yes | `{ message_id, preview, has_media, is_reply }` | `routes/send.js` after the insert at `:39-48` |
| `call.missed` | **`act`** | `contact` | `call` / `call_control_id` | yes | `{ ring_duration_seconds, direction }` | `routes/voice-webhook.js:252` hangup branch, when `answered_at is null` |
| `call.answered` | `aware` | `user` | `call` / `call_control_id` | yes | `{ answered_by, ring_duration_seconds }` — `answered_by` NULL per §4.3 | `routes/voice-webhook.js:227` |
| `call.ended` | `aware` | `user` \| `contact` | `call` / `call_control_id` | yes | `{ duration_seconds, ended_by }` | `routes/voice-webhook.js:252` |
| `contact.opted_out` | **`act`** | `contact` | `contact` / phone | yes | `{ keyword }` | `routes/webhook.js:87` |
| `automation.cancelled` | `aware` | `user` | `scheduled` / id | yes | `{ flow_type, order_id, send_at }` | `routes/automation.js` (renamed), the `DELETE` handler at `:89-125` |

**Substitution for Shore:** Shore has no `flows/` directory and no `routes/activity.js`, so `automation.cancelled` does not exist there. Shore launches with five. §10.

`description` is written at insert time and never updated (P2-01 §3.16; doc 06 §3.12 documents three independent products converging on this). `"replied to Sarah M."`, `"missed a call from +1 555 …"`. The client renders `actor_label` + `description` and owns no enum-to-copy switch.

`fingerprint` is set for every event that can be produced by a retryable webhook: `sha256(verb || target_id || provider_message_id)`. Telnyx retries; our own code will too. The unique partial index at P2-01 §3.16 makes duplicates impossible rather than unlikely.

### 7.2 Write-time grouping

Two rules, both at write time, per doc 06 §4.2b. Nothing is grouped at render time.

**Rule 1 — sliding batch on `message.sent`.** `batch_key = 'message.sent:' || actor_user_id || ':' || contact_phone`. On insert, first attempt:

```sql
update sms_activity_events
   set batch_count = batch_count + 1,
       batch_until = now() + interval '5 minutes',
       description = <re-rendered plural form>
 where batch_key = $1
   and batch_until > now()
   and id = (select id from sms_activity_events
              where batch_key = $1 and batch_until > now()
              order by id desc limit 1)
returning id;
```

If zero rows, insert with `batch_count = 1` and `batch_until = now() + interval '5 minutes'`. Cap the window extension at 30 minutes from the first event by carrying the original `created_at` — after that, start a new row. Result: "Dominic sent 9 messages to Sarah" as one line, which is what a human would say.

Note P2-01 §3.16 fixes doc 06's non-buildable partial index: use the plain `(batch_key, batch_until desc)` index with the time test in the `WHERE`, because `now()` is not immutable and Postgres rejects it in an index predicate.

**Rule 2 — call event collapse.** A single call produces `call.answered` and `call.ended` seconds apart. Emit `call.answered` at answer time, then **update it in place** on hangup with the duration, rather than inserting `call.ended`. This is Intercom's compound-event pattern (doc 06 §3.4) and it halves the volume of the noisiest category. A call that is never answered emits `call.missed` only. So in practice `call.ended` is written only for outbound calls, where there was no `call.answered` to update.

`sms_activity_events` is mutable by construction (`batch_count` increments, and Rule 2 updates in place). **That is precisely why it cannot double as the audit log** — P2-01 §8 makes this point and it is the load-bearing reason for the two-table split.

No creation grace period at launch. Linear's 3-minute rule (doc 06 §4.2b) solves a problem — a burst of property edits right after creation — that this product does not have, because there are no properties to edit.

### 7.3 Explicitly NOT logged at launch, and why

| Not logged | Why |
|---|---|
| Inbound messages | The feed would become a second, worse inbox. The inbox already exists and is better at this. |
| `status_update` (`routes/webhook.js:48`) | Highest-volume event in the system, zero team-awareness value. Pure audit. |
| Reactions (`routes/react.js`) | Audit at most. |
| Conversation opened / read (`routes/conversations.js:76-78`) | **Captured for presence, never rendered as a feed line.** §8. Intolerable noise as a feed entry, and it is the fastest route to a two-person team feeling surveilled. |
| Contact created/updated by sync | Record-keeping, not team awareness. |
| Order status changes | Belongs on the contact record. |
| `queue_added`, `message_sent` from `flows/utils.js:267` | **The single largest volume source.** Goes to `/api/automation`, which already does this job well. Excluded by `where actor_type = 'user'`, one predicate. |
| `stats_update` | A refresh nudge, not an event. |
| **Login, logout, failed login** | **Audit log only, firmly.** Nobody needs a notification that a colleague opened the app. Linear's audit log ships a one-click "exclude session-creation events" control (doc 06 §3.3) precisely because this is the classic mistake. |

Six types, not twenty-five. **Add a seventh only when someone asks for it by name.** Doc 06 §10.4 risk 4 — "the feed becomes wallpaper" — is mitigated by this list and by nothing else.

### 7.4 Read state and retention

**Read state is a watermark**, not per-row flags: `sms_users.last_read_activity_id bigint`. One column, no join table. Unread count is `count(*) where id > watermark and tier <> 'audit'`, which at ~500 events/month is instant. This is Missive's side of the read-state fork, chosen deliberately (doc 06 §7.3): the feed is not another inbox to manage. `POST /api/activity/read { up_to_id }`.

*(This is a third additive column on `sms_users` beyond §1.6's two. Same migration file.)*

Behaviour worth copying exactly from Missive: the unread dot clears the moment the panel opens, but individual items keep their unread styling until it closes, so you can still see what was new while you are looking at it.

**Retention:**

| Surface | Window | Mechanism |
|---|---|---|
| `sms_activity_events` | **90 days** | One nightly `delete from sms_activity_events where created_at < now() - interval '90 days'`. That is the whole implementation. |
| `sms_audit_log` | **5 years minimum**, effectively indefinite | Nothing. No delete job exists. §9. |

Do not partition, do not use `pg_partman`, do not build retention infrastructure. P2-01 §11.12 and doc 06 §6.7: the table grows ~3 MB/year at current volume and a single unpartitioned table serves past 50 million rows.

### 7.5 API surface

```
GET  /api/activity?cursor=<id>&limit=50            keyset, newest first, tier <> 'audit'
GET  /api/activity/since?after=<id>                catch-up after reconnect
GET  /api/activity/conversation/:phone?cursor=<id> per-conversation timeline
POST /api/activity/read { up_to_id }               watermark
```

Keyset pagination on `id`, never `OFFSET`. An activity feed is the worst case for `OFFSET` because rows are inserted at the head while the user pages, producing duplicates and gaps. Note that `routes/activity.js:38-47` and `routes/voice.js:37-44` both use `.range()` today — do not copy that pattern here.

### 7.6 Real-time delivery

Three changes to the broadcaster, in dependency order:

1. **Addressed delivery.** `sseClients` (`server.js:15`) becomes `Map<userId, Set<res>>`. `routes/sse.js:11` registers under `req.actor.userId`. `broadcast(event, { excludeUserId })` becomes possible, which is what suppresses self-authored events — doc 06 §4.3 rule 4, and currently impossible. Small change to `server.js:15-21`, `routes/sse.js`, and `lib/broadcaster.js` (all six lines of it).
2. **Event IDs and replay.** Write `sms_activity_events.id` as the SSE `id:` field. Browsers send `Last-Event-ID` on reconnect automatically; `routes/sse.js` reads it and replays before resuming. Nearly free, because the id is already the cursor.
3. **Persist first, broadcast second.** The row is the source of truth; the SSE frame is a hint.

Carry two timestamps per frame — `created_at` and a transmission timestamp — or a client replaying after a reconnect renders "2 minutes ago" off the wrong one.

**Not fixed, and it should be stated:** `sseClients` is still a `Set` in one Node process (`server.js:15`). A second Railway instance silently halves the feed. Change 2 makes that failure *recoverable* — a client on the wrong instance catches up by polling `/api/activity/since` — which is a mitigation, not a fix. The real fix is Postgres `LISTEN`/`NOTIFY`. Not now; build the replay endpoint first precisely so the limitation is survivable.

**iOS gets no SSE.** There is no `EventSource` in `ios/` and there should not be. Foreground: poll `/api/activity/since?after=<lastSeenId>` on `willEnterForeground`. Background: nothing. Never push an `aware`-tier event — doc 06 §9.2 is right that "Dominic replied to Sarah" is a notification about someone else's competence and will be muted within a week, taking the useful notifications with it. And do not add feed items to the app badge: it currently means "things waiting for you" (`lib/apns-notify.js:~185`), and diluting it destroys the one signal that works.

---

## 8. Collision detection

Doc 06 §8.1 argues collision detection beats the feed at two users. **Agreed, and the evidence is stronger than doc 06 makes it: the cheapest of the three mechanisms needs no identity at all, which means it can ship before stage 1.**

### 8.1 Ship order

**(a) Stale-reply guard — first, and before the feed.** No presence infrastructure, no identity, no schema, no iOS release.

`POST /api/send` (`routes/send.js:10`) accepts an optional `lastSeenMessageId`. Before calling `sendSMS` at `:27`:

```sql
select id, body, created_at from sms_messages
 where contact_phone = $1 and id > $2 and direction = 'inbound'
 order by id limit 5;
```

If non-empty, return `409` with `{ error: 'newer_messages', messages: [...] }`. The web client shows "2 new messages arrived while you were typing" with the text, and a Send anyway button that re-posts with the updated `lastSeenMessageId`.

It cannot false-negative from a dropped heartbeat, it is a server-side check, and it catches the expensive failure — two agents sending near-duplicate replies to a customer — even when both are offline from each other. **Roughly 30 lines in `routes/send.js` plus a client dialog.** Omitting the field behaves exactly as today, so the shipped iOS app is unaffected and needs no release.

**(b) Viewing/composing presence — second, after stage 1.** Needs `req.actor`.

**(c) The feed — third.**

### 8.2 Presence, concretely

In-memory, over the existing SSE transport. Do **not** adopt Supabase Realtime Presence for this: it means a second real-time transport on web and, worse, on iOS, to serve ten users. Doc 06 §8.3 reaches the same conclusion after pricing it.

```
POST /api/presence  { contact_phone, state: 'viewing' | 'composing' | 'gone' }
GET  /api/presence/:phone  →  [{ user_id, display_name, state, since }]
```

Server state, one process:

```js
// Map<contact_phone, Map<userId, { state, displayName, expiresAt }>>
```

| Parameter | Value | Reason |
|---|---|---|
| Heartbeat interval | **10s** while a conversation is open | |
| TTL | **30s** | Three missed heartbeats. |
| Sweep | every 10s | Emits `presence_update` on any transition. |
| `composing` trigger | first keystroke | Refreshed by the 10s heartbeat while typing. |
| `composing` → `viewing` | 15s of no keystrokes | Shorter than the TTL, so the composing state decays before presence does. |
| `viewing` → gone | tab close / blur (explicit `state: 'gone'`), or TTL | |

**SSE events**, broadcast to everyone in the org except the originating user:

```json
{ "type": "presence_update",
  "contact_phone": "+1555…",
  "viewers": [ { "user_id": 2, "display_name": "Dominic", "state": "composing", "since": "…" } ] }
```

Always send the **full viewer list** for that conversation, never a delta. Deltas require the client to hold correct state across reconnects, and it will not.

**UI:** an avatar chip in the thread header for each viewer, and an inline "Dominic is replying…" line above the composer when any viewer is `composing`. In the conversation list, a small dot on rows someone else is viewing. Nothing animates on receipt — Supabase's own presence docs warn that join/leave fire during reconciliation without real user movement, and the same is true of any TTL sweep.

### 8.3 Unclean disconnect

The failure mode is a laptop lid closing with no `req.on('close')` and no `state: 'gone'`.

- **Detection:** TTL expiry, ≤30 seconds. The sweeper removes the entry and broadcasts the updated list.
- **Redeploy:** the map dies with the process. Every client's next heartbeat (≤10s) rebuilds it. Stale presence self-heals; this is genuinely acceptable for presence and is one of the reasons not to persist it.
- **Two Railway instances:** presence splits, and each instance shows only its own clients. Same limitation as §7.6, lower stakes — you fall back to the stale-reply guard, which is server-side and instance-independent. **This is the second reason (a) ships first: it is the one that keeps working when the presence layer is degraded.**
- **The client must be idempotent.** Receiving the same viewer list twice, or a list that briefly loses and regains a viewer, must not flicker. Render from the last received list, keyed by `user_id`.

### 8.4 Recommendation

**(a) before the feed. (b) after stage 1, before the feed. (c) last.**

At two people the feed's value is close to zero and collision detection's is immediate and daily. Doc 06 §10.1 puts the question to the user — is 5–10 people imminent or aspirational — and the sequencing above is the answer that is correct either way: if headcount grows, the feed is still coming; if it does not, the two features that mattered shipped first and cheapest.

**Assignment** (doc 06 §8.4) is the structural fix that presence papers over, and it is what makes a feed useful above about four people. `sms_contacts.assigned_to bigint references sms_users(id)` plus `assigned_at` plus a filter in the conversation list. Not at launch; the first thing to build when a third person joins.

---

## 9. The audit log as a compliance artifact

Doc 03 §8 establishes that the audit fields have legal purpose, not merely product purpose. `sms_audit_log` (P2-01 §3.17) is the table; this section covers what P2-01 leaves to the application.

### 9.1 Append-only enforcement

P2-01 §3.17 specifies the trigger. Two things it leaves implicit:

**The trigger is the load-bearing control, not the grants.** We connect with the service-role key (`db.js:4-8`), which is powerful enough to route around grants. Add them anyway as belt-and-braces:

```sql
revoke update, delete, truncate on sms_audit_log from public, authenticated, anon, service_role;
grant insert, select on sms_audit_log to service_role;
```

**The honest limit.** Neither the trigger nor the grants stop a Postgres superuser with Supabase SQL-editor access — which is us. If tamper-evidence is genuinely required rather than tamper-resistance, the log has to be shipped off-box: an append-only object-storage drain, or a nightly export to a location the application cannot write to. **That is a conscious deferral, not an oversight**, and it should be written down as one. Practically: a weekly `COPY … TO` export to Google Drive, timestamped, costs an hour to build and converts "we could have edited it" into "here are the weekly snapshots".

### 9.2 What must never be deletable

Everything in `sms_audit_log`, without exception, and additionally:

- `sms_consent_events` — its own immutability trigger, P2-01 §3.5. It survives contact deletion, because destroying the record destroys the defence.
- `sms_users` rows. Deactivate, never delete. `approved_by` and `sent_by` are exhibits.
- `sms_campaigns` and `sms_campaign_test_sends`. Together they prove the test-send gate was satisfied for the exact content that went out.
- `sms_messages`. Already the universal outbound record (P2-01 §11.13); no delete path exists today and none should be added.

`sms_activity_events` **is** deletable and is deleted nightly at 90 days. It carries nothing the audit log does not.

### 9.3 What must be written, and the one place failure is not tolerable

P2-01 §3.17 lists the minimum action set. The application obligation this document adds is about failure handling:

`lib/activity.js` swallows its own errors — a feed write must never fail a send. **`lib/audit.js` must not, for the consent-bearing subset.** For `consent.granted`, `consent.revoked`, `suppression.added`, `suppression.released`, `campaign.approved`, and any exclusion override, an audit-write failure **fails the originating request**. The reasoning is the same as P2-01 §4.2's rule about `consent_event_id`: a compliance field that cannot be written must stop the action, not proceed silently. For everything else — settings, role changes, logins — log and continue.

Every audit row carries `ip` (from `req.ip`; `app.set('trust proxy', 1)` at `server.js:36` makes this the real client address behind Railway), `user_agent`, and a `request_id` generated per request so the row correlates with Railway logs. Add the request-id middleware in stage 1; it is four lines and it is the difference between "an audit row exists" and "we can reconstruct what happened around it".

### 9.4 Retention

**Five years minimum on everything, and in practice keep it all.** 47 CFR 64.1200(d)(6) requires do-not-call requests to be honoured for five years from the request. At this volume the table grows by single-digit megabytes per year, so the default is "keep it" and any exception needs justifying — the opposite of the feed's default.

P2-01 §8 makes a good structural point worth repeating: because `sms_consent_events` is its own table with its own trigger, the retention split is structural rather than a `WHERE action IN (...)` in a delete job. **A delete job with a filter is a delete job someone eventually gets wrong.** There is no delete job on `sms_audit_log`. Do not add one.

### 9.5 The export you would hand a lawyer

Assume the demand letter names one phone number and one date range. The artifact is a single directory, generated by `node scripts/export-consent-record.js --phone +1555… --from … --to …`, `owner` role only, and — per Slack's meta-auditing practice — **the export itself writes an audit row**.

```
export-+15551234567-2026-08-12/
  00-COVER.txt            phone, range, generated_at, generated_by, row counts,
                          the exact queries run, schema version
  01-consent.csv          sms_consent_events, every column, chronological.
                          The grant, its channel, its disclosure_text, its evidence_uri.
  02-consent-state.csv    the derived current state at export time
  03-suppressions.csv     sms_suppressions incl. suppressed_by / released_by
  04-messages.csv         sms_messages: direction, body, status, sent_at,
                          consent_event_id, suppression_checked_at,
                          recipient_local_time, campaign_id, message_class,
                          actor_user_id -> display_name
  05-calls.csv            call_logs for the number
  06-audit.csv            sms_audit_log where entity_id = the phone,
                          or entity_type='contact', across the range
  07-actors.csv           every sms_users row referenced above:
                          id, display_name, email, role, is_active
  08-attachments/         evidence_uri files, fetched and hashed
  MANIFEST.txt            sha256 of every file above
```

Four properties that make it usable as evidence rather than as data:

1. **Every id is resolved to a name in the same file.** `actor_user_id = 2` is not an exhibit; `Dominic Byrne (dominic@…, admin)` is. This is why `actor_label` is denormalised onto the row at write time.
2. **CSV, one row per event, one file per table.** Not JSON, not a PDF report. Counsel will open it in Excel, and a nested structure is worse than useless there.
3. **The queries are in the cover sheet.** An export whose derivation cannot be reproduced invites the argument that it was curated.
4. **`MANIFEST.txt` with hashes**, so the bundle can be shown to be the same bundle later.

The single most important line in the whole export is `sms_messages.suppression_checked_at`. It is the field that says the check ran before this message went out — which is the fact in dispute. P2-01 §4.2's rule that it must never be silently droppable exists for this sentence.

---

## 10. Shore Academy

### 10.1 What Shore has, and does not

Verified 12 August 2026 against both working trees.

**Shore does not have:** `routes/activity.js`, `routes/catchup.js`, `routes/intelligence.js`, `routes/sync.js`, `routes/webhook-ghl.js`, `routes/webhook-shipstation.js`, `routes/webhook-woocommerce.js`, and **no `flows/` directory at all**. No campaigns, no automations, no order flows, no WooCommerce, no ShipStation.

**Shore has that Vici does not:** `routes/webhook-ghl-contact.js`, `lib/compliance.js`, `lib/ghl-client.js`, `lib/ghl-contact-store.js`, and **`lib/startup-check.js`**.

**Shared and byte-identical:** `routes/auth.js`. That is the single most useful fact in this section.

**Shared and differing** (line counts are changed-line totals): `admin.js` (103), `contacts.js` (77), `webhook.js` (36), `webhook-send.js` (33), `send.js` (25), `conversations.js` (21), `voice.js` (15), `mobile-push.js` (6), `react.js` (2). `server.js` differs on the cookie name (`vici_sess` / `shore_sess`), the startup-check require, and the set of mounted routes.

**Separate Supabase projects.** Vici `cckzshsvchhsfsnbycoj`, Shore `hbwwvhslumwdyhgnilrr`. **Separate GitHub repos with no common ancestor** — `lubosik/Telynx-Inbox` and `lubosik/The-Shore-Academy-SMS-App` have entirely different histories. There is no cherry-pick across them; a "port" is a patch applied by hand.

**Shore has no migration ledger and no `scripts/*.sql` except a single `schema.sql`.** Vici has ten loose `.sql` files with no ordering convention, two of which were forgotten (P2-01 §9.3).

### 10.2 What Shore gets

| | Vici | Shore |
|---|---|---|
| `sms_users` + `sms_user_devices` + password login | Yes | Yes |
| `requireAuth` with `req.actor`; `requireRole` | Yes | Yes |
| Roles owner/admin/agent | Yes | Yes |
| `sms_activity_events` + `sms_audit_log` | Yes | Yes |
| Launch event types | **6** | **5** — no `automation.cancelled` |
| `/api/activity` ↔ `/api/automation` rename | **Required** | **Not needed** — no `routes/activity.js`, so `/api/activity` is free |
| `sms_messages.actor_user_id` | Yes | Yes |
| `sms_scheduled.cancelled_by` | Yes | **No `sms_scheduled` usage** — column can be added for schema parity or skipped |
| `call_logs.initiated_by_user_id` | Yes | Yes |
| Stale-reply guard | Yes | Yes |
| Presence / collision | Yes | Yes |
| `/api/catchup`, `/api/sync`, `/api/intelligence` role gates | Yes | N/A |
| Campaign approval gate, test-send gate, two-person rule | Yes | **No — Shore has no campaigns.** The `owner`/`admin`/`agent` roles still exist; they simply gate less. |
| `schema_migrations` + startup check | Yes — **port `lib/startup-check.js` from Shore** | Already has the startup check; add the migrations table |

Shore's version of this work is meaningfully smaller: no campaigns means no approval gate, no test-send gate, no two-person rule, and no `automation.cancelled`.

### 10.3 Sequencing — Vici first, and how Shore gets it

**Vici first**, for three reasons: it is the harder case (campaigns, automations, the `/api/activity` naming collision), it is where P2-01's other six migration files are landing anyway, and its client is the owner, so a mistake is survivable in a way it is not with a paying external client.

The practical mechanic, given no shared history:

1. **Write the shared code so it is copyable.** Every new file this plan creates — `lib/actor.js`, `lib/activity.js`, `lib/audit.js`, `lib/presence.js`, `routes/users.js`, `routes/feed.js`, `scripts/set-password.js`, `lib/migration-check.js` — must take **zero** Vici-specific dependencies: no `flows/`, no `sms_scheduled`, no campaign tables, no branding strings. Configuration comes from `process.env` and from `lib/brand.js` (new, ~10 lines: app display name, cookie name, bundle id, sender label). Then porting a file is `cp`, not a diff.
2. **Modify shared files identically.** `routes/auth.js` is byte-identical today. Keep it that way — after this work it should still be byte-identical, with the cookie name coming from `server.js` where it already does. Same for `routes/send.js`'s actor line, `routes/voice.js`'s `initiated_by_user_id` line, and `routes/conversations.js`'s presence hook.
3. **`server.js` is the only genuine three-way merge**, and it is small: the `requireAuth` body, the `SESSION_SECRET` hard-fail, the `sseClients` Map, and three new mounts. Do it by hand, twice. Twenty minutes.
4. **SQL runs twice regardless.** Two Supabase projects. Write `scripts/P2-03-identity.sql` and `scripts/P2-07-activity-and-audit.sql` so they are portable — P2-01 §2 already requires `if not exists` throughout and a closing `notify pgrst, 'reload schema';`, which makes them re-runnable and project-agnostic. Copy the files into Shore's `scripts/` unchanged. Shore also needs `P2-01-migration-ledger.sql` (just `schema_migrations`; it has no `sms_settings` need yet).
5. **iOS twice, unavoidably.** Two bundle IDs, two Keychain services, two TestFlight pipelines. The `.swift` diffs are identical in content — five files, ~40 lines total (§3) — so it is a manual re-apply, not a re-design. Ship Vici's build first, let it soak for a week, then Shore's.

**Lag: about one week behind Vici per stage.** Do not run them in parallel. The whole point of going second is to inherit the bugs already found.

### 10.4 The thing this forces

P2-01 §11.6 and doc 06 §10.4 risk 3 both note that the fork-vs-shared-core decision is unmade and gets more expensive weekly. This programme is the forcing function: it touches `server.js`, `routes/auth.js`, `db.js`, the SSE layer, and the push layer in **both** repos, which is the largest cross-cutting change the estate has seen.

**This document's position: do the fork twice, once more, and do not start extracting a shared core mid-programme.** Extracting a package while migrating live auth on two production systems is two hard changes interleaved, and the failure modes multiply. But step 1 above — write every new file with no repo-specific dependencies — is deliberately the groundwork for that extraction, and after this lands, roughly a dozen files will be genuinely identical across both repos. That is the moment to have the conversation, with evidence.

---

## 11. Effort and sequencing

### 11.1 Revising doc 06's estimate

Doc 06 §10.3 says 6–8 weeks, with only weeks 4–5 visible. Two things in it are now wrong:

- **Phase 0 (identity) was estimated at 2–3 weeks with "low" confidence, driven by the iOS leg.** With no Supabase Auth, no `supabase-swift`, no refresh-token machinery, and a five-file / ~40-line iOS diff that does not touch the voice stack, that becomes **about 6 working days of server work plus one TestFlight cycle**. Confidence rises from low to medium-high — the remaining uncertainty is TestFlight turnaround, not design.
- **"Only weeks 4–5 are visible" is a consequence of ordering, not of the work.** The stale-reply guard (§8.1a) needs no identity, no schema, and no iOS release, and it solves the most-cited daily pain. It can ship in the first two days.

**Revised: 4–5 weeks for Vici, plus about a week of lag for Shore. Something visible on day two.**

### 11.2 Increments

| # | Increment | Effort | Visible? | Depends on |
|---|---|---|---|---|
| **A** | **Stale-reply guard** (§8.1a) | **1–2 days** | **Yes** | Nothing |
| B | `SESSION_SECRET` hard-fail (§1.7) + request-id middleware (§9.3) | 0.5 day | No | — |
| C | `P2-01-migration-ledger.sql` + `lib/migration-check.js` (port Shore's `startup-check.js`) + `GET /api/health/migrations` | 1 day | No | — |
| D | **Stage 1** — `P2-03-identity.sql`, dual login, `req.actor`, `set-password.js` | 3 days | No | B, C |
| E | **Stage 3** — two humans migrate; `/auth/check` returns the user; web shows "signed in as" | 0.5 day | **Yes** | D |
| F | Role gates on `/api/catchup`, `/api/sync`, `/api/intelligence`, `/admin/*`; admin-token split (§1.7) | 1 day | Marginal | D |
| G | **Stage 2** — `P2-07-*.sql`, `lib/activity.js`, `lib/audit.js`, 6 call sites, actor columns, `/api/activity`→`/api/automation` rename with aliases | 4 days | No | D |
| H | Addressed SSE + `Last-Event-ID` replay (§7.6) | 2 days | No | G |
| I | **The feed UI** — right rail, watermark, self-suppression | 3 days | **Yes** | G, H |
| J | Presence (§8.2) | 2 days | **Yes** | D, H |
| K | Team management UI — add/deactivate/reset (§6) | 2 days | **Yes** | D |
| L | **Stage 4** — iOS ×2, plus the `logCall` retry (§3.4) | 2 days code + 2 TestFlight cycles | **Yes** | D |
| M | Per-user push via `sms_user_devices` (§4 #15, #16) | 1.5 days | Yes (fewer pushes) | L |
| N | Write-time batching + call-event collapse (§7.2) | 1.5 days | Yes | I |
| O | Audit export script (§9.5) | 1 day | Owner only | G |
| P | **Stage 6** — retire the shared password | 0.5 day | No | L + 2 weeks soak |
| Q | Shore: everything above minus campaigns | ~60% of the above, lagging one week | — | Vici equivalent |

Roughly 26 working days for Vici (A–P), which is 5 calendar weeks with normal interruption, plus Shore trailing.

Critical path: **B → C → D → G → H → I**. Everything else parallelises against it. **L is off the critical path entirely** — the iOS release can happen any time after D and should be started early precisely because TestFlight latency is the least controllable thing in the plan.

### 11.3 The smallest change that delivers real value on day one

**The stale-reply guard.** Increment A. About 30 lines in `routes/send.js` plus a client dialog.

It requires no identity, no schema migration, no new table, no SSE change, no iOS release, and no coordination between the two repos beyond a copy-paste. It cannot false-negative from a dropped heartbeat because it is a server-side read at send time. And it addresses the highest-value problem doc 06 identified — *"am I about to reply to something Dominic is already replying to"* — more reliably than the presence indicator that costs ten times as much.

If only one thing from this entire document ships, it should be that.

**The smallest change that delivers real *identity* value** is increment D+E together: about 3.5 days, after which the server can name the human behind every authenticated request and the web UI says "signed in as Dominic". Everything else in the programme is downstream of that one property.

---

## 12. Risk register

Ranked by expected damage × likelihood.

### R1 — An auth failure path calls `signOut()`, `CredentialStore.clearAll()` runs, and the phone stops ringing

**Catastrophic. Low likelihood, but only if it is guarded explicitly.** This is the one genuine CallKit risk in the plan, and §3.1 establishes it is the *only* one — the VoIP push path never touches HTTP auth, so nothing about token or cookie expiry can break it. What can break it is us: `SessionModel.swift:66` deletes the SIP credentials, and `startSDKForPush` (`TelnyxVoiceManager.swift:476`) returns false without them.

*Mitigation:* the three hard rules in §3.2, as an explicit item in the `ios/` PR checklist. No 401 handler may call `signOut()`. `clearAll()` and `disablePushNotificationsAndWait()` are reachable only from an explicit user tap. Verify by grepping for callers of both before merging.

### R2 — Stage 6 ships before every device has the stage-4 build

**Catastrophic for the affected device. Medium likelihood** — this is the kind of ordering that gets lost between two repos and two TestFlight pipelines. An un-upgraded phone can no longer authenticate: it still takes calls (§3.1) but stops syncing messages and stops logging calls, and the failure looks like a backend outage.

*Mitigation:* stage 6 is gated on a query — every enabled `sms_user_devices` row has `last_seen_at` after the stage-4 release date — plus a two-week soak. Keep `INBOX_PASSWORD` set in Railway for a month after, so rollback is a deploy.

### R3 — The cookie configuration is touched and every live session dies

**High damage. Medium likelihood, because it is a plausible-looking edit.** Changing `name`, `secret`, or `sameSite` at `server.js:54-61` invalidates every session including the phone's. P2-06 §7.3 step 4 exists for exactly this and says to test on a device that was *already logged in*, because a fresh install re-authenticates and hides it.

*Mitigation:* this plan changes none of the three, and the PR description must say so. The `SESSION_SECRET` fix (§1.7) changes the *fallback*, not the value — confirm `SESSION_SECRET` is actually set in Railway on both projects **before** deploying the hard-fail, or the boot check takes the service down.

### R4 — A forged cookie asserts a role

**High damage. Low likelihood once R4's own fix lands, high until then.** `server.js:56` currently falls back to a public string literal. Today that forges a boolean; after `{ uid, role }` goes into the session it forges an admin.

*Mitigation:* increment B ships **before** increment D. Non-negotiable ordering. Verify `SESSION_SECRET` is set on both Railway projects first (see R3).

### R5 — Push breaks during the `sms_user_devices` cutover

**Medium-high damage, medium likelihood.** `lib/apns-notify.js` and `routes/mobile-push.js` already carry a compatibility fallback between `ios_push_devices` and `push_subscriptions` (`mobile-push.js:64-71`, `apns-notify.js` device select). Adding a third table is a third branch.

*Mitigation:* P2-01 §9.2 file 03 copies rather than moves the existing rows, so the old path stays intact. Dual-write for one release, verify with `GET /api/mobile-push/status` (which already reports which storage is live), then retire. Do not retire in the same release that introduces the new read.

### R6 — The `/api/activity` rename breaks the shipped iOS app

**Medium damage, medium likelihood.** `APIClient.swift:205-224` calls `/api/activity/stats`, `/queue`, `/recent`, and `DELETE /queue/:id`. `public/app.js` is a compiled artefact, so a missed call site fails at runtime, not at build.

*Mitigation:* mount both paths on the same router for at least one full iOS release cycle (§ stage 2). Drop the alias only when the minimum shipped iOS version calls `/api/automation`. Add a log line on every alias hit so you can see when it stops being used.

### R7 — Migrations forgotten again

**Medium damage, high likelihood without a fix.** Two are already missing (`ios-push-devices-migration.sql`, `add-optout-column.sql`). This plan adds two more files across two databases — four applications.

*Mitigation:* increment C before increment D. `schema_migrations`, the startup diff (Shore's `lib/startup-check.js` is the pattern; port it to Vici), and `GET /api/health/migrations`. Seed the ledger with the existing nineteen scripts, marking the two known-missing as absent.

### R8 — The feed becomes wallpaper

**Low damage, high likelihood.** Doc 06 §4.1 describes the failure exactly: it launches, everyone watches it for four days, and by week three nobody opens it — but it still *looks* like a working feature, so nobody removes it.

*Mitigation:* six event types (§7.1), the exclusion list (§7.3), self-suppression, and shipping collision detection first (§8.4) so the genuinely valuable thing is not judged by the feed's reception. Add a seventh type only when someone names it.

### R9 — Silent 401s on `logCall` hide the auth migration's real state

**Low-medium damage, high likelihood.** `APIClient.swift:283-296` swallows 401s. During stages 3–6 that is exactly the window where call logs would go missing and nobody would notice, and the missing rows would be blamed on Telnyx.

*Mitigation:* §3.4's retry, in the stage-4 release. Separately, add a server-side log line when `POST /api/voice/logs` 401s — it costs one line and turns an invisible failure into a grep.

### R10 — Surveillance perception

**Low technical damage, real relational damage. Medium likelihood.** At two people, a feed logging one person's actions reads very differently than it does at fifty. Dominic is a client, not an employee.

*Mitigation:* no login events in the feed (§7.3), no "opened conversation" events, presence is symmetrical (he sees Lubosi too), and the owner tells Dominic it exists before he discovers it. That last one is not an engineering control and it is the one that matters.

### R11 — Per-agent SIP credentials get built anyway

**Medium damage, low likelihood.** Adding SIP registrations changes Telnyx's call-forking behaviour, which is the mechanism behind the "Answered Elsewhere" cleanup pushes the app special-cases at `TelnyxVoiceManager.swift:361-388`. That code took real work; disturbing it for a nullable column at two users is a bad trade.

*Mitigation:* §4.3's decision is recorded here as a decision, with the revisit trigger stated: **four or more people regularly taking calls.**

### R12 — Single-process SSE halves the feed and the presence map

**Low damage today, medium if the service ever scales.** `sseClients` is a `Set` in one Node process (`server.js:15`); the presence map (§8.2) is the same.

*Mitigation:* build the `Last-Event-ID` replay endpoint in the same increment as addressed delivery (§7.6), so the failure is recoverable rather than silent. The stale-reply guard is instance-independent by construction and is the fallback. Real fix — `LISTEN`/`NOTIFY` — is out of scope and should stay out until there is a second instance.

### R13 — The Supabase Auth decision is wrong

**Low damage, low-medium likelihood.** If SSO, self-serve signup, or MFA is demanded sooner than expected, we will want it.

*Mitigation:* `sms_users.auth_user_id uuid unique` stays in the schema, null. Adopting Supabase Auth later is: create `auth.users` rows, populate the column, add a JWT branch to the login handler, drop `password_hash`. One afternoon — the same afternoon P2-01 R12 quotes for retrofitting `org_id`. The decision is reversible and this is why it is safe to make now.

---

## 13. Open items

1. **`argon2` vs `bcrypt` on the Railway build image.** `argon2` needs native compilation. Check before increment D; `bcrypt` is an acceptable fallback and the choice is invisible above the `hashPassword`/`verifyPassword` pair.
2. **Migration-file naming collision.** P2-01 §9.1 names SQL files `P2-01-migration-ledger.sql` … `P2-07-activity-and-audit.sql`, while the research documents are also `P2-01` … `P2-06`. `P2-05` therefore means "campaigns" in `scripts/` and "auth and activity" in `research/phase2/`. Harmless if nobody says "run P2-05" out loud, which somebody will. Consider renaming the SQL prefix to `M2-nn`.
3. **`sms_users.last_read_activity_id`** (§7.4) is a third additive column beyond §1.6's two. Fold all three into `scripts/P2-03-identity.sql`.
4. **The `X-Vici-Client` header in Shore's iOS app** (`ShoreInbox/Core/APIClient.swift:235`) is a copy-paste leftover that currently works because Shore's `routes/voice.js:13` reads the same name. Rename both or neither; renaming one silently disables Shore calling with a 403.
5. **Does the client administer their own team?** Doc 06 §11 question 2, still open. It changes nothing before stage 4, and it changes only §6 afterwards.
6. **Is 5–10 people imminent or aspirational?** Doc 06 §11 question 1. §8.4's ordering is deliberately the answer that is correct either way, so this no longer blocks the start — but it does determine whether increments I and N are worth doing at all.
