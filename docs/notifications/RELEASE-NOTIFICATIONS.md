# Release notifications

Telling the two people who use the iPhone app that a new TestFlight build
exists, without pretending that a push can install it for them.

Sources: `lib/apns-notify.js`, `lib/release-targets.js`, `routes/mobile-push.js`,
`routes/admin.js`, `scripts/ios-push-devices-migration.sql`,
`.github/workflows/ios-testflight.yml`,
`ios/scripts/publish-testflight-build.py`, and
`ios/ViciInbox/App/MessageNotificationManager.swift`. Tests:
`test/apns-release-notify.test.js`, `test/release-targets.test.js`.

## The problem

A TestFlight build ships. Nobody knows. The tester either opens TestFlight out
of habit or runs the previous build for a week. Apple's own TestFlight
notification is opt-in per tester and easy to miss, and there is no way to tell
from the outside whether it arrived.

The app already holds APNs device tokens for message alerts. This reuses that
channel for a second, deliberately different kind of push.

## Architecture

### The provider connection

`lib/apns-notify.js` speaks HTTP/2 to Apple directly. There is no third-party
push library, matching this repository's no-native-dependencies posture.

Authentication is a **provider token**, not a certificate: an ES256-signed JWT
with header `{ alg: 'ES256', kid: APNS_KEY_ID }` and claims
`{ iss: APNS_TEAM_ID, iat: <now> }`, signed with the `.p8` private key decoded
from `APNS_KEY_P8_BASE64`, using `dsaEncoding: 'ieee-p1363'` — Apple requires the
raw r||s signature form, not DER.

