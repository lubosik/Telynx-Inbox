# Vici Inbox — iOS app

Native iPhone app for the Vici SMS/voice inbox. Its job in phase 1 is one thing:
**incoming calls to the business number ring the iPhone like a normal phone call**
— full-screen call UI, lock screen, ringtone, Recents entry — even when the app
is closed or the phone is locked.

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
    │   ├── AppDelegate.swift       PushKit registration + VoIP push handling
    │   └── SessionModel.swift      Observable state for the UI
    ├── Core/
    │   ├── AppConfig.swift         Server URL, push environment
    │   ├── APIClient.swift         Login + GET /api/voice/token (existing endpoints)
    │   ├── CredentialStore.swift   Keychain (survives cold launch from push)
    │   └── Log.swift               OSLog — how you debug the terminated-app path
    ├── Voice/
    │   ├── TelnyxVoiceManager.swift  TxClient + TxClientDelegate + CallKit bridge
    │   ├── CallKitCoordinator.swift  CXProvider / CXCallController
    │   └── CallModels.swift          UI-facing call state, phone formatting
    ├── UI/                          LoginView, DialerView, InCallView, RootView
    └── Resources/                   Info.plist, entitlements, asset catalog
```

## Backend: no changes required for the first test

The app reuses endpoints that already exist:

- `POST /auth/login` — the same shared inbox password as the web app
- `GET /api/voice/token` — returns the SIP credentials
- `POST /api/voice/logs` — best-effort call logging

The SIP credentials are cached in the Keychain (`kSecAttrAccessibleAfterFirstUnlock`)
so a push-woken cold launch can connect without waiting on the network.

## Build

No Mac here can compile this — see `BUILD-ENVIRONMENT.md`. Builds run on a
GitHub Actions macOS runner and go straight to TestFlight: **`CI-TESTFLIGHT.md`**.

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
4. ⬜ **Get a machine that can build** — see `BUILD-ENVIRONMENT.md` and `CI-TESTFLIGHT.md`; this Mac
   cannot (macOS 13 vs the Xcode 26 requirement)
5. ⬜ Build to a physical iPhone, sign in once in the foreground
   (the push token only registers with Telnyx during a successful login)
6. ⬜ **The spike:** force-quit the app, call `+1 305 404 3184`, confirm the
   phone rings natively — see `TESTING.md` Test 1
7. ⬜ TestFlight for the wider team

Everything that can be done without a compiler is done. Step 4 is the only
thing standing between here and a ringing phone.

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
- **`pushWhenActive: true`** is set so the phone still rings natively when the
  app happens to be open.

## Open item: the browser and the iPhone share one SIP credential

`GET /api/voice/token` returns a single shared SIP login. If a browser tab and
the iPhone are both registered, Telnyx decides how the transferred call forks
between them, and the backend has no device attribution — `call_logs` records a
generic "answered" with no record of which device took it.

For the spike this is fine. Before rolling out to more than one person it needs
either separate SIP credentials per device, or explicit answered-elsewhere
handling. The SDK's `pushWhenActive` / `answered_device_token` primitives exist
for exactly this.
