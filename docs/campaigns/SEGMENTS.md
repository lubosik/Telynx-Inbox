# Saved campaign segments

Status: schema, API and tests landed 23 August 2026. Membership is visible and
recomputable. Nothing here sends an SMS, and nothing here can.

## What this is, and what it deliberately is not

`lib/campaigns/reorder-cadence.js` and `lib/campaigns/winback.js` already decide
who is worth contacting. They are pure arithmetic, median and MAD over purchase
intervals, no model involved, and they are documented in
`SEGMENTATION-METHODOLOGY.md`. They were also invisible: the operator could see
campaign drafts, but never the population behind them.

Segments are the visibility layer. `lib/campaigns/segment-definitions.js`
delegates every decision to those two modules and adds nothing of its own, so a
segment can never disagree with a draft about who qualifies.
`test/campaign-segment-definitions.test.js` asserts that by deriving the
expected membership from `calculateReorderCadence` and `qualifyWinback`
directly and comparing.

A segment is not a send. Consent, DND, quiet hours, cadence limits, provider
approval and the two live-send brakes are all downstream and all unchanged. A
segment of 400 people can still have zero send-eligible recipients.

## Automatic and manual

The distinction is a stored column, `segment_kind`, and a trigger refuses to
change it after insert. It is not a UI label, because "why is this person in
this segment" has to have a permanent answer and a segment that could flip kind
would make every historical member row ambiguous.

| | automatic | manual |
|---|---|---|
| Who decides membership | the engine | a person |
| `definition.detector` | required | forbidden |
| Recomputable | yes | no, refused with 409 |
| Member rows | `computed` or `forced_include` | `manual` |
| Add or remove a person | overrides only | directly |

The constraint `sms_campaign_segment_definition_matches_kind` enforces the
detector rule in the database, so a manual segment can never acquire a detector
and get silently overwritten by a recompute.

## The catalogue

Automatic segments come from a closed catalogue, not free-form filters. An
arbitrary predicate would mean "why is this person here" had as many answers as
there had been edits.

| key | shown as | what it holds | the arithmetic underneath |
|---|---|---|---|
| `reorder_due_high_confidence` | Due to reorder, best timing | Due or past due, and the pattern the date rests on barely moves | `eligible` and `cadence.confidence === 'high'`: relative MAD at or below 0.25 with zero outlying gaps |
| `reorder_due` | Due to reorder, everyone due | Due or past due on any usable pattern, their own or the product's | `eligible`: state `due` or `overdue` on a reliable cadence, personal or product level |
| `reorder_approaching` | Nearly due to reorder | Close to their usual moment but not there yet | state `approaching`: inside the early half of the expected window |
| `winback_qualified` | Good customers who have stopped | Repeat buyers who have gone quiet, minus anyone it would be tactless to contact | reliable cadence, 3 or more lifetime orders, lapsed beyond max(60 days, 1.75x median), no complaint, refund, recent negative support, open opportunity or 180 day cooldown |

`GET /api/segments` returns the saved segments plus an `available` list of
catalogue entries not yet saved, so the client offers them without a second
call. A key is stored on live rows: renaming one orphans a segment.

### Why the names read the way they do

The keys are for the database. The names and descriptions in
`segment-definitions.js` are for somebody who has never opened this repository
and never will. The previous copy said "relative MAD at or below 0.25 with no
outlying intervals", which is true and useless: nobody outside these files knows
what a relative MAD is, and nobody should have to. The rule now is that a
description says who is in the group, how sure the timing is, and when you would
use it, using numbers a person can picture. It may not claim more certainty than
the arithmetic supports, it carries no em dash, and it never strays anywhere near
a health claim.

### The two "due to reorder" segments are not the same thing

They looked identical because both were called "reorder due" and the only
distinguishing words were "high confidence", which describes the DATA rather
than the decision an operator has to make. They were kept apart rather than
merged, because the relation between them is real:
`reorder_due_high_confidence` is a strict subset of `reorder_due`, filtered on
how evenly spaced the pattern is.
`test/campaign-segment-definitions.test.js` asserts the subset relation
directly, so merging would have thrown away a genuinely tighter list rather than
removing a duplicate.

Watch one thing that the old description got wrong. `confidence` describes
whichever cadence was actually used, and `calculateReorderCadence` falls back to
the product level cadence when a person's own history is too thin. So a person
CAN be in the high confidence segment on an aggregate pattern rather than on
their own. "Best timing" is true of both cases. "Their own purchase history" was
not, and is why that phrase is now banned from the description.

Names and descriptions are copied onto `sms_campaign_segments` when a catalogue
entry is saved, so a segment already saved under the old wording keeps it until
somebody edits the row. New saves pick the new copy up immediately.

## Per-member evidence

Every member row carries `inclusion_evidence`, the facts that put them there.
For a reorder member that is:

```json
{
  "detector": "reorder",
  "cadenceSource": "personal",
  "confidence": "high",
  "medianIntervalDays": 30,
  "intervalsObserved": 4,
  "madDays": 0,
  "purchaseCount": 5,
  "lastOrderAt": "2026-07-22T12:00:00.000Z",
  "expectedAt": "2026-08-21T12:00:00.000Z",
  "expectedRange": { "start": "...", "end": "..." },
  "state": "due",
  "cycleKey": "2026-07-22T12:00:00.000Z:3000",
  "productID": 900,
  "ruleVersion": "segments-2026-08-23",
  "segmentKey": "reorder_due_high_confidence"
}
```

`GET /api/segments/:id/members/:phone` returns that, plus the active override
and the full override history. This is the per-person rule trace that
`TRACKING-AND-LEARNING-RESEARCH.md` identifies as the gap nobody else fills. The
override rows carry `createdByUserId`, `createdAt` and `reason`, so the UI shows
"Manually excluded by Lubosi on 12 Aug, reason: customer requested" rather than
an invisible flag.

`ruleVersion` is stored on the row, so an old member row is always readable as
"this is what the rules said at the time".

## Overrides, and the rule that matters

**A manual exclusion survives recompute.** It is the rule an operator relies on
and the one a refactor loses first, because the natural way to write a recompute
is "delete everything, insert what the engine said", and that reinstates every
excluded person.

Three things stop that:

1. **Overrides live in their own table.** `sms_campaign_segment_overrides` is
   separate from the member rows precisely because recompute rewrites member
   rows. An exclusion stored on a member row would be destroyed by the operation
   it exists to survive.
2. **A database trigger.** `sms_campaign_segment_member_is_permitted` raises on
   any insert or update of a member row whose phone holds an active exclude
   override, whatever the caller sends.
3. **The application filter.** `reconcileSegmentMembership()` in
   `lib/campaigns/segment-membership.js` drops excluded phones before the RPC is
   called, and the RPC drops them again.

An exclusion is permanent until revoked. Revocation is an explicit action that
writes `revoked_at`, `revoked_by` and `revoke_reason`; the row is never deleted,
so who excluded whom and who reversed it stays readable. Revoking an exclusion
does not resurrect anybody. The next recompute decides, which is the point of an
automatic segment.

A force-include is the mirror image. The person stays a member whether or not
the engine matches them, keeps their human reason as `inclusion_evidence`, and
carries `engine_matched` plus `engine_evidence` separately so the UI can say
"kept by a person, the engine no longer agrees". An exclusion beats a
force-include: they cannot both be active (partial unique index), and if a
caller ever supplies both, refusing to contact is the safe direction.

## Recompute

Idempotent twice over. The run key is the sha256 digest of what the engine
computed, so replaying an unchanged world is recognised as the same run and
changes nothing, and `UNIQUE (segment_id, run_key)` refuses a duplicate
regardless. A run row records member count, joined, left, refreshed, forced
includes and how many people the exclusion filter dropped.

Only `computed` rows leave. Force-included rows are never deleted by a
recompute.

## The API

| method and path | permission | notes |
|---|---|---|
| `GET /api/segments` | `campaigns.read` | counts, plus unsaved catalogue entries |
| `GET /api/segments/catalogue` | `campaigns.read` | literal, sorted ahead of `/:id` |
| `POST /api/segments` | `campaigns.manage` | `kind: "automatic"` saves a catalogue entry, idempotent by key; `kind: "manual"` takes a member list |
| `GET /api/segments/:id` | `campaigns.read` | segment plus paged members plus overrides |
| `GET /api/segments/:id/members/:phone` | `campaigns.read` | the inclusion evidence |
| `POST /api/segments/:id/members` | `campaigns.manage` | manual segments only |
| `DELETE /api/segments/:id/members/:phone` | `campaigns.manage` | manual segments only |
| `POST /api/segments/:id/overrides` | `campaigns.manage` | automatic segments only |
| `DELETE /api/segments/:id/overrides/:phone` | `campaigns.manage` | revoke |
| `POST /api/segments/:id/recompute` | `campaigns.manage` | automatic segments only |

Support Agents hold `campaigns.read` and not `campaigns.manage`, so they may
look and answer "why is this customer being contacted?" without changing
anything. Every route has an entry in `lib/route-policy.js`; the enforcer
default-denies, so a route added without one is closed and
`test/route-policy.test.js` fails.

## The iPhone client

The API above shipped without an interface, so the owner opened Growth, saw
Automations and Campaigns, and asked where his segments were. That was a fair
reading: the word "segment" in `GrowthView.swift` was the segmented control, not
this feature.

Growth now carries a third control, "Audiences". The label is shorter than
"Segments" because that is what buys the room for three, and it is the word an
operator uses; the screens underneath say segment, matching the notifications
and this document. Hanging it off the Campaigns pane instead was rejected:
Growth opens on Automations, so anything requiring a switch to Campaigns first
reproduces the bug.

| screen | file | what it is |
|---|---|---|
| Audiences | `ios/ViciInbox/UI/SegmentsView.swift` | the list, grouped by origin, plus the unsaved catalogue and the manual builder |
| One segment | `ios/ViciInbox/UI/SegmentDetailView.swift` | paged members, active and reversed overrides, recompute |
| One person | same file, `SegmentMemberEvidenceView` | the rule trace |

