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

## Product identity

Everything above depends on knowing which product a historical line item was, and for most of the Vici history the line item does not say. `sms_orders.items` rows written by the older sync are `{sku, name, total, quantity}`: 2,334 of 2,343 paid line items carry no WooCommerce product or variation ID at all. The original rule read those IDs and accepted nothing else, so it identified 12 items, every detector saw an empty world, and every automatic segment was empty. That was read as a consent problem. It was not: consent gates sending and sits downstream of segmentation.

`lib/campaigns/product-identity.js` resolves a line item against the live catalogue. Every rule is an equality test, tried in this order:

1. `order_item_ids` — the line item already carries Woo identifiers;
2. `catalogue_sku` — the SKU equals exactly one catalogue SKU;
3. `catalogue_name` — the base name equals exactly one catalogue product name;
4. `curated_alias` — the base name is in the reviewed alias table in that file;
5. `component_set` — the canonical molecule set equals exactly one product's.

There is no prefix match, no substring containment, no edit distance, no closest match and no model. A key that two different parent products could claim is recorded as ambiguous and thereafter resolves to nothing. A SKU and a name that disagree about the parent resolve to neither. A wrong identity produces a wrong cadence, and a wrong cadence eventually produces a message to a real person at the wrong moment, so refusing is structural rather than a matter of care.

Unresolved items are counted, never absorbed. `sourceCoverage.productIdentity` reports the resolution method histogram, the unresolved reasons and the notes on partially resolved items, and `nonExactOrderItems` remains as the unresolved total.

### Dose variants are one product for cadence and two for stock

A resolution carries a parent `productID` and an exact `variationID`.

Cadence groups on the PARENT. "Retatrutide - 10mg" and "Retatrutide - 30mg" are the same molecule in a different vial, and customers titrate between them: the live history has the same people across RT10, RT20 and RT30. Splitting the series by vial leaves each customer with two or three purchases of each dose, below the three-interval floor above, so no cadence is ever reliable and the answer is zero forever. Grouping on the parent answers the question the detector is actually asking, which is how often this person comes back for this molecule.

Availability stays on the VARIATION. "Your BPC-157 is back" is a factual claim about one vial size. Stock is read for the exact variation the customer bought most recently and falls back to the parent record only when no variation-level record exists. That fallback direction matters: WooCommerce reports a variable parent as out of stock while a published, purchasable variation of it still has quantity, which is currently true of BPC-157, BPC-157 + TB-500, GHK-Cu + BPC-157 + TB-500 and Ipamorelin. Preferring the parent there would suppress every one of their buyers.

A cadence identity that spans doses also widens the contact ledger check to the parent. A reorder message already sent about the 10mg vial suppresses a second one about the 30mg vial of the same molecule. Widening can only suppress more contact, never cause more.

### Combination products are one identity and are never decomposed

"GHK-Cu + BPC-157 + TB-500" (BBG70) and "GHK-Cu + BPC-157 + TB-500 + KPV" (KLOW80) are separate catalogue products with separate stock and separate prices, and both appear in the live order history. A customer who buys the KLOW combo and later buys BPC-157 alone has bought two different things. You cannot fulfil a BPC-157 reorder from a KLOW purchase, the amounts are not comparable, and a cadence built by pooling them would fire at a time supported by neither series.

The component list is therefore used only to recognise a renamed bundle, by SET EQUALITY, and never to relate a bundle to its parts. Set equality is also what keeps BBG70 and KLOW80 apart, since one component list is a strict subset of the other. Relaxing it to containment would merge two real products, so there is a mutation test against it.

### Catalogue caching and invalidation

`lib/campaigns/product-catalogue.js` reads the catalogue once and caches it in process. It invalidates, in order of what actually fires:

1. the WooCommerce product webhook calls `invalidateProductCatalogue()`, so a product created, updated or deleted drops the cache immediately;
2. `CAMPAIGN_CATALOGUE_TTL_MS`, default 15 minutes, as the backstop for a missed webhook;
3. process restart, which costs one refetch and no authority.

A refresh that fails keeps the previous snapshot, marks it `stale`, and does not throw. `currentInventory()` still refuses any observation older than 24 hours, so a WooCommerce outage degrades to no candidates rather than to candidates based on last week's stock.

The catalogue supplies stock ROWS in the shape of `sms_product_inventory`, so there is no second definition of "available". It never supplies product EVENTS. Reading current stock is a first sighting, and a first sighting of "in stock" is not evidence that anything came back; `isRestockTransition()` has always said so and two tests guard it. `scripts/seed-product-inventory-baseline.js` can write the baseline so a later webhook has a `previous` to compare against, but it is read-only unless given both `--persist` and `PRODUCT_INVENTORY_SEED_APPROVED=YES`, it never overwrites an existing row, and it creates no event.

