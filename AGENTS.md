# Repository instructions

## Purpose and architecture

This repository contains the Vici Inbox web backend/UI and its native iPhone
client.

- The web application is a Node.js/Express service deployed on Railway. It uses
  Supabase for application data and integrates with Telnyx, WooCommerce, GHL,
  ShipStation, web push, and OpenRouter.
- The iOS application is native SwiftUI with UIKit bridges for PushKit and
  CallKit. It is not a WebView, Capacitor, React Native, Flutter, or another
  wrapper. It reuses the authenticated inbox, messaging, contacts, activity,
  voice-token, and call-log endpoints.
- The iOS objective is a complete native client for the shared inbox: messages,
  MMS, contacts, orders, automation visibility/control, call history, and native
  calling. Automations and provider integrations remain on the backend. Native
  incoming-call presentation uses Telnyx VoIP pushes and CallKit.
- SIP credentials are native-only: `/api/voice/token` requires the iOS app's
  explicit client marker and rejects browser user agents. The browser bundle
  contains no Telnyx SDK loader. Do not re-enable shared browser calling
  without designing explicit per-agent routing; otherwise web sessions compete
  with iPhones for calls.
- Incoming and missed call presentation is native-only through Telnyx VoIP
  push and CallKit. Browser VAPID notifications remain enabled for messages,
  but the voice webhook must not send browser call notifications.
- Live iOS SIP routing prefers the complete Railway pair
  `TELNYX_IOS_SIP_USERNAME` / `TELNYX_IOS_SIP_PASSWORD`. The legacy
  `TELNYX_SIP_*` pair is the rollback fallback; never overwrite or delete it
  during an iOS credential rotation.
- Keep Telnyx `pushWhenActive` disabled. Foreground calls already reach CallKit
  through the live SDK socket; SDK 4.1.2 replaces that socket while processing
  an active-state push, which can lose the INVITE during Answer.
- Native message alerts use standard UserNotifications/APNs from the Telnyx
  inbound-message webhook. This is separate from browser VAPID and VoIP PushKit.
- Call recording stays functional, but provider download URLs must never be
  returned to a client. `lib/private-recordings.js` archives audio into the
  private `call-recordings` bucket and `/api/voice/recordings/:id` creates an
  authenticated, short-lived playback redirect. Apply
  `scripts/private-recordings-migration.sql` before deploying related code.
  Retention deletion is destructive and must remain disabled until its dry run
  and target rows are approved.
- Every OpenRouter call must go through `lib/openrouter-private.js`. Direct
  provider calls are forbidden because the shared boundary enforces PII
  tokenisation, approved models/providers, ZDR, and data-collection denial.

## Important paths

- `server.js`, `routes/`, `lib/`, `db.js`: backend entry point and services.
- `public/`: browser UI. `public/app.jsx` is the source and `public/app.js` is
  its committed Babel build output. Railway's `buildCommand` does run
  `npm run build`, so the deployed bundle is never stale — but the committed
  artifact is what a reviewer reads and what a local run serves, so run
  `npm run build` after editing the source; the bundle-sync step in
  `.github/workflows/server-tests.yml` fails the build otherwise. `LoginScreen`
  has an optional email field — filled in, it signs in as a named account;
  blank, it keeps the shared-access-code path. Team management and the Activity
  Center remain iOS-only; the browser calls neither `/api/users` nor
  `/api/audit`.
- `scripts/`: migrations and integration/visual test harnesses. Read a script's
  safety header before running it against configured services.
- `docs/analytics/`: revenue-claim methodology, implementation architecture,
  and the provisional historical audit. Read the methodology before changing
  attribution rules or displaying revenue.
- `lib/campaigns/segment-rule-schema.js` is the CLOSED grammar a described
  segment may be expressed in, and `segment-rule-validator.js` is the gate
  every rule set passes through, whether it came from a model or from a client.
  Nothing downstream builds a query: `segment-rule-evaluator.js` switches over
  the same closed dimension list and reads properties of records
  `segment-facts.js` built in memory, which is why an invented field has
  nothing to reach. A dimension added to the schema needs a rendering, an
  evaluation branch and a sample in `test/campaign-segment-rule-validator.test.js`,
  and two of those three fail the suite if you forget them. `.env.example`
  carries `SEGMENT_AI_BUILDER_ENABLED`, off unless it is exactly `true`.
