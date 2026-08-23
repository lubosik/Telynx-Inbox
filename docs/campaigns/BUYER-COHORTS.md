# Buyer cohorts and the opportunity detector

Status: deterministic, read-only, measured against the live database on
23 August 2026. No language model is involved at any point. Nothing here sends
a message, writes a row, or grants permission to contact anybody.

## Why this exists

The reorder engine works and it reaches about nine people. It needs three
spaced purchases of one product before it will say anything.

The reason is not that Vici customers never come back. 277 of 781 buyers came
back at least once. The reason is that **when they come back they buy something
else**. Repeat behaviour here is cross-product, and an engine measuring
same-product spacing cannot see it.

The money is therefore in the 504 people who bought once and did not return.
This document describes how they are cut into groups, and how those groups are
sized without lying about them.

## The first rule: customer level, never customer-product level

A cohort is decided from the number of **distinct paid orders per person**.

Somebody who bought BPC-157 once and GHK-Cu once is a repeat customer with two
one-time products. They must never appear in a one-time-buyer cohort. Counting
customer-product pairs instead of customers turns 504 one-time buyers into an
imaginary 1,300 and makes the business look worse than it is.

`orderCount` comes from `buildCustomerFacts()`, which counts distinct paid
order ids per phone. Every cohort predicate reads it, and
`test/campaign-buyer-cohorts.test.js` asserts the cross-product case directly.

## Live shape of the customer base, 23 August 2026

| | |
|---|---:|
| Known contacts | 931 |
| Of those, buyers | 781 |
| Contacts with no paid order | 150 |
| Paid orders considered | 1,288 |

| Orders per buyer | Buyers |
|---:|---:|
| 1 | 504 |
| 2 | 157 |
| 3 | 70 |
| 4 | 25 |
| 5 | 10 |
| 6 | 6 |
| 7 | 4 |
| 8 | 2 |
| 9 | 1 |
| 10 | 1 |
| 11 | 1 |

One-time buyers are 504 of 781, or 64.5%. Repeat buyers are 277.

Order line identity resolves 2,342 of 2,346 paid line items against the live
catalogue. Reading `product_id` off the line item directly would resolve 12,
which is why every product-shaped figure here goes through
`lib/campaigns/product-identity.js`.

## Where the cuts come from

The axis is days since the only order. The boundaries are **30, 90 and 365**.

They are round numbers, and they were adopted only after being checked against
this shop's own repeat buyers. Measured across 277 repeat buyers:

| | Days |
|---|---:|
| Half of all returning customers had returned by | 33.9 |
| Three quarters had returned by | 63.4 |
| Nine in ten had returned by | 94.3 |

So 30 and 90 sit within a few days of where this shop's own behaviour already
puts them. The chance of a return decays steadily from the first order onwards,
so effort is front-loaded.

There is deliberately **no cohort beyond 365 days**. The oldest paid order in
the database is 215 days old, so it would contain nobody.

### The cuts are frozen, and drift is reported

`COHORT_CALIBRATION` in `lib/campaigns/buyer-cohorts.js` holds the boundaries
and the measurements behind them. They do not move on their own. A saved
segment whose meaning shifted every night would make "why is this person in
this list" unanswerable.

Every build recomputes the live distribution and emits `calibration.drift`
instead. When a cut has drifted past its tolerance the detector raises a
`cohort_cuts_have_drifted` blocker and the dry run prints it. Re-freezing is
then a deliberate act: change the constant, bump `BUYER_COHORT_RULE_VERSION`,
and record what moved here.

## The cohorts, live on 23 August 2026

| Key | People | Never contacted | Already paid (USD) |
|---|---:|---:|---:|
| `one_time_buyers` | 504 | 504 | 95,393.36 |
| `one_time_multi_product` | 323 | 323 | 69,597.71 |
| `one_time_above_typical_spend` | 252 | 252 | 66,290.07 |
| `one_time_lapsed` (91 to 365 days) | 241 | 241 | 44,465.52 |
| `one_time_first_month` (0 to 30 days) | 133 | 133 | 25,184.52 |
| `one_time_slipping` (31 to 90 days) | 130 | 130 | 25,743.32 |

