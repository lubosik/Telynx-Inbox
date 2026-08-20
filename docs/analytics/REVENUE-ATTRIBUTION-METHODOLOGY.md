# Revenue attribution methodology

Status: **version 1, conservative rollout**

Methodology key: `vici-revenue-v1`

Business timezone: `America/New_York` (stored centrally and changeable)

## The claim this dashboard makes

Vici Inbox reports only revenue that can be connected to an authoritative
WooCommerce payment and a qualifying communication. A message saying “paid” is
supporting evidence; it is not proof of payment. WooCommerce's payment timestamp,
status, order ID and refund records are the financial source of truth.

The headline terminology is deliberately precise:

- **Recovered Revenue**: payment-recovery orders with the best available causal
  evidence. It may include Direct and eligible Strong events, shown separately.
- **Attributed Revenue**: Direct plus Strong revenue. It is not presented as a
  controlled proof that no other channel contributed.
- **Influenced Revenue**: a lower-confidence contribution from a future,
  explicitly tracked workflow. It is always separate from Recovered Revenue.
- **Total Revenue Impact**: Direct + Strong + Influenced, visibly broken down so
  it cannot be mistaken for fully causal revenue.
- **Unattributed**: the mandatory default when eligible business revenue has
  incomplete, contradictory, ambiguous or out-of-window evidence. Verified
  staff/internal/test activity is excluded before aggregation rather than
  presented as business activity in this bucket.

Weighted value (Direct × 1.00 + Strong × 0.90 + Influenced × 0.60) is retained
for internal analysis only. It is not the primary owner-facing revenue metric.

## Confidence rules

Every paid order has exactly one classification. No order is forced into an
attributed bucket.

### 100% Direct (`direct`, `1.00`)

All of these must be true for historical payment recovery:

1. WooCommerce contains one authoritative paid order with a valid payment time
   and positive value.
2. A genuine payment-recovery automation log identifies that exact order.
3. The provider message ID is present in `sms_messages` with carrier status
   `delivered`; a GHL-imported “delivered” status is not sufficient carrier
   evidence. For events received after this release, that delivery and any
   confirmation reply must also have a trusted `analytics_message_events`
   record created from a fresh Telnyx v2 Ed25519 signature. Unsigned, stale or
   legacy-only callbacks may continue through the existing operational
   compatibility path but cannot create or strengthen a revenue claim.
4. Normalised reminder and order phone numbers match.
5. The latest eligible reminder preceded payment by no more than 24 hours.
6. Between that reminder and payment, the customer sent a narrowly recognised,
   whole-message payment confirmation such as “sent” or “I've paid.” A matching
   prefix followed by unrelated or ambiguous context does not qualify.
7. There is no merged-order wording, duplicate order, refund, cancellation,
   identity mismatch, contrary timestamp evidence, or configured staff/test
   exclusion.

The reply does not create attribution by itself. It upgrades an otherwise exact,
authoritatively paid match from Strong to Direct.

### 90% Strong (`strong`, `0.90`)

Rules 1–5 and 7 above must be true, but no explicit confirmation is available.
The exact order becoming paid shortly after its exact delivered reminder is
strong circumstantial evidence. This can be included in Attributed Revenue and,
for the payment-recovery workflow, Recovered Revenue; the UI still labels it
`90% Strong` separately.

### 60% Influenced (`influenced`, `0.60`)

Historical Influenced attribution is disabled in version 1. A nearby purchase
after an ordinary conversation is not enough.

Future campaign, reorder, back-in-stock and win-back events may qualify only
when the system has an explicit workflow/action ID, eligible recipient record,
relevant order match, configured window, consent/eligibility evidence and a
deterministic one-order/one-action winner. Those rules require their own sampled
validation before being enabled.

### Unattributed (`unattributed`, `0.00`)

Use this for everything else, including:

- no qualifying delivered reminder;
- customer or phone mismatch;
- non-numeric/missing or duplicate order ID;
- payment before the communication (“prepaid”);
- payment outside the configured window;
- merged or combined-order wording that prevents a one-order claim;
- a reminder sentinel produced by an old `BACKFILL ...` skip record;
- historical refund-bearing orders pending reconciliation;
- a statement of payment without authoritative payment data;
- weak timing or ordinary conversation evidence.

Unattributed orders remain available as a completeness/data-quality measure;
their value is not added to Revenue Impact.

Configured staff/internal/test phones and order IDs are excluded from all
Analytics sources, denominators, activity counts, sentiment, attribution rows
and drill-downs. They are not silently relabelled as Unattributed. The exclusion
list is operational configuration and must be reviewed when staff or test
identities change.

