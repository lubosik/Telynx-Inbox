# Main and VIP inbox spaces

Status: implementation plan based on the current repository, 28 September 2026.
This document does not deploy code, migrate data, change schedules, or send messages.

## Local implementation checkpoint

The first implementation (`fd4ac6a`) is merged and deployed on Railway and
distributed as TestFlight build 116. Non-signing cloud iOS build, server CI,
signed archive and tester distribution succeeded. The owner applied the migration
and the business_phone column was verified. Existing schedules are untouched.
This is an inbox-and-SMS foundation, not the complete VIP business zone.

The follow-up branch `feature/vip-growth-call-workspaces` was merged to main
at `c52703c` on 29 September 2026. Server CI, the unsigned iOS cloud build,
Railway production deployment, and the signed TestFlight workflow succeeded.
It adds server-side
Main/VIP Growth and Calls projections. Campaign approvals, recipients, schedules
and standing automation templates remain canonical/shared. Mixed jobs are marked
shared rather than duplicated. Scoped pages filter before pagination; incomplete
membership reads fail visibly instead of inventing zero counts. Native outbound
and automated voice caller ID were unchanged in that release. VIP voice work
is being developed separately in `feature/vip-calling-guide-drafts`.

Implemented locally:

- Shared persistent Main/VIP selection across Inbox and Contacts; disjoint
  customer lists and selected-workspace unread badge, global application badge.
- One unchanged canonical thread and full historical main-line history in VIP.
  Notification destinations follow current server-owned customer membership.
- Default SMS/MMS sender resolution centralized in `telnyx.sendSMS`, so payment
  reminders, order updates, cart recovery and other default senders follow VIP.
  Explicit server-resolved senders remain supported.
- Canonical paid-order facts reused by routing, contacts and inbox. Paid-order
  reads paginate; manual membership requires an actual `forced_include`.
  Order synchronization and manual overrides invalidate the local routing cache.
- New nullable `business_phone` provenance on inbox records, compatibility with
  unapplied migration, and actual accepted sender/recipient persisted by runtime
  campaign, cart, manual, transactional and reply writers. No guessed backfill.
- New history writes do not retry already accepted provider messages.
- Source/model tests, a Foundation executable smoke and full Foundation-layer
  typecheck. SwiftUI syntax checks are not a substitute for cloud iOS compilation.

Remaining before claiming a complete separate VIP zone:

- Growth's global campaigns, audiences and automations need validated server-side
  scoping, including explicit handling of mixed-audience jobs and frozen approvals.
- Calls remain global and caller ID unchanged. VIP SMS labels do not promise that
  native calls or automated voice calls originate from the VIP number.
- Coaching appointments and customer affiliate commissions are new product work;
  booking availability, cancellation and payout policies are not defined yet.
- External writes/other backend instances can retain a five-minute tier cache.
  Local order-webhook invalidation is implemented, not a cross-instance event bus.
- Initial migration, cloud build and distribution are complete. Physical-device
  verification of the switch remains a separate owner check.

Validation at this checkpoint: 2,629 / 2,629 offline Node tests passed with local
HTTP test servers allowed; complete documented Foundation-layer typecheck passed
(including `AssistantPresence.swift`); workspace executable smoke and SwiftUI
syntax parse passed. Initial sandbox-only failures were local socket EPERM,
not provider calls. Existing check-in visibility guards were updated to follow
the shared history helper while retaining table, field, dedup and catch checks.

## Product contract

One existing login opens one application with a persistent Main / VIP switch.
These are customer-service spaces inside the Vici account, not new tenants or
separate user accounts. Permissions remain the existing account permissions.

- Main contains standard customers.
- VIP contains VIP customers.
- A VIP customer has one canonical contact and one complete chronological
  conversation history, including messages previously exchanged on the main line.
- All future customer SMS/MMS, including payment reminders, order updates,
  check-ins, cart recovery and campaigns, use the VIP line after qualification.
- Standard customers continue using the main line.
- Opening the old main-number history of a VIP must not silently select that old
  number for the next reply.

Main number: +1 305 404 3184. VIP number: +1 917 725 4009. Runtime configuration
remains the source of truth; do not hard-code these numbers in application logic.
The toll-free voice opt-out number remains a separate compliance destination,
not an alternate customer inbox or replacement for either SMS sender.

## What already exists

`lib/vip-customers.js` defines automatic membership as at least three distinct
paid orders AND at least $500 lifetime paid-order spend. Existing audited segment
overrides support manually including customers. Membership never grants consent.

