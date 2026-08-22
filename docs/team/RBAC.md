# Roles, permissions and server-side authorisation

This describes what `scripts/rbac-migration.sql`, `lib/authz.js`,
`lib/route-policy.js`, `lib/enforce-policy.js`, `lib/password.js`,
`routes/auth.js`, `routes/users.js`, `routes/invitations.js` and the
authorisation-relevant parts of `server.js` actually do. Where the shipped
behaviour differs from what the design implies, the difference is stated rather
than smoothed over.

Two things to read before changing anything here: **"The enforcer never passes
anything through"** below, which documents a real bypass that was found and
fixed, and **"Deploy order: migration first, then code"**, which is the only
order that does not crash-loop production.

## What existed before

One password. `INBOX_PASSWORD` in the Railway environment, typed by two people,
producing a signed cookie that said `{ authenticated: true }` and nothing else.
Every authenticated request could do everything the backend could do. There was
no identity, so there was no question the audit trail could have answered even
if one had existed.

The change adds named accounts, four roles, a permission catalogue, and a
declarative route policy that is enforced before any handler runs. It is
additive: applying the migration alone changes nothing about who can reach the
inbox, because every human it seeds has `password_hash NULL`, which means the
account exists and cannot log in.

## The four roles

Grants live in `sms_role_permissions`, seeded by the migration. `sms_roles.rank`
orders privilege for comparison only; it grants nothing by itself.

| key | display name | rank | assignable | grants |
|---|---|---|---|---|
| `owner` | Owner | 300 | yes | every permission in the catalogue |
| `admin` | Admin | 200 | yes | every permission except `user.manage.owner` |
| `agent` | Support Agent | 100 | yes | the fourteen listed below |
| `legacy` | Team (shared password) | 90 | **no** | identical to `admin` |

Support Agent holds exactly:

```
conversation.read   message.send        contact.read       contact.write
realtime.subscribe  automation.read     call.read          call.log
voice.token         call.recording.play call.recording.control
intelligence.read   sync.read           device.register
```

and therefore does **not** hold `automation.cancel`, `analytics.read`,
`intelligence.manage`, `intelligence.send`, `catchup.preview`, `catchup.send`,
`sync.run`, `sync.import`, `device.read`, `device.test`, `user.read`,
`user.manage`, `user.manage.owner`, `admin.backfill` or `audit.read`.

`legacy` having the same grants as `admin` is deliberate and is the whole
rollout strategy. Two people currently share `INBOX_PASSWORD` on an iOS build
that cannot be replaced without a multi-day TestFlight round trip. On day one
after the migration plus the matching deploy, both of them see exactly what they
saw before. Tightening the shared login later is an environment-variable flip
(`LEGACY_SHARED_ROLE`, `LEGACY_SHARED_LOGIN`), not a second migration.

`legacy` is `is_assignable = false`, and `routes/users.js` refuses every write
against the `is_legacy_shared` row with 409 `LEGACY_USER_IMMUTABLE` — edit,
deactivate, and password reset alike. Two people are signed in as that row right
now; a mis-click must not be able to change what they can do.

## The permission catalogue

29 keys in `sms_permissions`. `is_destructive` is metadata for a future UI; it
gates nothing today.

| key | destructive | what it covers |
|---|---|---|
| `conversation.read` | | read the shared inbox and threads |
| `message.send` | | send SMS/MMS, upload media, send tapbacks |
| `contact.read` | | read contacts and order context |
| `contact.write` | | create and edit contacts |
| `realtime.subscribe` | | open the SSE stream |
| `automation.read` | | automation stats, queue, recent sends |
| `automation.cancel` | yes | cancel a queued automated message |
| `call.read` | | call history and missed-call state |
| `call.log` | | write a call log entry from a client |
| `voice.token` | | fetch native iOS SIP credentials |
| `call.recording.play` | | play an archived recording |
| `call.recording.control` | | start/stop recording on a live call |
| `analytics.read` | | revenue analytics and attribution drill-down |
| `intelligence.read` | | per-contact conversation intelligence |
| `intelligence.manage` | | view and dismiss campaign suggestions |
| `intelligence.send` | yes | send an intelligence campaign to customers |
| `sync.read` | | integration sync status |
| `sync.run` | | trigger a GHL/Woo/status sync |
| `sync.import` | yes | bulk-import or seed contact data |
| `catchup.preview` | | preview the unanswered-conversation batch |
| `catchup.send` | yes | send the catch-up batch to customers |
| `device.register` | | register/unregister this device for notifications |
| `device.read` | | view push configuration and registered devices |
| `device.test` | | send a test push |
| `user.read` | | list team members and invitations |
| `user.manage` | yes | invite, edit, deactivate, reset passwords |
| `user.manage.owner` | yes | grant or revoke Owner |
| `admin.backfill` | yes | run historical backfills against provider APIs |
| `audit.read` | | read the Activity Center audit trail |

### Per-user overrides

