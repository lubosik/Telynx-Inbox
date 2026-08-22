# Campaign revenue attribution

Status: **deterministic policy, bounded read APIs, global Analytics rollup,
atomic winner reconciliation, and trusted future-order campaign candidate
generation implemented; live campaign sending remains disabled**

Methodology key: `vici-campaign-revenue-v1`

This document extends, and does not replace,
`docs/analytics/REVENUE-ATTRIBUTION-METHODOLOGY.md`. The existing WooCommerce
payment/refund record remains the financial source of truth. Campaign activity
can supply attribution evidence, but it cannot create revenue by itself.

The pure reference implementation is
`lib/campaigns/attribution-policy.js`. It makes no database, network, provider,
or production calls. Its defaults are suitable for controlled dry runs, not an
authorization to send promotional messages.

## Claim boundary

A campaign order is considered only when all of these baseline facts exist:

1. exact matching workspace IDs plus a unique authoritative WooCommerce order
   ID, positive net amount, and paid timestamp;
2. a frozen campaign and recipient ID plus exact provider message ID;
3. a current, cryptographically trusted Telnyx `delivered` event and delivery
   timestamp before payment;
4. an exact recipient/order identity match;
5. a valid centrally configured window for that workflow;
6. no configured staff/test identity, cancellation, full refund, duplicate,
   timestamp contradiction, or other contrary evidence;
7. for a product-specific workflow, an exact Woo product ID match and, when a
   variation was targeted, the exact variation ID.

Provider API acceptance, queue state, `sent`, GHL status, a similar product
name, SKU similarity, or a nearby order is not delivery or conversion proof.
Guest Woo customer ID `0` is never an identity. Guest orders require another
exact identity such as the same normalized phone; conflicting non-zero customer
IDs are always disqualifying even when phone values match.

## Confidence rules

Every candidate ends as Direct, Strong, Influenced, or Unattributed. Unknown or
contradictory evidence fails to Unattributed.

### 100% Direct

All baseline facts must pass, followed by one recipient-bound conversion
signal:

- a trusted, signed first-party campaign link event whose token is bound to the
  exact campaign, recipient, and resulting order;
- a trusted single-use coupon assignment bound to that campaign/recipient,
  assigned no later than delivery, and present on the exact paid order; or
- a trusted deterministic inbound-intent event such as
  `purchase_confirmed`, sequenced after delivery and before payment. An AI
  feeling that a reply "sounds positive" is not enough; the evidence must have
  an explicit rule/version and still be backed by the authoritative order.

For product-specific campaigns, Direct still requires the exact target product
or variation in the order. A click alone is not a sale, and a coupon merely
mentioned in campaign copy is not a recipient-bound coupon assignment.

### 90% Strong

Use Strong only when the exact recipient buys the exact frozen campaign product
or variation inside that workflow's short Strong window after trusted delivery,
with no contradictory evidence. No direct conversion signal is required.

A generic blast with no product target cannot become Strong from timing alone.

### 60% Influenced

Use Influenced when the baseline facts pass but causality is weaker:

- the exact campaign product is purchased after the Strong window but inside
  the wider maximum window; or
- an exact recipient of a non-product campaign purchases inside its maximum
  window without recipient-bound link/coupon/intent proof.

Influenced revenue is separate from Attributed Revenue and Recovered Revenue.
It may appear in Total Revenue Impact only when visibly labelled.

### Unattributed

Use Unattributed for all other outcomes, including:

- accepted/sent but not trusted delivered;
- payment before delivery or after the maximum window;
- missing or conflicting customer identity;
- guest-ID-only matching;
- missing frozen product IDs for a product workflow;
- unrelated product or wrong variation;
- name/SKU-only historical product evidence;
- missing authoritative payment;
- cancelled, failed, fully refunded, duplicate, ambiguous, or contradictory
  orders;
- invalid or missing central attribution configuration.

