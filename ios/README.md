# Vici Inbox — iOS app

Native iPhone client for the complete Vici SMS/voice inbox. It provides the
conversation inbox, SMS/MMS composer, contacts and order detail, automation
queue/history, call history, and native calling. Incoming business calls use
PushKit and CallKit for the full-screen system call UI.

This is not a separate system. It talks to the same Railway backend and the same
Supabase database as the web inbox, reusing the existing endpoints.

---

## Confirmed project facts

All values below were verified against the live Apple certificate and the
Telnyx API on 2026-07-26 — none are guesses.

| Item | Value |
|---|---|
| Bundle ID | `com.vicipeptides.inbox` |
| Display name | Vici Inbox |
| Apple Team ID | `PQFYN2CD77` (read from the issued certificate's OU field) |
| Deployment target | iOS 16.0, iPhone only |
| Telnyx SDK | `TelnyxRTC` 4.1.2 (Swift Package Manager) |
| Backend URL | `https://web-production-2551e.up.railway.app` |
| Capabilities | Push Notifications, Background Modes → Voice over IP + Audio |

### Telnyx configuration (done)

| Item | Value |
|---|---|
| Phone number | `+13054043184` |
| Call Control app | `Vici Inbox` — id `2981716796505064762` |
| …its webhook | `https://web-production-2551e.up.railway.app/webhooks/voice` |
| Credential connection | `Vici` — id `2977904742740526399` |
| SIP username | `userdp33121` (this is `TELNYX_SIP_USERNAME`, set on Railway only) |
| iOS push credential | `313a9f6e-e5e0-4c48-a7c6-a953eeff6038` (alias `vici-inbox-voip-2026`) |
| VoIP cert validity | 26 Jul 2026 → **25 Aug 2027** |

The push credential is attached to the `Vici` connection, so an inbound INVITE
for `userdp33121` with no live socket should now produce a VoIP push.

**Rollback:** that connection previously pointed at push credential
`a8dbf407-028b-494d-860e-07ecd1e40a5f` (alias `ios-native-new-march-2025`), a
leftover from an earlier project with a different certificate. It was detached,
not deleted. To restore: `PATCH /v2/credential_connections/2977904742740526399`
with `{"ios_push_credential_id": "a8dbf407-028b-494d-860e-07ecd1e40a5f"}`.

## How the call path works

```
Customer dials the Telnyx number
        │
        ▼
Telnyx Call Control ──▶ POST /webhooks/voice  (existing backend, unchanged)
        │                    answer → greeting → transfer
        ▼
transfer to sip:<TELNYX_SIP_USERNAME>@sip.telnyx.com
        │
        ├─ iPhone on the socket?  → SIP INVITE straight to the app
        └─ iPhone asleep/killed?  → Telnyx sends a VoIP push via APNs
                                      │
                                      ▼
                        iOS relaunches the app in the background
                                      │
                        AppDelegate.pushRegistry(didReceiveIncomingPushWith:)
                                      │
                        TelnyxVoiceManager.handleVoIPPush
                          ├─ processVoIPNotification()  → socket reattaches
                          └─ CallKit reportNewIncomingCall() → PHONE RINGS
```

The critical rule: **every VoIP push must result in a reported call before the
PushKit handler returns.** If it doesn't, iOS kills the app, and repeated
offences make iOS stop delivering VoIP pushes entirely. `handleVoIPPush` is
written so that it always reports, even when credentials are missing or the
payload is malformed.

## Source layout

```
ios/
├── project.yml                  XcodeGen spec (for Macs that can run Xcode)
├── ViciInbox.xcodeproj/         committed — CI needs it; regenerate with scripts/
├── certs/
│   ├── ViciInbox_VoIP.certSigningRequest   ← send THIS to the account holder
│   └── voip_push_private_key.pem           ← NEVER leaves this machine (gitignored)
└── ViciInbox/
    ├── App/
    │   ├── ViciInboxApp.swift      SwiftUI entry point
    │   ├── AppDelegate.swift       PushKit + standard APNs callbacks
    │   ├── MessageNotificationManager.swift  message alerts + deep links
    │   ├── SessionModel.swift      Authentication + voice state
    │   └── FeatureModels.swift     Inbox/contact/activity/call feature state
    ├── Core/
    │   ├── AppConfig.swift         Server URL, push environment
    │   ├── APIClient.swift         Typed access to existing authenticated APIs
    │   ├── MobileModels.swift      Native API data-transfer models
    │   ├── CredentialStore.swift   Keychain (survives cold launch from push)
    │   └── Log.swift               OSLog — how you debug the terminated-app path
    ├── Voice/
    │   ├── TelnyxVoiceManager.swift  TxClient + TxClientDelegate + CallKit bridge
    │   ├── CallKitCoordinator.swift  CXProvider / CXCallController
    │   └── CallModels.swift          UI-facing call state, phone formatting
    ├── UI/                          Inbox, contacts, automations, calls, settings
    └── Resources/                   Info.plist, entitlements, asset catalog
```

## Backend relationship

The app reuses authenticated endpoints that already serve the browser:

- `POST /auth/login` — the same shared inbox password as the web app
- `/api/conversations` and `/api/send` — threads and SMS/MMS
- `/api/contacts` — contact and order data
- `/api/activity` — automation statistics, queue, history, cancellation
- `/api/voice/token` and `/api/voice/logs` — native calling and history
- `/api/mobile-push` — native APNs device registration and test delivery

Railway must stay running: it owns the database access, webhooks, integrations,
and scheduled automations. Provider credentials remain there and are never
embedded in iOS. The browser's SIP client is opt-in so the iPhone is the
default call endpoint.

The SIP credentials are cached in the Keychain (`kSecAttrAccessibleAfterFirstUnlock`)
so a push-woken cold launch can connect without waiting on the network.

## Message delivery status

Outbound SMS/MMS bubbles show the provider lifecycle, not a guessed receipt:

- **Queued** — accepted by Telnyx and waiting to be sent.
- **Sent** — handed to the carrier, with delivery not yet confirmed.
- **Delivered** — the carrier/device confirmed delivery.
- **Failed** — sending or delivery failed.
- **Status unavailable** — Telnyx's ten-day message lookup window has expired,
  so no final provider receipt can be recovered.

SMS and MMS do not expose when the recipient opens or reads the message, so
**Delivered does not mean Read**. Telnyx read receipts require a separately
approved RCS agent and are not part of the current SMS/MMS transport. Opening a
thread reconciles recent non-final rows against Telnyx, which repairs a status
when a delivery webhook arrived before its database row or was otherwise missed.

## Build

This local Mac cannot compile the app — see `BUILD-ENVIRONMENT.md`. Source-only
builds and signed TestFlight builds run through GitHub Actions. Both pipelines
have passed, and TestFlight build 1.0.0 (4) was installed successfully before
the full-inbox migration began.

`ViciInbox.xcodeproj` **is committed**, because CI needs a project and a shared
scheme to build. It is generated, not hand-maintained — after adding or removing
a Swift file:

```bash
python3 ios/scripts/generate-xcodeproj.py
```

IDs derive from file paths, so regenerating without changes produces no diff.
Forgetting fails the CI build with the exact command to run.

On a Mac that *can* run Xcode, `xcodegen generate` from `project.yml` produces
the equivalent project and is the nicer route; the Python generator exists
because XcodeGen cannot run on macOS 13.

**CallKit does not work in the Simulator.** All testing must be on a real device.

## Order of operations

1. ✅ Code written (this repo)
2. ✅ Account holder registered the App ID and created the VoIP certificate
3. ✅ Certificate uploaded to Telnyx and attached to the `Vici` SIP connection
4. ✅ Configure GitHub Actions as the Xcode 26 build machine
5. ✅ Non-signing build passed in GitHub Actions
6. ✅ Team/Admin App Store Connect key configured securely in GitHub Actions
7. ✅ TestFlight build 4 installed and signed in on a physical iPhone
8. ⬜ Build and distribute the full-inbox update
9. ⬜ Reopen that build, verify the three push diagnostics in Settings, then
   background normally (do not swipe away) and execute `TESTING.md`

The next proof point is the full-inbox `iOS Build` workflow run. It separates
Swift or package failures from distribution-signing and App Store authentication.

## Known gotchas baked into the code

- **Push environment must match the build.** Debug builds get a sandbox APNs
  token; TestFlight/App Store get production. `AppConfig.pushEnvironmentIsProduction`
  pins this off `#if DEBUG`. Mismatch here is the number-one cause of
  "the push never arrives".
- **CallKit UUID must equal `metadata.call_id`.** The SDK creates a placeholder
  call keyed on that UUID; report a different one and answering silently fails
  and the call UI gets stuck.
- **Answering before the socket reattaches is safe.** The SDK stashes the
  answer action and applies it when the INVITE lands. Don't poll for the call.
- **Login before push.** The device token only registers with Telnyx on a
  successful `connect()`. A fresh install must be opened once.
- **`pushWhenActive` stays false.** A foreground SDK socket receives the INVITE
  directly and `onIncomingCall` still reports it through CallKit. With SDK
  4.1.2, also processing a push while connected replaces that socket and can
  lose the INVITE during Answer. Locked/background calls still use PushKit.

## Browser and iPhone call ownership

The iPhone is the only supported SIP endpoint. `GET /api/voice/token` requires
the native app's `X-Vici-Client: ios` marker, rejects browser user agents, and
sends `Cache-Control: no-store`. The browser bundle contains no Telnyx SDK
loader, so opening the web inbox cannot compete with the native app for an
incoming call. Browser VAPID notifications continue for messages but are not
sent for calls. The native app refreshes the current credential when it returns
to the foreground and stores it in Keychain for a push-woken launch.

Production prefers the complete Railway override pair
`TELNYX_IOS_SIP_USERNAME` / `TELNYX_IOS_SIP_PASSWORD`. The original
`TELNYX_SIP_*` pair remains untouched as the rollback path; if either override
is absent, both the token response and inbound transfer fall back to the legacy
pair rather than mixing credentials.

An already-connected browser session from an older deployment may remain
registered until it disconnects or its SIP registration expires. Rotating the
backend to a dedicated iOS-only telephony credential immediately isolates those
legacy registrations. A future per-agent rollout should use separate telephony
credentials and explicit first-answer routing rather than re-enabling browser
calling.

## Missed-call and unread badges

iOS gives an app a single Home Screen badge, so it carries both halves of the
inbox: unread messages plus missed calls nobody has looked at. Five unread and
two missed shows **7** on the icon, **5** on Inbox and **2** on Calls.

The missed count clears by *seeing* call history, not by opening each call —
the same rule WhatsApp uses. Switching the Calls tab to **History** clears it.
Staying on **Keypad** does not.

"Seen" is tracked in two places, deliberately:

| Where | Purpose |
|---|---|
| `call_logs.seen_at` | Lets the server compute the badge it attaches to message pushes, and clears the count on a second signed-in device |
| `vici.calls.seen-missed-ids` in `UserDefaults` | Keeps the in-app badge correct offline, when the mark request fails, and before the migration below is applied |

**One-time migration:** run `scripts/missed-calls-seen-migration.sql` in the
Supabase SQL editor. Until it is applied, everything still works, with one
gap — an incoming SMS push resets the Home Screen badge to the unread count
alone, dropping the missed-call part until the app is next opened. The
migration also backfills existing missed calls as seen, so applying it does not
light up the badge with old history.

A call missed while the app is in the background moves the badge immediately:
the VoIP push keeps the process alive, so it does not wait for the next launch.
Call history replaces that estimate with the server's count when it loads.

## Native message notifications

The repository-side implementation is complete. The same inbound Telnyx
webhook now targets both the existing browser VAPID subscriptions and standard
iOS APNs device tokens. The iOS app registers its current token after login,
shows foreground banners/sounds, and deep-links notification taps into the
matching conversation.

Production activation still needs the one-time database migration, Railway
variables, and a distinct Apple Developer APNs signing key described in
`MESSAGE-NOTIFICATIONS.md`. The App Store Connect build/upload key is not an
APNs provider key, and VoIP PushKit credentials must remain call-only.