`sms_user_permission_grants` holds `allow`/`deny` rows per user, resolved by the
`sms_effective_permissions` view: role grants, union allow grants, minus denies.

Two asymmetries are intentional and are written into the view, not just the
comments:

- an `allow` with a past `expires_at` is inert;
- a `deny` is **not** expiry-checked. A deny is a safety brake, and a brake that
  releases itself on a timer fails in the wrong direction. To lift a deny,
  delete the row.

## Nothing authority-bearing is in the cookie

The signed session is `{ v: 1, authenticated: true, uid, se }`. There is no
`role` field and no permission list. A cookie that claims `"role":"owner"` is
ignored because nothing reads it — `test/authz.test.js` asserts exactly that.

Enforcement is three middlewares, mounted in `server.js` on `/api` only:

```js
app.use('/api', requireAuth, resolveActor, createPolicyEnforcer());
```

1. **`requireAuth`** — is there a signed session at all. 401 `NOT_AUTHENTICATED`
   otherwise.
2. **`resolveActor`** — turn the session into a database-backed actor. Reads
   `sms_users` uncached on every request (id, email, display name, role,
   is_active, is_legacy_shared, session_epoch, must_change_password), then
   resolves permissions.
3. **`createPolicyEnforcer()`** — look the request up in the route policy and
   compare the required permission against the actor's set.

### The enforcer never passes anything through

**Read this before editing `lib/enforce-policy.js`.** `enforcePolicy` has exactly
three outcomes: `next()` for a matched entry the actor holds, `next()` for a
matched entry whose `permission` is `null`, and a refusal. There is no fourth
branch, and none may be added.

There used to be one, and it was a real bypass, found and fixed in this release:

- Express matches routes **case-insensitively by default**, so
  `app.use('/api', …)` also matches `GET /API/users`.
- The enforcer then applied its own **case-SENSITIVE** `startsWith('/api')` test,
  which failed.
- On that failure the old code called `next()` — "this is not an API request,
  not my problem" — waving the request straight through to the real handler with
  no policy lookup and no permission check.

Verified before the fix: `GET /api/users` → 403 `FORBIDDEN` for a Support Agent;
`GET /API/users` → **200 with the full team list**. Uppercasing one letter
defeated every boundary in the file.

Four things changed:

1. `enforcePolicy` lower-cases the normalised pathname before matching, so every
   casing of a real endpoint resolves to the same policy entry.
2. A path that still fails to classify is **denied** (403 `POLICY_MISSING`) and
   logged, not passed on. A middleware whose job is to say no must not have a
   branch that says yes by accident.
3. `compilePolicy()` **throws at boot** if any literal segment of a policy path
   contains an upper-case character. Matching is done against a lower-cased
   pathname, so a mixed-case entry could never match and would silently leave
   that endpoint on `POLICY_MISSING`. Parameter names (`:entityType`) are exempt
   because they take no part in matching.
4. `findIn()` maps `HEAD` to `GET` before looking the entry up. Express
   auto-routes `HEAD` to the `GET` handler; without the mapping every `HEAD` on
   a valid endpoint answered 403 — fail-closed, but surprising to the first
   health checker or CDN that issues one.

`server.js` adds two second layers so a future mount that forgets the gate
cannot be reached by casing or by slashes either:

```js
app.set('case sensitive routing', true);   // Express defaults to case-INSENSITIVE
app.use((req, _res, next) => {             // collapse repeated slashes, globally
  if (req.url.startsWith('//') || req.url.includes('///')) {
    req.url = req.url.replace(/\/{2,}/g, '/');
  }
  next();
});
```

The slash collapse fixes its own live bug: `app.use('/api', …)` does not match
`//api/conversations`, so **neither the gate nor the real handler ran** — the
request fell through to the SPA catch-all and returned `index.html` with HTTP
200. Not a data leak, but a client asking for JSON was handed a page of HTML and
told it succeeded. `enforcePolicy` normalises repeated slashes too; the server
middleware makes it true for every route at once rather than only inside the
gate.

### Webhooks are protected by the MOUNT, not by a branch in the enforcer

This is the corollary of the above and it is the thing most likely to be
"helpfully" undone.

`app.use('/api', …)` is what keeps `/webhook/*` and `/webhooks/voice`
unauthenticated. It must never become a bare `app.use()`: every webhook route
above it runs unauthenticated by design, and guarding them globally would stop
inbound SMS, delivery receipts, Woo order flows, shipping updates and inbound
calls, all at once and silently.

So there is no need — ever — for a "let non-API paths through" branch inside
`enforcePolicy`, and adding one back reintroduces the bypass. `test/authz.test.js`
asserts all three halves of this contract:

- *"the gate never passes a request it cannot classify"* — `/`, `/index.html`,
  `/health`, `/auth/login`, `/webhook/telnyx` and `/apixyz` are all 403 and
  reach no handler **when routed through the gate**;