The three tenure cohorts partition `one_time_buyers` exactly: 133 + 130 + 241
is 504, with no overlap and no gap. The other two cut the same people from a
different angle and overlap all three.

Every one of these figures is money **already taken**. None of it is an
opportunity.

### Whether they can still buy what they bought

| Cohort | Everything still on sale | Some gone | All gone |
|---|---:|---:|---:|
| `one_time_buyers` | 448 | 39 | 17 |
| `one_time_lapsed` | 202 | 30 | 9 |
| `one_time_first_month` | 126 | 4 | 3 |
| `one_time_slipping` | 120 | 5 | 5 |

## What was deliberately not built

Recorded in code as `COHORTS_NOT_BUILT` and returned by the endpoint, so the
absence is visible on the screen rather than only to a reader of source.

| Not built | Reason |
|---|---|
| A dormant-over-a-year cohort | The oldest paid order is 215 days old. It would contain nobody. |
| An RFM grid | 781 buyers over a five by five by five grid averages six people per cell. A six-person cell has no measurable rate. |
| A propensity or lifetime-value model | At this sample size with a dominant never-repeated class, a fitted score reproduces noise and reports it to a decimal place. |
| A back-in-stock cohort | `sms_product_inventory` and `sms_commerce_product_events` are both empty, so there is no previous stock state to compare against and no transition can be evidenced. |

There is one binary value split and no finer one. That is the whole of the
value dimension by design.

### The actionable floor

`actionableFloorPeople` is 100. Below it, a cohort's own observed rate is
consistent with almost any true rate: a 50-person group showing 8% is
consistent with anything from roughly 3% to 19%. Such findings are **flagged,
not hidden**. `one_time_buyers_whose_product_is_gone` (56 people) is currently
the only one below it.

## Sizing: the part that stops the system lying to its owner

`lib/campaigns/opportunity-sizing.js` makes the dishonest shape unbuildable
rather than discouraged. There are exactly three results a caller can produce.

**`observed()`** A figure read off rows. Counts, order values, money already
taken. Carries `countedFrom`, naming what it was counted from.

**`project()`** A figure that depends on an assumed rate. It cannot be
constructed without the rate's **sample** (successes and trials, from which the
rate is derived rather than passed in), a **named source** from a closed set,
a **source detail sentence**, and a **claim**. It returns a **range** of people
and a **range** of money and no point figure for either, because the sample is
finite and the Wilson interval around it is arithmetic, not modesty.

A projection object carries no `value`, `total`, `amount`, `revenue`,
`estimate` or `headline` key. There is nothing on it a template can print on
its own and have it read like a fact. `assertNoHeadlineFigure()` enforces this
over the entire payload before it is returned, and the test suite asserts it.

**`refuse()`** A first-class result, not an error path. It carries the
population and the observed values in the place a number would have gone.
"504 people whose middle order was 169.24" is a fact. "5,300 of opportunity" is
a guess wearing a suit.

### Every rate here is organic, and that is why nothing is projected as revenue

The commercial contact ledger has **zero rows**. No promotional campaign has
ever been delivered from this system. Every second order in the history
happened with no contact at all.

That makes the observed rates a **yardstick a campaign has to beat**, and
useless as a forecast of one. Every projection therefore carries
`claim: 'no_action_baseline'` with a plain-English `claimMeans` beside it.

The question the owner actually wants answered, "how much extra will we make by
messaging them", is asked explicitly for every cohort and **refuses every
time**, with reason `no_measured_uplift`. `project()` refuses
`incremental_from_contact` by construction unless handed a measured uplift with
a real sample. There is no flag, no override and no default rate. Run a
campaign against a holdout, measure the gap, pass it in, and the refusal
becomes a projection with that sample stamped on it.

### Conditional rates, and the survivorship trap

