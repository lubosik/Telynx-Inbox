# Historical revenue analysis

Audit snapshot: **20 August 2026**

Status: **independently reviewed and promoted to production on 20 August 2026**

The figures below are the approved historical snapshot. The additive analytics
schema was migrated with row-level security, the reviewed cohort was promoted
idempotently, and production API totals were reconciled against the database
after deployment. Later live events are reported separately from this snapshot.

## Executive result

The existing data supports a narrow historical payment-recovery attribution
set. All other paid orders remain explicitly Unattributed.

- **13 reviewed 100% Direct orders — $2,398.48**
- **62 structurally qualified 90% Strong orders — $11,585.85**
- **75 total exact paid candidates inside 24 hours — $13,984.33**
- **Historical 60% Influenced — $0.00** (deliberately disabled)
- **1,322 of 1,397 eligible paid orders remain Unattributed — $249,297.26 excluded from impact**

These are the persisted historical Analytics totals. An independent read-only
review passed all 13 Direct records, all 62 Strong records on their
structured invariants, ten Strong timing/value extremes, and twelve
Unattributed edge cases. Two verified owner/staff identities and 43 linked local
Woo order IDs were applied as exclusions. Three authoritative Woo records in
this snapshot (two paid, totaling $12.87) were removed from Analytics entirely;
they are not included in activity, revenue, sentiment, denominators or the
Unattributed bucket. The migration, trusted webhook configuration, deployment
checks and controlled promotion all completed. A later live order was
independently classified as Unattributed; it does not change the historical
figures above.

## 1. How far the data goes

The read-only source inventory found:

| Source | Earliest reliable observed record | Snapshot volume |
|---|---:|---:|
| Local order mirror (`sms_orders`) | 17 January 2026 UTC / 16 January business date | 1,608 |
| SMS messages (`sms_messages`) | 29 April 2026 | 2,665 |
| Automation send log (`sms_sent_log`) | 27 May 2026 | 1,357 |
| Call history (`call_logs`) | 11 June 2026 | 133 |
| Authoritative WooCommerce orders | API snapshot | 1,712 |

“All Time” must therefore not imply identical coverage for every metric. The
Analytics API begins on 16 January in the account's `America/New_York`
timezone so the first order observed at 03:06 UTC on 17 January is not lost at
the civil-date boundary. Availability/warning metadata explains missing
pre-source periods.

## 2–4. Reminder and order matching funnel

The audit found:

- 240 provider-accepted payment-recovery reminders after 20 sentinel
  exclusions: 229 delivered, 8 sent/unconfirmed, 2 failed and 1 queued;
- 152 distinct reminder order identifiers;
- 150 numeric identifiers, all found in the WooCommerce snapshot;
- 149 exact order/phone identity matches;
- 75 rigorous paid candidates with a delivered provider message, exact latest
  eligible touch and payment inside 24 hours.

A reminder row or a nearby payment alone is insufficient. Sent/unconfirmed,
failed, queued, post-payment, outside-window, merged, refunded and otherwise
ambiguous evidence remains Unattributed.

## 5. Direct recovery

Thirteen candidates totaling **$2,398.48** passed the strongest historical rule:

1. exact WooCommerce order;
2. exact phone identity;
3. genuine delivered payment reminder;
4. reminder before payment and inside 24 hours;
5. a whole-message canonical customer payment confirmation between reminder
   and payment (not merely a confirmation-looking word at the start of a longer
   ambiguous message);
6. no detected refund in the candidate cohort.

An independent sanitized review passed all 13: each had exact action/order/flow
linkage, non-GHL Telnyx delivery, identity match, unique reply assignment,
action → reply → payment chronology and no refund. Keyword evidence did not
create the match; it only strengthened an already exact structured sequence.

## 6. Strong assistance

The remaining 62 exact candidates total **$11,585.85**. They have authoritative
payment, delivery, identity, order and timing evidence but no explicit customer
confirmation under the strict whole-message rule. All 62 passed structural
review; ten unique timing/value extremes were sampled. They remain `90% Strong`,
not `100% Direct`.