- *"case cannot be used to walk around the policy"* — `/api/users`,
  `/API/users`, `/ApI/users` and `/api/USERS` are all 403 `FORBIDDEN` for a
  Support Agent;
- *"the gate is mounted on /api only, so webhooks stay unauthenticated"* — reads
  `server.js` as text, asserts the exact `app.use('/api', requireAuth,
  resolveActor, createPolicyEnforcer())` line, asserts no bare
  `app.use(requireAuth`, and asserts the gate is registered after the `/webhook`
  mounts and before every `/api` mount.

### What is cached, and what deliberately is not

Only the resolved permission `Set`, for 30 seconds, keyed by `userId:sessionEpoch`.
The user row itself is read every request. That is one indexed primary-key
lookup, and it is what makes "deactivate this person" take effect on their next
request rather than on the next cache expiry. `test/authz.test.js` asserts both
halves: a second request within the TTL issues no second permission query, and
flipping `is_active` to false is refused immediately.

`last_seen_at` is written at most once per user per five minutes, fire-and-forget,
and a failure is a warning rather than a request error.

### Failure modes

| condition | response |
|---|---|
| no signed session | 401 `NOT_AUTHENTICATED` |
| named session, user row gone | 401 `ACCOUNT_NOT_FOUND`, cookie cleared |
| `is_active = false` | 401 `ACCOUNT_DISABLED`, cookie cleared |
| cookie `se` ≠ `session_epoch` | 401 `SESSION_STALE`, cookie cleared |
| shared session, no `is_legacy_shared` row | 503 `RBAC_NOT_READY` |
| database unreachable during resolution | 503 `AUTHZ_UNAVAILABLE` |
| `must_change_password`, non-exempt path | 403 `PASSWORD_CHANGE_REQUIRED` |
| policy entry exists, permission missing | 403 `FORBIDDEN` (echoes the key) |
| no policy entry for the path | 403 `POLICY_MISSING` |
| policy matched but `req.actor` absent | 401 `NO_ACTOR` |
| reached the gate but the path did not classify as `/api` | 403 `POLICY_MISSING`, logged |

`HEAD` is answered by the `GET` entry. `POLICY_MISSING` deliberately does not
echo the path back; a probe learns nothing it did not already supply.

`SESSION_STALE` is a 401 and not a 403 on purpose. On iOS a 401 triggers
`restoreSessionIfNeeded()`, so the app silently re-authenticates and picks up its
new permissions. A 403 would be a dead end that only a reinstall clears.

A missing shared identity row is 503, not a guess. Authorisation never fails
open, so "the migration has not been applied" is said plainly.

## The route policy is the single source of truth

`lib/route-policy.js` is a flat table of `{ method, path, permission, audit? }`.
Paths are absolute and include the `/api` prefix, because enforcement reads
`req.originalUrl` rather than a mount-relative `req.path` — a mount-relative
path would silently lose the prefix.

**Default deny.** A request under `/api` that matches no entry is answered 403
`POLICY_MISSING`. A new endpoint is closed until somebody writes it into the
table, rather than open until somebody remembers to close it. This also fixes a
live bug: before the enforcer, an unmatched `/api` GET fell past every mount to
the SPA catch-all in `server.js` and returned `index.html` with HTTP 200, so a
client fetching a mistyped or removed endpoint received a page of HTML where it
expected JSON and reported success.

`permission: null` means "any authenticated actor". It is spelled explicitly, it
is used for exactly two endpoints, and `compilePolicy()` throws if the key is
absent entirely — so a *missing* entry can never be mistaken for an intentional
open one. The two are `GET /api/users/me` and `POST /api/users/me/password`,
which are also the escape hatch from the `must_change_password` lock
(`PASSWORD_CHANGE_EXEMPT`). A locked account that could not read itself or set a
new password would be locked forever.

### Match ordering

`GET /api/voice/logs/:id` would happily match `/api/voice/logs/seen`. Entries are
sorted at compile time by specificity — fewer `:params` first, then longer
literal prefix, then more segments, then longer path — so ordering is a property
of the compiler, not of the order lines happen to appear in the file. Paths are
normalised before matching: the query string and fragment are stripped, repeated
slashes collapse, a trailing slash is removed, **and the result is lower-cased**.
`//API//Analytics//overview/?range=30d` resolves to the same entry as
`/api/analytics/overview`.

Because matching is against a lower-cased pathname, every literal segment in
`lib/route-policy.js` must be written lower-case. `compilePolicy()` throws at
boot on a mixed-case one rather than leaving that endpoint permanently on
`POLICY_MISSING`.

### The bijection test

`test/route-policy.test.js` reads `server.js` as text (requiring it would call
`app.listen()`, connect to Supabase, and start four background jobs), parses out
every `app.use('/api/...', … require('./routes/x'))` mount, loads each router,
walks its stack, and asserts **both** directions:

- every registered `/api` endpoint has exactly one policy entry — so adding an
  endpoint without a policy fails CI instead of shipping open;