Unattributed is a data-quality and honesty bucket, not a failure to hide. Its
revenue never enters Revenue Impact.

Configured staff/test identities are removed before campaign candidates and
denominators are persisted. The pure classifier marks them `excluded` so a
caller cannot accidentally turn them into business activity; they should not
inflate the Unattributed order count either.

## Provisional windows

The code contains one explicit default table so a dry run is reproducible. The
production source should be the `analytics_attribution_rules.rules` JSON (or
equivalent versioned central configuration), not scattered constants.

| Workflow | Strong | Maximum |
|---|---:|---:|
| Back in stock | 3 days | 7 days |
| Reorder | 7 days | 14 days |
| Win-back | 3 days | 14 days |
| Manual exact product | 3 days | 7 days |
| Manual / generic | 3 days | 3 days |

These are conservative product defaults to validate on real data, not laws and
not borrowed claims about another vendor's attribution. A malformed override,
including a maximum shorter than its Strong window, fails closed. The window is
measured from trusted carrier delivery to authoritative payment in UTC;
business timezone is used only for display/range boundaries.

## One order, one winner

`chooseAttributionWinner()` accepts candidates for exactly one order and picks
one reproducible winner in this order:

1. higher classification: Direct, then Strong, then Influenced;
2. stronger structured evidence: exact payment reminder plus confirmation,
   unique recipient coupon, recipient/order-bound link, deterministic purchase
   confirmation, exact payment reminder, then exact product timing;
3. transaction-specific payment recovery, then campaign, then call, then
   ordinary conversation when the prior evidence is otherwise equal;
4. shorter delivery/action-to-payment interval;
5. later qualifying action;
6. stable action-ID tie-break.

Invalidated and zero-net candidates cannot win. This means, for example, that a
Direct campaign link may beat a merely Strong payment reminder, while an exact
Direct payment-recovery confirmation wins a same-confidence collision. The
losing touches remain evidence in the audit trail but contribute zero revenue.

The database's existing unique `(workspace_id, order_id)` constraint remains
the final published-winner guard. `scripts/attribution-reconciliation-migration.sql`
adds an evidence-candidate ledger and an authoritative per-order financial
state. Its service-role-only RPC obtains a transaction-scoped lock for the
exact workspace/order, rejects stale financial and candidate observations,
re-evaluates every payment/campaign/call/conversation candidate, then publishes
one winner. Independent last-writer-wins upserts are no longer used by the live
Woo payment-recovery path.

The migration seeds both tables from existing published winners before the RPC
is used, so the first webhook retry cannot discard a pre-migration winner. The
losing candidates remain in the ledger for audit and deterministic future
recomputation. Partial/full refunds and cancellation update the shared order
state, so they affect whichever evidence source wins rather than only the
candidate that happened to process the refund.

The winner function rejects a mixed-workspace candidate set. Production reads
must also filter the authenticated actor's workspace before candidates reach
the policy layer; this check is defence in depth, not a substitute for tenant
authorization.

## Refunds, cancellation, correction, and downgrade

Partial refunds reduce net attributed revenue but retain the evidence-based
confidence. Full refund, cancellation, failed status, or zero remaining net
revenue invalidates the current revenue claim. The prior confidence remains in
revision history; its effective current classification is Unattributed and it
is excluded from aggregates.

Later identity corrections, duplicate resolution, proof that payment preceded
the action, or stronger competing evidence must trigger a complete winner
recalculation. The existing `revenue_attribution_history` trigger preserves the
prior row and change reason. Never delete the uncomfortable earlier result or
silently preserve a larger number.

## Campaign metric definitions

Detailed operational performance belongs in Campaigns; cross-workflow revenue
rollup belongs in Analytics.