- `docs/campaigns/`, `lib/campaigns/`, `routes/campaigns.js`: campaign research,
  deterministic opportunity and attribution policies, draft/review APIs, and
  the fail-closed delivery foundation. `scripts/campaigns-migration.sql` must
  be applied before the backend routes. Drafting and dry runs are safe while
  live delivery is disabled; they are not permission to send.
- `scripts/dry-run-campaign-cadence.js`: read-only, aggregate-only historical
  cadence analysis. It prints no customer or product identity and never writes.
  `scripts/dry-run-campaign-opportunities.js` accepts only a local fixture and
  prepares draft outputs without importing a database or provider client.
  `scripts/dry-run-campaign-proposals.js` is the same idea for campaign
  proposals: two local fixtures, one of them standing in for the model reply,
  no database and no OpenRouter client.
- `docs/campaigns/OPPORTUNITY-PROPOSALS.md`, `lib/campaigns/proposal-*.js`,
  `routes/campaign-proposals.js`: turning a detected cohort opportunity into
  several reviewable campaign proposals. Apply
  `scripts/campaign-proposals-migration.sql` before deploying the route. The
  brake is `CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED`, off unless it is exactly
  `true`. **A proposal is not a campaign.** The model writes only the wording;
  the mechanism, the audience, the offer structure and every number are
  deterministic. Read the doc before changing what a proposal may show: the
  opportunity shape in it is an ASSUMED contract with the cohort detector, and
  `lib/campaigns/opportunity-contract.js` is the single adapter to change if
  the detector lands with different field names. Two guards in
  `lib/campaigns/proposal-guards.js` are load-bearing and each is applied at
  three call sites on purpose: copy that failed the validator is never
  surfaced, and nothing becomes a campaign without a named human accepting it.
  Accepting produces an ordinary campaign `draft` and nothing more.
- `lib/campaigns/product-identity.js`, `lib/campaigns/product-catalogue.js`:
  which catalogue product a historical order line item is. Legacy
  `sms_orders.items` rows carry `{sku, name}` and no Woo identifiers, so the
  detectors used to discard 2,334 of 2,343 paid line items and every automatic
  segment was empty; that was misread as a consent problem, and consent gates
  sending rather than segmenting. Resolution is EQUALITY ONLY — Woo IDs, SKU,
  catalogue name, a curated reviewed alias table, then canonical component-set
  equality — with no prefix, substring, edit distance or model, and ambiguity
  resolves to nothing. Dose variants share a parent for CADENCE and stay
  separate for STOCK; combination products are one identity and are never
  decomposed into their components. Unresolved items are counted in
  `sourceCoverage.productIdentity`, never absorbed. The catalogue cache is
  invalidated by the product webhook first and `CAMPAIGN_CATALOGUE_TTL_MS`
  second, and a provider failure keeps the last snapshot marked `stale` rather
  than throwing. It produces stock ROWS and never product EVENTS: a first
  sighting of "in stock" is not a restock. Read
  `docs/campaigns/SEGMENTATION-METHODOLOGY.md` before changing a matching rule.
- `scripts/dry-run-campaign-identity.js`: read-only, aggregate-only. Reads the
  live database and the Woo catalogue, prints resolution counts and detector
  populations, and writes nothing. It prints catalogue product names and SKUs,
  which are public shop content, and no customer identity. Its
  support-clearance pass is an explicitly labelled counterfactual measuring
  reach, not permission.
- `lib/campaigns/segment-contactability.js` and the `clearance` option on
  `buildGenerationInput()`: the split between WHO MATCHES THIS PATTERN and MAY
  WE CONTACT THIS PERSON. Segment membership is behaviour only. It must never
  read consent, STOP, DND, quiet hours or support clearance, because gating it
  on the empty `sms_customer_commercial_eligibility` table made all four
  automatic segments read zero and look like a broken engine. Sending is
  unchanged: `clearance: 'gate'` is the default and is the historical
  behaviour, and only the named wrapper `buildSegmentationInput()` reaches
  observe mode. Its output is stamped `segmentationOnly` and
  `prepareOpportunityDraftRun()` THROWS on that stamp, so a widened view can
  never become a widened send. Contactability is reused from
  `lib/campaigns/eligibility.js`, computed at READ time, put ON the member row
  and never used to filter it, and never stored or hashed into
  `computedSetDigest()`. Do not add a `contactable` column; a stale one is what
  somebody later mistakes for permission.