- every policy entry corresponds to a registered endpoint — so deleting an
  endpoint without deleting its rule does not leave a dangling one.

There is an `AWAITING_SERVER_WIRING` escape list for routers whose policy landed
before their mount. It is currently empty, and the first test fails if a router
is listed there *and* already mounted, so it cannot rot into a permanent
exemption.

The same file asserts the shadowing behaviour, the two-and-only-two `null`
entries, that the previously ungated `POST /api/voice/backfill-recordings` now
requires `admin.backfill`, and that query strings, trailing slashes and doubled
slashes cannot dodge the policy. Eight tests, over the 65 entries currently in
the table.

## Deploy order: MIGRATION FIRST, THEN CODE

> **`scripts/rbac-migration.sql` must be applied to the Supabase project before
> the matching code is deployed. There is no safe reverse order.** The service
> refuses to start otherwise, and `main` auto-deploys to Railway, so getting it
> wrong is a crash loop on production, not a warning in a log.

This is deliberate. Authorisation is the one subsystem in this repository that
must **not** fail open, so unlike Analytics and the audit trail — both of which
degrade to "no rows" on an unapplied migration — a broken authorisation layer
takes the process down instead of serving requests it cannot correctly refuse.

### Every cause of `process.exit(1)`, and its exact precondition

| # | check | where | fails when | fix |
|---|---|---|---|---|
| 1 | `SESSION_SECRET` is set | `server.js`, immediately before `cookieSession()` is mounted — so it fails during module evaluation, long before `app.listen()` | the Railway variable is unset or empty | set `SESSION_SECRET` in Railway. The previous fallback value was committed to this repository, so an unset secret meant anyone who could read the source could mint a valid session |
| 2 | `assertPolicyPermissionsExist()` | `server.js`, inside the `app.listen()` callback | `sms_permissions` cannot be read (migration not applied), **or** any permission key named in `lib/route-policy.js` is absent from it | apply `scripts/rbac-migration.sql`; or fix the typo. A key like `analytics.raed` is a permission nobody holds — an endpoint silently bricked for every role including Owner |
| 3 | `syncLegacySharedRole()` | `server.js`, immediately after #2 | `sms_roles` cannot be read; `LEGACY_SHARED_ROLE` names a key that is not in it; the `is_legacy_shared` row cannot be read or does not exist; or writing the reconciled role fails | correct the environment variable, or apply the migration. "No `is_legacy_shared` user" says the migration has not run |

Checks 2 and 3 share one `try`/`catch`; either logs `err.message` and calls
`process.exit(1)`. Both run **after** `verifyConnection()`, so a Supabase
outage at boot surfaces there first.

Two further failures are boot-time but throw out of `require`, before
`app.listen()` is reached, so they crash rather than exit cleanly:

| check | where | fails when |
|---|---|---|
| policy table is well-formed | `compilePolicy()`, called by `createPolicyEnforcer()` at mount time | an entry has no `method`/`path`, no `permission` key at all, a path not starting with `/api`, a duplicate `METHOD path`, or an upper-case literal path segment |
| `path-to-regexp` can compile each path | same | a malformed pattern |

### Preconditions, in order

1. `scripts/rbac-migration.sql` has been applied to the configured Supabase
   project. It is additive and seeds every human with `password_hash NULL`, so
   applying it alone changes nobody's access.
2. `SESSION_SECRET` is set in Railway.
3. `LEGACY_SHARED_ROLE`, if set, names a row in `sms_roles`. Unset is fine; the
   default is used.
4. Only then: push to `main`.

Because the crash is on boot rather than on first request, a bad deploy is
visible immediately in the Railway logs — one line naming the missing key or the
unknown role — instead of quietly serving a broken authorisation layer.

## The endpoints the policy does not cover

`POST /admin/release-notify` and the rest of `routes/admin.js` sit outside the
cookie session entirely, behind a bearer token (`ADMIN_API_TOKEN`, falling back
to `INBOX_PASSWORD`). They are called by machines — a GitHub Actions workflow, a
one-off curl — that have a token and no browser session. That router fails
closed: no secret configured means 503, never `next()`.

## `session_epoch`: invalidating a 30-day cookie

The session cookie has `maxAge: 30 * 24 * 60 * 60 * 1000`. Demoting somebody
whose cookie lasts a month is useless unless the cookie can be ended.

`sms_users.session_epoch` starts at 1. A login stamps the current epoch into the
cookie as `se`. `resolveActor` compares them on every request and answers 401
`SESSION_STALE` when they differ. `bump_sms_user_session_epoch(user_id)` is a
`SECURITY DEFINER` RPC granted only to `service_role`; it increments the column
and returns the new value.

The epoch is bumped, and the cached permission Set invalidated, on:

- a role change (`PATCH /api/users/:id`);
- reactivation, and deactivation (`POST /api/users/:id/deactivate`);
- any permission-override grant or revoke;
- an admin password reset (`POST /api/users/:id/reset-password`);
- a self-service password change (`POST /api/users/me/password`);
- `scripts/set-password.js`;
- `syncLegacySharedRole()` when `LEGACY_SHARED_ROLE` has actually changed.

`revokeSessions()` in `routes/users.js` always does both the bump and
`authz.invalidate(userId)`. Doing one without the other leaves a stale grant live
for up to the 30-second cache TTL.

A self-service password change is the one case that re-stamps the current
request's cookie with the new epoch, so the person who just typed their new
password stays signed in on that device and only that device.

### The honest limit

**A pre-existing shared cookie carries no `se`, so there is nothing to compare
against, and it is exempt from the epoch check by design.** Bumping the legacy
user's `session_epoch` does **not** log those cookies out. That exemption is the
single branch that stops this deploy signing both current users out of an iOS
build that cannot be updated for days, so it is load-bearing, not an oversight.

To actually end shared sessions there are two levers, and both are needed for a
clean cut:

1. `LEGACY_SHARED_LOGIN=disabled` — stops new shared logins (401
   `LEGACY_LOGIN_DISABLED`). Existing cookies still resolve.
2. Rotate `SESSION_SECRET` — invalidates every signed cookie in existence,
   named and shared alike. Everyone signs in again.

There is no third option. A cookie with no epoch cannot be selectively revoked.

## Password hashing

`lib/password.js`. scrypt from `node:crypto`, nothing else.

This repository has zero native dependencies and a plain `npm ci` Railway build.
argon2 and bcrypt both pull a compiler into the deploy path. scrypt is
memory-hard, is in the standard library, and is adequate for a team of
single-digit size. That is the whole reasoning, and it is a trade recorded rather
than hidden: argon2id is the better primitive, and the encoding below exists so
it can be adopted without a migration.

Stored format:

```
scrypt$1$N=16384,r=8,p=1,len=64$<salt-base64>$<hash-base64>
```

- `scrypt` is the algorithm tag and `1` the version. `verifyPassword()`
  dispatches on both, so a future `argon2id$1$…` row can sit in the same column
  and be verified by the same function. Never strip them.
- Parameters are stored **per hash**, not read from a constant. Raising the cost
  later does not invalidate existing passwords.
- `N=16384, r=8, p=1` is the Node default and the scrypt paper's interactive
  parameter set. `maxmem` is raised above Node's 32 MB default because
  `128 · N · r` is 16 MB and Node wants headroom.
- Salt is 16 random bytes per hash.
- `parseParams()` bounds `N ≤ 2^20, r ≤ 64, p ≤ 16, len ≤ 256`. A hostile row
  could otherwise ask the process to allocate gigabytes during a login.
- `verifyPassword()` returns `false` for any malformed or unknown-algorithm
  stored value rather than throwing, so a corrupted row is a failed login and not
  a 500 that leaks the difference. Comparison is `crypto.timingSafeEqual`.

Policy is length-first: 12 to 200 characters, not only whitespace. No character
classes. Length beats composition rules.

### Timing

`DUMMY_HASH_PROMISE` is a real hash of 32 random bytes, built once at module
load. `routes/auth.js` verifies against it on the unknown-email branch, on the
`is_legacy_shared` branch, and on the "known email with no password set" branch,
so exactly one scrypt verification happens on every login path. Without it, an
attacker enumerates valid addresses purely from response latency.
`test/authz.test.js` asserts the three failures are indistinguishable.

### Lockout

Five consecutive failures set `locked_until` 15 minutes ahead and reset the
counter. A locked account returns 429 `ACCOUNT_LOCKED` **even when the password
supplied is correct** — otherwise the lock is a free oracle that tells an
attacker the moment they guessed right.

The shared login is exempt from that, because a database lockout on one shared
row would lock both current users out at once. It gets a per-IP throttle instead:
10 failures per 15 minutes, held in process memory. Brute force is stopped, and
one person fat-fingering the shared password cannot take the other person's
iPhone offline. Both paths also sit behind an `express-rate-limit` of 40 requests
per 15 minutes.

Every attempt, success or failure, appends a row to `sms_auth_events` with
method, outcome, code, IP, user agent and the `x-vici-client` header. That write
never throws; a failure is a warning.

## Invitations

`routes/invitations.js` plus `POST /auth/invitation/accept` in `routes/auth.js`.

1. An Admin posts `{ email, displayName, phone?, role?, expiresInHours? }` to
   `POST /api/invitations`. Default role is `agent`; default TTL is 168 hours,
   capped at 720.
2. The server generates `crypto.randomBytes(32)` base64url and stores **only**
   `sha256(token)` plus an 8-character prefix **of that hash**. No substring of
   the live secret is written anywhere, so a database dump yields neither a
   working invitation nor a head start on guessing one. The prefix exists only to
   tell two hashes apart in a log line; the UI identifies invitations by email.
