# Campaign segmentation methodology

Status: deterministic detector rules implemented for offline evaluation on 22 August 2026. They are not wired to production jobs and cannot send messages.

## Purpose

Campaign detection answers whether there is a current, evidence-backed reason to contact a particular customer. It does not establish permission to send. Consent, provider eligibility, revocation, DND, quiet hours, legal rules, product frequency, Admin approval, and the live-send switches remain independent gates.

The first implementation is deliberately conservative. Missing data produces no sendable opportunity. It does not fill gaps with a model-generated guess.

## Back in stock

`lib/campaigns/back-in-stock.js` qualifies a restock only when all of these facts are present:

1. the WooCommerce event and stored previous snapshot are explicitly marked trusted;
2. an official or compatibility delivery identifier exists and has not already been processed;
3. the exact product and variation identity is consistent across the previous, observed, and authoritative snapshots;
4. the previous state was definitely unavailable;
5. the event state was definitely available;
6. an explicitly trusted, authenticated WooCommerce re-fetch still reports it available after the configured debounce;
7. no opportunity for the same restock event is already open.

`product.updated` by itself is never enough. Price, image, title, or metadata edits while an item remains in stock do not qualify. Managed stock with a missing or non-positive quantity does not qualify. A variation cannot inherit a parent-product transition without exact variation evidence.

The returned transition key combines product, variation, and delivery IDs so a retry cannot create the same candidate twice. Persisted orchestration must also enforce a unique database key because a pure function cannot provide concurrency control.

## Reorder cadence

`lib/campaigns/reorder-cadence.js` uses authoritative, non-cancelled, non-failed, non-fully-refunded purchase timestamps for the exact product or variation. Duplicate timestamps are removed.

The sequence is:

1. calculate the days between qualifying purchases;
2. require at least three valid personal intervals, which normally means at least four purchases;
3. use the median interval rather than the average;
4. measure variability with median absolute deviation (MAD) divided by the median;
5. reject the cadence when relative MAD exceeds 0.40;
6. classify a stable cadence as high or moderate confidence;
7. create an expected range around the median using scaled MAD, with a minimum three-day uncertainty band.

A personal cadence is preferred. Product-level cadence is considered only when the customer has too few personal intervals, and only with at least 20 aggregate intervals across at least 10 distinct customers and the same variability check. A customer's sufficiently large but inconsistent history is negative evidence and is not overwritten by a cleaner aggregate product pattern. These thresholds are configurable inputs, not scattered constants.

If neither source is reliable, the result is `no_reliable_cadence`. The system must not display a guessed 30-day reorder window. One cycle key is derived from the last purchase and cadence, so a condition that remains true cannot create a new opportunity every day. A product that is unavailable or a cycle already contacted is suppressed.

## Win-back

`lib/campaigns/winback.js` does not use a fixed "no order in 30 days" rule. A customer must have:

- a reliable cadence;
- at least three lifetime qualifying purchases by default;
- no order until the later of 60 days or 1.75 times their normal interval;
- no existing open win-back opportunity;
- no unresolved complaint, open refund, or recent negative support state;
- an available relevant product;
- no win-back contact or rejected win-back inside the default 180-day cooldown.

The detector may run daily, but cohort assembly should initially run weekly. A qualifying candidate expires after 30 days and must be re-evaluated against current order and customer state before inclusion.

## Collision priority

`lib/campaigns/opportunity-policy.js` gives every supported promotional opportunity a fixed base priority:

1. exact product requested by the customer is back in stock;
2. repeat buyer's exact product is back in stock;
3. exact product back in stock;
4. high-confidence personal reorder;
5. other reliable personal or product reorder;
6. commercially relevant one-to-one enquiry;
7. qualified win-back;
8. manually selected exact-product segment;
9. other manual campaign;
10. generic promotion.

Active payment recovery is transaction-specific and should remain outside the promotional collision list. The orchestrator should suppress promotional contact while an active payment-recovery interaction is unresolved.

Within the same type, ties are broken in this exact order:

1. higher structured intent score;
2. higher exact-product relevance score;
3. higher cadence confidence score;
4. sooner expiry;
5. older detection time;
6. lexical opportunity ID.

This order makes the result reproducible across workers. Scores must be produced by documented structured rules. A language model must not invent an arbitrary priority.

Lower-priority collisions are recorded as `lower_priority_collision`. If frequency is the only blocker and the opportunity will remain useful, the orchestrator may defer it to `next_eligible_contact_at`. It must re-run all hard rules then.

## Expiry and closure

Each opportunity needs an explicit expiry or a known type with a bounded default. Unknown types without an expiry fail closed.

Current detector defaults are:

| Opportunity | Default lifetime |
|---|---:|
| Back in stock | 7 days |
| Unconverted enquiry | 7 days |
| Reorder | 21 days |
| Win-back | 30 days |
| Manual exact-product | 14 days |
| Manual | 14 days |
| Generic promotion | 7 days |

An opportunity closes earlier when the customer converts, the offer ends, consent is revoked, DND changes under the configured policy, or the customer enters a support/refund state that makes promotion inappropriate. Product-specific restock and reorder opportunities close when the product becomes unavailable.

## Evidence and storage boundary

The pure modules return reason codes and timestamps. A production detector must persist:

- workspace, contact, product, and variation IDs;
- source event and deduplication key;
- calculation/rule version;
- machine-readable inclusion evidence;
- detected and expiry times;
- cycle/restock identity;
- closure, suppression, or conversion reason.

No raw customer message body belongs in the campaign audit log. An unconverted-enquiry classifier remains out of scope until its accuracy is measured against a private, labelled sample through the existing OpenRouter privacy boundary.

## Known limitations before wiring

- Historical `sms_orders.items` may not retain WooCommerce product and variation IDs. Name or SKU matching alone is weaker and must not be silently treated as exact-product evidence.
- The product-level cadence thresholds have not yet been calibrated against the approved Vici historical dry run.
- Consent coverage and Telnyx eligibility remain unknown. A useful segment can still have zero send-eligible recipients.
- These functions do not read Supabase, claim jobs, schedule work, or send SMS. Persistence and concurrency belong in the campaign service and SQL queue.