- `scripts/dry-run-segment-membership.js`: read-only, aggregate-only, and with
  NO counterfactual. Live per-segment counts, the contactability breakdown, and
  the funnel from paid order to segment member. Use it, not the identity dry
  run, when the question is how many people are in a segment.
- `scripts/seed-product-inventory-baseline.js`: writes one current-stock row per
  purchasable catalogue unit into `sms_product_inventory`, so a later webhook
  has a `previous` to compare against. Read-only unless given BOTH `--persist`
  and `PRODUCT_INVENTORY_SEED_APPROVED=YES`. It never overwrites an existing
  row and never writes a product event.
- `scripts/onboarding-migration.sql` and `docs/onboarding/`: server-owned,
  role-aware first-time tour state. Existing accounts are deliberately
  ineligible; future named accounts start at `not_started`.
- `scripts/analytics-migration.sql`: additive analytics schema. Apply once
  before deploying Analytics code; it does not mutate existing source rows.
- `scripts/backfill-analytics.js`, `scripts/backfill-sentiment.js`: read-only by
  default. Historical persistence requires explicit owner review plus both
  `--persist` and `ANALYTICS_BACKFILL_APPROVED=YES`. Never run persist as a test.
- `scripts/private-recordings-migration.sql`: creates lifecycle columns and the
  private call-recording bucket; apply before the matching backend deploy.
- `docs/team/RBAC.md`: roles, the permission catalogue, server-side enforcement,
  session epochs and the shared-password retirement path. Read it before
  changing an authorisation rule or the route policy.
- `lib/route-policy.js`: the single declarative source of truth for which
  permission each `/api` endpoint requires. `lib/enforce-policy.js` compiles it
  at boot and default-denies anything unlisted. Adding an endpoint without a
  policy entry fails `test/route-policy.test.js`, not production.
  **The enforcer never passes a request through.** It lower-cases before
  matching (Express routing is case-insensitive by default, and a case-sensitive
  prefix test that called `next()` on its own failure was a live bypass:
  `GET /API/users` returned 200 with the full team list). A path that does not
  classify is denied, not forwarded. Webhooks stay unauthenticated because of
  the `/api` MOUNT, never because of a branch inside the enforcer — do not add
  one back. `server.js` also sets `case sensitive routing` and collapses
  repeated slashes, because `//api/x` previously missed both the gate and the
  handler and returned `index.html` with HTTP 200.
- `scripts/rbac-migration.sql`: additive accounts/roles/permissions schema. Every
  seeded human has `password_hash NULL`, so applying it alone changes nobody's
  access. Apply before deploying the matching code.
- `scripts/user-timezone-migration.sql` and `lib/timezones.js`: per-account
  DISPLAY time zone, `sms_users.timezone`, an IANA identifier and never an
  offset. Additive, nullable, backfills nothing: NULL means "never chosen" and
  the application falls back to `DEFAULT_TIME_ZONE` (Europe/London), reporting
  `isDefault: true` so a client can prompt. Validation is against
  `Intl.supportedValuesOf('timeZone')`, never a list in this repository.
  **This is not the business time zone.** Campaign quiet hours are enforced in
  SQL against `sms_campaign_settings.business_timezone`, and nothing that
  decides when a customer is contacted may read `sms_users.timezone`. Crossing
  the two would let one person shift the hours in which customers are textable
  by editing their own profile; `test/user-timezone.test.js` guards both
  directions against the source.
- `scripts/email-change-migration.sql`: confirmed self-service email changes.
  The confirmation link is `${APP_URL}/confirm-email-change?token=...`, served
  by `public/confirm-email-change.html` for anyone without the app. Its
  universal-link claim is STAGED in `lib/apple-site-association.js` behind
  `APPLE_CLAIM_EMAIL_CHANGE`, off by default: iOS caches the association
  document, so publishing a claim before a build that routes the path is in the
  field produces a link that opens the app to nothing. Flip the variable after
  that build ships, never before.