## Segmentation is not permission

Two different questions were being answered by one code path, and the smaller one was gating the larger one.

| Question | Answer comes from | Fails closed? |
|---|---|---|
| Who matches this pattern? | Purchase history, cadence, product identity, recency | No. It reports what is true. |
| May we contact this person? | Consent, STOP, DND freshness, quiet hours, frequency, support clearance | Yes, always, at every layer. |

`buildGenerationInput()` used to drop any candidate without a current commercial clearance before the cadence arithmetic ever ran. With `sms_customer_commercial_eligibility` empty in production that dropped every candidate: 3,378 `support_state_unknown` suppressions, four automatic segments reading zero, and a screen that looked identical to a broken engine.

The split is one option on that function.

- `clearance: 'gate'` is the default and is the historical behaviour to the byte. An uncleared phone produces no candidate. Draft generation and every delivery path use it and nothing about them changed.
- `clearance: 'observe'`, reachable only through the named wrapper `buildSegmentationInput()`, builds the candidate anyway and attaches `commercialClearance: { clear, reason }`. The whole input is stamped `segmentationOnly: true`.

`prepareOpportunityDraftRun()` throws `SEGMENTATION_INPUT_IS_NOT_A_SEND_PATH` on that stamp, and on `clearanceMode: 'observe'` independently, so removing either one is not enough to smuggle a segmentation input into a draft. `test/campaign-segmentation-seam.test.js` asserts the refusal, asserts that no send-path file so much as mentions the wrapper, and asserts that the person who is newly VISIBLE is still not DRAFTABLE.

### Eligibility travels as information

`lib/campaigns/segment-contactability.js` answers the permission question for display and puts it ON the member row, never in front of it. It reuses `evaluateRecipient()` from `lib/campaigns/eligibility.js` and `authoritativeSupportState()` unchanged rather than forming a second opinion; it only batches the reads and merges the two verdicts. Reasons accumulate rather than short-circuit, because "no clearance AND no consent" is two pieces of work.

It is computed at read time and never stored. A persisted "contactable: true" would be stale within the hour and is exactly the artefact somebody later mistakes for permission. It never enters `computedSetDigest()`, so a DND sync ageing out cannot move a person in or out of a segment or make an unchanged recompute look like a change.

The result is that a segment screen can say "9 people match, 0 can be messaged today, because 9 have no clearance on record and 9 have no current DND sync", which is both true and actionable, instead of showing nothing.

### What the live numbers actually are

Read-only, live, no counterfactual, 23 August 2026, via `scripts/dry-run-segment-membership.js`:

| Segment | People matching | Contactable |
|---|---:|---:|
| Reorder due | 9 | 0 |
| Reorder due, high confidence | 4 | 0 |
| Reorder approaching | 2 | 0 |
| Win-back qualified | 2 | 0 |

Non-zero for the first time, and much smaller than the 1,689 candidate groups across 761 people that the identity dry run reported as reach. The gap is not permission and not identity. It is repeat-purchase evidence, and it is the next real constraint:

- 1,318 of 1,689 candidate groups have exactly one qualifying purchase, so they have no interval at all;
- 1,659 of 1,689 have fewer than the three personal intervals the cadence floor requires;
- only 21 of 761 people have three or more intervals on any single parent product;
- the product-level fallback rescues nobody. Four products clear the 20-interval and 10-customer volume bar and all four fail the variability check: relative MAD 0.42 and 0.58 on the two largest, and outlier fractions of 0.33 to 0.52 against a 0.25 ceiling. Products 556 and 558 are inside the MAD limit and fail on outliers alone.

That is a description of the customer base, not a bug. Most Vici buyers have bought once. Raising the segment population means either more repeat history or a deliberately calibrated relaxation of the cadence thresholds, which is a decision about acceptable wrongness and belongs to the owner, not to a patch.

## Known limitations before wiring

- The product-level cadence thresholds have not yet been calibrated against the approved Vici historical dry run.
- Consent coverage and Telnyx eligibility remain unknown. A useful segment can still have zero send-eligible recipients, and today every one of them does. That is now displayed rather than hidden.
- These functions do not read Supabase, claim jobs, schedule work, or send SMS. Persistence and concurrency belong in the campaign service and SQL queue.
- `sms_customer_commercial_eligibility` is empty in production, so `authoritativeSupportState()` answers `unknown` for every phone. That still fails SENDING closed with `support_state_unknown`, which is correct. It no longer fails SEGMENTATION closed: see "Segmentation is not permission" below. `scripts/dry-run-segment-membership.js` reports live membership with no counterfactual anywhere in it.
- `sms_commerce_product_events` is empty, so back in stock has nobody: there is no recorded out-to-in transition, and current stock is not one. Seeding the inventory baseline is what makes the FIRST future transition detectable rather than swallowed.
