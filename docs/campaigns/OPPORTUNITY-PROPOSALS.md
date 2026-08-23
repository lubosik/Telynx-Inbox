# Campaign proposals from a detected opportunity

The layer that turns "most of these people bought once and never came back"
into several reviewable campaign proposals, each with a different mechanism, a
stated cost, a stated risk, and a drafted message that has already passed the
compliance validator.

It is designed to be worth running with delivery switched off. What it produces
is an argument a person can read and decide about. Nothing in it schedules,
approves or sends, and accepting a proposal produces an ordinary campaign
`draft` that still has to pass every existing brake.

## The assumed opportunity contract

**This shape is an assumption and it is written down so it can be reconciled.**
The cohort/portfolio opportunity detector is being built in parallel. Nothing
in this repository emits this shape yet. `lib/campaigns/opportunity-contract.js`
is the single adapter: if the detector lands with different field names, that
file is the whole diff.

```jsonc
{
  "id": "one_time_buyers_no_second_order",   // machine key
  "kind": "repeat_purchase",                 // closed list, see OPPORTUNITY_KINDS
  "title": "Most buyers have ordered once and not come back",  // NO DIGITS
  "cohort": {
    "key": "one_time_buyers",
    "label": "One-time buyers",              // NO DIGITS
    "size": 700,
    "sizeBasis": "Customers with exactly one paid order, counted from sms_orders.",
    "segmentKey": "one_time_buyers",         // null until saved as a segment
    "definition": { "match": "all", "conditions": [ /* closed segment grammar */ ] },
    "anchorProductKey": "41:0",              // optional; enables the bundle narrowing
    "anchorProductName": "BPC-157"           // optional; verified catalogue name
  },
  "facts": [
    { "id": "single_purchase_groups", "label": "...", "value": 1318, "unit": "groups", "basis": "..." }
  ],
  "sizing": {
    "reachable": 412,
    "reachableBasis": "Cohort members with a phone number and no STOP on record.",
    "confidence": "insufficient_data",       // insufficient_data | low | moderate | high
    "assumptions": [
      { "id": "second_purchase_rate", "statement": "...", "source": "..." }
    ],
    "scenarios": [
      { "id": "...", "label": "...", "assumptionId": "second_purchase_rate", "value": 20, "unit": "orders" }
    ]
  },
  "detectedAt": "2026-08-23T09:00:00.000Z",
  "detectorVersion": "cohorts-2026-08-23"
}
```

Rules the contract enforces, all of them as refusals with reasons:

- `title` and `cohort.label` carry **no digits**. They are transported into a
  model prompt, and a number in a prompt is a number the model repeats.
- No field may contain an identity shape. The check is `IDENTITY_SHAPES` from
  `lib/campaigns/copy-writer.js`, one list for the whole repository.
- Every fact and every count carries a `basis`. A number that cannot say where
  it came from is not shown.
- Every scenario names an `assumptionId` that exists on the same opportunity.
  A scenario resting on an assumption nobody wrote is refused, because that is
  the exact shape of an invented conversion rate.
- An unknown `kind` is refused rather than handled generically.

### Deliberately NOT the same object as `sms_campaign_opportunities`

That table already exists and holds a **per-customer** opportunity: this
product is back in stock for this person. This contract describes a
**portfolio** opportunity: most of this cohort bought once. Different objects,
different lifetimes, deliberately not merged.

## The proposal shape

One proposal per mechanism. Persisted in `sms_campaign_proposals`
(`scripts/campaign-proposals-migration.sql`).

| Field | What it holds |
|---|---|
| `mechanism`, `mechanismLabel`, `distinctnessClass` | which lever this is, from the closed catalogue |
| `audience` | rule set in the closed segment grammar, plain English, and whether it needs saving as a segment before it can be accepted |
| `offer` | structured: kind, `appliedBy: human_at_review`, and the terms a human still has to set. Never in the copy |
| `copy` | the drafted message, its septet count, and the copy rules version it passed |
| `reasoning` | the model's one sentence, labelled as the model's, plus the business premise from the catalogue and the cohort narrative |
| `costs`, `risks` | from the catalogue, with severity and whether each is evidence or judgement |
| `projections` | counts and conditional statements, each with a basis. Never labelled revenue |
| `status` | `proposed` -> `accepted` or `dismissed`. A dismissal keeps its reason |
| `opportunitySource` | `detector` or `client_supplied` |

## How the variations are kept genuinely different