| Metric | Definition |
|---|---|
| Recipients | Unique selected recipients in the approved frozen revision |
| Queued | Pending, deferred, claimed, or sending recipient jobs |
| Provider accepted | Provider submission accepted; explicitly **not** delivery |
| Delivered | Unique recipients with a trusted final Telnyx delivery event |
| Failed | Unique recipients with a terminal failed state |
| Skipped | Send-time suppressed recipients; show suppression reasons |
| Replies | Unique recipients with a trusted inbound reply after the campaign action |
| Opt-outs | Unique recipients with a trusted post-action revocation event |
| Revenue Impact Orders | Unique orders whose global winner is this campaign at Direct, Strong, or Influenced |
| Attributed Orders | Direct + Strong winning orders only |
| Influenced Orders | Influenced winning orders only, shown separately |
| Attributed Revenue | Net Direct + net Strong revenue |
| Influenced Revenue | Net Influenced revenue, separate from Attributed Revenue |
| Total Revenue Impact | Direct + Strong + Influenced, visibly split by confidence |
| Conversion rate | Unique converted recipients divided by trusted delivered recipients; `null`, not zero, when no trusted delivery denominator exists |

Money is accumulated in integer cents, orders and recipients are deduplicated,
partial refunds use current net value, and invalidated orders are excluded. The
pure `summariseCampaignPerformance()` function first selects the global winner
for each order, then counts revenue only when that winner belongs to the exact
requested campaign. This prevents a Campaign detail screen from taking credit
for a payment-recovery or another campaign's order.

## Persistence and rollout

The existing Analytics schema holds the published classification, and the
additive `scripts/campaigns-migration.sql` declares the indexed campaign links
needed by production drill-down. Apply and verify migrations in this order:

1. `scripts/analytics-migration.sql`;
2. `scripts/campaigns-migration.sql`;
3. `scripts/attribution-reconciliation-migration.sql`.
4. `scripts/campaign-attribution-policy-migration.sql`.

The reconciliation migration does not infer historical campaign attribution
and neither migration enables sends. The policy migration installs versioned,
tenant-scoped conservative windows. Its Direct evidence allowlist is empty by
default because no signed link, unique-coupon, or deterministic intent ledger
is active.

`lib/campaigns/attribution-generator.js` is called only after a trusted Woo
paid/refund/cancel event has been stored. It pages exact-phone campaign
recipients, checks the approved frozen revision, reads canonical signed Telnyx
`provider.delivered` events, requires the exact provider message identity, and
uses exact frozen product/variation identifiers. Each classified result,
including Unattributed, is staged through the global reconciliation RPC. It
never writes `revenue_attributions` directly.

The persistence contract is:

- use its nullable indexed `campaign_id` and `campaign_recipient_id` references
  on `revenue_attributions`; the read path treats these as authoritative and
  uses exact action-ID matching only for compatible older rows;
- store the campaign attribution rule/version and frozen target product and
  variation IDs with the approved revision;
- preserve Woo `product_id` and `variation_id` in new `sms_orders.items` rows;
  historical name/SKU-only rows remain lower-quality and cannot be called exact;
- retain trusted final delivery in the recipient event ledger with provider
  event ID, provider message ID, occurred time, received time, signature result,
  and deduplication key;
- include normalized authoritative Woo line-item IDs, coupons, paid timestamp,
  refund values, status, and order/customer identity in the trusted order-event
  evidence used by reconciliation;
- if first-party links are introduced, use signed, expiring recipient tokens and
  an allowlist of owned destinations. Never create an open redirect. Store a
  minimal click ledger and only call it order-bound when checkout/order metadata
  securely carries the same token;
- if coupons are used for Direct evidence, persist an immutable campaign/
  recipient assignment. A broadly shared campaign coupon may support reporting
  but is not recipient-bound Direct evidence;
- retain every losing candidate or a compact winner-decision record so a client
  can see why another workflow won.

`sms_campaign_recipients.delivered_at` alone is never attribution evidence. The
generator independently requires the immutable canonical Telnyx delivery event
with `trusted=true`, a provider event ID, and `telnyx_ed25519_v2` trust source.
Legacy product names and SKUs cannot qualify as exact product evidence.

