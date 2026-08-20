# Real-device test plan

CallKit does not work in the Simulator. Every test below needs a physical iPhone.

## Prerequisites

- App ID registered and VoIP Services Certificate created (Account Holder steps)
- Certificate PEMs uploaded to Telnyx and assigned to the SIP connection used by
  `TELNYX_SIP_USERNAME`
- App installed on a real iPhone from a build signed with that Bundle ID
- Native-message migration applied and Railway APNs provider variables set; see
  `MESSAGE-NOTIFICATIONS.md`

## Test 0 — First run (must pass before anything else)

The device token only registers with Telnyx during a successful login, so a
fresh install must be opened once in the foreground.

1. Launch the app, sign in with the inbox password
2. Allow notifications when iOS asks
3. Settings tab → **Status** should read **"Ready for calls"**
4. Settings → **Message notifications** should read **Enabled** and
   **Production** for a TestFlight build
5. In Console.app (Mac, device selected, filter subsystem `com.vicipeptides.inbox`)
   confirm: `received VoIP push token` then `client ready — registered with Telnyx`

If the status never reaches Ready, nothing downstream will work. Check the SIP
credentials returned by `GET /api/voice/token`.

## Test 1 — Incoming call, app normally backgrounded

**Do not swipe the app away from the app switcher for this test.** A user
force-quit sets an iOS flag that can prevent the app being relaunched for a
background push until it is opened manually again. That is an operating-system
constraint, not a supported terminated-state test.

The open question it answers: your backend does not receive calls directly — it
answers them and then *transfers* to `sip:USERNAME@sip.telnyx.com`. Telnyx's docs
say a push fires whenever an inbound INVITE reaches a credential with no live
socket, but no documentation explicitly covers the answer-then-transfer path.

1. Open Vici Inbox and confirm Settings shows **VoIP token: Received**,
   **Push login: Registered**, and **Status: Ready for calls**
2. Leave the app using the Home gesture, but do not swipe it away
3. Close browser inbox tabs for the first isolation test, then lock the phone
4. Call the business number from another phone
4. Expect: after the "please hold" greeting, the iPhone rings with the **native
   full-screen incoming call UI**, Answer/Decline, on the lock screen
5. Answer, confirm two-way audio
6. Hang up, confirm the call appears in the iPhone's own **Recents**

**If it rings:** the background push path is confirmed, proceed to Test 2.

**If it does not ring:** check in this order —
- Console.app for `incoming VoIP push`. If absent, Telnyx never sent the push:
  the certificate is not attached to the SIP connection, or the push
  environment does not match the build (debug build needs a sandbox token).
- If the push arrives but no ring: look for `reportNewIncomingCall FAILED`.
- If the push arrives and the call is reported but audio never connects: inspect
  the Telnyx invite/CallKit logs. Browser calling is now off by default, but an
  explicitly enabled browser session can also receive the fork.

## Test 1b — Caller name on the lock screen

Runs alongside Test 1; it is already deployed on the backend.

The server resolves the caller against `sms_contacts` and passes the name as
`from_display_name` on the SIP transfer. Telnyx documents the SIP side of this
but **not** whether it reaches the push payload's `metadata.caller_name`, so
this test is what settles it.

1. Call from a number that **is** saved in the inbox → expect that contact's
   name on the incoming call screen
2. Call from a number that is **not** saved → expect the formatted number
3. Either way the call should appear in the iPhone's Recents, and tapping it
   should dial the **customer** back, not the Vici number

If the name does not appear but the call rings correctly: the transfer worked
and only the display-name propagation failed. Check the Railway logs for
`Transfer initiated to ... as <name>` to confirm the server sent it. The
fallback is client-side enrichment — the app can look the contact up and call
`CallKitCoordinator.updateCall`, which is already wired.

## Test 2 — Incoming call, app foregrounded

Leave Vici Inbox visible and call. This should work over the live SIP socket even
without needing APNs. If this fails while Status says Ready, investigate the SIP
registration/transfer. If this passes but Test 1 fails, investigate APNs token,
certificate, and production-environment delivery.

## Test 3 — Web inbox open, iPhone owns calls

Browser SIP credentials and browser call alerts are disabled. Leave the web
inbox open and confirm the browser does not ring, show an incoming-call
notification, or present a call panel while the iPhone rings through CallKit.
Web messaging and browser message notifications remain usable. The Voice tab
should say **iPhone calling only** and must not offer a browser-calling control.

Test both native paths separately:

1. Leave Vici Inbox visible and call. The live SDK socket should receive the
   INVITE directly and report it through CallKit; no VoIP push is requested.
2. Lock the phone with Vici Inbox backgrounded and call again. PushKit should
   wake the app, the SDK should attach to the INVITE, and Answer should reach
   ACTIVE rather than remaining on Connecting.

## Test 4 — Decline and missed

1. Decline an incoming call → caller should be released promptly
2. Let a call ring out unanswered → CallKit UI dismisses, call is logged as
   missed in the backend

## Test 5 — Outbound

Dial from the keypad. Expect the native call UI, working audio, correct caller
ID at the far end, and a Recents entry.

## Test 6 — In-call controls

Mute, hold, speaker. Verify from the *system* call UI as well as the in-app one:
both route through CallKit, so they must stay in sync.

## Test 7 — Focus / Do Not Disturb

With Do Not Disturb on, the call should be silenced exactly like a normal
cellular call (and be visible in missed calls). This is correct behaviour, not a
bug — CallKit calls obey the same rules as the system dialler.

## Test 8 — System-terminated process (optional)

After the app has registered successfully, leave it normally and let iOS evict
it naturally under memory pressure. A later call should relaunch it from the
VoIP push. There is no deterministic manual gesture for this state. Do not use
swipe-away as a proxy.