`routes/conversations.js` already enriches a single canonical contact list with
VIP classification and the next reply's sending number. `InboxViews.swift`
currently displays All Customers / VIP views of that same list. All Customers
includes VIPs today; this must become a disjoint Main / VIP partition.

`lib/vip-inbox-messaging.js` resolves sender numbers for manual replies and
reactions. Its five-minute membership cache currently has no order-triggered
invalidation, and its manual membership check treats any segment member as VIP,
whereas the inbox only treats `forced_include` rows as manual additions. Those
two semantics must be aligned before making this the universal send boundary.

`telnyx.js:sendSMS` defaults to the main number. Transactional call sites in
cart recovery, webhook-send, catchup, intelligence and check-in replies can
therefore bypass the existing resolver. Updating only the inbox UI cannot meet
the routing contract.

Messages are currently stored and fetched by customer phone. They do not reliably
retain the actual business line used. The inbound webhook does read Telnyx's
destination number to mark VIP notifications, but customer tier and destination
line are different facts and must not be conflated.

Existing Growth campaigns, audiences, coupons, review, scheduling, automations,
analytics and native calls should be reused. `routes/referrals.js` implements
internal conversation handoffs to staff; it is NOT a customer affiliate scheme.
No dedicated customer affiliate commission ledger or coaching appointment
scheduler was identified. Do not advertise those as complete.

## Routing and promotion

Use one authoritative customer-tier resolver for inbox membership, contacts,
Growth audience defaults, notifications and SMS sender selection. Reuse the
paid-order facts and manual override ledger, rather than create another VIP
definition or duplicate contacts. Normalize customer phones once.

When a paid-order webhook changes qualification, invalidate the customer's tier
cache after the authoritative order write. The next list read moves the customer
into VIP and the next send uses the VIP number. Refresh tier again at actual
send time: a message queued before promotion must use the current VIP line when
it sends. Existing welcome automation owns welcome enrollment and idempotency;
promotion must not create another welcome worker or duplicate welcome.

Current membership is recomputed from current paid-order facts. Preserve that
rule for the first release. Refund/status changes can make a customer stop
qualifying, unless an audited manual include remains. Do not silently introduce
permanent sticky membership. If the business wants VIP retained forever after
first qualification, make that a separate explicit policy with a persisted
promotion event and audited downgrade controls.

An unreadable tier must not invent VIP eligibility. Preserve existing established
main-line fallback initially, expose the routing-read failure operationally and
avoid representing it as verified VIP routing. A cached, recently verified VIP
assignment could later support a bounded fallback, but stale guesses must not
become permanent contactability or tier state.

Centralize SMS/MMS sender selection at the common provider boundary, with the
existing explicit sender overrides audited for test and provider-specific needs.
Avoid circular imports: VIP classification imports segment facts and must not
cause provider/database initialization cycles. Use lazy resolution or a clean
dependency-injected wrapper. All transports must retain existing STOP, consent,
DND, quiet-hour, commercial cadence, idempotency and approval checks.

Voice needs a separate verified transport pass. Native outbound call creation,
SDK caller-number defaults, cart-recovery call caller ID, transfer behavior and
provider connection capability must agree before promising VIP-originated calls.
Never change the toll-free opt-out destination or create a transfer loop merely
to align SMS inbox numbers.

## Old-number inbound messages

A promoted VIP may reply to an older main-line text. Continue attaching that
message to their canonical contact. Show it in their VIP customer workspace,
preserve its actual received-on line and reply from their current VIP line.
An unobtrusive line label explains the transition. Do not copy the contact into
Main or create a competing thread.

A standard customer who somehow texts the VIP number remains standard unless
they qualify or receive an audited manual include. Preserve the received-on
line, show the message in Main and flag the VIP-line arrival without automatically
granting VIP membership. STOP applies to the customer's existing shared
suppression record across both lines; switching lines must never bypass STOP.

Workspace badges count unread conversations in the current customer partition.
Notification payloads should separately carry current customer workspace and
actual received-on line so taps open the correct space and thread. A notification
created before promotion still resolves the current tier on opening.

## Additive schema and API

Keep `sms_contacts`, `sms_messages`, orders, campaigns and existing workspaces.
Do not add a second contact table or reinterpret `workspace_id = vici` as a
Main/VIP tenant identifier.

For auditable provenance, propose additive nullable columns on `sms_messages`:

- `business_phone`: actual outbound sender / inbound recipient in normalized E.164.
- `routing_tier`: standard or vip as resolved at send/receive time, if known.