The token is cached in a module global for 50 minutes (Apple's limit is 60).
`resetProviderTokenCache()` exists purely as a test hook: without it, a test that
sets different credentials would silently reuse the previous test's token and
pass for the wrong reason.

Credentials come from three Railway variables — `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_KEY_P8_BASE64`. Per `AGENTS.md` these are a **separate Apple Developer APNs
key**; the App Store Connect API key and the Telnyx VoIP credential are not
substitutes. If any is absent, `reportMissingConfiguration()` logs once per
process and returns `{ sent: 0, disabled: true }`.

Hosts: `api.push.apple.com` for production tokens, `api.sandbox.push.apple.com`
for sandbox. Devices are grouped by environment and **exactly one connection is
opened per environment actually present** in the target set — never one per
device. A sandbox token is meaningless to the production host and vice versa.
`test/apns-release-notify.test.js` asserts the connection count for mixed and
single-environment sets.

### Two storages, and why one of them is the real one

There are two places a device token can live:

- **`ios_push_devices`** — the dedicated table, defined by
  `scripts/ios-push-devices-migration.sql`.
- **`push_subscriptions`** — the browser web-push table, holding typed APNs rows
  with `endpoint = 'apns://{environment}/{token}'` and the device fields inside
  the existing jsonb `subscription` column.

**`ios_push_devices` does not exist in production.** The migration file says so
in its own header and has never been applied, which is why it is amended in
place rather than followed by a second migration. Everything therefore runs
through the compatibility path today.

#### The migration file itself, since it will be applied eventually

Two things changed in it, both about the state it leaves behind if it is run:

- **It is wrapped in `BEGIN` / `COMMIT`**, matching
  `scripts/audit-migration.sql` and `scripts/rbac-migration.sql`. Every statement
  in it is transactional in Postgres, so a failure part-way through now rolls the
  whole file back rather than leaving the table created but unindexed and — the
  part that matters — unprotected. It stays re-runnable: every statement is
  `IF NOT EXISTS` or an idempotent `ALTER`.
- **RLS is `ENABLE`, not `DISABLE`.** It previously read `DISABLE`, which would
  have left a table holding APNs device tokens — and, since the `user_id` column,
  a map of which human owns which iPhone — readable by `anon` and
  `authenticated` through the Supabase REST endpoint with nothing but the
  publishable key. A device token is a push-delivery credential. Enabled with no
  policies, matching every other table in this release: the Railway backend uses
  the service role, which bypasses RLS, and every other Postgres role sees zero
  rows. `REVOKE ALL` from `PUBLIC`/`anon`/`authenticated` and an explicit
  `GRANT` to `service_role` sit alongside it.

#### Known gap: `push_subscriptions` has no RLS, and now carries `userId`

The compatibility table — **the one actually holding the real APNs device tokens
today** — does not have RLS enabled, and since device registration started
recording ownership it also carries a `userId` inside its jsonb `subscription`
column. So the exposure the paragraph above describes for `ios_push_devices`
exists right now on `push_subscriptions`.

That is recorded, not fixed here, and deliberately so. `push_subscriptions` is a
live table serving browser web push and the iOS compatibility path
simultaneously. Enabling RLS on it is its own migration with its own review of
every reader, not a side effect of a file about a table that does not exist yet.
The header of `scripts/ios-push-devices-migration.sql` says the same thing in the
same words: **do not quietly fold it into that one.**

`loadDevices()` tries the dedicated table first and falls back on error, so the
code is correct either way:

1. Query `ios_push_devices` for `id, device_token, environment, bundle_id,
   user_id, app_build, user_agent`.
2. On error, retry with the original narrower column list — so a *half*-applied
   migration (table present, targeting columns absent) degrades to "targeting
   unavailable" rather than to "no devices at all".
3. On error again, query `push_subscriptions` for `endpoint LIKE 'apns://%'` and
   normalise each row via `normaliseCompatibilityRow()`, which lifts
   `deviceToken`, `environment`, `bundleId`, `userId` and `appBuild` back out of
   the jsonb.

Every normalised row carries `storage: 'dedicated' | 'compatibility'`, and that
field is load-bearing on the write side: `removeInvalidDevice()` deletes from the
table the row actually came from. Getting this wrong is how stale-token cleanup
came to be a silent no-op in production — the delete ran against a table that
does not exist, the error was logged and swallowed, and nothing was ever removed.

Consequences of running on the compatibility path:

- `user_id` and `app_build` live inside jsonb rather than in indexed columns, so
  owner and build filters are applied in memory after the read. At two devices
  that is irrelevant.
- A soft error (429, 503, timeout) cannot record `last_error`, because
  `push_subscriptions` has no such column. `removeInvalidDevice()` returns early
  for compatibility rows.
- Deletion on a *permanent* failure still works, against `push_subscriptions`.

### Paging, not a limit

`loadDevices()` pages with `.range()` at 1000 rows per page up to 10 000.

This replaced a `.limit(100)`. PostgREST caps a response at 1000 rows and does
not say it did; a hard `.limit(100)` was the same silent truncation with a lower
ceiling. At two registered devices it is invisible, and it stays invisible right
up to the day the 101st iPhone stops getting notified for no observable reason.
If the 10 000 ceiling is genuinely reached, it logs "some devices were not
notified" rather than quietly sending to a subset.

### Registration

`POST /api/mobile-push/register`, from `MessageNotificationManager` after
authentication. Body: `deviceToken`, `installationId`, `environment`, and
optionally `appBuild`.

`user_id` is taken **only** from `req.actor.id`, never from the request body. A
client-supplied user id is a trivial impersonation vector: anyone who can
register a device could claim to be another operator and receive pushes
addressed to them.

Because `ios_push_devices.user_id` is `bigint`, a non-numeric actor id is
stripped from the dedicated-table row rather than failing the whole
registration; compatibility storage, being jsonb, still records the owner.

Token rotation cleanup runs on every register, against **both** storages: delete
any prior row with the same `installation_id` and a different `device_token`. The
compatibility half prefers a PostgREST filter on the jsonb key
(`subscription->>installationId`) so Postgres does the matching and nothing is
read into memory; if that operator is rejected it falls back to a paged scan.
Without this, a rotated token keeps receiving alerts until APNs eventually 410s
it, which can take weeks.

**The iOS client does not currently send `appBuild`.**
`APIClient.registerMessagePushDevice` posts only `deviceToken`, `installationId`
and `environment`. So build-staleness targeting in production runs entirely off
the User-Agent fallback described below. The backend accepts `appBuild` and
`normaliseAppBuild()` handles it; nothing sends it yet.

## Targeting

`lib/release-targets.js` is kept pure and separate from the I/O so the decision
can be tested offline. Two filters, and the difference matters.

### `userId` — "this person's iPhones"

Exact string match on `row.user_id`. Correct once a device has been registered by
a signed-in user. **A device with no owner is never returned by an owner-scoped
send.** That asymmetry is deliberate: a release note reaching the wrong person is
harmless, an admin action reaching the wrong person is not, and this function
serves both.

`user_id` is normalised to a string on read, because Postgres returns a bigint as
a JavaScript number and the comparison is `===`. Without `normaliseUserID()` an
owner-scoped send would match nothing and silently reach no one.

### `belowBuild` — "iPhones not already running this build"

The right filter for a release announcement, regardless of identity:

- **self-correcting** — a device stops matching the moment it updates and
  re-registers;
- **idempotent** — re-running after everyone has updated sends to nobody.

`deviceBuild(row)` prefers the explicit `app_build` field, then falls back to
parsing the User-Agent:

```js
/^[\w .-]*inbox\/(\d{1,9})(?=\s|$)/i
```

`Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0` → `21`. The pattern is
anchored to our own product token, not to any `name/version` pair, because a
User-Agent carries several of them and an unanchored match against
`CFNetwork/3860` yields `3860` — which reads as "already on a newer build" and
quietly excludes the one device that needed telling. The name decodes to
`Vici Inbox`, with a space, so the character class allows spaces; it also matches
the Shore fork.

**Fail open on an unknown build.** A device whose build cannot be determined is
included, not skipped. Telling someone twice is a nuisance; silently failing to
tell the one person who needed the message is the failure that matters.

`belowBuild` is compared with `Number.isFinite`, not `Number()`. `Number(null)`
is `0`, which is finite, so an absent filter would read as "exclude anything
built after the dawn of time" and return nobody.

The two filters **intersect**, never union. An empty selection stays empty and
never falls back to everyone — a test asserts exactly that, because "no matches,
so send to all" is the shape of every accidental mass notification.

### Which to use

| situation | filter |
|---|---|
| a new TestFlight build is out | `belowBuild: <the new build number>` |
| one person's device is misbehaving and you want to confirm it can receive a push | `userId` |
| a targeted message to one operator | `userId`, and only `userId` |
| both — "tell this person if they are stale" | both; they intersect |

## The release payload

```json
{
  "aps": {
    "alert": { "title": "…", "body": "…" },
    "sound": "default",
    "thread-id": "vici-release"
  },
  "screen": "analytics"
}
```

It carries **no `badge`** and **no `phone`**, and both omissions are load-bearing.

**No `badge`.** The Home Screen badge is one number for the whole app and it
carries unread messages *plus* unseen missed calls. A release note is not an
unread message. Sending a badge with it would overwrite a real operational count
with a number that means nothing.
`sendReleaseNotification` never even calls `currentUnreadCount()` — a test
asserts the query is not issued, not merely that the field is absent.

**No `phone`.** The iOS tap handler keys off a top-level `phone` and would try to
open a conversation thread that does not exist. `screen: "analytics"` sends the
tap somewhere real instead.

Contrast with `sendNativeMessagePush`, which carries both, plus
`thread-id: <phone>` so iOS groups banners per conversation. Two payloads, one
delivery path — `deliver()` only transports; the two senders decide what is in
the envelope.

`apns-collapse-id` defaults to `vici-release-<belowBuild>` and is sanitised to
printable ASCII and truncated to 64 bytes, which is Apple's limit. A retry
replaces the banner rather than stacking a second one.

Delivery headers are fixed: `apns-push-type: alert`, `apns-priority: 10`,
`apns-expiration` 24 hours out, `apns-topic` from the row's `bundle_id`.
`safeExtraHeaders()` refuses any caller-supplied header starting with `:` or
named `authorization`, so a payload option cannot become a delivery redirect.

## `POST /admin/release-notify`

Lives on `routes/admin.js`, **outside the cookie session**, behind
`Authorization: Bearer <ADMIN_API_TOKEN>` (falling back to `INBOX_PASSWORD` while
the dedicated variable is unset). That router fails closed: no secret configured
means 503, never `next()`. It is off the session because the intended callers are
machines — a workflow, a one-off curl — that have a token and no browser.

```
POST /admin/release-notify
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json

{
  "userId":     "7",            // optional
  "belowBuild": 22,             // optional, digits only, 1-9 chars
  "title":      "Vici Inbox 22",// required to send, ≤120 chars
  "body":       "…",            // required to send, ≤500 chars
  "collapseId": "vici-release-22", // optional
  "dryRun":     false           // see below
}
```

### `dryRun` defaults to **true**

```js
const dryRun = payload.dryRun !== false;
```

Only an explicit `"dryRun": false` sends anything. Omitting the field, sending
`"dryRun": "false"` as a string, sending `null`, sending `0` — all of those are
dry runs. The cost of a mistaken dry run is a JSON list; the cost of a mistaken
send is a push notification on someone's phone that cannot be recalled.

A dry run returns the resolved target list and sends nothing:

```json
{
  "ok": true,
  "dryRun": true,
  "sent": 0,
  "targeted": 1,
  "apnsConfigured": true,
  "targets": [
    { "id": 1, "storage": "compatibility", "environment": "production",
      "user_id": "7", "app_build": null, "device_token_suffix": "3f9a2c11" }
  ]
}
```

Two properties of that response are asserted by tests:

- **No APNs connection is opened.** A dry run must not touch Apple.
- **`device_token` is absent; only `device_token_suffix` leaves the API.** A full
  APNs device token is a delivery credential — anyone holding it plus provider
  access can push to that iPhone. Eight characters is enough to match a device
  against the register and status logs and useless for anything else.

A dry run also answers when APNs credentials are **not** configured
(`apnsConfigured: false`), because it cannot send and there is therefore nothing
to protect. A real send in that state returns `{ sent: 0, disabled: true }`.

`title` and `body` are only required when actually sending — a dry run answers
"who would this reach", which is a useful question before the copy is written.
For a real send with neither, the handler substitutes "Vici Inbox update" / "A
new build is available."; a real send missing one of the two is a 400.

Outcomes: a provider or device-read error is a 502 with the message; a thrown
exception is a 500. Every call logs one line with `dryRun`, `userId`,
`belowBuild`, `targeted` and `sent`.

### Suggested sequence

```bash
# 1. Who would this reach? (dryRun is the default; the flag is written anyway)
curl -sS -X POST https://<host>/admin/release-notify \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"belowBuild": 22, "dryRun": true}'

# 2. Read the target list. Confirm the count and the suffixes.

# 3. Send.
curl -sS -X POST https://<host>/admin/release-notify \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"belowBuild": 22, "dryRun": false,
       "title": "Vici Inbox 22",
       "body": "Team roles and the Activity screen. Update in TestFlight."}'
```

## The release workflow, end to end

`.github/workflows/ios-testflight.yml`, `workflow_dispatch` only — it signs and
uploads a release, so it never runs on a push. Concurrency group `ios-testflight`
with `cancel-in-progress: false`, on `macos-26` (the image carrying Xcode 26,
which App Store Connect has required since 28 April 2026).

1. **Check out**, print the toolchain.
2. **Verify the generated project is current** — run
   `ios/scripts/generate-xcodeproj.py` and `git diff --exit-code`. The Xcode
   project is generated, not maintained by hand, so a Swift file added without
   regenerating would silently not be compiled. Fail loudly here instead.
3. **Compile for the simulator, unsigned.** A failure at this point is source
   code or package resolution, not Apple credentials.
4. **Write the App Store Connect API key** from `ASC_KEY_P8_BASE64`, verifying it
   decoded to a PEM private key without printing it.
5. **Archive** with `CODE_SIGNING_ALLOWED=NO` and
   `CURRENT_PROJECT_VERSION=${{ github.run_number }}`. **That run number is the
   build number**, and it is the value `belowBuild` refers to later.
6. **Seed archive push entitlements** — an ad-hoc local `codesign` so the
   requested push capability survives the cloud-managed re-sign, verified by
   extracting `aps-environment` and requiring `development`.
7. **Export the `.ipa`** with `-allowProvisioningUpdates` and the authenticated
   Team key.
8. **Verify production push signing** — unzip the exported `.ipa`, extract both
   the app's entitlements and the embedded provisioning profile, and fail unless
   *both* say `production`. A TestFlight binary can compile and sign while
   carrying the wrong APNs environment; a sandbox-push build reaching testers
   would mean every production push silently fails.
9. **Upload to TestFlight** via fastlane `pilot`, with
   `skip_waiting_for_build_processing:true` and a 25-minute step timeout.
   `altool` is deprecated and currently broken against Xcode 26.
10. **Publish notes and distribute** — `ios/scripts/publish-testflight-build.py`.
11. **Remove the API key**, `if: always()`.

### Why steps 9 and 10 are separate

fastlane cannot do both. Waiting for build processing hangs long enough to hit
the job timeout — on 20 August 2026 a build uploaded fine and the workflow still
reported "cancelled" an hour later. But a changelog cannot be applied while
skipping that wait, so passing both silently produced an **empty release note**
and testers saw nothing describing the build.

So the upload uploads, and `publish-testflight-build.py` sets the notes and
distributes afterwards through the App Store Connect API, which needs no
processing wait. The script:

- mints its own ES256 JWT (15-minute expiry, `aud: appstoreconnect-v1`);
- reads the newest build: `GET /builds?filter[app]=<id>&limit=1&sort=-version`,
  and prints its `processingState`;
- **exits non-zero if the changelog file is empty** — testers would get a blank
  release note, which is the failure this script exists to prevent;
- `PATCH`es the existing `en-US` `betaBuildLocalizations` row if fastlane already
  created an empty one, otherwise `POST`s a new one;
- `POST`s the build into the beta group relationship. Already-assigned is the
  normal case and is not treated as an error;
- **verifies the end state** with `GET /builds/{id}?include=betaGroups` and exits
  non-zero if the group is missing.

That last check is what makes a build installable at all: an uploaded build
assigned to no group notifies nobody.

### The workflow does not send the push

There is no release-notify step in the YAML. After the workflow succeeds, the
`POST /admin/release-notify` call above is made by hand. Automating it would mean
putting `ADMIN_API_TOKEN` into GitHub Actions secrets and giving a workflow the
ability to push to operators' phones — a reasonable future change, but it is not
what ships today.

## Deep linking

The payload carries `screen: "analytics"`.

`MessageNotificationManager` handles it in
`userNotificationCenter(_:didReceive:)`. `phone` and `screen` are read
independently — a payload may carry either, both, or neither — and if neither is
present the handler returns without queueing anything. A non-empty `screen` is
stored in `@Published pendingScreen`.

`MainTabView` observes it and calls `applyPendingNotificationRoute()`, which maps
lowercased values onto tabs:

| `screen` | tab |
|---|---|
| `analytics` | Analytics, **only if** the actor holds `analytics.read` |
| `inbox`, `messages` | Inbox |
| `contacts` | Contacts |
| `automations`, `activity` | Automations |
| `calls` | Calls |
| anything else | ignored |

When the role cannot see Analytics the tap is silently ignored rather than
redirected: landing somewhere unrelated is more confusing than staying put. The
pending value is consumed either way, so a stale route cannot fire again on the
next launch.

## Three honest limitations

### 1. A push cannot install a build

It tells someone an update exists. That is all. The tester still has to open
TestFlight and tap Update, or have TestFlight's automatic-update setting on.
There is no API — Apple's or otherwise — by which a server can install a
TestFlight build on a device.

So the release notification is a **reminder**, and its value is entirely in
timing: it reaches a phone that is already in someone's hand, rather than sitting
in a TestFlight notification they may have muted. Copy accordingly. "Update in
TestFlight" is a useful body; "You now have X" is a false one, because they do
not have it yet.

### 2. App Store Connect can prove distribution, not installation

The API can confirm that a build finished processing and is assigned to a beta
group — `publish-testflight-build.py` verifies the second of those directly via
the `betaGroups` relationship, and prints `processingState` for the first.
(A dedicated `buildBetaDetail` resource exposes `internalBuildState` for a
sharper processing/ready signal; the script does not query it today, so what is
actually proven is "processed enough to appear in `/builds`, and assigned to the
group".)

What none of that establishes is that a **specific tester installed the build**.
App Store Connect exposes tester-level install and session metrics only as
aggregate TestFlight analytics, with lag, and there is no per-device "has
installed build N" fact the workflow could gate on.

The nearest available proxy is inside this system, not Apple's: once a device
updates, it re-registers and its build changes, so
`POST /admin/release-notify` with `dryRun: true` and the same `belowBuild`
returns a shrinking `targeted` count. Zero targets means every registered device
reports the new build — which is real evidence, but only for devices that have
registered, and only as good as the build string they report. Combined with the
missing `appBuild` field noted above, that string currently comes from the
User-Agent alone.

### 3. The `screen: "analytics"` deep link is inert for the release that announces it

This is the sharpest one and it is inherent, not a bug.

The device receiving the notification is running the **previous** build. If the
`screen` handler shipped in build N, then a notification sent to announce build N
lands on a device running build N−1, which has no handler for it. On a build
predating the handler, `userInfo["screen"]` is read by nothing, `phone` is absent,
and the tap simply opens the app on whatever tab it was last on.

The deep link becomes useful from the *next* release onward. There is no way
around it: a payload feature can only ever be exercised by a client that already
has it.

Two practical consequences:

- Do not write a release body that depends on the tap landing somewhere
  particular. "Open Analytics to see…" is a promise the receiving build cannot
  keep.
- The same reasoning applies to any future payload key. Adding one is always a
  two-release change — ship the handler, then start sending the key.

## Failure handling

`deliver()` **resolves, never rejects.** It runs inside Telnyx webhook processing
for message pushes, and a failed banner must not fail an inbound SMS. A
connection error marks the whole environment's rows failed and continues; the
connection is closed in a `finally`.

Per-device results:

| result | action |
|---|---|
| 200 | counted sent; `last_error` cleared (dedicated storage only) |
| 410, or reason `BadDeviceToken` / `DeviceTokenNotForTopic` / `Unregistered` | the row is **deleted**, from whichever table it came from |
| anything else — 429, 503, timeout | `last_error` recorded (dedicated only); the row is **kept** |

The split matters. A 429 or a 503 is the provider being busy, not the device
being gone; deleting on those would unregister a perfectly good iPhone. A
per-request timeout of 10 seconds cancels the stream and reports
`RequestTimeout`, which falls into the keep bucket.

Partial failure is genuinely partial — three devices with one failure sends two
and reports `{ sent: 2, failed: 1 }`, asserted by test.

## Environment and secrets

| variable | where | purpose |
|---|---|---|
| `APNS_KEY_ID` | Railway | APNs provider key id |
| `APNS_TEAM_ID` | Railway | Apple Developer Team ID |
| `APNS_KEY_P8_BASE64` | Railway | base64 of the APNs `.p8` |
| `APNS_BUNDLE_ID` | Railway, optional | defaults to `com.vicipeptides.inbox` |
| `ADMIN_API_TOKEN` | Railway | bearer token for `/admin/*`; falls back to `INBOX_PASSWORD` |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` | GitHub Actions secrets | App Store Connect Team API key, Admin role |

Per `AGENTS.md`: never commit, print, or paste any of the `.p8` values. Apple
Developer Team ID, App Store Connect issuer ID, API key ID, bundle ID and the
numeric App Store app ID are five distinct identifiers; never substitute one for
another. The App Store Connect key and the APNs key are different keys with
different purposes and are not interchangeable.

`ASC_APP_ID` (`6794893971`) and `ASC_BETA_GROUP_ID` sit in the workflow YAML in
plain text on purpose — they appear in every App Store Connect URL, and keeping
them visible makes the publish step readable rather than hiding two opaque ids in
a secret store.

## Files

| path | role |
|---|---|
| `lib/apns-notify.js` | provider token, device loading, delivery, both senders |
| `lib/release-targets.js` | pure targeting: `selectReleaseTargets`, `deviceBuild` |
| `routes/mobile-push.js` | register / unregister / status / test; dual-storage writes |
| `routes/admin.js` | `POST /admin/release-notify`, bearer auth, dry-run default |
| `scripts/ios-push-devices-migration.sql` | the dedicated table — **not applied in production**; transaction-wrapped, RLS enabled, re-runnable |
| `.github/workflows/ios-testflight.yml` | manual signed archive, export, upload |
| `ios/scripts/publish-testflight-build.py` | release notes and beta-group distribution via ASC API |
| `ios/ViciInbox/App/MessageNotificationManager.swift` | APNs registration, badge halves, tap routing |
| `ios/ViciInbox/UI/RootView.swift` | `applyPendingNotificationRoute()` — the `screen` → tab map |
| `test/apns-release-notify.test.js` | hosts, connection counts, storage fallback, payload shape, dry run, partial failure |
| `test/release-targets.test.js` | build parsing, filter intersection, fail-open on unknown build |

## Related

- `ios/MESSAGE-NOTIFICATIONS.md` — the message-push side of the same channel.
- `ios/CI-TESTFLIGHT.md` — distribution setup.
- `docs/team/RBAC.md` — `analytics.read`, which decides whether the
  `screen: "analytics"` tap has a tab to land on.