- `docs/team/ACTIVITY-CENTER.md` and `lib/audit/`: the append-only audit trail
  (`sms_audit_log`, `/api/audit`). Campaign draft, review, approval, scheduling,
  rejection, and cancellation types are active; `campaign.launched` remains
  reserved until a separately reviewed delivery worker exists. The `team.*`
  types are live and instrumented in `routes/users.js` and
  `routes/invitations.js`. Note the name
  collision: `routes/activity.js` and `/api/activity/*` are the scheduled-SMS
  queue behind the iOS tab labelled "Automations", not the audit trail. Do not
  rename the live route.
- `scripts/audit-migration.sql`: additive append-only audit table. Apply before
  the matching deploy; the writer fails open, so out-of-order degrades to "no
  audit rows" rather than a broken send. In `lib/audit/log.js` the
  missing-schema check runs **before** the consent-bearing throw, deliberately:
  an unapplied migration must not break the inbound STOP path. An unrecorded
  suppression is a bookkeeping problem; an unhonoured STOP is a regulatory one.
  The hard failure still applies when the table exists and refuses the write.
  Use `logAuditSafely()` at any call site where the audit follows the effect.
- `docs/notifications/RELEASE-NOTIFICATIONS.md`, `lib/apns-notify.js`,
  `lib/release-targets.js`: APNs release announcements and their targeting.
- `scripts/ios-push-devices-migration.sql`: NOT applied in production. Device
  registration and delivery run through the `push_subscriptions` compatibility
  path; keep both storages in step or a change only works on the half that is
  live. The file is transaction-wrapped, re-runnable, and enables RLS with no
  policies. **Known gap:** `push_subscriptions` — the storage actually holding
  the live APNs device tokens, and now a `userId` inside its jsonb column — has
  no RLS. Fixing that needs its own deliberate migration reviewing every reader
  of that table; do not fold it into this file.
- `ios/ViciInbox/`: Swift source, resources, plist, and entitlements.
- `scripts/segment-lifecycle-migration.sql`: NOT applied yet. Adds
  `sms_campaign_segments.purpose`, backfills it, and creates
  `delete_sms_campaign_segment` / `restore_sms_campaign_segment`. It DROPs the
  nine-argument `create_sms_campaign_segment` and replaces it with a
  ten-argument version, deliberately rather than adding an overload, so apply
  it in the SAME window as the matching deploy: in the gap the running backend
  gets PGRST202 on segment CREATION only, which `databaseError()` already turns
  into the friendly not-ready message. Reads, member edits, overrides and
  recomputes are untouched by the gap. It adds no permission key, so it cannot
  cause a startup crash loop.
- A SEGMENT is removed the same way a campaign is: `delete_sms_campaign_segment`
  decides, the caller cannot ask for the destructive path, and the audit row is
  written before the effect with the hard-failing `logAudit`. Destruction is
  reachable only for a segment that no campaign was built against, that the
  engine never ran on, that carries no override row (revoked ones count), and
  where no member row carries a written reason. Bare membership is deliberately
  not a blocker: a hand-picked list of phone numbers records no decision about
  anybody. Everything else archives, and the archive is reversible.
- TWO KINDS OF REASON, AND THEY MUST NOT BE MERGED. A manual segment carries one
  required `purpose`, captured at creation, that explains everybody in it. A
  per-person reason lives on the member row's `inclusion_evidence` and on
  `sms_campaign_segment_overrides.reason`, and answers a different question
  about one named human. The second is the whole record on an AUTOMATIC segment,
  where somebody is overruling the engine, and automatic segments have no
  purpose at all because their detector definition is it. A database CHECK
  enforces that split.
- `GET /api/segments/:id/candidates` is the add-someone picker and the only
  segment GET that is not `campaigns.read`. It subtracts current members BEFORE
  paging; do not filter membership in the client, because the picker is paged
  and the client holds one page of a set that runs to thousands of rows. People
  with an active exclude override come back separately in `held`, never hidden:
  a database trigger refuses to add them, so hiding them would leave a missing
  name with no explanation.
