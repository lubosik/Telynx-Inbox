# Campaign Cadence Dry Run

> Historical snapshot: the aggregate table below is the last authorised live
> read from 22 August 2026. The analyser has since been hardened to include
> current HighLevel DND freshness, authoritative campaign suppressions and the
> deduplicated commercial-contact ledger for each 2/4/6 scenario. It has not
> been rerun against external data during the repository-only completion pass,
> so these counts must not be presented as a current launch audience.

Generated on 22 August 2026 from the live Vici operational dataset using the read-only `scripts/dry-run-campaign-cadence.js` analyser. The script made no database changes, created no campaigns, and emitted no customer names, phone numbers, email addresses, order IDs, product names, or message content.

## Result

| Measure | Aggregate result |
| --- | ---: |
| Paid orders analysed | 1,281 |
| Customer-product histories | 1,975 |
| Reliable personal cadence histories | 9 |
| Reliable product-level cadence histories | 166 |
| Customers with one selected opportunity | 44 |
| Reorder opportunities | 40 |
| Win-back opportunities | 4 |
| Lower-priority collisions suppressed | 1 |
| Eligible promotional sends today | 0 |

The 44 opportunities are useful candidates for future review, but none is currently eligible for a promotional SMS. The production database does not yet contain the evidenced promotional-consent ledger required by the campaign safety model. Consent is not inferred from an order, a phone number, an existing contact, or prior transactional messaging.

## Frequency scenarios

The previous two, four, and six messages-per-month scenarios all produced the same safe result: 44 identified opportunities, zero allowed sends, and 44 consent suppressions. This is not evidence that frequency makes no difference. On the next authorised read-only run, each scenario will independently apply the rolling monthly cap after current consent, STOP, DND, authoritative suppression, 24-hour spacing, and 7-day cap checks. Historical data still cannot support a truthful fatigue, reply-rate, opt-out-rate, or revenue comparison unless the underlying outcomes exist.

The first-release default remains conservative: at least 24 hours between promotional contacts, no more than two in seven days, and no more than four in 30 days across all workflows. These are safety defaults, not a claim of an experimentally optimal cadence. They must be monitored and can be tightened centrally.

## Data quality findings

- None of the historical order line-item observations contains the newly preserved WooCommerce product or variation IDs yet. The dry run used 1,912 SKU observations and 415 legacy normalized-name observations.
- Product and variation IDs are now retained for newly synchronized orders, improving exact-product matching from this release onward.
- Historical order creation time was used because the operational `sms_orders` table does not store an authoritative paid timestamp.
- Back-in-stock candidates were deliberately not reconstructed. They require a future, verified unavailable-to-available inventory transition after debounce and authoritative WooCommerce refetch.
- One lower-priority opportunity was removed by the deterministic collision policy, leaving no more than one selected opportunity per customer.
- Existing opt-out sentinel data was available. The absence of a positive promotional consent record was independently sufficient to suppress every candidate.

## Safe interpretation

This analysis shows that the available purchase history can support a useful, narrow first cohort once consent evidence is onboarded. It does not authorize sending to those customers and it does not claim expected revenue. Before any launch, an Admin must review a frozen audience and exact message, an Admin must separately approve that revision, each recipient must pass live consent/opt-out/quiet-hours/frequency checks, provider approval must be recorded, and the server environment kill switch must be enabled deliberately.

## Reproduction

Run `node scripts/dry-run-campaign-cadence.js` from the repository with read-only access to the existing Supabase project. Results vary with current order and consent state. The output is aggregate-only by design.