A rate measured from day zero is dominated by people who came back inside a
week. **Not one of those people is still in a one-time-buyer cohort.** Quoting
that rate at a lapsed group overstates it badly.

So the baseline is measured conditionally: of the people who were still on one
order at day A, how many came back by day B.

| Still on one order at | Returned by | Observed |
|---:|---:|---|
| day 30 | day 90 | 95 of 370, 25.7% |
| day 30 | day 180 | 62 of 184, 33.7% |
| day 90 | day 180 | 18 of 140, 12.9% |

Each tenure cohort quotes the rate anchored at **its own lower boundary**. That
errs high on purpose: somebody 25 days into the first month has already gone 25
days without returning, so their true remaining chance is at or below the rate
measured from day zero. Erring high on a hurdle a campaign must clear is the
safe direction, and the assumption sentence says so.

**A cohort that spans every tenure is refused a rate entirely.**
`one_time_buyers`, `one_time_above_typical_spend` and `one_time_multi_product`
each contain customers from last week and customers from six months ago. There
is no single rate that describes both, so they return a
`mixed_tenure_population` refusal that points at the three tenure cohorts,
which do have an answer.

### Live sizing, 23 August 2026

Only the three tenure cohorts have a defensible rate. All are do-nothing
baselines, all are ranges, none is revenue.

| Cohort | People | Rate assumed | Sample | People range | Money range (USD) |
|---|---:|---:|---|---|---|
| `one_time_first_month` | 133 | 39.43% (35.04 to 43.99) | 179 of 454, own data | 46 to 59 | 5,685 to 13,086 |
| `one_time_slipping` | 130 | 33.70% (27.26 to 40.80) | 62 of 184, own data | 35 to 54 | 4,517 to 12,215 |
| `one_time_lapsed` | 241 | 12.86% (8.29 to 19.41) | 18 of 140, own data | 19 to 47 | 1,910 to 10,105 |

Refused, with the population reported instead:

| Finding | People | Refusal |
|---|---:|---|
| `one_time_buyers` | 504 | `mixed_tenure_population` |
| `one_time_multi_product` | 323 | `mixed_tenure_population` |
| `one_time_above_typical_spend` | 252 | `mixed_tenure_population` |
| `repeat_behaviour_is_cross_product` | 277 | `not_a_revenue_question` |
| `contacts_with_no_paid_order` | 150 | `no_observed_order_value` |
| `one_time_buyers_whose_product_is_gone` | 56 | `nothing_to_offer_them` |
| every cohort, incremental question | | `no_measured_uplift` |

## Refreshing

`lib/campaigns/opportunity-portfolio.js` recomputes from WooCommerce and
Supabase, through `readAuthoritativeGenerationSources()` and the shared
catalogue cache. There is no second reader and no second copy of the truth: the
whole computation is a pure function of the sources, so the cache is
in-process, holds one payload, and can be discarded at any moment.

- `CAMPAIGN_OPPORTUNITY_TTL_MS`, default six hours, capped at 24.
- `CAMPAIGN_OPPORTUNITY_MIN_REFRESH_MS`, default five minutes. A forced refresh
  inside this window is debounced, so a held-down refresh control cannot become
  a load test against WooCommerce.
- Concurrent refreshes share one read.
- A failed refresh leaves the previous payload in place and serves it with
  `freshness.stale: true` and the failure attached. A stale answer that says so
  beats an empty screen.

`server.js` starts a rebuild 60 seconds after boot and then on the TTL. It is
read-only, so unlike the delivery loop there is no flag keeping it off, and a
failure logs and returns rather than interrupting the inbox, the dialler or
order SMS.

## The endpoint

```
GET /api/campaigns/opportunities[?refresh=true]
```

`campaigns.read`, declared literally in `lib/route-policy.js` so the enforcer
sorts it ahead of `/api/campaigns/:id`. Not audited, because nothing changes.
Any query parameter other than `refresh` is rejected with
`CAMPAIGN_OPPORTUNITY_INPUT_REJECTED`: every population, rate and figure is
server-owned, and a caller who could supply one could choose the answer.