- `ios/ViciInbox/UI/SegmentsView.swift`, `SegmentDetailView.swift`: the client
  for `routes/segments.js`, reached from the Growth tab's third control,
  "Audiences". All evidence interpretation lives in
  `ios/ViciInbox/Core/SegmentModels.swift` rather than in a view, precisely so
  it lands in the Foundation layer that can be type-checked locally. The copy
  rule is the same as the notification module's: no em dashes, and an override
  is never described as a membership edit. A removal confirmation must not
  promise an outcome: the server chooses delete or archive and the sentence
  shown afterwards is built from the response.
  is never described as a membership edit.
- `ios/ViciInbox/UI/SegmentRuleBuilderView.swift` and
  `ios/ViciInbox/Core/SegmentRuleModels.swift`: describing a segment in plain
  words. The model DRAFTS RULES; it never creates a segment and never returns
  people. The order is enforced in `SegmentRuleBuilderModel.canSave`, not in a
  view: no preview of the current rules, no Save, and editing a rule takes the
  preview away again. `SegmentRuleModels.swift` is the only segment file with a
  `CodingKeys` map, because the wire key for a comparison is literally
  `operator`.
- `ios/project.yml`: human-readable XcodeGen source of truth.
- `ios/ViciInbox.xcodeproj`: generated project committed for cloud CI.
- `ios/scripts/generate-xcodeproj.py`: deterministic generator used on this
  Ventura machine and in CI.
- `.github/workflows/ios-build.yml`: non-signing simulator compile check.
- `.github/workflows/ios-testflight.yml`: manual signed archive and TestFlight
  upload.
- `ios/CI-TESTFLIGHT.md`, `ios/TESTING.md`: distribution and device test plans.
- `ios/MESSAGE-NOTIFICATIONS.md`: native APNs architecture and activation steps.

## Web setup and checks

Use npm because `package-lock.json` is authoritative.

```bash
npm ci
npm test
npm run build
find . -path './node_modules' -prune -o -path './.git' -prune -o -type f -name '*.js' -exec node --check {} \;
```

`npm test` runs the offline Node unit and integration-shape tests under `test/`.
Two of them are shape guards rather than behaviour tests, and both exist because
the shape they ban already caused an outage:

- `test/no-unbounded-in.test.js` — no unbounded `.in()` filter.
- `test/no-builder-catch.test.js` — no `.catch()`/`.finally()` on a Supabase
  query builder. A builder is a thenable with `then` only, so `.catch()` throws
  a `TypeError` **before the query is sent** and skips every statement after it.
  That silently killed the inbound STOP path here and in the Shore fork. Use
  try/catch around the `await` and check `error`.

`.github/workflows/server-tests.yml` runs `npm test` and then verifies that
`public/app.js` matches a fresh build of `public/app.jsx`.

Broader harnesses are deliberately separate because some read live configured
services:

- `node scripts/test-mms-flows.js`: uses the configured Supabase project and a
  reserved fake number; Telnyx/GHL/push are mocked and created rows are cleaned.
- `node scripts/test-flows.js`: read-only production connectivity and scenario
  audit, but its output may contain customer/order context; do not paste raw
  output into public logs.
- `node scripts/test-ui-visual.js <scratch-dir>`: fixture-only Playwright UI
  check when Playwright is installed.

Do not run migrations, backfills, or send scripts merely as validation.

Analytics dry runs may read configured production sources only when the task
explicitly authorizes a historical audit. Their output must remain aggregate or
go to a private, untracked review location; never log raw message bodies, names,
emails, addresses, or phone numbers. Configure all staff/test exclusions with
`ANALYTICS_EXCLUDED_PHONES` / `ANALYTICS_EXCLUDED_ORDER_IDS` before approving a
historical write. Historical Influenced revenue is disabled in methodology v1.

## iOS project and checks

Project: `ios/ViciInbox.xcodeproj`

Scheme/target: `ViciInbox` (shared scheme)

Bundle ID: `com.vicipeptides.inbox`

Deployment: iOS 16+, iPhone only

Dependency: `TelnyxRTC` pinned exactly to 4.1.2 through Swift Package Manager