## Test 9 — Incoming message notifications

1. Leave Vici Inbox normally using the Home gesture and lock the iPhone
2. Send an SMS to the business number from another phone
3. Expect a Vici Inbox banner with the contact name/message preview and sound
4. Tap it and confirm the app opens that conversation with the new message
5. Repeat while Vici Inbox is onscreen; expect the foreground banner and sound
6. Confirm the browser still receives its existing web notification

If the message appears after opening the app but no banner arrives, inspect the
Settings notification status first, then the authenticated
`GET /api/mobile-push/status` response and Railway `APNs:` logs. A TestFlight
device row must say `production`; `sandbox` is only for a locally installed
Debug build.

## Test 10 — MMS send, receive and Photos saving

Use disposable non-customer images and a test handset. A successful upload is
not enough: the receiving carrier must actually deliver the attachment.

1. In a Vici Inbox thread, tap the photo button and send one large HEIC camera
   photo without a caption. Expect an outbound picture bubble, then a real image
   on the test handset and a final Sent/Delivered state in Vici Inbox.
2. Send four photos with a caption. Expect all four thumbnails before sending,
   all four images on the test handset, and no `Media file too large` failure.
3. From the test handset, send a picture-only MMS to the Vici number. Expect a
   `Photo` notification/preview and the picture in the exact app thread.
4. Repeat with a caption and confirm the image and text stay together.
5. Tap a received image, tap Save, allow add-only Photos permission, and confirm
   `Saved to Photos.` appears and the image is present in the iPhone library.
6. Deny Photos permission once and confirm the app reports how to enable it in
   Settings instead of claiming success. Re-enable access and repeat the save.
7. Background and relaunch the app, reopen the same thread, and confirm the
   received images still load. This verifies the backend re-hosted the expiring
   Telnyx media URL rather than retaining only a temporary provider URL.
8. Press and hold a message image. Confirm the menu contains **Reply**, **Copy**,
   **React**, and **Save**. Copy should copy the caption when present, or the
   image for an image-only message. Tap **Save** and confirm the image appears
   in Photos without first opening the full-screen viewer. For a message
   containing multiple images, Save should add every attachment.

If send fails, inspect the user-visible error and Railway log without printing
message contents. If receive or later reload fails, check the `mms-media`
Supabase bucket and `[MMS] Re-hosted inbound media` log entry. Do not use the
live integration script unless its cleanup and fake-number safeguards have been
reviewed for the configured environment.

## Reading logs from a terminated app

The cold-launch path cannot be debugged with the Xcode console, because the app
is not attached to the debugger when the push arrives.

Use **Console.app** on the Mac: select the iPhone in the sidebar, filter on
subsystem `com.vicipeptides.inbox`. Categories are `push`, `voice`, and `app`.

## Test 11 — Analytics (after the additive analytics migration)

Analytics is read-only from the iPhone. Do not create fake orders or payments
in production to exercise it. Validate historical numbers against the approved
backfill report and use an isolated fixture database for destructive or
high-volume scenarios.

Prerequisite: Railway must have the correct account `TELNYX_PUBLIC_KEY`. Send a
real test message and confirm no v2 signature warning appears before treating
new delivery, reply or sentiment evidence as live Analytics data.

1. Confirm the tab bar still contains exactly **Inbox**, **Contacts**,
   **Automations**, **Calls**, and **Analytics**. Open Settings from the gear in
   the Analytics navigation bar and confirm voice/push controls remain usable.
2. Exercise Today, Week, Month, Year, All Time, and a Custom start/end range.
   Confirm every visible card changes to the same server-reported range and the
   account timezone is shown. Include a range crossing midnight and a daylight
   saving boundary.
3. Compare Direct, Strong, Influenced, and Unattributed counts/totals with the
   API response. Influenced must remain separate from Attributed Revenue;
   Unattributed must never increase a revenue headline. Confirm refunded value
   is deducted and duplicate order/webhook records appear only once.
4. Tap Attributed Revenue and inspect multiple orders. Verify order ID, amount,
   confidence, timestamps, rule explanation, and non-sensitive evidence codes.
   Confirm invalidated/refunded attribution is labelled and excluded from the
   headline total.
   Tap Influenced and Unattributed independently and confirm each opens its own
   filtered audit list. Tap Payment Recovery and confirm only that workflow is
   shown. Change filters rapidly on a slow connection and verify an older
   response never appears under the newly selected label.
5. Verify payment recovery, message/reply/delivery, first-response, sentiment,
   and call totals against a small known sample. Missing data must show an
   honest empty/unavailable treatment rather than a fabricated zero or sample.
6. Leave Analytics visible, then send and receive a test message and complete a
   test call. Confirm the relevant card refreshes after the authenticated live
   event without full-dashboard polling. Background/foreground the app and pull
   to refresh to verify both fallback refresh paths and the freshness version.
7. Test no-data, malformed-data, unauthenticated, offline, HTTP 500, and
   `ANALYTICS_NOT_READY` responses. Existing data may stay visible with a stale
   warning; first load must show a retryable error and messaging/calling must
   remain unaffected.
8. Test attribution pagination with more than 25 and more than 100 records;
   verify there are no duplicates when the next page loads.
9. On the smallest supported iPhone and a current large-screen iPhone, verify
   scrolling, chart labels, long currency values, custom calendars, light/dark
   mode, largest accessibility text sizes, VoiceOver labels, loading states,
   and pull-to-refresh.
10. Before TestFlight, reconcile the complete historical totals against the
    reviewed report, run the server regression suite and simulator build, then
    repeat Tests 0, 1, 3, 9, and 10 to ensure Analytics did not regress login,
    native calls, message notifications, or MMS.