```jsonc
{
  "detectorVersion": "opportunity-detector-2026-08-23",
  "computedAt": "2026-08-23T...",
  "currency": "USD",
  "portfolio": {
    "moneyAlreadyTaken": { "kind": "observed_money", "alreadyTaken": 245890.66, "hypothetical": false },
    "customers": { "kind": "observed", "knownContacts": 931, "buyers": 781, "ordersPerBuyer": {} }
  },
  "findings": [
    {
      "key": "one_time_lapsed",
      "segmentKey": "one_time_lapsed",
      "title": "Bought once, and the usual return time has passed",
      "population": 241,
      "actionability": { "people": 241, "floor": 100, "belowFloor": false, "note": "..." },
      "evidence": {
        "countedAt": "customer",
        "people": { "kind": "observed", "people": 241, "neverContacted": 241, "countedFrom": "..." },
        "orderValue": { "kind": "observed", "lowerQuartile": 100.52, "middle": 156.48, "upperQuartile": 215 },
        "timeSinceOrder": { "kind": "observed", "middleDays": 0 },
        "canStillBuyIt": { "kind": "observed", "everyProductStillOnSale": 202 }
      },
      "observed": {
        "moneyAlreadyTaken": { "kind": "observed_money", "alreadyTaken": 44465.52, "hypothetical": false }
      },
      "sizing": {
        "baseline": {
          "kind": "projection",
          "claim": "no_action_baseline",
          "claimMeans": "What this group is expected to do with no message sent...",
          "rate": { "point": 0.1286, "low": 0.0829, "high": 0.1941,
                    "successes": 18, "trials": 140,
                    "source": "internal_observed_cohort", "fromThisShopsOwnData": true },
          "peopleRange": { "low": 19, "high": 47 },
          "moneyRange": { "currency": "USD", "low": 1909.88, "high": 10105 },
          "assumption": "Assumes 12.86% (8.29% to 19.41%...)",
          "hypothetical": true
        },
        "incremental": { "kind": "refusal", "reason": "no_measured_uplift", "population": 241 }
      }
    }
  ],
  "refusals": [ { "finding": "...", "question": "incremental", "reason": "no_measured_uplift" } ],
  "notBuilt": [ { "key": "rfm_grid", "reason": "sample_too_small", "detail": "..." } ],
  "blockers": [ { "key": "live_sending_is_off", "severity": "blocking", "detail": "..." } ],
  "calibration": { "frozen": {}, "observed": {}, "drift": {} },
  "baseline": { "neverContacted": true, "returnWithin": [], "returnAfterPassing": [] },
  "coverage": {},
  "floor": { "people": 100 },
  "freshness": { "computedAt": "...", "ageSeconds": 0, "stale": false }
}
```

## The cohorts as saved segments

Each cohort is a first-class entry in the segment catalogue in
`lib/campaigns/segment-definitions.js`, carrying `source: 'buyer_cohorts'`. It
is created, recomputed, reconciled, overridden, audited, deleted and notified
by exactly the same code path as `reorder_due`. The only difference is which
input `computeSegmentMembers()` is handed, and `segment-service.js` dispatches
on that one field.

Membership is behaviour and never permission. No cohort predicate reads
consent, STOP state, DND, quiet hours or support clearance, and
`commercialClearance` on a cohort member row is `null` because a cohort has no
clearance observation to carry. Contactability is filled in at read time by
`lib/campaigns/segment-contactability.js`, as information on the row, never as
a filter.

`everCommerciallyContacted` is on the evidence because "nobody in this group
has ever been contacted" is the most important fact about these people. It is a
record of what was sent. It is not consent.

## Reproducing the numbers

```bash
node scripts/dry-run-buyer-cohorts.js
node scripts/dry-run-buyer-cohorts.js --json
```

Read-only, aggregate-only, no customer identity in the output, and it writes
nothing.