After adding/removing Swift files or changing generated project settings:

```bash
python3 ios/scripts/generate-xcodeproj.py
git diff --exit-code -- ios/ViciInbox.xcodeproj
```

Portable checks available without Xcode:

```bash
# Syntax only. This does NOT type-check, so it cannot catch a wrong Codable
# conformance, a bad conditional binding, or a missing protocol requirement.
# Two such errors reached CI before this note was written.
swiftc -frontend -parse ios/ViciInbox/App/*.swift ios/ViciInbox/Core/*.swift ios/ViciInbox/Voice/*.swift ios/ViciInbox/UI/*.swift

# SwiftUI view files get NO local type-check at all. `-parse` accepts them and
# the Foundation typecheck below cannot include them, so the `iOS Build`
# workflow is their only gate. Assume any new SwiftUI file is unverified until
# CI is green. One trap that has already cost a red build: `Section` has no
# `Section(_ title:) { } footer: { }` overload. A string title composes only
# with content; the moment you need a footer, write
# `Section { } header: { Text("Title") } footer: { }`. The compiler reports it
# as "cannot convert value of type 'String' to expected argument type
# '() -> Content'", which points at the title, not at the missing overload.

# A REAL type-check of the Foundation-only layer. Run this before pushing any
# change to the models or the API client — it is where most Swift edits land and
# where -parse is blindest. The UI and Voice layers cannot be checked this way
# (SwiftUI needs the iOS SDK, TelnyxRTC is a Swift Package that is not vendored),
# so a full compile still belongs to the `iOS Build` workflow.
#
# THIS LIST IS HAND-MAINTAINED AND GOES STALE SILENTLY. It listed neither
# CampaignArchiveModels.swift nor SegmentModels.swift at one point, so the
# command as written failed with "cannot find type 'CampaignListResult'" and
# looked like the caller's fault. Add every new Foundation-only file here.
# Anything a file in this list references must also be in it.
swiftc -typecheck \
  ios/ViciInbox/Core/AccountModels.swift ios/ViciInbox/Core/MobileModels.swift \
  ios/ViciInbox/Core/AnalyticsModels.swift ios/ViciInbox/Core/CampaignModels.swift \
  ios/ViciInbox/Core/CampaignArchiveModels.swift ios/ViciInbox/Core/SegmentModels.swift \
  ios/ViciInbox/Core/SegmentRuleModels.swift \
  ios/ViciInbox/Core/ExperienceModels.swift ios/ViciInbox/Core/AppConfig.swift \
  ios/ViciInbox/Core/APIClient.swift ios/ViciInbox/Core/CredentialStore.swift \
  ios/ViciInbox/Core/Log.swift ios/ViciInbox/Voice/CallModels.swift
plutil -lint ios/ExportOptions.plist ios/ViciInbox/Resources/Info.plist ios/ViciInbox/Resources/ViciInbox.entitlements
xmllint --noout ios/ViciInbox.xcodeproj/xcshareddata/xcschemes/ViciInbox.xcscheme
```

On a current Xcode machine, list configuration before assuming it:

```bash
xcodebuild -list -project ios/ViciInbox.xcodeproj
xcodebuild -showdestinations -project ios/ViciInbox.xcodeproj -scheme ViciInbox
xcodebuild build -project ios/ViciInbox.xcodeproj -scheme ViciInbox -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

CallKit behavior and VoIP push delivery require a physical iPhone. A simulator
build proves compilation only.

## Signing and secret handling

- Never commit, print, paste into chat, or add to build artifacts: `.p8`,
  `.p12`, `.pem` private keys, provisioning profiles, `.env`, session cookies,
  API tokens, signing certificates, or secret values.
- App Store Connect automation requires an Admin **Team** API key, its issuer
  UUID, key ID, and private `.p8`. Individual API keys cannot use Provisioning
  endpoints and are not compatible with the current signing workflow.
- Store distribution credentials only as GitHub Actions secrets named
  `ASC_ISSUER_ID`, `ASC_KEY_ID`, and `ASC_KEY_P8_BASE64`. Do not place their
  values in YAML, plist, xcconfig, Markdown, commits, or artifacts.
- APNs provider delivery requires a separate Apple Developer APNs key. Store
  its key ID, team ID, and base64 `.p8` only as Railway runtime variables
  `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_P8_BASE64`. The App Store Connect
  API key and the Telnyx VoIP credential are not substitutes.
- Apple Developer Team ID, App Store Connect issuer ID, API key ID, bundle ID,
  and App Store numeric app ID are distinct identifiers. Never substitute one
  for another.
- Local VoIP certificate material under `ios/certs/` is ignored. The tracked
  CSR is public material; matching private keys must remain local.

## Deployment safety

- The `main` branch auto-deploys the web service to Railway. Treat pushes to
  `main` as deployments even when a change appears documentation-only.
- Analytics must remain additive and fail-safe: an analytics write, migration
  ordering issue, or classifier failure may not interrupt a working SMS, call,
  commerce webhook, fulfilment, CRM sync, or automation. Do not present
  candidate historical revenue as final, and never force uncertain orders out
  of the Unattributed bucket. Verified staff/internal/test identities are a
  separate exclusion class and must be removed from all Analytics metrics rather
  than relabelled as Unattributed.
- Promotional campaign delivery has two independent brakes:
  `CAMPAIGNS_LIVE_SEND_ENABLED=true` in the backend environment and both
  `provider_approved=true` plus `live_send_enabled=true` in
  `sms_campaign_settings`. Keep every gate off until written provider approval
  covers the exact Vici products, registered use case, number/profile, and
  representative copy. Never infer promotional consent from an order, contact,
  phone number, or transactional message. A recipient also needs evidenced
  positive consent, known-current HighLevel SMS DND clearance, STOP clearance,
  quiet hours, cadence limits, and the frozen approved revision. There is no
  campaign delivery worker in the current release; do not describe a recorded
  schedule as a send.
- Authorisation is server-side only. Nothing authority-bearing goes in the
  session cookie: it carries `{ v, authenticated, uid, se }` and the role,
  active state and permissions are read from the database every request. Apply
  `scripts/rbac-migration.sql` before deploying code that expects it — startup
  validates every policy permission key and `LEGACY_SHARED_ROLE` against the
  database and exits 1 rather than serving a broken authorisation layer.
  `server.js` calls `process.exit(1)` for three causes: `SESSION_SECRET` unset,
  `assertPolicyPermissionsExist()` failing, and `syncLegacySharedRole()`
  failing. `main` auto-deploys, so the wrong order is a production crash loop,
  not a warning. `docs/team/RBAC.md` enumerates every cause and precondition.
- The `legacy` shared identity keeps Admin-equivalent grants on purpose while
  two people share `INBOX_PASSWORD` on an un-updatable iOS build. A pre-existing
  cookie carries no session epoch and cannot be epoch-revoked; ending those
  sessions requires `LEGACY_SHARED_LOGIN=disabled` plus a `SESSION_SECRET`
  rotation. Do not remove the no-`uid` branch in `lib/authz.js`.
- The audit trail is append-only and gives tamper-resistance, not
  tamper-evidence: a Supabase superuser can still disable the trigger. It has no
  retention job by design, and message bodies are never stored in it — only
  length, a sha256 digest, and a reference by id. Do not add a body column, a
  write API, or a purge job.
- `POST /admin/release-notify` defaults to `dryRun: true`; only an explicit
  `"dryRun": false` sends. A push cannot install a TestFlight build, and a new
  payload key is always a two-release change because the receiving device is
  running the previous build.
- Live SMS delivery/reply evidence requires a verified Telnyx v2 Ed25519 event
  recorded in `analytics_message_events`. `TELNYX_PUBLIC_KEY` is public
  configuration, but must be sourced from the correct Telnyx account; never
  fall back to an unsigned message status for revenue attribution.
- Do not push, merge, trigger a signed archive, upload to TestFlight, submit to
  App Review, alter signing ownership, rotate/revoke credentials, run database
  migrations, or modify GitHub/Apple/Railway secrets without explicit approval.
- Run the non-signing `iOS Build` workflow before the TestFlight workflow.
- Preserve unrelated local changes. Never use force push, destructive reset,
  clean, or rebase published work during routine maintenance.