## Event and API design

The intended non-blocking flow is:

```text
verified Telnyx final delivery -> recipient event ledger
                                        |
verified Woo paid/refund event -> collect eligible touches for exact order
                                        |
                              classify every candidate
                                        |
                              choose one global winner
                                        |
                 upsert revenue_attributions + revision history
                                        |
                       bump analytics/campaign invalidation state
```

Messaging, Woo order handling, and payment recovery must stay operational if an
analytics write fails. Reconciliation is idempotent by trusted provider event
ID and Woo delivery/order event identity.

Implemented read surfaces:

- `GET /api/campaigns/:id/performance` under `campaigns.read`: operational
  audience, queue, delivered, reply, failure, skip, and opt-out counts without
  financial details;
- `GET /api/analytics/campaigns/:id` under `analytics.read`: Direct, Strong,
  Influenced, refunds, net values, and confidence splits;
- `GET /api/analytics/campaigns/:id/attributions` under `analytics.read`: paged
  order-level evidence with safe reason codes, never raw private message bodies.

This split preserves the current RBAC rule that Support Agents do not hold
`analytics.read`. Every endpoint still requires the normal authenticated actor,
workspace boundary, default-deny route policy, paging, and minimised DTOs.
The campaign performance route is intentionally operational-only because
Support Agents may hold `campaigns.read`; revenue is company-sensitive and is
available only from the two `analytics.read` routes. Campaign attribution reads
do not select phone/name/message-body fields, and their response omits customer
and recipient identifiers. It exposes the order/action reference and an
allowlist of non-content evidence codes so a permitted owner can audit the
claim without receiving raw message content through Analytics.

The global Analytics overview also includes a `revenueDrivers` rollup derived
only from existing winning `revenue_attributions` rows. It separates payment
recovery, generic campaigns, reorder, back-in-stock, and win-back categories;
unknown categories are omitted instead of being forced into a flattering
bucket. Direct + Strong, Influenced, gross, refunds, and order counts remain
separate.

If either the campaign or Analytics additive migration is missing, these reads
return an explicit not-ready response instead of plausible-looking zeroes.

## Required integration tests before enabling campaign delivery

- paid order before delivery, exact order after delivery, unrelated product,
  wrong variation, outside each window, and missing product IDs;
- provider accepted/sent versus trusted final delivered;
- customer-ID conflict, phone fallback, and guest customer ID zero;
- valid and forged/stale/duplicate link, coupon, Telnyx, and Woo events;
- duplicate Woo deliveries and multiple orders per recipient;
- multiple campaigns plus payment reminder and call touching one order;
- partial/full refund, cancellation, later correction, downgrade, and revision
  history;
- staff/test exclusions;
- more than 1,000 recipients/orders with bounded paging and chunking;
- campaign operational metrics versus revenue metrics and permission denial;
- realtime invalidation without full-dashboard polling.

No historical campaign revenue should be persisted until candidate samples are
reviewed. Historical records lacking exact product/variation IDs, trusted
delivery, or recipient-bound conversion signals must remain Unattributed.

## Primary technical references

- [WooCommerce REST API v3 orders](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/) documents authoritative paid dates, status, totals, customer IDs, line items, coupons, and refunds.
- [WooCommerce REST API v3 webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/) documents signed webhook delivery and delivery identifiers used for trust and deduplication.
- [Telnyx receiving messaging webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks) documents signed messaging events and distinct delivery lifecycle outcomes.
- [Klaviyo message attribution](https://help.klaviyo.com/hc/en-us/articles/1260804504250) is a vendor example showing why attribution windows and channel events must be defined explicitly; Vici does not copy its defaults.
- [Shopify marketing attribution models](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/marketing-reports) illustrates why different attribution models produce different claims and should be disclosed.