3. The raw token and an `acceptUrl` (built from `APP_URL`, `null` if unset) are
   returned **once**, in that response. They are not stored, not logged, and not
   recoverable.
4. The invitee posts `{ token, password }` to `POST /auth/invitation/accept` —
   public by necessity, since they have no session yet. The token is the only
   credential it accepts.

### There is no email sender

This service has no email transport. `POST /api/invitations` returns:

> This token is shown once and is not recoverable. No email is sent from this
> service — pass the link to them over a channel you trust.

The Admin passes the link on themselves. Every adjacent endpoint says the same
thing rather than letting an admin assume a mail went out: `POST /api/users`
without a password says the account cannot sign in yet, and
`POST /api/users/:id/reset-password` returns the temporary password inline with
"Shown once. Pass it on over a channel you trust."

That is also why accepting an invitation does **not** sign anybody in. The
inviting Admin frequently holds the token themselves; auto-signing-in would put
the new account into the Admin's browser. The response is 201 with
`mustChangePassword: true` and an instruction to sign in and set a new password.

### Concurrency

Redemption goes through the `redeem_sms_invitation(token_hash, password_hash)`
SQL function: `SELECT … FOR UPDATE` on the invitation, the four state checks,
the `INSERT` into `sms_users` with `must_change_password = true`, and the
`accepted_at` update, all in one transaction. Two simultaneous redemptions of the
same token yield exactly one account; the loser blocks, then sees `accepted_at`
set and raises `INVITATION_USED`. `test/authz.test.js` asserts this. Do not
reimplement it as read-then-write in Node — that race is what the function exists
to remove.

`RAISE EXCEPTION` messages map to HTTP in `REDEMPTION_ERRORS`:
`INVITATION_NOT_FOUND` 404, `INVITATION_REVOKED` 409, `INVITATION_USED` 409,
`INVITATION_EXPIRED` 410.

A partial unique index enforces at most one **open** invitation per email
address; accepted and revoked rows stay as history and do not block a re-invite.
`attempt_count` is bumped best-effort outside the function, because the function
raises and rolls its own transaction back. `sms_auth_events` is the audit trail
that actually matters.

Only an Owner may invite an Owner (`user.manage.owner`); `legacy` is
`is_assignable = false` and is refused with `ROLE_NOT_ASSIGNABLE`.

## The last-administrator guard

`wouldStrandWorkspace()` in `routes/users.js` refuses any change that would leave
zero active Owners or Admins. It fires on demotion out of an administrative role,
on deactivation, and returns 409 `CANNOT_DEACTIVATE_LAST_OWNER`.

It is application logic rather than a database constraint on purpose: the caller
gets a 409 they can act on instead of a 500 they cannot. `test/authz.test.js`
asserts the status code specifically, not just the refusal.

The count is `countActiveAdministrators()`, a head-count with
`.in('role', ADMINISTRATIVE_ROLES)`. That `.in()` is over a two-element module
constant, not a computed list, so it cannot grow with the data — the constraint
`test/no-unbounded-in.test.js` exists to enforce.

Related guards in the same file:

- Only an actor holding `user.manage.owner` may set a role to `owner`, change a
  role away from `owner`, reset an Owner's password, or grant
  `user.manage.owner` as an override. All 403 `OWNER_ROLE_REQUIRES_OWNER`.
- `PATCH` refuses `isActive: false` with 400 `USE_DEACTIVATE_ENDPOINT`, so a
  deactivation always goes through the endpoint that records it.
- `publicUser()` is the only serialiser. `password_hash` is reduced to a
  `hasPassword` boolean and dropped; `test/authz.test.js` asserts no response
  body anywhere carries a hash.
- `POST /api/users/me/password` is refused for the shared identity with 400
  `LEGACY_SESSION_NO_PASSWORD`. Its credential is `INBOX_PASSWORD`, held by
  Railway, not a row in the table. `scripts/set-password.js` refuses it too.

## Analytics is Admin-only, and why

`analytics.read` is held by `owner`, `admin` and `legacy`. It is **not** held by
Support Agent, so `GET /api/analytics/overview` and
`GET /api/analytics/attributions` are 403 for that role, and `MainTabView` in the
iOS client hides the Analytics tab when the permission is absent.

The reasoning:

- The Analytics surface is the business's revenue: gross, refunds, net,
  attributed order values, and a drill-down that names individual orders. That is
  ownership information, not operational information. Nothing in a Support
  Agent's job — reading threads, replying, updating a contact, taking a call —
  needs it.
- `docs/analytics/ANALYTICS-ARCHITECTURE.md` records that this deployment cannot
  yet support defensible per-staff usage metrics. Revenue visible to everyone in
  a workspace with no per-staff attribution invites exactly the comparison the
  data cannot support.