## Attribution window and winner

The payment-recovery Strong and maximum windows are both **24 hours** in version
1. They live in `analytics_attribution_rules`, not scattered through code.
The window is measured from the latest qualifying delivered reminder before the
authoritative payment timestamp.

This is intentionally narrower than general-purpose SMS marketing windows.
For context, Klaviyo documents configurable, channel-specific windows and warns
that platforms define attribution differently; its current defaults distinguish
SMS delivery, open and click windows. Google Analytics likewise defines the
lookback window as the period in which a touchpoint remains eligible for credit.
Those conventions support having an explicit window, not copying a vendor's
default. Vici's 24-hour rule is tailored to short-lived outstanding-payment
recovery and must be validated against real samples before production claims.

If several reminders touched one order, only the latest qualifying reminder can
win. One short customer confirmation can strengthen only the exact order on the
latest delivered recovery touch preceding it; it cannot upgrade several
overlapping orders. SMS and a call cannot each claim the same order. The
database enforces one current row per `(workspace_id, order_id)`.

## Refunds, cancellations and later corrections

Live attribution stores gross, refunded and net values. A verified refund or
cancellation causes the order to be reconciled, and a fully refunded attribution
can be invalidated. A revision trigger saves the previous row in
`revenue_attribution_history` before an attribution changes.

Historical version 1 is stricter: any refund-bearing candidate is Unattributed
until refund timing and amount have been manually reconciled. This avoids
claiming gross recovered revenue while the backfill is under review.

Later evidence may invalidate or downgrade any attribution. The audit history
must retain what changed, when and why; correcting revenue is preferable to
preserving an impressive number.

## Historical backfill protocol

`scripts/backfill-analytics.js` is read-only by default. It joins:

1. genuine payment-reminder rows;
2. their exact Telnyx provider messages and delivery status;
3. the exact WooCommerce order;
4. normalised order/reminder phone identity;
5. authoritative payment/refund timestamps;
6. optional customer confirmation between the last reminder and payment.

It creates one candidate per paid order and never emits raw customer names,
emails, phone numbers, addresses or message bodies. `--candidate-json` and
`--report` should point to a private review location outside the repository.

The safe process is:

1. Run the default dry run and generate aggregate/candidate review files.
2. Manually review every Direct candidate plus representative Strong and
   Unattributed samples
   against WooCommerce and the conversation.
3. Resolve mismatches, duplicates, staff/test exclusions and refund cases.
4. Record approval outside the repository.
5. Only then run with both `--persist` and
   `ANALYTICS_BACKFILL_APPROVED=YES`.

Possessing either gate alone cannot write historical results. Persistence first
stages the entire run as `rule_accepted`, then one protected database function
promotes it atomically. Existing live attribution rows win conflicts and are
never overwritten by the historical snapshot. A failed promotion leaves no
partial revenue cohort. **Do not persist before the production backup,
migration, backend smoke check and explicit approval.**

## Limitations

- SMS/MMS does not provide a universal “read” signal. `delivered` means the
  provider/carrier reports delivery, not that the customer read the message.
  Telnyx documents the delivery status events carried by its
  [messaging webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks).
- A close payment timestamp supports attribution but cannot prove the customer
  saw only this channel.
- Historical records predate the new trusted event ledger and have weaker
  observability than events tracked from this release onward.
- GHL mirror status cannot substitute for Telnyx delivery evidence.
- Historical ordinary conversations, calls and campaigns are not assigned
  revenue without workflow-specific structured evidence.
- The confidence percentages are rule labels, not model-generated probabilities.

## External reference points

- [WooCommerce REST API order fields](https://woocommerce.github.io/woocommerce-rest-api-docs/#orders) documents order status, `date_paid_gmt`, totals and refunds used as authoritative commerce evidence.
- [WooCommerce webhook documentation](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/) documents HMAC-SHA256 signatures and delivery IDs used to authenticate and deduplicate live events.
- [Klaviyo message attribution](https://help.klaviyo.com/hc/en-us/articles/1260804504250) documents distinct attribution windows and explicitly notes that vendors define attribution differently.
- [Google Analytics lookback windows](https://support.google.com/analytics/answer/16291704?hl=en) explains that only touchpoints inside a selected conversion window are eligible for credit.
- [Shopify marketing attribution models](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/marketing-reports) illustrates why last-click, first-click and multi-touch claims differ and why terminology must be disclosed.