These describe historical events, not current customer membership. Legacy NULL
means unknown; never backfill main or VIP from current tier. Only verified
provider records justify historical backfill. Keep the current complete timeline
query and hidden-message behavior. Index additional fields only where actual
queries use them; no per-number message partition is necessary for this contract.

`sendSMS` should return actual chosen sender with provider acceptance. Writers
persist that sender, not a newly computed guess after sending. Campaign attempts
must likewise retain their actual sender in the persisted provider attempt or
accepted inbox message without altering idempotency keys.

Initially, reuse existing conversation enrichment for the client workspace
partition. For larger lists, add validated `audience=main|vip|all` filtering to
existing collection endpoints, before pagination where those endpoints page.
Do not filter a single page client-side and call it the full VIP audience.
Any new endpoints require existing route-policy permissions and tests.

Growth context is a default audience constraint, not authorization. Explicitly
show the selected audience before approval; do not permit the UI switch to
silently rewrite a frozen campaign audience. Campaigns/automations spanning both
tiers should retain one canonical job with a shared badge or explicit filter,
not create duplicated sends in each space.

## Native application layout

Put one compact Main / VIP switch in the shared navigation shell. Preserve the
selected space across launches on that device. Keep Inbox, Contacts, Growth and
Calls navigation familiar; each space changes defaults and contextual filtering,
not login, permission grants or canonical data.

In VIP: a restrained VIP label and occasional gold accent, no gold bordered
cards or duplicated summary dashboard. Analytics remains the destination for
spend totals and rankings. Growth remains the destination for offers, audience
segments, campaigns and automations. Calls remains call history and calling.
Show the active sender adjacent to the composer and actual-line provenance on
messages where it resolves ambiguity. Unread badges stay separately visible.

Offer creation uses current coupons and VIP audiences. Coaching booking and
customer affiliates need later dedicated work: booking availability, timezone,
reminders and access rules; affiliate identity, referrals, attribution and payout
rules. Do not add dead buttons, sample offers, or imply those capabilities ship
with the inbox switch. Existing staff conversation referrals remain unchanged.

## Safe rollout

1. Add tests and align the single membership resolver with the inbox's manual
   override semantics and paged paid-order reads. Add cache invalidation.
2. Route all SMS/MMS providers consistently; preserve actual selected numbers.
   Prove transaction and campaign routing with fake provider fixtures only.
3. Prepare additive migration TXT for owner execution. Deploy compatibility code
   that tolerates NULL legacy provenance; do not run migrations as validation.
4. Add the shared Main/VIP shell and customer partition without losing history.
   Reuse the existing Growth/contact/call screens with explicit contextual scope.
5. Implement webhook line provenance, current-workspace notification navigation
   and separate unread counters. Verify physical-device notifications separately
   from the simulator compile.
6. Audit voice routing and provider capabilities; only expose verified VIP caller
   ID behavior. No live test calls/messages without explicit test authorization.
7. Offline backend tests, Swift Foundation typecheck, Swift parse, non-signing
   iOS CI build, review, then separately approved merge/Railway/TestFlight release.

Today’s already scheduled VIP retry campaign must not be cloned, rewritten,
unscheduled, resent or moved as a side effect of workspace creation. Preserve
frozen copy, audience, review revision, schedules, cancellation state and provider
attempts. Classification at actual sending can select the correct permitted line
without changing the approved body. Reconciliation must not resend uncertain
provider attempts. Any intentional changes to existing frozen data require an
explicit owner-authorized operation and audit.

## Required acceptance cases

- Standard customer appears only in Main; all message categories use main.
- New qualifying paid order moves one existing customer into VIP with no duplicate.
- VIP payment reminder, order update, cart recovery, campaign and manual reply
  all use VIP; campaign and recovery delivery remain idempotent.
- Queued message for a customer promoted before send uses VIP at execution.
- Historical main messages remain visible in VIP, in chronological order.
- VIP replies to old main-line text: received-on main, visible in VIP, next reply VIP.
- Standard contacts texting VIP do not gain VIP membership automatically.
- Forced include agrees across inbox, sender and Growth; stale ordinary segment
  membership does not become an unintentional manual override.
- Refund/status changes and manual override removal follow the documented policy.
- STOP on either line blocks governed sends on both; tier is never consent.
- Unread badges and notification navigation follow the current workspace, while
  actual line provenance stays historically correct.
- Existing campaign approval, preview, tests, coupons, cancellation, automation
  queue totals, recordings privacy and internal staff referrals are unchanged.
- Legacy NULL provenance loads safely and is not presented as known line evidence.
- VIP-only Growth defaults never silently expand or rewrite a frozen audience.
- API permissions apply identically in both spaces; the switch grants no access.
