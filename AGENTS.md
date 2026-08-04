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
- SIP credentials are native-only: `/api/voice/token` rejects browser user
  agents. Do not re-enable shared browser calling without designing explicit
  per-agent routing; otherwise web sessions compete with iPhones for calls.
- Keep Telnyx `pushWhenActive` disabled. Foreground calls already reach CallKit
  through the live SDK socket; SDK 4.1.2 replaces that socket while processing
  an active-state push, which can lose the INVITE during Answer.
- Native message alerts use standard UserNotifications/APNs from the Telnyx
  inbound-message webhook. This is separate from browser VAPID and VoIP PushKit.

## Important paths

- `server.js`, `routes/`, `lib/`, `db.js`: backend entry point and services.
- `public/`: browser UI. `public/app.jsx` is the source and `public/app.js` is
  its Babel build output.
- `scripts/`: migrations and integration/visual test harnesses. Read a script's
  safety header before running it against configured services.
- `ios/ViciInbox/`: Swift source, resources, plist, and entitlements.
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

`npm test` runs focused, offline Node unit tests under `test/`. Broader harnesses
are deliberately separate because some read live configured services:

- `node scripts/test-mms-flows.js`: uses the configured Supabase project and a
  reserved fake number; Telnyx/GHL/push are mocked and created rows are cleaned.
- `node scripts/test-flows.js`: read-only production connectivity and scenario
  audit, but its output may contain customer/order context; do not paste raw
  output into public logs.
- `node scripts/test-ui-visual.js <scratch-dir>`: fixture-only Playwright UI
  check when Playwright is installed.

Do not run migrations, backfills, or send scripts merely as validation.

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
swiftc -frontend -parse ios/ViciInbox/App/*.swift ios/ViciInbox/Core/*.swift ios/ViciInbox/Voice/*.swift ios/ViciInbox/UI/*.swift
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
- Do not push, merge, trigger a signed archive, upload to TestFlight, submit to
  App Review, alter signing ownership, rotate/revoke credentials, run database
  migrations, or modify GitHub/Apple/Railway secrets without explicit approval.
- Run the non-signing `iOS Build` workflow before the TestFlight workflow.
- Preserve unrelated local changes. Never use force push, destructive reset,
  clean, or rebase published work during routine maintenance.
