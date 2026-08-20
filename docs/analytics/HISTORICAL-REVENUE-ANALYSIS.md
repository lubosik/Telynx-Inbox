# Historical revenue analysis

Audit snapshot: **20 August 2026**

Status: **read-only discovery and independent sample review; not persisted**

No analytics schema migration or historical revenue/sentiment backfill had been
applied when this report was written. The figures below are local read-only
analysis, not database rows and not production dashboard claims.

## Executive result

The existing data supports a narrow historical payment-recovery candidate set,
but it does not yet support publishing a final historical revenue claim.

- **13 reviewed 100% Direct candidates — $2,398.48**
- **61 structurally qualified 90% Strong candidates — $11,479.06**
- **74 total exact paid candidates inside 24 hours — $13,877.54**
- **Historical 60% Influenced — $0.00** (deliberately disabled)
- **1,325 of 1,399 paid orders remain Unattributed — $249,416.92 excluded from impact**

These are reviewed candidates, not persisted Analytics totals. An independent
read-only review passed all 13 Direct records, all 61 Strong records on their
structured invariants, ten Strong timing/value extremes, and twelve
Unattributed edge cases. The production promotion gate remains closed until the
business exclusion list, timezone/rule settings, database backup and deployment
sequence are explicitly approved.

## 1. How far the data goes

The read-only source inventory found:

| Source | Earliest reliable observed record | Snapshot volume |
|---|---:|---:|
| Local order mirror (`sms_orders`) | 17 January 2026 | 1,607 |
| SMS messages (`sms_messages`) | 29 April 2026 | 2,661 |
| Automation send log (`sms_sent_log`) | 27 May 2026 | 1,355 |
| Call history (`call_logs`) | 11 June 2026 | 133 |
| Authoritative WooCommerce orders | API snapshot | 1,712 |

“All Time” must therefore not imply identical coverage for every metric. The
Analytics API uses the earliest reliable application date for its range, while
availability/warning metadata explains missing pre-source periods.

## 2–4. Reminder and order matching funnel

The audit found:

- 240 provider-accepted payment-recovery reminders after 20 sentinel
  exclusions: 229 delivered, 8 sent/unconfirmed, 2 failed and 1 queued;
- 152 distinct reminder order identifiers;
- 150 numeric identifiers, all found in the WooCommerce snapshot;
- 149 exact order/phone identity matches;
- 74 rigorous paid candidates with a delivered provider message, exact latest
  eligible touch and payment inside 24 hours.

A reminder row or a nearby payment alone is insufficient. Sent/unconfirmed,
failed, queued, post-payment, outside-window, merged, refunded and otherwise
ambiguous evidence remains Unattributed.

## 5. Plausible Direct recovery

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

## 6. Provisional Strong assistance

The remaining 61 exact candidates total **$11,479.06**. They have authoritative
payment, delivery, identity, order and timing evidence but no explicit customer
confirmation under the strict whole-message rule. All 61 passed structural
review; ten unique timing/value extremes were sampled. They remain `90% Strong`,
not `100% Direct`.

The 24-hour window is deliberately short for a failed/on-hold payment-recovery
workflow. It is centrally configurable and documented in
`REVENUE-ATTRIBUTION-METHODOLOGY.md`.

## 7. Influenced revenue

Historical Influenced revenue is **$0.00**. Existing ordinary conversations,
calls and order timing cannot reliably prove a reorder, win-back,
back-in-stock, campaign or unconverted-enquiry workflow. Those categories need
explicit event/cohort tracking from their future release onward.

## 8. Cases that cannot fairly be attributed

1,325 of 1,399 paid orders remain Unattributed in the audited snapshot.
Reasons include no recovery reminder, no carrier-delivery proof, mismatched or
missing identity, payment before the reminder, payment outside 24 hours,
merged-order language, duplicate/malformed evidence, or test/internal/refund
controls.

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
- Staff/internal/test exclusions require a complete centrally maintained list.
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

A separate aggregate-only sentiment dry run examined 721 inbound rows: 665 were
eligible for the versioned local classifier, 16 reply/reaction audit rows, 39
empty/media-only or tapback rows, and one ambiguous mixed-sentiment row were
excluded. The aggregate result was not persisted. No raw bodies or phone
numbers were emitted. The configured internal/test exclusion list was empty in
that run and must be completed before any sentiment persistence.

WooCommerce documents the paid timestamp, status, totals and refunds used as the
authoritative financial fields in its [REST order schema](https://woocommerce.github.io/woocommerce-rest-api-docs/#orders). Its [webhook documentation](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/) documents the signed delivery metadata used for future trusted events.

## Review decision required before persistence

Do not run persistence yet. The next review must:

1. retain the completed independent review record for all 13 Direct candidates,
   all Strong structural invariants, 10 Strong samples and 12 Unattributed edges;
2. confirm the complete internal/test phone and order exclusion lists;
3. confirm the account timezone and currency;
4. approve or adjust the 24-hour recovery rule;
5. back up the production database and deploy the reviewed schema/backend commit;
6. record explicit approval before using `--persist` plus
   `ANALYTICS_BACKFILL_APPROVED=YES`.

Any generated candidate JSON contains internal order/action/evidence IDs even
though it excludes direct PII. It must stay in a private local, untracked review
location and must not be attached to a public issue or committed.
