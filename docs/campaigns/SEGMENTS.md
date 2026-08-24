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
| `back_in_stock_nearly_due` | Back in stock, and nearly due to reorder | The exact thing they bought went out of stock and has come back, AND they are close to their usual next order | a genuine out to in transition on a signed event, the item in stock now, and state `approaching` on the parent product. No threshold of its own |
| `back_in_stock_other_buyers` | Back in stock, everyone else who bought it | The same return, pointed at the rest of that item's buyers, with no timing read at all | the identical transition test, minus every phone `back_in_stock_nearly_due` returned, minus state `due` or `overdue` on the parent, minus anyone who re-bought that exact item since it returned |
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

### Back in stock, and nearly due: two weak signals making one strong one

`back_in_stock_nearly_due` is the only segment built from two detectors at once,
and the reason it exists in that shape is a compliance reason rather than a
targeting one.

| signal | on its own |
|---|---|
| nearly due | the timing is a guess about somebody's consumption. Unsafe to act on. |
| back in stock | the timing is a fact, but it is pointed at everybody who ever bought the thing. |
| both | the timing is a fact, AND it is pointed at the people for whom saying it today is worth anything. |

**The restock is the reason the message exists. The timing only decides who
receives it, and is never stated, implied or referenced in copy.**

`REPEAT-PURCHASE-RESEARCH.md` rules out replenishment and "running low"
reminders outright: the mechanism is a consumption-rate assumption, which is a
dosing claim, and under 21 CFR 201.128 the firm's own written statements are
evidence of intended human use. It names the substitute in one line, "a restock
notice about OUR stock, which moves the trigger from their usage to our supply".

"The thing you bought is back in stock" is a fact about our inventory. "You are
probably running low" is a claim about a person's body. The first is fine and
the second ends the business. Every member row therefore carries `statedReason`
and `timingUse: 'selection_only'` alongside a constant `copyBasis` sentence, so
the split is written next to each name rather than living only in a document.

#### The bar did not move, and here is the argument

The obvious temptation is to say that because the restock carries the reason,
the timing half can be read more loosely here than it would be on its own. It
cannot, and it is not.

`lib/campaigns/restock-reorder.js` holds no threshold. It calls
`calculateReorderCadence()` with the same arguments `reorder_approaching` uses
and accepts the same single state, so the segment is a strict subset of "Nearly
due to reorder" and `test/campaign-segment-restock-reorder.test.js` asserts it.

- **Not widened.** A restock tells us something about our shelves and nothing
  at all about how fast a person gets through what they bought. Replacing the
  MAD-scaled band with a fixed "within N days" would be the relaxation that was
  considered and declined, arriving through a side door. The band's width is
  the person's own regularity, which is the property that makes "approaching"
  mean anything.
- **Not raised either.** On `reorder_due` the timing IS the reason for the
  message, so being wrong means writing to somebody for no reason. Here the
  reason is true of everybody in the list whatever the timing said, so a
  merely-usable pattern mistimes a truthful message rather than manufacturing a
  false one. Demanding the tightest patterns would take a list that currently
  tops out at two people to a certain zero and teach nobody anything.
- **Still refused: no pattern at all.** Somebody whose history is unreadable is
  not rescued by the restock. That would be "restock alone", which is an
  untargeted campaign and a different thing with a different name.
- **Not `due` or `overdue` either.** Those people are already in "Due to
  reorder, everyone due". Two lists means two messages.

#### The awkward cases and what was chosen

- **They bought it again since it came back.** Excluded. The news is not news to
  somebody who has already acted on it. Note this is a real case and not a
  theoretical one only because a short pattern can be `approaching` again within
  days; a longer pattern moves to `not_due` and falls out on its own.
- **They have since bought a different vial of the same product.** Nothing
  special happens, and nothing needs to: timing groups on the parent, so the
  later purchase moves the whole series and they are `not_due`.
- **They have since bought a combination product containing the same molecule.**
  They stay in. `product-identity.js` never decomposes a combination into its
  parts, and relaxing that to make this case work would merge two real products
  everywhere else. The cost is bounded: the message still says only that a
  product they demonstrably buy is back on the shelf.
- **A product goes out and back in twice in a week.** One member, not two. The
  most recent return is the current fact and the earlier ones are counted in
  `earlierReturnsSeen`, which the evidence sentence admits out loud. The pairing
  also requires the item to be in stock *now*, so a flap that ended out of stock
  produces nobody.
- **A variation restocks and the person bought a different size.** Not a member.
  "Your BPC-157 10mg is back" is a claim about one vial size.
  `buildGenerationInput()` already indexes buyers under both the parent and the
  exact variation and looks an event up by its own key, so a variation-level
  event only reaches the buyers of that vial; a parent-level event reaches
  everyone. That behaviour is reused, never weakened.
- **The vial they bought most recently is out of stock.** They are left out,
  because the engine builds no reorder candidate for them at all and their
  timing is therefore unreadable. This errs toward silence and is counted as
  `noReorderCandidateForBuyer` rather than hidden.

### The second back-in-stock list, and why it is disjoint rather than nested

