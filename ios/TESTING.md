# Real-device test plan

CallKit does not work in the Simulator. Every test below needs a physical iPhone.

## Prerequisites

- App ID registered and VoIP Services Certificate created (Account Holder steps)
- Certificate PEMs uploaded to Telnyx and assigned to the SIP connection used by
  `TELNYX_SIP_USERNAME`
- App installed on a real iPhone from a build signed with that Bundle ID

## Test 0 — First run (must pass before anything else)

The device token only registers with Telnyx during a successful login, so a
fresh install must be opened once in the foreground.

1. Launch the app, sign in with the inbox password
2. Settings tab → **Status** should read **"Ready for calls"**
3. In Console.app (Mac, device selected, filter subsystem `com.vicipeptides.inbox`)
   confirm: `received VoIP push token` then `client ready — registered with Telnyx`

If the status never reaches Ready, nothing downstream will work. Check the SIP
credentials returned by `GET /api/voice/token`.

## Test 1 — The spike: incoming call, app force-quit

**This is the one test that decides whether the whole approach works.**

The open question it answers: your backend does not receive calls directly — it
answers them and then *transfers* to `sip:USERNAME@sip.telnyx.com`. Telnyx's docs
say a push fires whenever an inbound INVITE reaches a credential with no live
socket, but no documentation explicitly covers the answer-then-transfer path.

1. Force-quit the app (swipe up from the app switcher)
2. Lock the phone
3. Call the business number from another phone
4. Expect: after the "please hold" greeting, the iPhone rings with the **native
   full-screen incoming call UI**, Answer/Decline, on the lock screen
5. Answer, confirm two-way audio
6. Hang up, confirm the call appears in the iPhone's own **Recents**

**If it rings:** the architecture is confirmed, proceed to Test 2.

**If it does not ring:** check in this order —
- Console.app for `incoming VoIP push`. If absent, Telnyx never sent the push:
  the certificate is not attached to the SIP connection, or the push
  environment does not match the build (debug build needs a sandbox token).
- If the push arrives but no ring: look for `reportNewIncomingCall FAILED`.
- If the push arrives and the call is reported but audio never connects: the
  transfer is reaching a different registration (e.g. an open browser tab
  holding the same SIP credential). Close all browser tabs and retry.

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

## Test 2 — Incoming call, app backgrounded

Same as Test 1 but with the app backgrounded rather than killed. Should behave
identically.

## Test 3 — Incoming call, app open

With `pushWhenActive: true` both a push and a socket INVITE may arrive.
Expected: exactly **one** call reported, no duplicate ring. The duplicate guard
is the `activeCallUUIDs` check in `onIncomingCall`.

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

## Test 8 — Browser and iPhone together

Known weak spot. With the web inbox open in a browser *and* the iPhone
registered, both share one SIP credential.

1. Call in, answer on the iPhone
2. Check whether the browser stops ringing

Expect this to be imperfect. The backend has no device attribution, so
"answered elsewhere" is handled by Telnyx's SIP fork semantics alone. Record
what actually happens; it determines how much work the multi-device story needs
before more than one person uses this.

## Reading logs from a terminated app

The cold-launch path cannot be debugged with the Xcode console, because the app
is not attached to the debugger when the push arrives.

Use **Console.app** on the Mac: select the iPhone in the sidebar, filter on
subsystem `com.vicipeptides.inbox`. Categories are `push`, `voice`, and `app`.