`ios/ViciInbox/Core/SegmentModels.swift` holds every model AND all of the
evidence interpretation. That split is deliberate: SwiftUI files get no local
type-check on the Ventura build machine, the Foundation layer does, and the
interpretation is the part worth checking. `SegmentInclusionEvidence` reads a
stored row back as `headline(personName:)`, one short paragraph, plus `facts`,
a checklist of only the values that are actually present. Nothing recomputes;
`ruleVersion` is the last line of the checklist so an old row still reads as
what the rules said then.

The trace is written for somebody reading it between two other jobs, so it
sounds like a colleague talking:

> Alex usually orders every 30 days or so. The last one was on 22 July 2026,
> which puts the next around 21 August 2026. That is about now.

Not "median interval 30.0 days, relative MAD 0.18". Two rules hold that line.
The checklist labels never name a statistic, they name the question a person
would actually ask, so `medianIntervalDays` appears as "Usually orders every".
And where the number does not belong to the person on screen it says so:
a product level cadence is labelled "Other customers order every" and
"Gaps measured across those customers", because "usually orders every" printed
over somebody else's number is a lie the reader has no way to catch.

Turning on a catalogue entry is two calls, save then recompute, because
`POST /api/segments` saves an automatic segment with no members and only a
recompute reads the engine. A failure of the second is reported without
implying the first was undone.

Read-only is absence, not disablement. A Support Agent holds `campaigns.read`,
sees every screen including the evidence, and sees no mutating control at all.
That follows `CampaignsView`, and deliberately not `TeamView`: TeamView greys a
control out and explains the rule, because there the actor normally could act
and one specific guard is stopping them. Here they never can, so the
explanation sits once at the foot of the list.

`GET /api/users` needs `user.read`, which an agent does not hold, so an
override's author degrades to "a team member" rather than firing a request that
would 403. The date and the reason always show, because they arrive on the
override row itself.

### Against the research

`TRACKING-AND-LEARNING-RESEARCH.md` is cited above and by
`lib/campaigns/segment-notifications.js` but is **not committed on any branch**.
It survives only inside a dangling stash object, `e6606a2`, on
`ios/onboarding-spotlight`. Read it with
`git show e6606a2:docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md`, and commit
it properly before that object is garbage collected. Its "Segmentation UX"
section asks for six things:

| asked for | where it is |
|---|---|
| named segment, live count, plain-language rules, browsable members | the list row and `SegmentDetailView` |
| origin label and edit affordance, not a separate menu | `SegmentOriginBadge` on every row, one list, and controls that differ by kind |
| per-person rule trace, "the thing nobody else has" | `SegmentMemberEvidenceView` |
| the trace ends in an "exits if" line | `SegmentInclusionEvidence.exitConditions` |
| override as a surviving property, shown as a sentence naming who and when | `attributionSentence`, over the existing override tables |
| live member count while building | the running "Chosen" count in the manual builder |

The one item NOT built is Braze's "which campaigns and flows currently target
this segment". There is no link from a segment to a campaign anywhere in the
schema or the API, so the client has nothing to read. It needs a backend change
first and is deliberately not faked.

## Notifications

`SEGMENT_CHANGE_NOTIFICATIONS_ENABLED` must be the exact lowercase string
`true`. It defaults off, exactly like `CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED`.
Recipients are active Owners and Admins holding `campaigns.manage`; the shared
legacy identity and Support Agents are excluded, because two people share the
former and reading a segment on request is not the same as being paged about it.

A change is material when the segment is created, or when joined plus left
reaches `SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA` (default 1). A replayed
recompute is never material.

No em dashes in notification copy. The rule is enforced in
`prepareSegmentChangeNotifications` (throws) and again in
`segmentChangePayload` (returns null), because those are two files a future edit
could change independently.

## Deleting a campaign

`DELETE /api/campaigns/:id`, `campaigns.manage`, audited.

A draft that was never submitted, never approved, never scheduled and whose
recipients never reached a provider is genuinely deleted. Everything else is
archived: it leaves the working list, the row stays, and `?archived=true` finds
it again. `delete_sms_campaign` makes that decision inside the transaction and
has no force mode, so a caller can ask for an archive but never for a delete.

Blockers checked in SQL: non-draft status, approval timestamp, approval audit
timestamp, a schedule, a review submission, any `sms_campaign_approvals` row,
any recipient event, any commercial contact ledger row, any linked
`sms_messages` or `sms_sent_log` row, any revenue attribution, and any recipient
with a provider message id, idempotency key, attempt start, send, delivery or
failure timestamp, or a state past `pending`.

The `campaign.deleted` audit row is written **before** the delete, with
`logAudit` rather than `logAuditSafely`: no row, no delete. After the row is
gone there is nothing left to describe.

## Applying the migration

`scripts/campaign-segments-migration.sql`, once, after
`rbac-migration.sql`, `audit-migration.sql` and `campaigns-migration.sql`, and
before deploying this code.

It adds no permission key. Segments reuse `campaigns.read` and
`campaigns.manage`, which `campaigns-migration.sql` already seeds, so the
startup permission check cannot fail because of this file.

`campaigns-migration.sql` and `sms-optin-migration.sql` are applied in
production and were not edited.