`back_in_stock_nearly_due` deliberately refused to sweep in people with no
readable buying pattern, on the grounds that calling somebody nearly due when we
cannot measure when they are due is a false label on a member row. It named the
alternative in its own words: "that is restock alone, which is an untargeted
campaign, and if the owner wants it he should get it under its own name". The
owner does want it, and he is right that it is legitimate.

**A restock notice needs no cadence.** "The thing you bought is back in stock"
is a fact about our warehouse. It is true on the day it is observed whatever the
recipient's buying looks like, and it stays true when we can read nothing about
them at all. `REPEAT-PURCHASE-RESEARCH.md` bans every replenishment and "running
low" reminder because the mechanism is a consumption-rate assumption, and names
exactly one substitute: a restock notice about OUR stock. This segment is that
substitute with nothing else attached, which makes it the safest list in the
catalogue rather than the loosest one.

#### Disjoint, not nested, and the difference from the reorder pair

`reorder_due` and `reorder_due_high_confidence` are nested on purpose. That
works because they answer the SAME question at two levels of certainty: each
description names the other and an operator picks one.

The two back-in-stock lists do not have that shape. They answer the same
question about ONE event, so a person in both receives **two messages about one
restock**, and the nearly-due one is strictly better timed. Nesting them would
leave that outcome resting on an operator noticing an overlap that is invisible
on a screen.

So the split is structural rather than editorial:

```
restockOnlyRows()  ->  calls restockReorderPairs()  ->  subtracts every phone it returned
```

Not a re-implementation of the pairing's rule and not a parallel filter that
happens to agree today. The sibling decides its own membership and this file
removes exactly whoever that was, so a future change to the pairing propagates
here for free and cannot re-create an overlap.
`test/campaign-segment-restock-only.test.js` asserts the intersection is empty
against a fixture that deliberately holds people in every state.

The subtraction is at the **person** level, not person-and-product. Somebody
nearly due on one returned product and unreadable on another returned product is
two true facts and still two restock texts in one recompute. The pairing is the
better timed of the two, so it wins the person outright.

#### What happens to the people who are due or overdue

Excluded, at the person-and-product level, for the reason the pairing already
gives for excluding them: they are in "Due to reorder, everyone due" and two
lists means two messages. Both back-in-stock lists therefore treat the reorder
lists identically, and only the relationship BETWEEN the two back-in-stock lists
is tightened to the person, because only they are about the same event.

#### Why somebody who is simply a long way off is still in the list

State `not_due` means we can read their buying and their moment is far away. The
temptation is to drop them too, on the grounds that this list is "the people we
cannot time". It was declined, and the reason is worth keeping:

- Excluding `approaching`, `due` and `overdue` is a **de-duplication** rule.
  Each of those states has a list that already holds the person.
- `not_due` has no list. Dropping them would be a **timing** rule, and a timing
  rule inside a segment whose entire justification is that a restock needs no
  timing is incoherent.
- It would also re-import the banned reasoning through a side door. "They bought
  recently so they do not need to hear this" is a claim about their supply,
  which is the exact sentence this business may not think, let alone send.

The rule is therefore: **subtract the lists that exist, never the states we can
read.** What the member row owes the reader instead is an honest sentence about
which case it is, and every row carries one.

#### What did not soften

- `qualifyRestockForSegment()` is imported and called unchanged. Signed event,
  definitely-out previous state, definitely-in observed state, still in stock
  now. This list is broader in WHO it holds and not one notch looser in WHAT
  counts as the fact it rests on. The bar matters more here, because there is
  no second signal to reduce a wrong claim to a merely mistimed one.
- Anyone who re-bought the returned item since it returned is out. Checked
  against **the exact item**, from `lastPurchaseAt` on the restock candidate,
  rather than against the parent series the pairing uses. Somebody who bought a
  different vial of the same molecule has not bought the vial that came back,
  and telling them it is available is still true and still useful.
- `RESTOCK_REORDER_COPY_BASIS` is reused verbatim. One permitted message, one
  constant. Two near-identical ones would be two things to keep in step and one
  of them would eventually be edited alone.

#### One narrow gap, recorded rather than hidden

`approaching` is excluded here on the STATE, not only by subtracting whoever the
pairing returned. Those are not the same rule, because the pairing applies
filters after its own state test.

The case where they diverge: somebody `approaching` who has re-bought a
DIFFERENT vial of the same molecule since the return. The pairing drops them,
because its "already ordered again" check is on the parent series. This list
does not pick them up, because they still read as `approaching` and a row here
would then claim we cannot time somebody we plainly can. They are in neither
list.

That was chosen over the alternatives. Relaxing the state test would put an
`approaching` person into a list whose every member row says the opposite, and
weakening the pairing's own check is out of scope for a segment that is supposed
to add people rather than change who the pairing holds. The cost is one message
not sent to a person who has just bought from us anyway, which errs toward
silence. `test/campaign-segment-restock-only.test.js` pins the behaviour so a
future change to it is deliberate.

#### Both are empty, and that is a true answer

