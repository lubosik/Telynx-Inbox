# Assistant navigation contract

## Status

Phase 8 is integrated locally and remains additive and fail-closed. Typed and
finalized push-to-talk input use the same coordinator as the three App Intents;
Offers & Proposals and the segment people/reasons destination are real typed
routes. Xcode 26 compilation and physical-device Siri/voice validation remain
release gates.

## What is deterministic

`AssistantNavigationParser` compares the complete, whitespace-normalised phrase
to a closed table. It does not use the on-device model, fuzzy matching,
substring matching, regular expressions, or entity extraction. One final
period, question mark or exclamation mark is accepted. Quotes and all other
words remain part of the phrase, so these do not route:

- `Don't go to the offers`
- `"Go to the offers"`
- `Customer said go to the offers`
- `Go to the offers and send to everyone`
- `Open segment seg-123`
- `Show segments`

The three demonstration contracts are:

1. `Take me to the segment you just created.` resolves only a segment created
   successfully during the current authenticated session. The exact ID must be
   re-read successfully before opening.
2. `Open the people and show me why they are in it.` resolves only when the
   exact underlying main route is a segment. It never chooses a segment from a
   list, and the exact current segment is checked again after record
   verification. It opens the dedicated typed people-and-reasons route only
   after the exact segment loads and the people section is visible. Repeating
   the command on that exact people route is idempotent.
3. `Go to the offers.` opens the read-only proposed Offers & Proposals queue
   only after `campaigns.manage`, fresh Assistant capability, and an
   authoritative proposed-page read succeed. It is never redirected to
   Campaigns or the opportunity portfolio.

Fixed aliases exist only for explicit movement to Inbox, Contacts, Automations,
Campaigns, Audiences, Calls, Analytics, Referrals and Settings. Ordinary
business questions continue through the grounded Assistant answer path.

## Created-segment context

`AssistantNavigationContextStore` is in-memory only. Root binds one authenticated
user to a fresh session. The store records an ID and optional display name only
after these create operations return successfully. Each operation captures an
opaque session token before its network request and must present the same token
when the response returns. A late response from a prior identity, foreground
epoch or permission state is rejected:

- a new automatic catalogue segment (`didCreate == true` only);
- a manual segment;
- a rule-built segment.

List loading and an already-tracked catalogue entry never record context. The
record expires after 30 minutes and is removed on background, incoming-call,
identity, permission, capability, and sign-out resets. The target is verified
again by exact ID before routing.

## Unsaved changes

`AssistantUnsavedDraftRegistry` stores only opaque tokens, a generic editor type
and dirty state. It never stores draft text, attachments, customer identity, or
closures. Programmatic navigation takes a snapshot. If any token is dirty,
navigation stops and returns a confirmation with an opaque ID. Only a visible
button can pass that ID to `confirmDiscardByVisualAction`. That call publishes
an opaque discard request and still does not navigate. Each affected draft
owner clears its own local state, dismisses any local sheet and acknowledges its
token. Only then may the visible flow call
`completeConfirmedDiscardByVisualAction`. Spoken or typed confirmation must not
call either method. Owners must compare the published request ID immediately
before clearing state; cancellation or a newer navigation removes the request,
and a stale request must be ignored.

Before owners clear anything, the exact target and fresh access are rechecked;
an offline, deleted, archived or denied target keeps every draft. The
confirmation is invalidated if dirty state, identity, permissions, app
lifecycle, call state, capability state or the 60-second expiry changes. The
route and permission are rechecked immediately before opening.

Each draft-owning view still needs to register and maintain its dirty flag. At
minimum cover message and attachment composition, campaign audience and copy,
both segment editors, referral/reassign/resolve forms, and contact/override/
rejection editors. Nested sheets register independently. The current owner
integration covers the message composer and asynchronous photo picker, campaign
wizard and reason/schedule sheets, manual and described segment editors,
segment reason and add-member sheets, referral composer and transition sheet,
contact editor, profile name/email, voluntary password change, team-member role
editing, team invitation, Assistant question and dialer digits. Successful
invitations and saved role changes update their clean baseline. The forced
password screen is rendered instead of
the signed-in app and cannot run Assistant or App Intent navigation; its fields
still use the same synchronous zeroing and focus-clear hook defensively.

## Integrated app hooks

The app target must make these connections:

1. Root/session state calls
   `AssistantNavigationCoordinator.shared.updateAuthenticatedSession(userID:identityFingerprint:access:)`
   after authentication and whenever effective permissions change. Pass the
   real `campaigns.manage` bit as `campaignsManage`, not `campaigns.read`.
