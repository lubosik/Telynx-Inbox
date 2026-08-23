# 02 — Campaign Flows, Segmentation, and Revenue Mechanics

Research brief for the Telynx AI campaign wizard.
Scope: what campaigns exist, who they should hit, when, and what they are actually worth.
Clients in scope: **Vici Peptides** (US research-peptide e-comm, ~26 SKUs, ~390 customers, WooCommerce + ShipStation + GoHighLevel) and **Client B** (ocean-safety school, course sales).

**Date of research:** 2026-08-11. Benchmarks decay fast; re-verify anything older than 12 months before it drives a projection shown to a client.

---

## 0. How to read this document

### 0.1 The vendor bias problem — read this before any number below

Effectively every SMS benchmark in public circulation is published by a company that **bills per message sent**. Klaviyo, Attentive, Postscript, and Omnisend all monetise volume. This produces a consistent, predictable distortion:

| Distortion | How it shows up | Example |
|---|---|---|
| Send-more bias | "Optimal" frequency is always set just below where opt-outs visibly spike, never where *profit* peaks | Attentive: "revenue per send peaks at 6–8 messages/month; opt-outs don't rise until 10–15/month" ([attentive.com](https://www.attentive.com/blog/best-time-to-send-sms-marketing)) |
| Last-touch attribution | Any order within an N-day window after a send is credited to that send, whether or not the send caused it | Klaviyo's default attribution window is 5 days ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)) |
| Survivorship | Benchmarks are computed over accounts that stayed on the platform | Postscript's report covers "17,000+ Shopify stores" that were still customers on 2025-12-15 ([postscript.io](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026)) |
| Aggregation across incomparable sizes | A 2M-subscriber brand and a 400-subscriber brand are averaged together | Klaviyo's "183,000+ customers" figure ([klaviyo.com](https://www.klaviyo.com/products/sms-marketing/benchmarks)) |

**Every conversion rate and RPR figure in Section 1 is a last-touch attributed number, not an incremental one.** The honest incremental figure is materially lower — commonly cited holdout studies put email/SMS incrementality somewhere between 30% and 70% of last-touch credit, meaning a "$3.65 RPR" flow may be worth $1.10–$2.55 incrementally `[UNVERIFIED — I could not find a peer-reviewed or first-party holdout study for SMS specifically within this research budget; treat the 30–70% band as a working prior, not a fact]`.

**Design implication for the wizard:** the projection UI must display an *attribution haircut* slider or constant, and the default must be less than 1.0. Showing a raw last-touch projection as "projected revenue" is the single easiest way to lose a client's trust in month 3 when their Shopify/Woo revenue doesn't move by the promised amount.

### 0.2 The two rankings people confuse

Benchmark tables rank flows by **revenue per recipient (RPR)**. Operators care about **total revenue contribution**. These give opposite answers.

- Welcome flows have the highest RPR (~$8.17 entry-message RPR in one dataset) but the smallest audience — only new opt-ins ever enter.
- Post-purchase and replenishment have low RPR ($0.48 and $0.26) but every customer enters, repeatedly, forever.

For Vici with ~390 customers and low new-subscriber velocity, **the high-RPR/low-volume flows are near-worthless in absolute dollars** and the low-RPR/high-volume flows are where the money is. Section 1.4 ranks both ways.

---

## 1. The complete flow taxonomy

### 1.1 Benchmark sources and what each one actually measures

| Source | Sample | Period | Measures | Bias flag |
|---|---|---|---|---|
| [Klaviyo SMS benchmarks](https://www.klaviyo.com/products/sms-marketing/benchmarks) | 183,000+ accounts | 2026 report | Aggregate SMS flow vs campaign | Vendor, sells sends |
| [Klaviyo campaign SMS/MMS benchmark bands](https://help.klaviyo.com/hc/en-us/articles/360051110111) | Klaviyo US SMS users, updated 2025-10-28 | rolling | Campaign (not flow) click/conv/unsub/RPR bands | Vendor |
| [Postscript 2026 benchmarks](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026) | 17,000+ Shopify stores | 2025-01-01 → 2025-12-15 | Percentile RPM, cadence, retention | Vendor, Shopify-only |
| [Postscript conversion-by-message-type, via Omnisend](https://www.omnisend.com/blog/sms-marketing-conversion-rate/) | "thousands of stores" | unstated | Per-flow SMS conversion ranges | Vendor, second-hand |
| [Omnisend 2026 ecommerce report](https://www.omnisend.com/blog/sms-marketing-conversion-rate/) | 150,000+ brands | 2026 | SMS automation vs campaign conversion, RPM | Vendor |
| [Attentive send-time study](https://www.attentive.com/blog/best-time-to-send-sms-marketing) | 25B messages | unstated | Time-of-day / day-of-week / frequency | Vendor, enterprise-skewed |
| [BS&Co Klaviyo flow benchmarks](https://bsandco.us/blog-post/klaviyo-flow-benchmarks) | **14 brands** | trailing 365d | Per-flow email CR and RPR | Agency; **n=14 is anecdote, not benchmark** |

The BS&Co dataset is the only one with a per-flow RPR breakdown, and it is **email-only** ("SMS branches excluded from v1") across **fourteen brands**. Some flows in it rest on 5–7 brands. Treat every number from it as directional only. I use it because nothing better is public, not because it is good.

### 1.2 The taxonomy

Columns: **Trigger** = the event that enrols a contact. **Delay** = time from trigger to first message. **CR** = conversion (order) rate per message delivered. **RPR** = revenue per recipient. **vs Email** = how the SMS version differs from the email version.

---

#### 1. Welcome / opt-in confirmation

- **Trigger:** SMS consent captured (popup, checkout checkbox, keyword opt-in, in-person).
- **Delay:** Immediate — under 60 seconds. This is the one flow where "immediate" is not a heuristic but a requirement: the double opt-in / program disclosure message is a CTIA compliance artefact, not a marketing message. It must confirm program name, message frequency, "Msg&data rates may apply", and HELP/STOP.
- **CR (SMS):** 0.4%–2.3% for the welcome series per Postscript's per-type ranges; **7.0%–26.1% for keyword opt-ins specifically** ([omnisend.com citing Postscript](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)). The gap is entirely intent: someone who texted a keyword to join is a warm lead; someone who ticked a checkbox at checkout has already bought.
- **RPR (email analogue):** $8.17 entry-message RPR, but with a 19× spread across brands (0.95%–18.04% CR) ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)).
- **vs Email:** SMS welcome must be 1–2 messages; email welcome runs 3–5. The SMS version's job is to (a) discharge the compliance disclosure and (b) deliver the opt-in incentive code. Education belongs in email.
- **Vici note:** Vici's opt-in volume is the constraint. With ~390 total customers, the welcome flow will fire perhaps a handful of times a month. It is compliance-critical and revenue-trivial. Build it first for legal reasons, expect ~nothing from it financially.

#### 2. Abandoned checkout (checkout started, not completed)

- **Trigger:** Checkout initiated with contact details captured, no order placed.
- **Delay:** SMS at 30 minutes; a second at 4–24 hours; stop after two. Recovery rates "drop dramatically after the first few hours" and "waiting beyond 2 hours drops recovery rates by roughly 30%" ([omnisend](https://www.omnisend.com/blog/abandonment-sms/), [attnagency](https://www.attnagency.com/blog/sms-abandoned-cart-recovery)) — note both are agency/vendor claims without published methodology `[UNVERIFIED]`.
- **CR (SMS):** 3.7%–10.2% (Postscript, grouped with abandoned cart). Postscript separately reports **9.1% average conversion on abandoned cart automations** and **$8.11 earnings per message** ([postscript via search](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)).
- **RPR (email analogue):** $3.47 entry / $3.56 full-flow; **started-checkout converts 2.3× higher than added-to-cart** ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)).
- **vs Email:** SMS wins on speed and wins on the "one tap back to checkout" mechanic. Email wins on cart contents display. The empirically strongest configuration is both: one case study reports 12.3% email-only vs 41.7% email+SMS recovery ([attnagency](https://www.attnagency.com/blog/sms-abandoned-cart-recovery)) — a single-brand case study, so `[UNVERIFIED]` as a generalisation.
- **Vici note — CRITICAL FEASIBILITY FLAG:** Telynx currently receives WooCommerce order webhooks (`routes/webhook-woocommerce.js`) and has flows for `confirmed`, `shipped`, `hold`, `failed`. WooCommerce creates an order row at checkout with status `pending` / `failed`, so **abandoned checkout is buildable today** from existing data — a `pending` order with a resolvable phone that never reaches `processing`. The repo's `flows/failed.js` and `flows/hold.js` are already 80% of this machinery.

#### 3. Abandoned cart (added to cart, no checkout)

- **Trigger:** Add-to-cart without checkout initiation.
- **Delay:** 1–4 hours (lower intent than checkout abandonment, so more room; also more likely to be genuine browsing).
- **CR / RPR:** email $2.96 entry RPR, 1.82% entry CR ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)). Lower than checkout abandonment on both.
- **Vici note — BLOCKED:** requires on-site JavaScript tracking that identifies the visitor and captures cart events. Telynx has no such tracking script. Building it means shipping a pixel, handling identity resolution, and adding a consent surface. **Do not put this in the wizard's flow catalogue for Vici until that instrumentation exists**, or the wizard will offer a campaign it cannot populate.

#### 4. Browse abandonment

- **Trigger:** Product page viewed, no add-to-cart.
- **Delay:** 2–24 hours.
- **CR (SMS):** 1.1%–2.5% (Postscript ranges). Email RPR $0.90, entry CR 0.61% ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)).
- **vs Email:** This is the flow where SMS is *worst* relative to email, and the one I would argue against on SMS at all for a small list. Intent is weak, and an SMS about a product someone merely looked at reads as surveillance in a way an email does not. Omnisend reports browse abandonment saw the largest YoY growth (50%) of non-transactional automations ([omnisend](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)) — growth in adoption, not in performance.
- **Vici note — BLOCKED and additionally inadvisable.** Same instrumentation gap as #3, plus a compliance concern: a text triggered by browsing a specific peptide page creates an inference about the recipient's health interests. Do not build.

#### 5. Post-purchase (order confirmation, education, cross-sell)

- **Trigger:** Order placed / paid.
- **Delay:** Confirmation immediate. Education/cross-sell staged after **delivery**, not after order — delivery-triggered is materially better because the customer now physically has the product.
- **CR (SMS):** 0.4%–1.5% for the promotional post-purchase message (Postscript). Email post-purchase RPR $0.48, entry CR 0.31%, but **58% open rate — the highest of any flow** ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)).
- **vs Email:** The transactional part (confirmation) is the one place SMS is unambiguously superior and expected. The promotional part is where SMS is worst — a sales text 3 days after someone bought reads as greedy. Split them: SMS carries the receipt and the tracking; email carries the education sequence and the cross-sell.
- **Vici note:** Already live (`flows/confirmed.js`, `flows/shipped.js`). The upgrade is delivery-triggering the education leg off ShipStation `delivered` status (`shipstation_tracking` table already exists).

#### 6. Shipping / delivery notifications

- **Trigger:** Fulfilment created, in transit, out for delivery, delivered, exception.
- **Delay:** Real-time on each carrier event.
- **CR:** Not a conversion flow. Its value is (a) support-ticket deflection, (b) opening a two-way thread that later flows inherit, and (c) providing the *delivered* timestamp that replenishment maths depends on.
- **vs Email:** SMS dominates. This is the single most-wanted transactional text.
- **Vici note:** Live. **The delivered timestamp is the most valuable data point in the entire system for Vici** — see Section 2. Ensure ShipStation `delivered` webhooks are persisted with a timestamp, not just tracking numbers.

#### 7. Review / feedback request

- **Trigger:** N days after **delivery** (never after order).
- **Delay:** 14 days is the industry default — **over 76% of Judge.me users keep the 14-day default** ([judge.me](https://judge.me/blog/review-requests-4-key-points-to-get-more-responses-and-better-reviews)). But category-adjusted: **supplements & wellness 21–30 days**, because the product needs time to produce an observable effect ([smartsmssolutions](https://smartsmssolutions.com/resources/blog/best-time-to-request-reviews)).
- **Response rate:** 5–8% typical, 12–15% for first-time buyers or high-engagement products; response rates drop 60–70% after the two-week mark ([Yotpo 2024 benchmark data, cited second-hand](https://smartsmssolutions.com/resources/blog/best-time-to-request-reviews)) `[UNVERIFIED — I could not reach the primary Yotpo benchmark]`.
- **vs Email:** SMS gets far higher response but much shorter reviews. Best pattern per Yotpo: three touches across two channels over 7–10 days.
- **Vici note:** Use **21–30 days post-delivery**, not 14. Peptide protocols run 4–8 weeks; asking at day 14 asks for a review of a product that has not yet done anything. **Compliance flag:** a review request for a research chemical must not solicit efficacy claims about human use. The prompt should ask about shipping, packaging, and product quality — not results.

#### 8. Replenishment / reorder — see Section 2 for the full treatment

- **Trigger:** Predicted depletion date minus lead time.
- **CR:** email RPR $0.26, entry CR 0.46% in the BS&Co set — **but that is across only 5 brands and almost certainly includes brands whose products are not consumable on a predictable cycle** ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)). Agency sources claim replenishment reminders convert at 8–15% vs 1–3% for general promos ([aiadvantageagency](https://aiadvantageagency.com/replenishment-emails-for-ecommerce/)) — an unsourced agency claim, `[UNVERIFIED]`, and the 5–10× multiplier is suspiciously round.
- **Why the benchmark understates it for Vici:** replenishment RPR is low in aggregate benchmarks because most catalogues are not consumable. For a catalogue where **every SKU is consumed on a schedule**, this flow's ceiling is set by repeat-purchase rate, not by benchmark RPR.
- **Vici note:** This is the flow. Section 2.

#### 9. Win-back / lapsed reactivation

- **Trigger:** No order in X days, where X is a multiple of the customer's own repurchase cycle — **not a fixed calendar threshold**. Recommended: first message at 2–3× the normal repurchase cycle ([finsi.ai](https://www.finsi.ai/blog/win-back-email-campaign-guide/)).
- **Delay/cadence:** 60–90 days is the standard window for consumables, 90–120 for non-consumables. A 4-message escalation is the standard structure.
- **CR (SMS):** 0.4%–1.6% (Postscript) — the **lowest of any triggered flow**. Email winback in the BS&Co set: 0.09% entry CR, **$0.05 RPR** — effectively zero.
- **Program-level reactivation:** 12–20% of inactive customers across a full program; one source cites 14.7% cumulative from a 4-email escalation attributed to "Klaviyo benchmark data" ([eightx](https://eightx.co/blog/average-win-back-reactivation-rate-benchmarks), [finsi.ai](https://www.finsi.ai/blog/win-back-email-campaign-guide/)) `[UNVERIFIED — I could not locate the underlying Klaviyo publication]`.
- **The contradiction you must not paper over:** per-message CR is ~0.1–1.6% while program reactivation is quoted at 12–20%. These measure different things — per-message conversion vs eventual return over months, with heavy last-touch credit for people who would have returned anyway. **The wizard must project win-back on the per-message number, not the program number.**
- **vs Email:** Win-back is the flow where SMS is most likely to generate opt-outs, because by definition you are texting someone who stopped caring. Email first, SMS only for contacts with a prior *inbound* SMS reply.

#### 10. VIP / loyalty

- **Trigger:** Crossing a spend, order-count, or predicted-LTV threshold.
- **Delay:** On threshold crossing; then a recurring privileged-access cadence.
- **CR:** No reliable public benchmark. Directionally the highest-converting non-triggered audience because it is definitionally your best customers — which also makes its measured performance mostly a selection effect, not a campaign effect.
- **Vici note:** With ~390 customers, a "VIP" tier of the top decile is **39 people**. That is a concierge list, not a campaign segment. The right treatment is manual, one-to-one messaging through the existing two-way inbox — which Telynx already is. Do not build an automated VIP flow for Vici; build a VIP *view* in the inbox.

#### 11. Back-in-stock

- **Trigger:** Explicit subscription to a restock alert for a specific SKU, plus inventory crossing zero → positive.
- **Delay:** Immediate on restock.
- **CR (SMS):** **6.0%–14.3%**, the highest-converting message type in Postscript's set; CTR 36–58% ([postscript](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026), [omnisend](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)).
- **Why it converts:** it is the only message on this list the recipient explicitly asked for, for a specific product, at a specific moment. It is a fulfilled request, not an interruption.
- **vs Email:** SMS wins decisively — restocks are a race, and the first channel to reach the buyer takes the sale.
- **Vici note:** Requires (a) a restock-subscription capture on the product page and (b) reading WooCommerce `stock_status` transitions. (b) is available via existing `product.updated` webhooks. (a) is a small front-end build. **This is the second-best ROI build for Vici after replenishment** — high conversion, low volume, zero fatigue cost, and it doubles as a demand signal for purchasing.

#### 12. Price drop

- **Trigger:** Price of a SKU the contact viewed/bought/wishlisted drops by ≥ X%.
- **Delay:** Within hours.
- **CR:** No credible SMS-specific benchmark found.
- **Vici note — do not build.** It requires browse/wishlist tracking Vici does not have, it trains customers to wait for discounts on a repeat-purchase catalogue (directly cannibalising replenishment margin), and with 26 SKUs the price-change event volume is negligible.

#### 13. Sunset / suppression

- **Trigger:** No engagement in N days, where SMS "engagement" = click, conversion, or inbound reply.
- **Standard definitions** ([Klaviyo Academy](https://academy.klaviyo.com/en-us/courses/build-an-sms-marketing-strategy/lessons/improve-sms-engagement-with-segmentation), [Attentive](https://www.attentive.com/blog/sunset-policy-guide)): *engaged* = clicked/converted in last 30d; *less engaged* = clicked in last 90d but not last 30d (reduce to 3–4/month); *unengaged* = consented, received ≥1 SMS in last 120d, no click in last 60d; *never active* = no engagement or purchase in 180d → suppress.
- **CR:** Negative by design. Its value is (a) opt-out rate protection, (b) cost — every SMS to a dead contact is a direct cash cost with a nonzero probability of a spam report.
- **Vici note — DO NOT APPLY THE STANDARD THRESHOLDS.** A peptide customer on an 8-week protocol who bought once and is mid-cycle looks identical to a dead contact at day 60. Vici's suppression threshold must be **≥ 3× the cohort median inter-purchase interval**, and the list is small enough that suppressing 30 people materially shrinks every future campaign. Sunset is a large-list hygiene tool. At 390 contacts, the cost of suppressing a false positive exceeds the cost of one extra send.

### 1.3 SMS vs email: the general rule, not flow by flow

Across all sources the same structural facts hold:

- **SMS flows drive 45.2% of SMS revenue from 7.6% of sends; ~8× the RPR of SMS campaigns; top-decile flows exceed $5 RPR** ([klaviyo.com](https://www.klaviyo.com/products/sms-marketing/benchmarks)).
- **Omnisend: automated SMS click-to-conversion 3.81% vs 0.97% for broadcast; SMS automations $0.74 revenue per message** ([omnisend](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)).
- **Klaviyo campaign SMS bands (US):** click "great" ≥14.6% / "critical" <5.9%; conversion "great" ≥2.1% / "critical" <0.5%; unsub "great" <0.5% / "critical" ≥2.0%; RPR "great" ≥$2.42 / "critical" <$0.18 ([klaviyo help](https://help.klaviyo.com/hc/en-us/articles/360051110111), updated 2025-10-28).
- **Postscript percentile RPM:** median $0.98, p75 $2.13, p90 $4.54; 30-day retention median 93.1% ([postscript](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026)).

The generalisable difference between the SMS and email version of the same flow:

| Dimension | SMS | Email |
|---|---|---|
| Marginal cost per send | ~$0.01–0.03 + carrier fees | ~$0.0001 |
| Cost of a wasted send | Real money + fatigue + opt-out risk | Near zero |
| Optimal message count per flow | 1–2 | 3–5 |
| Best at | Urgency, time-boxed windows, transactional confirmation, restocks | Education, product detail, catalogue browsing, long-form persuasion |
| Worst at | Anything requiring context or explanation; anything the recipient did not ask for | Anything urgent |
| Reversibility | None — opt-out is permanent and legally binding | Re-permission possible |

**The operative asymmetry: an unwanted email costs nothing; an unwanted SMS permanently destroys the contact.** Every design decision in the wizard should follow from that sentence.

### 1.4 Ranking

**By RPR (generic e-commerce, email data, n=14 brands — directional only):**
1. Welcome $8.17 · 2. Abandoned checkout $3.47 · 3. Abandoned cart $2.96 · 4. Browse abandonment $0.90 · 5. Post-purchase $0.48 · 6. Replenishment $0.26 · 7. Win-back $0.05 ([bsandco.us](https://bsandco.us/blog-post/klaviyo-flow-benchmarks))

**By SMS conversion rate (Postscript per-type ranges):**
1. Keyword opt-in 7.0–26.1% · 2. Back-in-stock 6.0–14.3% · 3. Abandoned cart/checkout 3.7–10.2% · 4. Browse abandonment 1.1–2.5% · 5. Welcome 0.4–2.3% · 6. Win-back 0.4–1.6% · 7. Post-purchase 0.4–1.5% · 8. Broadcast 0.1–0.6% ([omnisend citing Postscript](https://www.omnisend.com/blog/sms-marketing-conversion-rate/))

**By expected total annual revenue contribution *for Vici specifically*, given ~390 customers, a consumable catalogue, no on-site tracking, and existing Woo/ShipStation integration:**

| Rank | Flow | Why | Buildable today? |
|---|---|---|---|
| 1 | **Replenishment / reorder** | Every SKU consumable; every customer eligible repeatedly; no new instrumentation | Yes — order history exists in `sms_orders` |
| 2 | **Abandoned checkout** | Woo `pending`/`failed` orders already webhook in; highest-intent recoverable event available | Yes — `flows/failed.js` is most of it |
| 3 | **Post-purchase delivery-triggered cross-sell** | Full customer base, recurring, uses existing ShipStation delivered event | Yes |
| 4 | **Back-in-stock** | Highest CR of any flow; zero fatigue cost | Needs a product-page capture form |
| 5 | **Win-back** | Low CR but at 390 contacts every reactivated customer is 0.26% of the list | Yes |
| 6 | **Review request (21–30d post-delivery)** | Revenue-indirect; social proof compounds for a trust-constrained category | Yes |
| 7 | **Welcome / opt-in** | Compliance-mandatory, revenue-trivial at current opt-in velocity | Yes — build for legal reasons |
| 8 | VIP/loyalty | 39 people — do it by hand in the inbox | N/A |
| 9 | Sunset | Do not apply standard thresholds at this list size | Defer |
| — | Abandoned cart, browse abandonment, price drop | **Blocked on instrumentation Vici does not have** | No |

---

## 2. Replenishment — the deep treatment

### 2.1 Why this is the whole ballgame for Vici

Vici sells peptides. Peptides are:
- consumed on a fixed dosing schedule,
- packaged in discrete units (a 5 mg vial),
- used in protocols with defined cycle lengths,
- and, critically, **not substitutable mid-protocol** — running out interrupts the protocol, which is a hard, felt event on a known date.

That combination makes depletion far more predictable than for a typical consumable, and it means the customer's *own* planning horizon precedes the depletion date. This is the ideal condition for a replenishment flow.

### 2.2 Two independent estimators — use both

There are two fundamentally different ways to predict when a customer will run out. Most platforms implement only the first. **For Vici, the second is more valuable, because it works on single-order customers, which is where the first fails hardest.**

---

#### Estimator A — Behavioural: inter-purchase interval from order history

For customer *c* with order timestamps `t₁ < t₂ < … < tₙ`:

```
gaps  gᵢ = tᵢ₊₁ − tᵢ          for i = 1 … n−1
k_c   = n − 1                  (number of observed gaps)
```

**Central estimate — use the median, not the mean.** A single bulk stock-up order, a gift order, or a returned order will drag a mean badly. With k ≤ 5 gaps, one outlier is 20% of the data.

```
m_c = median(gᵢ)
```

**Work in log space.** Inter-purchase intervals are right-skewed (bounded below by zero, unbounded above). Fitting on `ln(g)` makes the distribution roughly symmetric, makes the geometric mean equal the median, and makes the confidence interval multiplicative rather than additive — which is the correct shape, since a customer with a 90-day cycle has proportionally more absolute variance than one with a 20-day cycle.

```
μ_c = mean( ln gᵢ )
s_c = stdev( ln gᵢ )              (needs k ≥ 2)
m_c = exp(μ_c)                    (= median under lognormal)
```

**Dispersion — use MAD, not stdev, when k is small.**

```
MAD_c = median( |gᵢ − m_c| )
σ̂_c   = 1.4826 × MAD_c            (consistent estimator of σ for normal data)
CV_c  = σ̂_c / m_c                 (coefficient of variation — the confidence signal)
```

**Handling low k — shrink toward a cohort prior (empirical-Bayes style):**

```
w_c   = k_c / (k_c + κ)                       κ = shrinkage constant, start at κ = 2
m̂_c   = exp( w_c · ln m_c  +  (1 − w_c) · ln m_cohort )
```

Behaviour of that weight:

| Orders (n) | Gaps (k) | w at κ=2 | Interpretation |
|---|---|---|---|
| 1 | 0 | 0.00 | Pure cohort prior — you know nothing about this person's cycle |
| 2 | 1 | 0.33 | Mostly cohort. One gap is not a pattern. |
| 3 | 2 | 0.50 | Half and half |
| 4 | 3 | 0.60 | Personal signal starting to dominate |
| 6 | 5 | 0.71 | |
| 11 | 10 | 0.83 | Trust the individual |

Tune κ by backtesting: hold out each customer's last order, predict it from the earlier ones at several κ values, minimise median absolute log error. **At Vici's data volume this tuning will itself be noisy — pick κ=2, note it as a guess, and revisit at 2,000+ orders.**

**Cohort ladder — walk up until the cohort has ≥ 30 observed gaps:**

1. Same SKU
2. Same product family (healing/recovery peptides, GLP-1 class, cosmetic/GHK-Cu, sexual health/PT-141, GH secretagogues)
3. Same AOV band (tercile)
4. Whole store

**Blunt assessment for Vici:** with ~390 customers, if the repeat-purchase rate is around 30% (roughly the e-commerce norm — [finsi.ai](https://www.finsi.ai/blog/repeat-purchase-rate-ecommerce/) cites 25–30%), you have on the order of 120 customers with ≥2 orders and therefore **on the order of 150–250 observed gaps in total, spread across 26 SKUs.** That is ~6–10 gaps per SKU. **SKU-level cohorts are not viable.** You will be operating at product-family or store-wide level for the foreseeable future. Any wizard UI that offers "per-product replenishment timing" for Vici is offering a precision the data cannot support — and should say so on screen.

---

#### Estimator B — Deterministic: dose-based depletion

This is the one that actually fits Vici, and almost no SMS platform does it because almost no catalogue supports it.

```
supply_days(SKU) = (units_purchased × mg_per_unit) / mg_per_day_typical
depletion_date   = delivered_at + supply_days
```

Worked example, arithmetic only:

- A 5 mg BPC-157 vial, at a commonly-discussed 250–500 mcg/day: 5,000 mcg ÷ 250 mcg = **20 days**; ÷ 500 mcg = **10 days**. So one vial ≈ 10–20 days of supply.
- A 5 mg TB-500 vial at 2.0–2.5 mg/week: **2–2.5 weeks**.

Reference for the dosing ranges: [dosingcalc.com](https://dosingcalc.com/guides/bpc-157-tb-500-research-guide-dosing), [peptides.org](https://www.peptides.org/bpc-157-dosage/). **Note:** one search summary I encountered claimed a 5 mg vial at 250–500 mcg/day yields "10–20 weeks" — that is an arithmetic error by a factor of seven. It is 10–20 *days*. Do not let an LLM populate this table from search results; the sources are unreliable and the errors are large.

**Therefore:**

> The `sku → supply_days` mapping must be a **client-maintained lookup table**, entered by Vici, versioned, and never inferred by the model. The wizard reads it. The wizard does not write it.

**Combining A and B:**

```
if k_c ≥ 2 and CV_c < 0.5:        use A   (individual behaviour is informative)
elif SKU has a supply_days entry: use B   (deterministic beats a weak prior)
elif k_c ≥ 1:                     use A with heavy shrinkage
else:                             use cohort median; flag low confidence
```

When both are available, a sanity cross-check is valuable: if A and B disagree by more than 2×, the customer is not using the product on the assumed schedule (stockpiling, sharing, or reselling). Flag rather than guess.

### 2.3 How many days before depletion to send

**The evidence, such as it is:**

| Recommendation | Source | Quality |
|---|---|---|
| 7–10 days before estimated depletion | [webmedic.com](https://webmedic.com/refill-campaign) | Agency blog, no methodology |
| 5–7 days before running out | [aiadvantageagency.com](https://aiadvantageagency.com/replenishment-emails-for-ecommerce/) | Agency blog, no methodology |
| 3–5 days as the "standard range" | [theinterconnections.com](https://www.theinterconnections.com/blog/email-flows-youre-missing) | Agency blog, no methodology |
| Trigger at 70–80% of the consumption window | [reotter.com](https://reotter.com/blog/second-purchase-problem-dtc-brands) | Vendor selling reorder prediction |

**No published controlled test of replenishment lead time exists in the public literature I could reach.** Every number above is a practitioner heuristic. `[UNVERIFIED]` applies to all four. They converge on 3–10 days, which is reassuring but is also just what everyone copies from everyone else.

**The formulation I would implement:**

```
lead_time L = clamp( (1 − α) · m̂_c ,  L_min ,  L_max )
send_at     = depletion_date − L
              where α = 0.80
                    L_min = transit_time_p90 + 2 days     ≈ 7 days for US ground
                    L_max = 14 days
```

The `L_min` floor is the part the heuristics all miss and the part that matters most: **a replenishment message is useless if the reorder cannot physically arrive before depletion.** For Vici, US domestic ground shipping plus order processing means L_min ≈ 7 days. Sending 3 days out guarantees a supply gap even if the customer converts instantly. Derive `transit_time_p90` empirically from `shipstation_tracking` — you have shipped-to-delivered timestamps.

**Asymmetry of error — send early, not late.**

| Too early | Too late |
|---|---|
| Message reads as irrelevant / pushy | Customer has already run out |
| Costs one slot from the frequency budget | Protocol interrupted → a natural quit point |
| Small opt-out risk | Customer may have already bought from a competitor |
| **Recoverable** — you can send again | **Not recoverable** — the purchase occasion is gone |

For a protocol-driven consumable the late-error is strictly worse, because depletion is a churn moment, not just a delayed sale. Bias early. Concretely: if uncertain, use α = 0.75 rather than 0.85.

**What actually happens to conversion if you're wrong:** I found **no data** quantifying the conversion penalty as a function of days-early or days-late. Anyone who tells you "conversion drops X% per day early" is making it up. The honest position for the wizard UI is to show the *predicted window*, not a predicted day, and to let the operator see how wide it is.

### 2.4 Confidence gating — when *not* to send a replenishment message

```
CV_c < 0.35                 → tight cycle. Single message at depletion − L. High confidence.
0.35 ≤ CV_c < 0.75          → loose cycle. Send at the early edge (depletion − L_max),
                              optional second nudge at depletion − L_min.
CV_c ≥ 0.75, or k_c = 0
  with no supply_days entry → DO NOT call this replenishment. Either fall through to a
                              generic lifecycle/win-back message, or send nothing.
```

The third branch is the one that gets skipped in every implementation and is the reason replenishment flows underperform their promise. **A replenishment message sent at a randomly-chosen time is just a promo with extra steps, and it will convert like a promo (0.1–0.6%) while consuming the fatigue budget of a replenishment message.**

### 2.5 Prediction interval, stated honestly

Under the lognormal fit with k gaps:

```
95% interval for the next gap ≈ exp( μ_c ± t₀.₉₇₅,k₋₁ · s_c · √(1 + 1/k) )
```

The `√(1 + 1/k)` term is what makes this a *prediction* interval (for a new observation) rather than a confidence interval (for the mean). It is the term everyone drops, and dropping it makes the interval look about 20–40% tighter than it is at small k.

At k = 2, `t₀.₉₇₅,₁ = 12.71`. With even a modest `s_c = 0.3`, the interval multiplier is `exp(±12.71 × 0.3 × 1.22) = exp(±4.65)` — a range spanning a factor of **~100×**. That is not a usable prediction. It is a correct statement that **two gaps tell you almost nothing**, and it is exactly why the shrinkage in 2.2 is mandatory rather than optional.

**Show this in the UI.** A replenishment preview that says "predicted reorder: 14 Sept" is a lie. One that says "predicted reorder window: 2–24 Sept, low confidence (2 prior orders)" is the truth and lets the operator decide.

### 2.6 The compliance landmine

This must be stated plainly because it is the sort of thing that ends a client relationship.

Vici sells **research peptides**. The legal posture of the entire category rests on the products being sold for research use, not human consumption. A replenishment SMS that says any of:

- "Time for your next dose"
- "You're due for a refill"
- "Your protocol restarts in 5 days"
- "Running low on your BPC-157?"

...is a written admission, from the seller, that the seller believes the buyer is injecting the product on a schedule. That is evidence against the research-use framing, it is a claim about human use, and separately it risks the A2P 10DLC campaign registration. Carriers already restrict SHAFT content plus cannabis, CBD, and various high-risk verticals, and campaigns in restricted categories face additional vetting and carrier filtering **even after registration is approved** ([10dlccheck.com](https://10dlccheck.com/learn/ctia-guidelines-explained), [infobip](https://www.infobip.com/blog/what-is-a2p-10dlc)). Research peptides are not on the published prohibited list, but they sit adjacent to categories that are, and carrier filtering decisions are opaque and not appealable in any practical timeframe.

**Safe framing:** reference the *order*, never the *use*.

> "Hi Alex — it's been 24 days since your last order (5mg BPC-157). Restock here: [link]. Reply STOP to opt out."

**The wizard must enforce this with a hard content filter on the replenishment flow, not a soft prompt instruction.** A regex/classifier gate on dosing language, applied before the message reaches a human for approval. This is one of the few places I would build a deterministic blocklist rather than trust a model.

---

## 3. Segmentation models

All SQL below targets the **actual Telynx schema** as observed in the repo: `sms_contacts` (PK `phone`, plus `name, email, city, state, country, woo_customer_id, last_seen`), `sms_orders` (`contact_phone, woo_order_id, status, items` JSONB `[{name, quantity, total, sku}]`, `total, tracking_number, carrier, shipped_at, created_at, order_sms_sent, shipped_sms_sent, delivery_sms_sent`), `sms_messages` (`contact_phone, direction, body, status, created_at, media_urls, reply_to_message_id, reactions`), `sms_sent_log` (`order_id, flow_type, phone, sent_at, message_body`), `sms_scheduled`, `sms_customer_profiles`, `shipstation_tracking`.

**Columns that need to be added before this is implementable** (flagged, not assumed):
- `sms_contacts.opted_out boolean` — opt-out is currently detected by regex in `routes/webhook.js` and there is an `isOptedOut()` helper, but the persisted column name should be confirmed.
- `sms_contacts.timezone text` and `sms_contacts.consent_at timestamptz`
- `sms_sent_log.campaign_id` — currently only `flow_type`; campaign-level attribution needs an id.
- A `sku → supply_days` lookup table (Section 2.2).

### 3.1 RFM, implemented rather than described

The theory is trivial and the theory is not the problem. The problems are: (a) quintiles are meaningless on small N, (b) recency must be measured against the *category's* purchase cycle, not calendar time, (c) monetary should be net of refunds.

```sql
-- Base: one row per customer with R, F, M primitives.
WITH valid_orders AS (
  SELECT
    contact_phone,
    created_at,
    total
  FROM sms_orders
  WHERE status IN ('processing','completed','shipped','delivered')  -- exclude pending/failed/refunded/cancelled
    AND total > 0
    AND contact_phone IS NOT NULL
),
rfm_base AS (
  SELECT
    contact_phone,
    (CURRENT_DATE - MAX(created_at)::date)      AS recency_days,
    COUNT(*)                                    AS frequency,
    SUM(total)                                  AS monetary,
    AVG(total)                                  AS aov,
    MIN(created_at)::date                       AS first_order_at,
    MAX(created_at)::date                       AS last_order_at
  FROM valid_orders
  GROUP BY contact_phone
)
SELECT * FROM rfm_base;
```

**Scoring — and why NTILE is wrong here.**

The standard advice is `NTILE(5)`. On 390 customers with a long tail of one-time buyers, NTILE(5) on `frequency` produces buckets like [1,1,1,1,2] — four of the five quintiles are identical, and the "score" carries no information. NTILE forces equal-sized buckets onto a distribution that is not continuous.

**Use absolute thresholds calibrated to the business, not quantiles, until N is large:**

```sql
SELECT
  contact_phone,
  recency_days, frequency, monetary,

  -- R: measured in units of the cohort's median inter-purchase interval (see §2),
  -- NOT in raw days. :cohort_ipi is the store-wide median gap in days.
  CASE
    WHEN recency_days <=     :cohort_ipi        THEN 5   -- within one cycle
    WHEN recency_days <= 1.5*:cohort_ipi        THEN 4
    WHEN recency_days <= 2.0*:cohort_ipi        THEN 3
    WHEN recency_days <= 3.0*:cohort_ipi        THEN 2
    ELSE                                             1
  END AS r_score,

  CASE
    WHEN frequency >= 5 THEN 5
    WHEN frequency  = 4 THEN 4
    WHEN frequency  = 3 THEN 3
    WHEN frequency  = 2 THEN 2
    ELSE                     1
  END AS f_score,

  -- M against absolute bands derived from the catalogue's price points,
  -- reviewed by the client. Placeholder values shown.
  CASE
    WHEN monetary >= 1000 THEN 5
    WHEN monetary >=  500 THEN 4
    WHEN monetary >=  250 THEN 3
    WHEN monetary >=  100 THEN 2
    ELSE                       1
  END AS m_score
FROM rfm_base;
```

Expressing recency in **multiples of the cohort inter-purchase interval** rather than raw days is the single most important adaptation for a consumable catalogue. A 45-day-lapsed customer is "overdue" if the cycle is 20 days and "early" if the cycle is 90 days. Fixed 30/60/90-day recency buckets are a general-merchandise convention and they mis-segment consumables badly.

**Segment labels:**

```sql
CASE
  WHEN r_score >= 4 AND f_score >= 4                    THEN 'champion'
  WHEN r_score >= 4 AND f_score  = 1                    THEN 'new_customer'
  WHEN r_score >= 3 AND f_score >= 3                    THEN 'loyal'
  WHEN r_score  = 3 AND f_score <= 2                    THEN 'promising'
  WHEN r_score <= 2 AND f_score >= 3 AND m_score >= 4   THEN 'at_risk_high_value'
  WHEN r_score <= 2 AND f_score >= 2                    THEN 'at_risk'
  WHEN r_score  = 1 AND f_score  = 1                    THEN 'lost_one_timer'
  ELSE 'unclassified'
END AS rfm_segment
```

**Honest limits at Vici's size.** With ~390 customers, an 11-way RFM segmentation produces segments of 10–80 people. Segments under ~50 cannot support any measurement at all (Section 5). **The wizard should collapse RFM to 4 operational buckets for Vici — champion / active / at-risk / lapsed — and hide the 11-way view.** Offering fine-grained RFM on a 390-person list is offering false precision, and it will produce campaigns targeting 14 people whose results are pure noise.

### 3.2 Predicted LTV

The standard machinery is BG/NBD (transaction count) + Gamma-Gamma (monetary value), or Pareto/NBD. Both assume: heterogeneous per-customer transaction rates drawn from a Gamma, and a per-customer dropout process (Beta-Geometric for BG/NBD — dropout can only occur immediately after a transaction; Pareto for Pareto/NBD — dropout can occur at any time). See [CLVTools](https://rdrr.io/cran/CLVTools/man/bgnbd.html) and the standard write-ups.

Klaviyo's own predictive analytics require **500+ customers with non-zero, non-refunded orders, 180+ days of history, and some customers with 3+ orders**, and Klaviyo states plainly that "predictions work best when averaged over many customers and are not expected to be exact for any single individual" ([Klaviyo help](https://help.klaviyo.com/hc/en-us/articles/360020919731)). Klaviyo does not publish the model family.

**Direct consequence: Vici at ~390 customers does not clear the bar Klaviyo itself sets for turning predictive analytics on.** Do not ship a per-customer predicted-LTV number for Vici. It will be a fitted parameter draped over 3–4 observations per customer, and it will be wrong in ways that look authoritative.

**What to ship instead — historical value plus a cheap forward proxy:**

```sql
-- Observed value + a naive forward projection. Honest, cheap, explicable.
SELECT
  contact_phone,
  monetary                                              AS ltv_to_date,
  aov,
  frequency,
  CASE WHEN frequency >= 2
       THEN aov * (365.0 / NULLIF(personal_ipi_days,0))
       ELSE NULL                                        -- do not guess for one-timers
  END                                                   AS naive_annual_run_rate
FROM rfm_base
JOIN customer_intervals USING (contact_phone);
```

Label it "run rate", never "predicted LTV". A run rate is an extrapolation the operator can audit. A predicted LTV is a claim about the future the model cannot support at this N.

Revisit BG/NBD at ~2,000 customers with ≥400 repeat buyers.

### 3.3 Lifecycle stages

Orthogonal to RFM, and more useful for flow routing because the stages are mutually exclusive and map 1:1 onto flows.

```sql
CASE
  WHEN o.orders = 0 AND c.consent_at IS NOT NULL              THEN 'subscriber_never_purchased'
  WHEN o.orders = 1 AND o.days_since_last <= :cohort_ipi      THEN 'first_purchase_active'
  WHEN o.orders = 1 AND o.days_since_last >  :cohort_ipi      THEN 'first_purchase_lapsing'
  WHEN o.orders >= 2 AND o.days_since_last <= 1.2*:ipi        THEN 'repeat_active'
  WHEN o.orders >= 2 AND o.days_since_last <= 2.0*:ipi        THEN 'repeat_overdue'
  WHEN o.orders >= 2 AND o.days_since_last <= 3.0*:ipi        THEN 'repeat_lapsed'
  ELSE                                                             'dormant'
END AS lifecycle_stage
```

**The `first_purchase_lapsing` → `repeat_active` transition is the single highest-value conversion in the business** and is where replenishment earns its keep. Repeat purchase rate benchmarks sit around 25–30% ([finsi.ai](https://www.finsi.ai/blog/repeat-purchase-rate-ecommerce/)); moving that by 5 points on a 390-person base is ~20 additional repeat customers a year, which at a $150 AOV and 2 orders each is ~$6,000 — a real number, and a more honest thing to promise than a campaign RPR projection.

### 3.4 Engagement segments — Telynx has a better signal than most platforms

Standard SMS engagement = link click or conversion. **Telynx has something better: inbound replies and tapback reactions**, both persisted (`sms_messages.direction`, `sms_messages.reactions`). An inbound reply is a far stronger engagement signal than a link click, and it is not spoofable by scanners or link-prefetchers.

**Caveat that must be checked:** link-click tracking on Telnyx requires wrapping outbound links in a redirector. If Telynx does not currently do this, **click-based engagement segments are not available at all** and the entire engagement model must run on replies + orders. Verify before designing around clicks.

```sql
WITH engagement AS (
  SELECT
    c.phone,
    MAX(m.created_at) FILTER (WHERE m.direction = 'inbound')  AS last_inbound_at,
    COUNT(*)          FILTER (WHERE m.direction = 'inbound'
                              AND m.created_at > now() - interval '90 days') AS inbound_90d,
    COUNT(*)          FILTER (WHERE m.direction = 'outbound'
                              AND m.created_at > now() - interval '30 days') AS outbound_30d,
    COUNT(*)          FILTER (WHERE m.reactions IS NOT NULL
                              AND m.created_at > now() - interval '90 days') AS reactions_90d
  FROM sms_contacts c
  LEFT JOIN sms_messages m ON m.contact_phone = c.phone
  GROUP BY c.phone
)
SELECT phone,
  CASE
    WHEN last_inbound_at > now() - interval '30 days'  THEN 'engaged'
    WHEN last_inbound_at > now() - interval '90 days'  THEN 'less_engaged'
    WHEN outbound_30d > 0 AND last_inbound_at IS NULL  THEN 'never_responded'
    ELSE 'unengaged'
  END AS engagement_tier
FROM engagement;
```

Threshold reference: Klaviyo Academy defines SMS *less engaged* as clicked in last 90d but not last 30d (recommend 3–4 texts/month), and *unengaged* as consented, received ≥1 SMS in last 120d, no click in last 60d ([Klaviyo Academy](https://academy.klaviyo.com/en-us/courses/build-an-sms-marketing-strategy/lessons/improve-sms-engagement-with-segmentation)).

**Vici adjustment:** `never_responded` is not a meaningful negative signal for a transactional program. Most people do not reply to a shipping notification. Do not suppress on it.

### 3.5 Product affinity

The `items` JSONB on `sms_orders` carries `sku` and `name`, so affinity is a straightforward unnest.

```sql
WITH purchased AS (
  SELECT
    o.contact_phone,
    item->>'sku'                          AS sku,
    item->>'name'                         AS product_name,
    (item->>'quantity')::int              AS qty,
    o.created_at
  FROM sms_orders o
  CROSS JOIN LATERAL jsonb_array_elements(o.items) AS item
  WHERE o.status IN ('processing','completed','shipped','delivered')
)
SELECT
  contact_phone,
  sku,
  SUM(qty)                AS total_units,
  COUNT(*)                AS order_count,
  MAX(created_at)         AS last_purchased_at
FROM purchased
GROUP BY contact_phone, sku;
```

Cross-sell affinity (co-purchase lift) is the obvious next step and is **not viable at Vici's volume**. Market-basket lift on 26 SKUs needs thousands of baskets to distinguish a real association from chance; with a few hundred orders every pair will look either co-occurring-always or never. **Use a hand-authored product-family adjacency map maintained by the client** (e.g. BPC-157 ↔ TB-500 is a known stack), not a mined one. This is a case where a lookup table beats a model and the wizard should say so rather than pretending to have learned it.

### 3.6 Negative segments — the exclusion layer

This is the part of segmentation that actually protects revenue, and it is the part every wizard UI under-builds. **Exclusions must be applied as a mandatory final filter on every campaign, not as an optional checkbox.**

```sql
-- Universal suppression list. Every campaign audience LEFT JOINs against this
-- and drops matches. No exceptions, no per-campaign override for the first four.
CREATE OR REPLACE VIEW sms_suppressed AS

-- 1. HARD LEGAL — never overridable
SELECT phone, 'opted_out'      AS reason FROM sms_contacts WHERE opted_out IS TRUE
UNION ALL
SELECT phone, 'no_consent'     AS reason FROM sms_contacts WHERE consent_at IS NULL

-- 2. HARD OPERATIONAL — never overridable
UNION ALL
SELECT phone, 'undeliverable'  AS reason
FROM (
  SELECT contact_phone AS phone,
         COUNT(*) FILTER (WHERE status IN ('failed','undelivered')) AS fails,
         COUNT(*) AS total
  FROM sms_messages
  WHERE direction = 'outbound' AND created_at > now() - interval '90 days'
  GROUP BY contact_phone
) d
WHERE fails >= 3 AND fails::float / NULLIF(total,0) > 0.5

-- 3. RECENT PURCHASER — do not sell to someone who just bought
UNION ALL
SELECT DISTINCT contact_phone, 'recent_purchaser'
FROM sms_orders
WHERE status IN ('processing','completed','shipped','delivered')
  AND created_at > now() - interval '10 days'

-- 4. FREQUENCY CAP — the per-contact budget from §4
UNION ALL
SELECT contact_phone, 'frequency_cap'
FROM sms_messages
WHERE direction = 'outbound'
  AND created_at > now() - interval '30 days'
GROUP BY contact_phone
HAVING COUNT(*) >= :monthly_cap

-- 5. COOLDOWN — minimum spacing between any two marketing messages
UNION ALL
SELECT DISTINCT contact_phone, 'cooldown'
FROM sms_messages
WHERE direction = 'outbound'
  AND created_at > now() - interval '48 hours'

-- 6. ALREADY IN AN ACTIVE FLOW — prevents flow collision
UNION ALL
SELECT DISTINCT contact_phone, 'in_active_flow'
FROM sms_scheduled
WHERE send_at > now() AND status = 'pending'

-- 7. FATIGUE RISK — received a lot, never engaged, never bought
UNION ALL
SELECT contact_phone, 'fatigue_risk'
FROM sms_messages
WHERE created_at > now() - interval '60 days'
GROUP BY contact_phone
HAVING COUNT(*) FILTER (WHERE direction = 'outbound') >= 6
   AND COUNT(*) FILTER (WHERE direction = 'inbound')  = 0
   AND NOT EXISTS (
     SELECT 1 FROM sms_orders o
     WHERE o.contact_phone = sms_messages.contact_phone
       AND o.created_at > now() - interval '60 days'
   );
```

Reasons 1–2 are absolute. Reasons 3–7 should be **overridable only by a human, with the override logged**, and the wizard should surface the count it is suppressing and why: *"Audience 214 → 137 after exclusions: 41 recent purchasers, 22 frequency-capped, 9 opted out, 5 in an active flow."* That single line does more for operator trust than any projection.

**The recent-purchaser exclusion deserves emphasis.** For a consumable catalogue, the *only* thing worse than not sending a replenishment message is sending one to somebody who reordered yesterday. It signals the system does not know its own customers, and it is the fastest route to the client losing confidence in the tool.

---

## 4. Send frequency and fatigue

### 4.1 What the evidence actually says — and where it contradicts itself

| Claim | Source | Note |
|---|---|---|
| RPS peaks at **6–8 messages/month**; opt-outs don't rise until **10–15/month** | [Attentive, 25B messages](https://www.attentive.com/blog/best-time-to-send-sms-marketing) | Attentive bills per message. This is the number that maximises their revenue. |
| Median cadence in the wild is **1.91 msgs/subscriber/month**; p75 3.84; p90 6.65 | [Postscript, 17k Shopify stores, 2025](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026) | **Observed behaviour, not advice — the most trustworthy figure here.** |
| **56% of US consumers unsubscribe at 4+ messages/30 days** from one company | consumer survey, cited [omnisend](https://www.omnisend.com/blog/sms-frequency/) | Survey self-report; people overstate intolerance. But directionally opposite to Attentive. |
| 2–4 campaigns/month is the sustainable baseline; 6+/month raises opt-outs without proportional revenue | [omnisend](https://www.omnisend.com/blog/sms-frequency/) | Omnisend also bills per send, and still recommends less than Attentive |
| At 10+/month, opt-out reaches **0.71%/send (3.4%+/month)** | [digitalapplied](https://www.digitalapplied.com/blog/sms-marketing-statistics-2026-open-ctr-data) | Aggregator, primary source unclear `[UNVERIFIED]` |
| Per-send opt-out averages **0.42%**; monthly cumulative attrition ~1.7% | aggregated Klaviyo/Postscript, via [digitalapplied](https://www.digitalapplied.com/blog/sms-marketing-statistics-2026-open-ctr-data) | |
| **61% of opt-outs cite "too many messages"** | [omnisend](https://www.omnisend.com/blog/sms-frequency/) | |
| Subscriber-level caps of 4–6/month cut opt-outs **28%** vs campaign-level caps at the same total volume | via [digitalapplied](https://www.digitalapplied.com/blog/sms-marketing-statistics-2026-open-ctr-data) | Primary source not locatable `[UNVERIFIED]` — but the mechanism is sound and the finding is the most actionable one here |

**The contradiction, stated plainly:** Attentive says opt-outs are flat until 10–15/month. Consumer survey data says a majority unsubscribe at 4+. Observed median behaviour across 17,000 stores is 1.91/month. **The median store sends one-fifth of what the largest vendor says is optimal.** Either 17,000 merchants are leaving money on the table, or the vendor's optimum is computed on a revenue objective that ignores list depletion. The second explanation requires fewer assumptions.

Note also that Attentive's "revenue per send peaks at 6–8" is measured on their customer base, which skews to large enterprise lists with continuous acquisition replacing churned subscribers. **A 390-person list with low acquisition velocity cannot outrun attrition.** At 1.7% monthly attrition and near-zero new opt-ins, Vici's list halves in about 40 months at *normal* cadence. At an aggressive cadence it halves in under two years. The list is a depleting asset and must be treated as one.

### 4.2 The per-contact message budget — token bucket

Global campaign-level caps are the wrong abstraction: they cap the *campaign*, but a contact who qualifies for five different campaigns still gets five messages. The cap must live on the contact.

```
Per contact:
  capacity     B = 4 messages          (bucket size — max burst)
  refill_rate  R = 4 messages / 30 days
  cooldown       = 48 hours minimum between marketing messages

Exempt from the bucket (transactional, expected, requested):
  - order confirmation
  - shipping / delivery notification
  - order problem (failed, on hold)
  - back-in-stock (the contact explicitly requested this specific alert)
  - any reply in an active two-way conversation

Consumes from the bucket:
  - replenishment
  - win-back
  - review request
  - cross-sell / promotional
  - broadcast campaigns
```

Exempting back-in-stock is a deliberate call: the recipient asked for that specific message about that specific product, it converts at 6–14.3%, and treating it as promotional means a high-value requested message gets dropped in favour of a lower-value one.

**Contention resolution.** When two flows want the same contact's last token, rank by expected value per message:

```
priority = p_flow × AOV_segment × (1 − attribution_haircut)
```

Replenishment for a tight-CV customer will beat a generic promo on this metric essentially always, which is the correct outcome.

**Tiered caps by engagement** (mapping Klaviyo's guidance onto the budget):

| Engagement tier | Monthly cap | Rationale |
|---|---|---|
| `engaged` (inbound reply <30d) | 6 | They talk back; they tolerate more |
| `less_engaged` (reply 30–90d) | 3–4 | Klaviyo's explicit recommendation for this tier |
| `unengaged` / `never_responded` | 2 | Transactional + at most one marketing message |
| `fatigue_risk` (§3.6) | 0 marketing | Transactional only |

### 4.3 What a global cap looks like at platform scale

At Attentive/Postscript scale the pattern is: quiet hours enforced at the platform layer with per-state overrides; subscriber-level frequency caps configurable per account; campaign-level caps as a secondary guard; "smart sending" style suppression that silently drops a contact from a send if they received anything within a window; and tiered sending that ships to the most-engaged cohort first so deliverability reputation is established before the long tail ([Attentive deliverability guidance](https://help.attentivemobile.com/hc/en-us/articles/18936132271636-Maintain-and-improve-email-deliverability-with-segmentation-best-practices)).

**The one to copy is silent suppression, not a blocking error.** When a contact is capped, the platform excludes them and reports the exclusion — it does not fail the campaign. The operator sees "sent to 137 of 214, 22 frequency-capped" and moves on.

**Additional hard cap for Vici specifically:** Florida's mini-TCPA limits marketers to **3 contact attempts (call or text) within a rolling 24-hour period, and this applies across different sending numbers** ([activeprospect](https://activeprospect.com/blog/tcpa-calling-hours/), [Klaviyo on Florida's mini-TCPA](https://help.klaviyo.com/hc/en-us/articles/4405332994843)). That is a statutory cap, not a best practice, and it must be enforced in code for FL contacts.

---

## 5. Revenue projection

### 5.1 The formula

```
E[R] = N_eligible × d × p × AOV_segment × (1 − h)

  N_eligible  = audience size AFTER all exclusions (§3.6)
  d           = delivery rate           (measure from sms_messages.status; ~0.95 typical)
  p           = conversion rate per delivered message, for this flow × this segment
  AOV_segment = mean order value of that segment's historical orders (not store-wide AOV)
  h           = attribution haircut     (see §0.1; default h ≥ 0.3, i.e. keep ≤ 70%)
```

Use `AOV_segment`, never store AOV. A win-back audience and a champion audience have different basket sizes, and using a blended AOV systematically over-projects the low-value segments and under-projects the high-value ones.

### 5.2 Where `p` comes from — empirical Bayes, not the raw rate

The first time a flow runs there is no history. The tenth time there is a little. Neither the industry benchmark alone nor the observed rate alone is right.

```
Beta prior from the benchmark:
   prior_mean  μ₀ = benchmark CR for this flow    (e.g. 0.015)
   prior_strength s = 100 pseudo-sends            (deliberately weak)
   α₀ = μ₀ · s = 1.5
   β₀ = (1 − μ₀) · s = 98.5

Posterior after observing k conversions in n sends:
   p̂ = (k + α₀) / (n + α₀ + β₀)
```

Worked: first replenishment campaign, 150 sends, 0 conversions.
- Raw rate: 0/150 = **0%**. Projecting $0 forever is wrong.
- Posterior: (0 + 1.5) / (150 + 100) = **0.60%**. Pulled down from the 1.5% prior by real evidence, but not to zero.

After 6 campaigns, 900 sends, 18 conversions: raw 2.0%, posterior (18+1.5)/(900+100) = **1.95%**. The prior has correctly faded.

This is the right machinery precisely *because* Vici's list is small: it degrades gracefully from "we know nothing" to "we know something" without ever producing an absurd point estimate.

### 5.3 The confidence interval — and it is much wider than anyone shows

Revenue is a compound random variable: a binomial number of orders, each of random value.

```
K ~ Binomial(N, p)                      number of conversions
R = Σ Vᵢ  for i = 1…K                   V = order value, mean μ_v, sd σ_v

E[R]   = N · p · μ_v
Var[R] = N · p · ( σ_v² + (1 − p) · μ_v² )
SE[R]  = √Var[R]
```

**Worked example — a realistic Vici replenishment campaign:**

```
N = 200 deliverable, p = 0.02, μ_v = $150, σ_v = $60

E[R]   = 200 × 0.02 × 150                          = $600
Var[R] = 200 × 0.02 × (60² + 0.98 × 150²)
       = 4 × (3,600 + 22,050) = 4 × 25,650         = 102,600
SE[R]  = √102,600                                  ≈ $320

95% interval (sampling variation only):  $600 ± $628  →  [$0, $1,228]
```

**That is before accounting for uncertainty in `p` itself.** If `p = 0.02` was estimated from a prior campaign of 200 sends with 4 conversions, the Wilson 95% interval on `p` is roughly **[0.8%, 5.0%]**. Propagating that:

```
Lower: 200 × 0.008 × 150 =   $240   →  with sampling SE:  [$0,   $640]
Upper: 200 × 0.050 × 150 = $1,500   →  with sampling SE:  [$530, $2,470]

Honest combined interval:  ~$0 – $2,500 around a $600 point estimate.
```

**The interval spans a factor of roughly four to five.** Any wizard that displays "Projected revenue: $600" without that range is lying by omission.

**What the UI should show:**

> **Projected: $600** · likely range **$250 – $1,400** · *low confidence — based on 1 prior send of this flow (4 conversions from 200). This range will narrow after ~5 more campaigns.*

Show the point estimate, the range, the evidence base, and what would improve it. The last clause is what converts an uncomfortable admission into a product feature.

### 5.4 Statistical power at N ≈ 390 — the blunt version

**You cannot A/B test at Vici's list size. Not "it's hard" — you cannot.**

Standard two-proportion sample size:

```
n_per_arm = (z_{α/2} + z_β)² · [ p₁(1−p₁) + p₂(1−p₂) ] / (p₁ − p₂)²
```

To detect a **doubling** of conversion from 1.5% → 3.0%, at 95% confidence / 80% power:

```
(1.96 + 0.84)² = 7.84
p₁(1−p₁) + p₂(1−p₂) = 0.014775 + 0.0291 = 0.043875
(p₁ − p₂)² = 0.015² = 0.000225

n_per_arm = 7.84 × 0.043875 / 0.000225 ≈ 1,529
Total needed ≈ 3,060.   Vici has 390.   Shortfall: ~8×.
```

Run it the other way — what *can* be detected with 195 per arm?

```
MDE = √( 7.84 × 0.043875 / 195 ) ≈ 0.042  →  4.2 percentage points
```

On a 1.5% baseline that means **the only detectable result is a jump from 1.5% to ~5.7% — a near-4× lift.** No copy change, send-time change, or offer tweak produces a 4× lift. Anything the wizard would realistically test is invisible.

This aligns with the general guidance that email A/B tests want ~1,000+ per variant, and that lists under 10,000 should only test variables with large expected effects ([HubSpot](https://blog.hubspot.com/marketing/email-a-b-test-sample-size-testing-time), [Campaign Monitor](https://www.campaignmonitor.com/blog/email-marketing/a-b-testing-sample-sizes-explained/)).

**A full-list send:**

```
390 contacts × 0.95 delivered × 2% ≈ 7.4 expected orders.
Wilson 95% CI on 7/370 (1.89%) ≈ [0.9%, 3.8%]
Revenue at $150 AOV: point $1,110, honest range ~$500 – $2,100.
```

**Seven orders. The entire campaign result is seven data points.** One unusually large order moves the measured RPR by 30%.

### 5.5 What to do instead of A/B testing

1. **Pool across campaigns by flow type, not within campaigns.** Twelve replenishment sends over a year is 2,000+ messages. That is a testable unit; a single send is not.
2. **Sequential Bayesian updating**, per §5.2. Every campaign updates the posterior. No campaign is a "result".
3. **Test only structural changes, never cosmetic ones.** Send/don't-send. Offer/no-offer. Day 7/day 14. Things with plausible 2–4× effects.
4. **Use holdouts to measure incrementality rather than to compare variants.** A 15% holdout on a recurring flow, accumulated over a year, eventually answers the only question that matters — *does this flow cause revenue* — even though no single month does. Note this costs 15% of the flow's revenue and takes ~a year; say so up front.
5. **Report leading indicators as directional, not conclusive.** Reply rate and opt-out rate accumulate faster than conversions and are worth watching, but a 1-point reply-rate difference on 200 sends is noise too.

### 5.6 The uncomfortable conclusion

At 390 customers, **the binding constraint on Vici's SMS revenue is list size, not campaign quality.** Optimising message copy against a 390-person list is optimising a term that rounds to zero next to the term you are not touching. Postscript's median acquisition rate — new orders converting into SMS subscribers — is ~1.06%, p75 2.32%, p90 5.22% ([postscript](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026)). Moving Vici from median to p90 acquisition is a 5× list growth trajectory, which is worth more than every optimisation in this document combined.

**The wizard should say this to the operator.** A campaign tool that opens with "your list is the bottleneck, here is the opt-in capture you are missing" is more valuable — and more credible — than one that opens with a revenue projection it cannot support.

---

## 6. Timing

### 6.1 Time of day and day of week

From Attentive's analysis of 25 billion messages ([attentive.com](https://www.attentive.com/blog/best-time-to-send-sms-marketing)):

| Metric | Best window |
|---|---|
| Revenue per send | **4pm – 7pm** local |
| Click-through rate | **12pm – 3pm** local (lunch availability) |
| Revenue per send, by day | **Monday and Tuesday** |
| CTR, by day | **Tuesday and Thursday** |

Vendor-published and enterprise-skewed, but it is the largest dataset available and the CTR/revenue split (clicks at lunch, purchases in the evening) is mechanistically plausible rather than convenient, which is mild evidence for it.

**Caveat that matters more than the finding:** these are aggregate optima. They are also, by construction, the times *everyone else is sending*, because everyone reads the same blog post. On a shared attention channel, the published optimum is a crowded slot. `[UNVERIFIED — I have no data on SMS inbox competition effects, but the mechanism is well documented in email.]`

**For Vici specifically:** with 390 contacts and a projected ~7 orders per campaign, **time-of-day optimisation is unmeasurable and not worth the wizard's attention beyond avoiding obviously bad slots.** Default to 4–7pm local, do not offer send-time testing, do not present send time as a lever.

### 6.2 Quiet hours — legal floor first

**Federal TCPA:** 8:00am – 9:00pm **local time at the recipient's location** ([activeprospect](https://activeprospect.com/blog/tcpa-calling-hours/)).

**Stricter states — 8:00am – 8:00pm:** Florida, Oklahoma, Washington ([leadfriendly](https://www.leadfriendly.com/guides/tcpa-calling-hours-by-state), [Klaviyo on FL mini-TCPA](https://help.klaviyo.com/hc/en-us/articles/4405332994843)). Florida additionally caps contact attempts at **3 per rolling 24 hours across all your numbers**.

The state mini-TCPA landscape changes; verify the current list before each client onboarding rather than hardcoding it once.

**Also relevant to what the wizard may auto-send:** under the FCC revocation rules effective **11 April 2025**, consumers may revoke consent by **any reasonable means**, the words *stop, quit, revoke, opt out, cancel, unsubscribe, end* must all be honoured as revocation, and revocation must be processed within **10 business days** ([BCLP](https://www.bclplaw.com/en-US/events-insights-news/the-tcpas-new-opt-out-rules-take-effect-on-april-11-2025-what-does-this-mean-for-businesses.html), [Carlton Fields](https://www.carltonfields.com/insights/publications/2025/mastering-the-new-tcpa-opt-out-regulations)). A limited FCC waiver delayed the cross-message-type revocation requirement to **11 April 2026** ([Nixon Peabody](https://www.nixonpeabody.com/insights/alerts/2025/04/11/fcc-partially-delays-new-tcpa-consent-revocation-rules), [Carlton Fields](https://www.carltonfields.com/insights/publications/2025/fcc-delays-effective-date-of-tcpa-revocation-of-consent-rules)) — **which means as of this writing that waiver has expired and the full rule is in force.** Verify.

Telynx's current opt-out regex in `routes/webhook.js` covers stop/stopall/unsubscribe/cancel/end/quit/opt-out plus several natural-language phrasings — that is broader than the FCC's enumerated list and is the right posture. Note that the FCC standard is "any reasonable means", so a regex will always under-match; unmatched inbound messages that a human would read as opt-outs need to reach a human.

### 6.3 Timezone per contact — do not use the area code

Area-code-derived timezone is unreliable and the reason is structural, not incidental: local number portability means a number's NPA-NXX no longer reliably indicates the serving switch, let alone the subscriber's residence ([Wikipedia: LNP](https://en.wikipedia.org/wiki/Local_number_portability)). People move states and keep their number. In the mobile era this is the norm, not the exception.

**Resolution ladder for Vici:**

1. **`sms_contacts.state`** — populated from WooCommerce billing address at order time. This is the shipping destination, i.e. where the person actually is. **Use this first.** It is already in the schema and it is the best signal available.
2. `sms_contacts.city` + `state` for the states split across two zones (FL, TX, KS, NE, ND, SD, MI, IN, KY, TN, OR, ID). Ship a city→timezone table; do not guess.
3. Observed reply timestamps — the distribution of a contact's inbound message times is a real behavioural signal `[UNVERIFIED as a production technique, but it is cheap and self-correcting]`.
4. Area code — **last resort only**.
5. Unknown → the universal-safe window below.

**The universal-safe window, derived:**

If you send at time *T* in US Eastern and do not know the recipient's zone:

```
Pacific recipient sees T − 3h.  Need ≥ 8:00am  →  T ≥ 11:00 ET
Eastern recipient sees T.       Need ≤ 8:00pm  →  T ≤ 20:00 ET   (FL/WA 8pm rule)

Continental US safe window:  11:00 – 20:00 ET

Including Alaska (ET − 4):      T ≥ 12:00 ET
Including Hawaii  (ET − 5/−6):  T ≥ 13:00 / 14:00 ET

Bulletproof all-50-state window:  14:00 – 20:00 ET
```

**Add a delivery-latency margin.** Carrier queuing means a message submitted at 19:55 ET can deliver after 20:00. Stop scheduling 15 minutes before the boundary. A 19:58 submission that lands at 20:03 in Florida is a statutory violation, and TCPA damages are $500–$1,500 *per message*.

**Also relevant:** replenishment and other predicted-date flows should have their send *date* chosen by the model but their send *time* snapped to the contact's safe local window by the scheduler. These are two separate decisions and conflating them is how quiet-hours violations happen.

---

## 7. What the AI wizard decides vs. what a human approves

### 7.1 The principle

Draw the line at **reversibility × blast radius**, not at difficulty.

An SMS is irreversible (you cannot unsend), costs real money per unit, carries statutory damages of $500–$1,500 per violating message, and can get a 10DLC campaign filtered by carriers with no practical appeal. Meanwhile the *upside* of full autonomy at Vici's scale is small: we established in §5.6 that campaign optimisation is not the binding constraint. **The expected value of removing the human is negative.** That is the whole argument, and it does not depend on any view about model capability.

### 7.2 The line

**The AI decides autonomously (no approval, logged and auditable):**

| Decision | Why it is safe |
|---|---|
| Translating a stated intent into segment SQL | Deterministic, previewable, reversible before send |
| Computing audience size and running all exclusions | Purely mechanical |
| Computing predicted depletion dates and replenishment windows | Maths, shown with its confidence interval |
| RFM / lifecycle / engagement classification | Recomputed nightly; wrong labels cost nothing until a send |
| Revenue projection with intervals | An estimate, not an action |
| Send-time selection **within** an already-approved quiet-hours window | Bounded by a hard constraint |
| Per-contact scheduling and staggering across the window | Mechanical |
| Enforcing frequency caps and cooldowns | Constraint enforcement, always safe to be conservative |
| Flow-contention priority ranking | Bounded by the cap that already exists |
| Drafting message copy | Output goes to a human before it goes to a phone |
| Suggesting which flow to build next | Advisory |
| Post-send analysis, posterior updates, anomaly flags | Read-only |

**A human must approve, every time, no exceptions at Vici's scale:**

| Decision | Why |
|---|---|
| **Any message copy that reaches more than one person** | Irreversible; one bad phrase is a compliance event |
| **Any discount, offer, or price claim** | Direct margin impact; the model has no view of unit economics |
| **The audience, previewed as actual names and counts** | The operator knows things the data does not — who complained last week, who is a wholesale account |
| **Turning a new flow on for the first time** | A flow is a standing commitment, not a one-off |
| **Any override of an exclusion in §3.6 reasons 3–7** | Overriding a suppression is the highest-risk action in the system |
| **Any list-wide send** | At 390 contacts every broadcast touches the entire business |
| **Any message mentioning a product's effects, use, dosing, or protocol** | §2.6 — this is the one that can end the client |
| **Changing quiet hours, caps, or consent handling** | Configuration with legal force |

**Never, under any circumstance, by the AI:**

- Marking a contact as consented, or reversing an opt-out
- Removing STOP/HELP language from a message
- Sending outside the computed legal window
- Modifying the `sku → supply_days` table
- Suppressing a delivery failure or compliance alert from the operator

### 7.3 Graduated autonomy — how the line should move

The line above is right *for Vici today*. It should be a function of evidence, not a permanent policy:

| Stage | Condition | What unlocks |
|---|---|---|
| 0 — today | Any new client, any new flow | Everything approved. Human sees copy + audience + projection. |
| 1 | A flow template approved unchanged **5 consecutive times**, zero compliance flags | Auto-send that flow to individuals as they trigger; human reviews a weekly digest |
| 2 | Flow at stage 1 for 90 days, opt-out rate < 0.5%/send, list > 2,000 | Auto-send with variable substitution; human approves template changes only |
| 3 | List > 10,000, holdout-measured positive incrementality | Auto-optimise send time and sequencing within the template |

**Copy for a new template never auto-sends, at any stage.** The template is the unit of approval; the sends within it are the unit of automation. That distinction is what makes graduated autonomy safe — a human always approved the exact words, just not the exact moment.

### 7.4 Two design consequences for the wizard UI

1. **The approval screen must show the exclusion breakdown, not just the final count.** "214 → 137" with reasons is the artefact that builds operator trust in the automation. A bare "137 recipients" invites the operator to wonder what was dropped and why, and the answer to that wondering is usually to stop using the tool.

2. **The projection must lead with its confidence, not its point estimate.** For Vici, most projections will be low-confidence, and the wizard that says so will keep the client. The wizard that shows a confident $600 and delivers $180 twice in a row will not.

---

## 8. Open questions and what to verify before building

1. **Does Telnyx link-click tracking exist in Telynx?** If not, all click-based engagement segmentation is unavailable and §3.4 must run on replies + orders only. **Blocking for the segmentation model.**
2. **Confirm the `sms_contacts` opt-out column name and whether `consent_at` exists.** §3.6 depends on both.
3. **Are ShipStation `delivered` events persisted with timestamps?** Replenishment (§2) and review requests (§1.7) both anchor on delivery, not order date. **Blocking for replenishment.**
4. **Pull the actual distribution of inter-purchase gaps from `sms_orders` before committing to any of §2's constants.** Every number in §2.3 is a heuristic pending Vici's own data. Compute: total customers with ≥2 orders, total gaps, median gap, CV distribution, and gaps-per-SKU. That query is a day's work and it determines whether replenishment is viable at all.
5. **Vici must author the `sku → supply_days` table.** Do not build the flow without it, and do not let a model populate it (§2.2).
6. **Legal review of replenishment copy** against the research-use framing before a single message sends (§2.6).
7. **Re-verify the state mini-TCPA list and the FCC revocation waiver status** as of the build date (§6.2).
8. **Establish the attribution haircut with the client explicitly**, in writing, before showing any projection (§0.1).
9. **Client B (ocean-safety school) is not covered here.** Courses are not consumable, so replenishment does not apply; the relevant flows are pre-course reminders, waitlist/back-in-stock for full cohorts, post-course certification follow-up, and seasonal re-enrolment. Different taxonomy, different maths — separate document.

---

## Sources

- [Klaviyo — 2026 SMS Marketing Benchmarks](https://www.klaviyo.com/products/sms-marketing/benchmarks)
- [Klaviyo Help — Campaign SMS and MMS benchmarks](https://help.klaviyo.com/hc/en-us/articles/360051110111)
- [Klaviyo Help — Understanding Klaviyo's predictive analytics](https://help.klaviyo.com/hc/en-us/articles/360020919731)
- [Klaviyo Help — Understanding Florida's mini-TCPA](https://help.klaviyo.com/hc/en-us/articles/4405332994843)
- [Klaviyo Academy — Improve SMS engagement with segmentation](https://academy.klaviyo.com/en-us/courses/build-an-sms-marketing-strategy/lessons/improve-sms-engagement-with-segmentation)
- [Klaviyo Academy — Build your engaged segments](https://academy.klaviyo.com/en-us/courses/strengthen-your-sender-reputation/lessons/build-your-engaged-segments)
- [Postscript — SMS Marketing Benchmarks 2026](https://postscript.io/blog/sms-marketing-benchmarks-what-good-performance-looks-like-in-2026)
- [Omnisend — SMS Marketing Conversion Rate benchmarks](https://www.omnisend.com/blog/sms-marketing-conversion-rate/)
- [Omnisend — SMS Marketing Frequency](https://www.omnisend.com/blog/sms-frequency/)
- [Omnisend — Abandoned cart SMS timing](https://www.omnisend.com/blog/abandonment-sms/)
- [Attentive — Best times to send SMS (25B messages)](https://www.attentive.com/blog/best-time-to-send-sms-marketing)
- [Attentive — Sunset policy guide](https://www.attentive.com/blog/sunset-policy-guide)
- [Attentive — Deliverability segmentation best practices](https://help.attentivemobile.com/hc/en-us/articles/18936132271636-Maintain-and-improve-email-deliverability-with-segmentation-best-practices)
- [BS&Co — Klaviyo flow benchmarks (n=14 brands)](https://bsandco.us/blog-post/klaviyo-flow-benchmarks)
- [Eightx — Win-back and reactivation rate benchmarks](https://eightx.co/blog/average-win-back-reactivation-rate-benchmarks)
- [Finsi — Win-back email campaign guide](https://www.finsi.ai/blog/win-back-email-campaign-guide/)
- [Finsi — Repeat purchase rate benchmarks](https://www.finsi.ai/blog/repeat-purchase-rate-ecommerce/)
- [Judge.me — Review request timing](https://judge.me/blog/review-requests-4-key-points-to-get-more-responses-and-better-reviews)
- [SmartSMSSolutions — Best time to request reviews](https://smartsmssolutions.com/resources/blog/best-time-to-request-reviews)
- [AI Advantage Agency — Replenishment emails](https://aiadvantageagency.com/replenishment-emails-for-ecommerce/)
- [WebMedic — Product refill campaigns](https://webmedic.com/refill-campaign)
- [reOtter — The second purchase problem](https://reotter.com/blog/second-purchase-problem-dtc-brands)
- [ATTN Agency — SMS abandoned cart recovery](https://www.attnagency.com/blog/sms-abandoned-cart-recovery)
- [DigitalApplied — SMS marketing statistics 2026](https://www.digitalapplied.com/blog/sms-marketing-statistics-2026-open-ctr-data)
- [ActiveProspect — TCPA calling hours](https://activeprospect.com/blog/tcpa-calling-hours/)
- [LeadFriendly — TCPA calling hours by state](https://www.leadfriendly.com/guides/tcpa-calling-hours-by-state)
- [BCLP — TCPA opt-out rules effective April 11 2025](https://www.bclplaw.com/en-US/events-insights-news/the-tcpas-new-opt-out-rules-take-effect-on-april-11-2025-what-does-this-mean-for-businesses.html)
- [Carlton Fields — Mastering the new TCPA opt-out regulations](https://www.carltonfields.com/insights/publications/2025/mastering-the-new-tcpa-opt-out-regulations)
- [Nixon Peabody — FCC partially delays consent revocation rules](https://www.nixonpeabody.com/insights/alerts/2025/04/11/fcc-partially-delays-new-tcpa-consent-revocation-rules)
- [10dlccheck — CTIA guidelines explained](https://10dlccheck.com/learn/ctia-guidelines-explained)
- [Infobip — A2P 10DLC guide 2026](https://www.infobip.com/blog/what-is-a2p-10dlc)
- [HubSpot — A/B testing sample size](https://blog.hubspot.com/marketing/email-a-b-test-sample-size-testing-time)
- [Campaign Monitor — A/B testing sample sizes explained](https://www.campaignmonitor.com/blog/email-marketing/a-b-testing-sample-sizes-explained/)
- [CLVTools — BG/NBD model documentation](https://rdrr.io/cran/CLVTools/man/bgnbd.html)
- [Wikipedia — Local number portability](https://en.wikipedia.org/wiki/Local_number_portability)
- [DosingCalc — BPC-157 / TB-500 dosing reference](https://dosingcalc.com/guides/bpc-157-tb-500-research-guide-dosing)
- [Peptides.org — BPC-157 dosage](https://www.peptides.org/bpc-157-dosage/)