Three rewordings of one offer is not three proposals. Four deterministic
layers, none of which the model participates in:

1. **Mechanism selection.** `lib/campaigns/proposal-mechanisms.js` is a closed
   catalogue. One proposal per mechanism, one mechanism per distinctness class,
   the no-offer control always present so the set can answer "does this cohort
   need an offer at all", not only "which offer". Integrity is asserted at
   require time: a second mechanism in one class is a boot failure.
2. **Audience.** Where the detector supplies the fact to narrow on, a mechanism
   targets a different set of people. No threshold is ever written in code or
   by the model; when the fact is absent the proposal targets the whole cohort
   and says why it did not narrow.
3. **Offer.** Structured and typed. Three of the six mechanisms carry none.
4. **A similarity floor on the copy.** Jaccard overlap of the content words,
   after the brand prefix and the mandatory opt-out are removed. At or above
   0.6 the later proposal is refused with `too_similar_to` naming the other.

The mechanisms today: `plain_check_in` (no offer), `product_education` (no
offer), `ask_what_stopped_them` (no offer), `free_shipping`, `bundle`,
`first_reorder_incentive`.

## Offer terms are not allowed in the message, and that is the design

A proposal may carry `offer.kind = 'free_shipping'` and its drafted SMS still
may not say "free shipping". `free` is on the carrier-filter list in
`SMS-COPY-RESEARCH.md`; a price or a percentage fails
`no_unsupported_quantity_price_or_deadline`; and
`CAMPAIGN-COPY-PLAYBOOK.md` is explicit that an offer is attached by a human
during review and never by a drafter.

So the offer lives in the structured part of the proposal, where the reviewer
prices it and decides, and the copy is the plain compliant message that carries
it. `offer.termsRequiredFromHuman` lists exactly what still has to be set,
including creating and testing the coupon in the store, before anything is
approved.

## Honesty about numbers

- The model produces **no numbers at all**. A rationale containing a digit
  refuses the whole proposal. The copy validator refuses a price, a percentage,
  a quantity and a deadline in the message.
- Every figure comes from the deterministic layer, from the opportunity, with
  its basis attached.
- A scenario is a conditional statement and is labelled as one. Nothing is
  called revenue, earnings or profit; `assertNoRevenueClaim()` refuses the
  words outright, including "projected revenue", because there is no phrasing
  of that which survives being quoted out of context.
- When the detector reports `confidence: insufficient_data`, a scenario is
  shown **with that label and no point estimate**. That is
  `TRACKING-AND-LEARNING-RESEARCH.md` rule 25 applied to sizing.
- A scenario that arrives without a figure is dropped with a reason. Nothing
  here computes one.

## What stops a proposal becoming a campaign

`lib/campaigns/proposal-guards.js` holds two pure guards, each applied at three
call sites so deleting one does not open the gate.

- `assertSurfaceable` — a proposal whose copy did not pass
  `lib/campaigns/copy-validator.js` is never surfaced, never persisted and
  never returned by an API. Not repaired, not shown with a warning. Refusals
  are reported as check ids and the checks' own titles; the rejected text never
  leaves the process.
- `assertHumanAcceptance` — acceptance needs a named, signed-in person, an open
  proposal, no campaign already attached, and copy that still passes. The
  service additionally wins a compare-and-swap on the stored status, so two
  clicks cannot make two campaigns.

Acceptance order is claim first, then create, then attach. Losing the claim is
a conflict, not a second campaign. If the campaign creation fails, the claim is
released and the proposal has to be accepted again. The database enforces the
same three invariants independently: a dismissal must carry a reason, an
acceptance must name a person, and only an accepted proposal may point at a
campaign.

An accepted proposal produces a campaign in `draft`. Submit, review, approval,
scheduling and both live-send brakes are unchanged and untouched.

## Flag, permission, migration

- `CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED`, read as `=== 'true'`. Off by default.
- Permission: `campaigns.manage` on every endpoint including the reads. A
  proposal is unapproved marketing copy, and reading it is not a Support Agent
  concern.
- Apply `scripts/campaign-proposals-migration.sql` before deploying
  `routes/campaign-proposals.js`.

## Trying it without a deploy

```bash
node scripts/dry-run-campaign-proposals.js \
  --opportunity fixture.json --model-reply reply.json
```

Offline, fixture-only, no database and no OpenRouter client. Put a health
claim, a discount, a reworded duplicate or a number in the model reply fixture
and watch each deterministic layer refuse it.
