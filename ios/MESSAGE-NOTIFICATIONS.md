# Native iPhone message notifications

Vici Inbox has two independent Apple push paths:

- **Calls:** Telnyx sends PushKit VoIP pushes and the app reports them to
  CallKit. The existing Telnyx VoIP certificate remains unchanged.
- **Messages:** the Railway backend sends standard APNs alert pushes when the
  existing Telnyx `message.received` webhook runs. The same webhook continues
  to send browser VAPID notifications as well.

PushKit must not be used for SMS alerts. Apple reserves VoIP pushes for live
call invitations.

## Repository-side pieces

- `MessageNotificationManager.swift` requests notification permission on the
  first authenticated launch, registers with APNs every launch, and forwards
  the current device token to the authenticated backend.
- `routes/mobile-push.js` stores and removes iOS device tokens.
- `lib/apns-notify.js` signs an APNs provider JWT and sends alert pushes over
  HTTP/2. Each payload includes the current shared-inbox unread total so iOS
  can update the Home Screen badge while the app is suspended.
- `routes/webhook.js` invokes both browser push and native APNs after an inbound
  message or tapback.
- `scripts/ios-push-devices-migration.sql` creates the separate APNs device
  table.

## One-time Apple setup

The App Store Connect API key used by GitHub Actions signs/uploads builds. It
is **not** the provider credential used to send notifications.

An Account Holder or Admin must create an Apple Developer APNs key:

1. Open Apple Developer → Certificates, Identifiers & Profiles → Keys.
2. Add a key and enable **Apple Push Notifications service (APNs)**.
3. Download its `.p8` once and record that key's ID.
4. Keep the file outside this repository. Do not reuse the App Store Connect
   key merely because both files use the `.p8` extension.

The current App ID and signed TestFlight build already carry the
`aps-environment` entitlement. The TestFlight workflow verifies that both the
exported app and embedded provisioning profile say `production` before upload.

## One-time database and Railway setup

The backend can activate immediately using typed records in the existing
`push_subscriptions` table. Browser delivery filters those records by their
`apns://` namespace. `scripts/ios-push-devices-migration.sql` remains the
recommended long-term dedicated table; the API and sender switch to it
automatically after it is applied.

Configure these Railway service variables:

| Variable | Meaning |
|---|---|
| `APNS_KEY_ID` | Key ID of the Apple Developer APNs key |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_KEY_P8_BASE64` | Base64 encoding of the APNs `.p8` file |
| `APNS_BUNDLE_ID` | Optional; defaults to `com.vicipeptides.inbox` |

These are Railway runtime values, not GitHub Actions secrets. Never add their
values to source, Markdown, workflow YAML, build artifacts, or logs.

The APNs signing key works with both production and sandbox. Each device row
records its environment: TestFlight/App Store builds use production, while
locally installed Debug builds use sandbox.

## Verification order

1. Deploy the backend after the Railway variables exist. The dedicated database
   migration may be applied before or after deployment.
2. Distribute the updated iOS build through TestFlight.
3. Open the app, sign in, and allow notifications at the system prompt.
4. In Settings, confirm **Message notifications → Status: Enabled** and
   **APNs environment: Production**.
5. Call `POST /api/mobile-push/test` from an authenticated session or send a
   real inbound SMS. Confirm a banner and sound while the app is backgrounded.
6. Tap the banner and confirm it opens the matching conversation.
7. Confirm the Inbox tab and app icon show the same unread total, then open the
   unread thread and confirm both badges disappear when the total reaches zero.
8. Confirm the browser still receives its existing notification.

The backend removes tokens when APNs reports them as unregistered or invalid.
Signing out removes the current device's backend registration. APNs provider
configuration failures do not block webhook storage, automations, SSE, or the
existing web notification path. The app also reconciles its icon badge from the
server whenever the Inbox loads or returns to the foreground, so reading a
thread clears stale counts without waiting for another push.