- Hidden UI is not security, and the code says so. `MainTabView` comments that
  the server rejects the endpoints for this role regardless of what the tab bar
  shows. The tab is hidden for tidiness; the 403 is the control. `SessionModel.can()`
  even **fails open** — an unknown account, including one on a backend that
  predates `/api/users/me`, is treated as fully permitted — precisely because
  that gate exists to keep the interface honest rather than to secure anything.
  The permission set it consults comes from `GET /api/users/me`, not from the
  login response.
- The tab is hidden by an enum case rather than by renumbering integer tags.
  With the old `.tag(0)`…`.tag(4)` literals, hiding one tab silently renumbered
  the rest and `AnalyticsView(isSelected: selection == 4)` would have bound to
  whichever tab landed on index 4.

This is a policy decision, not a technical constraint. Granting a specific agent
read access is a single `allow` override on `analytics.read` — no code change and
no migration. That is the intended path if the decision is ever revisited for one
person rather than for the role.

## Migrating off the shared password

The shared login is retired by configuration, in this order. None of it is a
migration.

1. **Give each person a named account.** Either invite them
   (`POST /api/invitations`, pass the link on yourself) or run
   `NEW_PASSWORD='…' node scripts/set-password.js --email someone@example.com`.
   Replace the seeded placeholder `dominic.placeholder@vici.invalid` with the
   real address first — the migration says so inline.
2. **Confirm both people have signed in with their own credentials at least
   once.** `GET /api/users` shows `hasPassword` and `lastSeenAt`.
   `sms_auth_events` shows `method = 'password'` successes.
3. **Demote the shared identity.** Set `LEGACY_SHARED_ROLE=agent` and redeploy.
   `syncLegacySharedRole()` reconciles the role at boot, bumps the shared row's
   epoch, and clears its cached permissions. Anything still on a shared cookie
   drops to Support Agent immediately. This is the reversible step; use it to
   discover what still depends on the shared login before removing it.
4. **Disable the shared login.** Set `LEGACY_SHARED_LOGIN=disabled`. New shared
   logins are refused with 401 `LEGACY_LOGIN_DISABLED` and the message "The
   shared team password is no longer accepted. Sign in with your own email."
   Existing shared cookies still resolve.
5. **Rotate `SESSION_SECRET`.** This is the step that actually ends the existing
   shared cookies, because they carry no epoch. Every session, named and shared,
   is invalidated. Everyone signs in again once.
6. Optionally rotate `INBOX_PASSWORD` afterwards. Note that `routes/admin.js`
   falls back to it as the machine bearer token, so set a dedicated
   `ADMIN_API_TOKEN` first or the admin endpoints will start refusing.

Do not skip to step 4. Between steps 3 and 5 the shared identity should be a
Support Agent for long enough to notice anything that quietly depended on its
Admin grants.

### The browser can now sign in as a named account

This changed. An earlier revision of this document said the web UI knew only the
shared password and that step 4 above would lock the browser out; that is no
longer true.

`LoginScreen` in `public/app.jsx` has an optional email field, placeholder
"Email (leave blank for the shared code)". The submit posts
`{ email, password }` when the field is non-empty after trimming, and
`{ password }` alone when it is blank, so the shared-access-code path is
unchanged and nobody has to learn a new habit on day one. The password field's
own placeholder follows the email field — "Password" once an address is typed,
"Access code" while it is empty — and the error copy distinguishes
`ACCOUNT_LOCKED`, `LEGACY_LOGIN_DISABLED`, `ACCOUNT_DISABLED` and
`PASSWORD_CHANGE_REQUIRED` rather than telling all four "incorrect password".

This is what makes step 4 of the retirement above survivable: with
`LEGACY_SHARED_LOGIN=disabled`, the browser still has a way in, and an invited
Support Agent can reach the web UI at all.

**`public/app.js` is a committed build artifact of `public/app.jsx` and nothing
rebuilds it at deploy time.** Editing the source and forgetting `npm run build`
ships a browser bundle that silently ignores the change. The bundle-sync step in
`.github/workflows/server-tests.yml` runs `npm run build` and then
`git diff --exit-code -- public/app.js`, so that mistake now fails CI. It is the
web-side counterpart of the generated-Xcode-project check in
`.github/workflows/ios-build.yml`.

#### Still iOS-only

The named login is the only part of the team feature set the browser has.
`public/app.jsx` makes no request to `/api/users`, `/api/invitations` or
`/api/audit`.

- **Team management** — inviting, editing roles, deactivating, resetting
  passwords — is the iOS Team screen, or a direct API call.
- **The Activity Center** (`docs/team/ACTIVITY-CENTER.md`) is the iOS Activity
  screen, or a direct API call.

An Owner or Admin working from a browser can sign in and use the inbox, and can
do nothing administrative without curl.

## Future roles

Nothing below exists. It is recorded so the next reader knows what was
considered and rejected for now.

- **Read-only / Viewer.** Everything `agent` has, minus `message.send`,
  `contact.write`, `call.log` and `call.recording.control`. Not added because
  nobody needs it yet, and an unused role is a role whose grants nobody has
  checked.