2. Sign-out calls the same method with nil identity/access before another user
   can authenticate.
3. Scene background calls `reset(reason: .background)`.
4. Incoming or active calls call `reset(reason: .callStarted)` before Assistant
   speech/result completion can navigate.
5. Disabling Assistant calls `reset(reason: .capabilityDisabled)`.
6. `AssistantNavigationOperations` returns typed fresh authorization results,
   performs exact record/route preflight, and builds the two dedicated routes.
   Transient network failure denies movement without erasing valid context;
   proven capability or identity changes rotate it.
7. Assistant submission checks `AssistantNavigationParser` before the business
   answer path. If it returns a command, await the shared coordinator exactly
   once and render its typed outcome. Do not pass it through a model.
8. Main-screen content is prepared underneath the Assistant sheet. The sheet is
   dismissed only after the exact destination reports authoritative readiness.
   Timeout, call, background or supersession rolls the route back.
9. Register every draft owner with `AssistantUnsavedDraftRegistry`; unregister
   on teardown. Each owner observes the opaque discard request, clears its own
   state, dismisses and acknowledges. The visible flow completes navigation
   only after all owners acknowledge. Tokens remain registered after a discard,
   so an editor that remains alive can become dirty and guarded again.
10. Root pushes lifecycle and call state into a reference-owned monitor. Siri's
    transient inactive state preserves opaque context, real background purges
    it, and App Intents use a bounded cold-launch readiness wait without
    bypassing fresh server checks.

## Offers recommendation

The product phrase "offers" should map to a real read-only **Offers & Proposals**
screen backed by proposed campaign proposals, using the existing endpoint whose
contract is `GET /api/campaign-proposals?status=proposed`. The endpoint requires
`campaigns.manage`, so navigation access now carries a separate manage bit.
Do not use `GET /api/campaigns?status=review_required`, do not map Offers to the
Campaigns root, and do not use the opportunity portfolio. The initial screen
must be read-only; proposal acceptance or dismissal remains an explicit existing
workflow with its own confirmation and server authorisation.

## Xcode and App Intents

This foundation uses Foundation, Combine and the existing typed `AppRouter`, so
it is compatible with the current Xcode 26 lane and iOS 16 deployment floor.
`ViciNavigationIntents.swift` provides three harmless read-only adapters for the
three demonstration commands. Each intent requires local-device authentication,
opens the app using the Xcode 26-compatible `openAppWhenRun` contract and calls
the same deterministic coordinator phrase as the in-app Assistant. There are no
record parameters, direct route mutations, spoken discard confirmation or
dynamic result dialogs. Session, capability, permission, dirty-draft and exact
record checks remain coordinator-owned.

Every App Shortcut phrase includes `\(.applicationName)`. Siri can still use
semantic matching rather than byte-for-byte phrase equality when deciding that
an App Shortcut was requested. The intent itself has no free-form parameter and
maps only to its one reviewed command, which limits the result of such matching,
but does not prove that Siri will reject every negated utterance. Physical-device
red-team testing must include `do not`, `don't`, quoted speech, customer-content
phrases, compound commands, locked-device invocation, Apple Watch invocation,
duplicate invocation and an incoming call during foreground launch. Any negated
or ambiguous invocation that Siri matches must still produce no destructive
action; these intents can only request guarded navigation.

Xcode 27-only APIs, including `supportedModes`, View Annotations, App Intents
testing, Evaluations and Dynamic Profiles, remain out of the Xcode 26 target.

Primary platform references:

- [AppIntent](https://developer.apple.com/documentation/appintents/appintent)
- [Local-device authentication policy](https://developer.apple.com/documentation/appintents/intentauthenticationpolicy/requireslocaldeviceauthentication)
- [App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts)
- [AppShortcutsProvider](https://developer.apple.com/documentation/appintents/appshortcutsprovider)

## Verification

`test/ios-assistant-navigation.test.js` statically checks the safety contracts
and compiles/runs `ios/Tests/AssistantNavigationSmoke.swift`. The smoke covers
exact phrase acceptance, hostile and ambiguous phrase rejection, session and
identity isolation, expiry, exact record verification, unavailable route
behavior, permissions, draft-preserving preflight failure, stale confirmation,
idempotent routes, call-during-load rollback and request supersession. Full
Xcode 26 compilation, Siri semantic matching, locked-device behavior and
physical latency/voice-quality testing remain required on the pilot iPhone.