`sms_product_inventory` and `sms_commerce_product_events` are both empty in
production, so no out-to-in transition has ever been recorded and BOTH
back-in-stock segments return nobody. Reading current stock is not a substitute:
a first sighting of "in stock" is not evidence that anything came back, and
`back-in-stock.js` has always said so.

An empty automatic segment and a broken one look identical on a screen, and this
project has already lost a week to that confusion. So each description says the
list stays empty until something is recorded going out and coming back, and each
has its own explainer: `describeRestockReorderEmptiness()` names which of six
things is missing for the pairing, and `describeRestockOnlyEmptiness()` does the
same for the other list. Its codes are not the same set, because two of its ways
of being empty are its own. **Everybody who bought the thing is already in a
better timed list**, which is the engine working rather than failing. And
**something came back that nobody had ever bought**, which reads as zero
candidates exactly like "nothing has come back" does, but is a different answer:
one of them sends a reader hunting for a missing inventory baseline that is
already there. The two are told apart by `sourceCoverage.restockEvents`, and a
fixture that carries no coverage block gets the conservative sentence rather
than a guess. `scripts/dry-run-segment-membership.js` prints both, in sections 2b and
2c.

#### How big each one gets once a real return is recorded

Neither has ever held anybody, so this is arithmetic over the live 23 August
figures rather than a measurement, and it is stated as a bound:

- `back_in_stock_nearly_due` can only ever hold buyers of the returned item who
  are ALSO in `reorder_approaching`. That list holds **2 people in total**
  across the whole catalogue, so unless one of those two happens to have bought
  the item that returns, this segment stays at zero and otherwise reaches one or
  two.
- `back_in_stock_other_buyers` is bounded by the buyers of the returned item
  instead, less those two, less whichever of the **9** people in `reorder_due`
  bought it, less anyone who re-bought it since. Across 761 buyers and 1,689
  person-product groups, **1,318 of those groups have exactly one qualifying
  purchase**, so nearly every buyer of a returned item lands here rather than in
  the pairing.

That ratio is the whole point of building it. The pairing is a list of one or
two people that exists because its timing is defensible; this one is the rest of
the room, and the only reason it is safe to write to them is that the sentence
does not depend on knowing anything about them.

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

A `back_in_stock_nearly_due` member carries the same timing block, stamped with
its own detector, plus the stock half and the rule that keeps the two apart:

```json
{
  "detector": "back_in_stock",
  "statedReason": "product_back_in_stock",
  "restockObservedAt": "2026-08-22T09:00:00.000Z",
  "restockedProductID": 900,
  "restockedVariationID": 568,
  "earlierReturnsSeen": 0,
  "timingUse": "selection_only",
  "mostRecentVariationID": null,
  "state": "approaching",
  "medianIntervalDays": 56,
  "lastOrderAt": "2026-07-03T12:00:00.000Z",
  "copyBasis": "Say only that the product is back in stock. ...",
  "summary": "Their GHK-Cu came back in stock on 22 August 2026. They last ordered it on 3 July 2026, and they usually reorder around every 8 weeks."
}
```

A `back_in_stock_other_buyers` member carries no timing block at all, and says
so rather than leaving a gap somebody has to interpret:

```json
{
  "detector": "back_in_stock",
  "statedReason": "product_back_in_stock",
  "restockObservedAt": "2026-08-22T09:00:00.000Z",
  "restockedProductID": 900,
  "restockedVariationID": 568,
  "earlierReturnsSeen": 0,
  "lastOrderAt": "2026-07-03T12:00:00.000Z",
  "purchaseCount": 1,
  "timingUse": "exclusion_only",
  "timingRead": "none",
  "timingState": null,
  "notInThisList": "back_in_stock_nearly_due",
  "copyBasis": "Say only that the product is back in stock. ...",
  "summary": "Their GHK-Cu came back in stock on 22 August 2026. They bought it once, on 3 July 2026. We cannot tell when they usually buy this again, so there is no way to say whether today is a good day for them. That is why they are here rather than in \"Back in stock, and nearly due to reorder\"."
}
```

The three fields that matter most on that row are the last three before the copy
rule. `timingUse: 'exclusion_only'` says timing did nothing here except hand
other people to other lists. `timingRead` is one of `none`, `not_near` or
`not_computed`. `notInThisList` names the better timed list explicitly, because
"why is this person not in that one" is the first question anybody will ask, and
a row that cannot answer it invites somebody to assume the engine missed them.
`lastOrderAt` and `purchaseCount` are about THE ITEM THAT CAME BACK rather than
the parent reorder series, because the item is what the message names.

`summary` is written server-side and uses absolute dates on purpose: a sentence
containing "three days ago" would change every night and churn the run digest.
A product-level pattern is never described as this person's own, for the same
reason the iPhone's evidence checklist relabels it.

**Known gap.** `SegmentInclusionEvidence.headline` on iOS switches on
`detector` and has branches for `reorder` and `winback` only, so a
`back_in_stock` row currently falls to the generic sentence. The fact checklist
underneath it renders correctly. Adding the branch, and showing `summary`
directly, is a small client change that was out of scope for the build that
added the segment.

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
