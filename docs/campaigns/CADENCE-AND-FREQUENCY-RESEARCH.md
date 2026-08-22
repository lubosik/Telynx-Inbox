# Campaign cadence and frequency research

Status: product research completed 22 August 2026

## Purpose

Campaign detection may be continuous while customer contact remains controlled.
This document separates product cadence from legal or provider caps and defines
the dry-run inputs needed before choosing Vici's first live policy.

## Three separate layers

### 1. Hard rules

Hard rules include active opt-out or DND, missing consent, provider ineligibility,
quiet hours, jurisdiction-specific limits, and an unavailable product. They
cannot be overridden through a campaign screen.

### 2. Product frequency policy

Product policy protects customer experience and coordinates campaigns with
promotional flows. An Admin may not bypass the initial policy in V1. A future
override would require an explicit permission, reason, and audit design.

### 3. Recommendations

Recommendations include best send time, opportunity priority, and whether a
cohort should wait. They inform the Admin but do not weaken hard rules.

## External product-practice reference points

Klaviyo's current SMS Smart Sending default is 24 hours. Its February 2026
engagement guidance recommends starting near two to four SMS campaigns per
month, often one to two per week for many brands, then increasing only when
engagement and unsubscribe behavior support it.

Sources:

- [Understanding Smart Sending](https://help.klaviyo.com/hc/en-us/articles/115002779311), updated 6 August 2025
- [Create an engagement-based SMS schedule](https://help.klaviyo.com/hc/en-us/articles/360044556071), updated 10 February 2026

These values are product examples, not law and not proof that Vici recipients
want that frequency.

Klaviyo also applies a conservative maximum of three promotional texts in a
rolling 24-hour period for phone numbers whose area code maps to selected
states. Its article explicitly says it is informational rather than legal
advice.

Source: [State-law frequency limits](https://help.klaviyo.com/hc/en-us/articles/44447515845019), updated 15 January 2026.

Vici must keep direct state-law rules and product Smart Sending separate. State
definitions and exemptions vary, and provider guidance is not statutory text.

## Required recipient ledger

One durable commercial-contact ledger should cover all promotional contacts,
not only Campaign rows. Store:

- tenant and contact ID;
- normalized phone reference;
- campaign, recipient job, flow, and opportunity identifiers;
- promotional or transactional classification;
- campaign type and product or topic;
- provider message ID;
- created, accepted, sent, delivered, failed, and skipped timestamps;
- reply and opt-out events;
- attributed order reference;
- consent and eligibility rule versions;
- jurisdiction and timezone basis;
- skip, defer, or suppression reason.

Frequency evaluation should use actual qualifying sends, with a documented
choice about whether provider-accepted but failed messages consume the product
cap. For V1, count provider-accepted promotional sends toward the contact cap,
because the app attempted contact and retrying through another campaign could
otherwise create pressure. Preserve delivery outcome separately.

## Dry-run scenarios

Run the same historical opportunity stream through:

| Scenario | Monthly promotional cap | Minimum spacing | Purpose |
|---|---:|---:|---|
| Conservative | 2 | 24 hours | Establish the least intrusive eligible cohort |
| Moderate | 4 | 24 hours | Measure incremental reach and overlap |
| Expanded | 6 | 24 hours | Quantify the cost in collisions and fatigue signals, not a default recommendation |

The legal or provider layer can suppress more strictly in every scenario.

For each scenario report:

- unique opportunities;
- unique customers;
- eligible sends;
- suppressed sends by reason;
- deferred sends;
- customers eligible for multiple campaign types;
- exact-product versus generic opportunities;
- historical orders inside relevant windows;
- attributable outcomes where structured evidence supports them;
- opt-outs and negative sentiment following prior commercial contacts;
- delivery failure rate;
- internal or test exclusions;
- unknown consent exclusions.

Do not infer historical promotional eligibility where consent evidence is
missing. The dry run may report the opportunity as commercially relevant while
still reporting zero legally or provider-eligible sends.

## Initial collision priority to validate

This is a product hypothesis for dry run, not a final rule:

1. active payment recovery remains separate transaction-specific logic;
2. exact requested-product back in stock;
3. high-confidence personal reorder due;
4. unresolved commercially relevant one-to-one enquiry;
5. high-confidence win-back;
6. manual exact-product segment;
7. generic promotion.

Suppress or defer lower-priority opportunities when one customer qualifies for
several. Do not merge unrelated reasons into vague copy.

Priority must also account for customer experience. An unresolved complaint,
refund, delivery problem, negative support state, recent opt-out signal, or
product unavailability can close or suppress an otherwise valuable opportunity.

## Detector and campaign cadence

Opportunity detection frequency is not send frequency.

- Back in stock: event-driven from a verified transition, with debounce and
  current-stock confirmation. One opportunity per genuine restock event.
- Reorder: daily evaluation. One opportunity per expected reorder cycle, closed
  when reordered, expired, or contacted.
- Win-back: daily eligibility evaluation with an initially weekly draft cohort
  and a long cooldown after contact or rejection.
- Unconverted enquiry: event-driven candidate creation, preferably one-to-one
  rather than bulk until classification quality is measured.
- Manual: created on demand but subject to the same ledger and collision rules.

Do not create daily duplicate opportunities from a condition that remains true.

## Deferral and expiry

When only product frequency prevents a send, the opportunity may be deferred to
`next_eligible_contact_at` if it will still be useful. Re-evaluate every hard
rule at that time.

Close rather than defer when:

- the customer converted;
- consent or DND changed;
- product is unavailable;
- offer ended;
- supporting intent became stale;
- a higher-priority action resolved the need;
- provider eligibility expired;
- the customer's support state makes promotion inappropriate.

## Recommended V1 decision process

1. Build the ledger and pure policy evaluator.
2. Run all three scenarios without sending.
3. Manually inspect collision and suppression samples.
4. Review actual consent coverage and Telnyx eligibility.
5. Compare opportunity value with opt-out, complaint, negative sentiment, and
   delivery signals.
6. Select one centrally configured Vici default.
7. Release draft-only detection first.
8. Re-run the analysis after enough approved campaign outcomes exist.

No cadence result can override the default-off provider eligibility gate.

## Minimum cadence tests

- rolling 24-hour boundary;
- calendar-month boundary;
- recipient local time and DST transition;
- promotional and transactional separation;
- campaigns and promotional flows share one ledger;
- provider-accepted failure counting rule;
- multiple campaigns competing for one contact;
- exact-product opportunity outranks generic promotion;
- suppression defers only while the opportunity remains useful;
- converted, opted-out, refunded, and complaint-state customers close or
  suppress as configured;
- duplicate event does not create a second opportunity;
- one phone shared by duplicate contacts cannot bypass the cap;
- unknown location uses the documented conservative fallback;
- state rule and product rule report distinct skip reasons;
- large cohorts remain paged and bounded.