- **Billing / Finance.** `analytics.read` and nothing else — the mirror image of
  Support Agent. This is the most likely next role, and it is precisely the case
  the Admin-only analytics decision above defers. Today it is achievable as an
  `allow` override on an `agent`.
- **Integration / service account.** A non-human principal for scripted access.
  `sms_users.actor_type` does not exist; the audit log's `actor_type` enum
  already reserves `'integration'`, so the audit side is ready and the identity
  side is not. Machine access currently goes through the `/admin` bearer token
  instead, which is a different and deliberately narrower surface.

Adding a role is one `INSERT` into `sms_roles` plus its `sms_role_permissions`
rows. No code change is required, because nothing in `lib/` branches on a role
name — `enforce-policy.js` compares permissions only. The single exception is
`ADMINISTRATIVE_ROLES` in `routes/users.js`, which is what the
last-administrator guard counts; a new administrative role must be added there or
it will not count towards preventing a lockout.

## Campaign and autonomous-workflow permissions

The campaign review foundation is implemented with explicit permissions:

```
campaigns.read       view campaigns, previews and operational performance
campaigns.manage     create/edit drafts and submit them for review
campaigns.approve    approve or reject a frozen campaign revision
campaigns.launch     schedule an approved campaign (destructive)
campaigns.cancel     cancel queued/claimed recipients (destructive)
campaigns.configure  change provider/live-send eligibility (Owner only)
```

The approve/launch split is deliberate. Owner/Admin/legacy accounts receive
read/manage/approve/launch/cancel; Support Agent receives only
`campaigns.read`; only Owner receives `campaigns.configure`. Route-policy
enforcement is authoritative, so hiding controls in SwiftUI is only a usability
layer.

Draft, review, approval, scheduling and cancellation audit types are active.
`campaign.launched` remains reserved because there is no live delivery worker in
this release. Existing `campaign.suggestion.*` single-message actions remain
separate and continue to use `intelligence.manage` / `intelligence.send`.

`docs/analytics/REVENUE-ATTRIBUTION-METHODOLOGY.md` already records the rule that
matters here: Suggested, Approval Required and Autonomous execution modes belong
to the future automation system, and **Autonomous must never be the default**.
An autonomous mode needs a distinct permission from `campaign.launch` — the
question "may this person send a campaign" and the question "may this person let
the system send campaigns without a human" are not the same question, and one
key cannot answer both.

Any future worker/reconciler or autonomous mode needs its own separately
reviewed permission and must be added to `sms_permissions` and
`lib/route-policy.js` together. The boot-time catalogue check and route-policy
bijection test fail the build if only one side is changed.

## Files

| path | role |
|---|---|
| `scripts/rbac-migration.sql` | roles, users, permission catalogue, grants, overrides, invitations, auth events, two RPCs, RLS |
| `server.js` | `SESSION_SECRET` guard, case-sensitive routing, slash collapse, the `/api` mount, the two boot-time checks |
| `lib/authz.js` | session → actor, permission cache, auth event writer |
| `lib/route-policy.js` | the policy table (65 entries) and the password-change exemptions |
| `lib/enforce-policy.js` | compile, order, lower-case match, enforce; `HEAD`→`GET`; boot-time catalogue check |
| `lib/password.js` | scrypt hashing, verification, strength policy, timing dummy |
| `routes/auth.js` | login (dual path), logout, check, invitation acceptance, `syncLegacySharedRole` |
| `routes/users.js` | team CRUD, self-service password, owner and last-admin guards, seven `team.*` audit call sites |
| `routes/invitations.js` | invitation store, create/list/revoke, token hashing, three `team.*` audit call sites |
| `public/app.jsx` | `LoginScreen` — optional email field; blank keeps the shared-access-code path |
| `scripts/set-password.js` | out-of-band password set; writes to the configured Supabase project |
| `test/authz.test.js` | 35 tests: cookie forgery, epochs, caching, per-role sweeps, the case bypass, the mount, user guards, invitations, login |
| `test/route-policy.test.js` | 8 tests: the bijection, ordering, normalisation |
| `test/password.test.js` | round-trip, versioning, per-hash parameters, hostile input |
| `test/audit-team.test.js` | the nine `team.*` audit rows: summaries, before/after, no hash or token |
| `.github/workflows/server-tests.yml` | `npm test`, plus `public/app.js` must match a fresh build of `public/app.jsx` |

## Related

- `docs/team/ACTIVITY-CENTER.md` — what these actors did, recorded in
  `sms_audit_log`. `audit.read` is the permission that opens it. The nine
  `team.*` event types written by `routes/users.js` and `routes/invitations.js`
  are documented there, with the worked role-change example.
- `docs/analytics/ANALYTICS-ARCHITECTURE.md` — the subsystem `analytics.read`
  gates, and the workspace-boundary limitation behind the Admin-only decision.