One $106.79 order moved from Unattributed to Strong on the refreshed source
snapshot. Independent review confirmed an exact delivered reminder, order and
phone match, a payment 4.4 minutes later, no refund and no staff/test overlap.
A short inbound financial-completion signal did not satisfy the strict Direct
reply rule, so the more conservative Strong classification was retained.

The 24-hour window is deliberately short for a failed/on-hold payment-recovery
workflow. It is centrally configurable and documented in
`REVENUE-ATTRIBUTION-METHODOLOGY.md`.

## 7. Influenced revenue

Historical Influenced revenue is **$0.00**. Existing ordinary conversations,
calls and order timing cannot reliably prove a reorder, win-back,
back-in-stock, campaign or unconverted-enquiry workflow. Those categories need
explicit event/cohort tracking from their future release onward.

## 8. Cases that cannot fairly be attributed

1,322 of 1,397 eligible paid orders remain Unattributed in the audited snapshot.
Reasons include no recovery reminder, no carrier-delivery proof, mismatched or
missing identity, payment before the reminder, payment outside 24 hours,
merged-order language, duplicate/malformed evidence, or refund controls.
Verified test/internal orders are excluded before cohort calculation rather
than being presented as Unattributed business activity.

There were six refund-bearing WooCommerce orders overall and none in the
candidate cohort. Historical backfill still rejects any refund-bearing order by
rule until refund timing and amount are reviewed.

## 9. Data gaps and limitations

- Historical source start dates differ, so earlier orders cannot be treated as
  fully observed communications journeys.
- The old send log was built for workflow safety, not formal attribution.
- GHL mirror rows may say delivered but do not prove Telnyx/carrier delivery.
- SMS provides no general read receipt.
- The payment timestamp proves when WooCommerce recorded payment, not exclusive
  causality by one communication channel.
- Three reminder/order phone mismatches demonstrate that order ID alone is not
  enough.
- Combined-order messages are not safely divisible into one revenue claim.
- Staff/internal/test exclusions are centrally maintained and must be updated
  whenever another verified internal identity is introduced.
- Historical calls lack workflow-specific revenue intent/evidence.
- Historical campaign/reorder/win-back opportunity events do not exist.

## 10. Tracking added for future accuracy

The new architecture adds:

- trusted, signed and deduplicated Woo order events;
- exact action/order identifiers and conversion timestamps;
- central attribution windows and methodology version;
- explicit Direct/Strong/Influenced/Unattributed score and explanation;
- supporting evidence codes without exposing raw message content to the app;
- gross, refund and net values;
- invalidation plus revision history;
- one current attribution per workspace/order;
- local, versioned inbound sentiment classification;
- an analytics state version/realtime invalidation signal;
- dry-run-first revenue/sentiment backfill tools with dual persistence gates.

The approved production sentiment run examined 723 inbound rows. It removed six
verified staff/internal rows and persisted 662 eligible customer-message
classifications: 5 very negative, 22 negative, 396 neutral, 196 positive and 43
very positive. No raw bodies or phone numbers were emitted. One subsequent live
classification brought the verified production total to 663 without changing
the historical distribution above.

WooCommerce documents the paid timestamp, status, totals and refunds used as the
authoritative financial fields in its [REST order schema](https://woocommerce.github.io/woocommerce-rest-api-docs/#orders). Its [webhook documentation](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/) documents the signed delivery metadata used for future trusted events.

## Promotion record

The controlled promotion completed only after:

1. retaining the completed independent review record for all 13 Direct candidates,
   all Strong structural invariants, 10 Strong samples and 12 Unattributed edges;
2. loading the approved internal/test phone and order exclusions into production;
3. confirming the account timezone and USD currency;
4. retaining approval of the 24-hour recovery rule;
5. taking a scoped pre-deploy snapshot and deploying the additive schema/backend;
6. using the dual `--persist` plus `ANALYTICS_BACKFILL_APPROVED=YES` gate;
7. reconciling production API totals, drill-down counts and database aggregates.

The production check immediately after release showed 13 Direct orders,
62 Strong orders, zero Influenced orders, 1,322 historical Unattributed orders
and one additional live Unattributed order. Staff/test exclusions had no overlap
with the promoted cohort.

Any generated candidate JSON contains internal order/action/evidence IDs even
though it excludes direct PII. It must stay in a private local, untracked review
location and must not be attached to a public issue or committed.
