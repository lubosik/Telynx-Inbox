# 05 — Revenue Attribution and Campaign Testing

**Scope:** how revenue attribution and campaign testing should actually work for the Telynx Inbox AI campaign wizard, at our real scale.
**Reference client:** Vici Peptides. ~390 contacts in `sms_contacts`, WooCommerce store syncing into Supabase Postgres (`sms_orders`), outbound via Telnyx, two-way inbox plus voice.
**Current state:** no revenue attribution exists. The dashboard shows $0 because nothing is tracked.
**Date:** 2026-08-11.

> **The one-sentence version.** We can build honest, deterministic *click-to-order* attribution and it will be genuinely useful. We cannot, at 390 contacts, prove *incremental* revenue for any single campaign — the minimum detectable effect is roughly a **tripling** of conversion rate — and any product that claims otherwise is lying. The buildable path is: deterministic attribution ledger with evidence grades, a permanent randomised holdout that accumulates across campaigns for 6–12 months, Bayesian testing on **clicks** rather than dollars, and a dashboard that shows intervals instead of a fake number.

---

## Table of contents

1. [Attribution models for SMS, and how the incumbents overstate](#1)
2. [Holdout groups — the honest answer, with the maths](#2)
3. [A/B testing at small n](#3)
4. [Technical attribution plumbing and the data model](#4)
5. [The tricky cases](#5)
6. [Metrics that matter — exact formulas and denominator gotchas](#6)
7. [The campaign test suite spec](#7)
8. [Dashboard spec — presenting uncertainty honestly](#8)
9. [Build order](#9)
10. [Sources](#10)

---

<a name="1"></a>
## 1. Attribution models for SMS, and how the incumbents overstate

### 1.1 The model zoo

Attribution models are **labelling rules**, not measurements. Each one is an arbitrary convention for assigning a conversion to a prior touch. None of them contains any notion of the counterfactual — "would this person have bought anyway?" — which is the only question a business actually cares about.

| Model | Rule | What it is good for | Failure mode for SMS |
|---|---|---|---|
| **Last-click** | Credit the last *clicked* touch before conversion within window W | Operational: which link actually delivered the session | Selects on intent. People who click were already the likeliest buyers. Credits the messenger for the purchase. |
| **Last-touch** | Credit the last *known* touch (click **or** delivery/open) within W | Nothing defensible | Delivery is not an action the recipient took. If you text the whole list, every organic order gets a touch. Systematically the worst offender. |
| **First-touch** | Credit the first touch in the journey | Acquisition/prospecting analysis | Useless for a 390-person list of existing buyers — first touch is usually "bought something two years ago". |
| **Linear** | Split credit equally across all touches in W | Cross-channel diplomacy | Makes SMS look smaller, but it is equally uncausal. Splitting fake credit does not make it real. |
| **Position-based (U-shaped 40/20/40)** | 40% first, 40% last, 20% spread | Reporting politics | Same objection. The weights are invented. |
| **Time-decay** | Exponentially weight recency | Marginally better than last-touch | Still uncausal. Decay half-life is invented. |
| **Incrementality / randomised holdout** | Randomly withhold the message from a control group; incremental revenue = (revenue per recipient in treated) − (revenue per recipient in control) × N_treated | **The only model that answers the business question** | Requires sample size we do not have per-campaign. See §2. |
| **Media mix modelling (MMM)** | Regress aggregate revenue on aggregate spend by channel | Big spenders, many channels, years of weekly data | Needs 100+ periods of variation. Completely inapplicable at our scale. Do not build it. |

**The only two things worth building:** deterministic last-click for *operational* attribution (which is honest if labelled honestly), and randomised holdout for *incremental* measurement (which is the only thing that can be called "how much money this makes").

### 1.2 What the incumbents actually do — documented defaults

**Postscript** ([help.postscript.io](https://help.postscript.io/en/articles/13563857-customize-your-attribution-windows))

- Default: **7-day click window and 24-hour view window.**
- Their own description of the view window: a 7-day click and 24-hour view attribution window "will accredit any sales from a subscriber who received a text **up to 24 hours after the text was sent — regardless of whether they ordered through the shop link or not** — to your SMS program."
- Coupon override: "If an order includes a Postscript coupon, **even outside of your designated attribution window**, that order is attributed to SMS."

**Attentive** ([help.attentive.com](https://help.attentive.com/hc/en-us/articles/7050482152212-FAQs-Attentive-s-attribution-model), [configure attribution settings](https://help.attentive.com/hc/en-us/articles/37873174009620-Configure-your-attribution-settings))

- Model: **last-known-touch** within a window.
- As of **21 July 2025**, Attentive moved to a **rolling 24-hour** window as their stated industry-best-practice default — the 24-hour click window starts at the moment the subscriber clicks. This is a genuine tightening versus the multi-day windows that were previously common.
- Both **click and view** attribution exist; view attribution can be dismissed in the UI to see clicks only.
- Changing your attribution settings **recalculates historical conversion data**.
- *(Attentive's help centre returns HTTP 403 to automated fetches; the above is from search-result extraction of those pages rather than a direct read. Treat the precise per-touchpoint default table as [UNVERIFIED] and re-check in the live UI before quoting it to a customer.)*

**Klaviyo** ([Understanding Klaviyo message attribution](https://help.klaviyo.com/hc/en-us/articles/1260804504250), [attribution model updates blog](https://www.klaviyo.com/blog/introducing-attribution-model-updates-to-reporting))

- Default model: **last touch**.
- Defaults for accounts created after **9 October 2024**:
  - Email click: **5 days**
  - Email open: **5 days**
  - SMS click: **5 days**
  - SMS open: **1 day**
  - **Delivered SMS: optional touchpoint, 12-hour default window** (some Klaviyo material states the default as 1 day — the two figures appear in different documents; treat the exact figure as [UNVERIFIED] and read it out of the account)
  - Push open: **24 hours**
  - WhatsApp click: 5 days
- Stated rationale for crediting *delivered* SMS with no click: "Consumers typically open every text they receive."
- Cross-channel: a single order is attributed to one message — the last qualifying touch. Klaviyo's own docs warn "it's important to be mindful of both your email and SMS attribution window settings together."
- Klaviyo shipped **bot-click filtering** in August 2024 and is rolling out an optional **linear multi-touch** model for CDP customers.

### 1.3 The mechanisms of overstatement — specifically

These are not vague complaints. Each is a concrete arithmetic mechanism.

**(a) View / delivered attribution manufactures revenue out of nothing.**
This is the big one. Postscript's default 24-hour view window and Klaviyo's optional delivered-SMS touchpoint credit purchases where the recipient *took no action at all*. The mechanism: let `q` be the probability that a given list member places an organic order in a 24-hour period. If you message all `N` members, you harvest `N · q` attributed orders per send that would have happened regardless.

For Vici: if the 390-person list organically generates ~60 orders/month, that is `q ≈ 60 / (390 × 30) ≈ 0.51%` per person per day. A single blast to all 390 with a 24-hour view window auto-claims `390 × 0.0051 ≈ 2.0 orders ≈ $300` before the message has done anything. Send three times a week and the platform claims roughly **a quarter of all organic revenue from the list**, permanently, as SMS-driven. Widen the view window to 7 days and it claims essentially all of it.

**(b) Long click windows select on pre-existing intent.**
A 5-day or 7-day click window catches a large fraction of people who were going to buy this week anyway. Clicking is itself an intent signal — the click does not *cause* the intent, it *reveals* it. This is exactly the eBay result: Blake, Nosko & Tadelis ran large randomised experiments and found brand-keyword paid search had **no measurable short-term benefit**, and that returns to paid search overall were "a fraction of non-experimental estimates" ([Econometrica 83(1):155–174, 2015](https://onlinelibrary.wiley.com/doi/abs/10.3982/ECTA12423); [NBER w20171](https://www.nber.org/papers/w20171); [PDF](https://faculty.haas.berkeley.edu/stadelis/BNT_ECMA_rev.pdf)). Someone typing your brand name into Google is the search-ad analogue of someone clicking your SMS link: highly selected, already converting.

**(c) No deduplication across vendors.**
Each platform reports the revenue *it* can claim under *its own* window. Klaviyo dedupes inside Klaviyo. It does not dedupe against Attentive, Meta, Google, or against our SMS platform. If a customer gets an email and an SMS and clicks both, the same order appears in two dashboards at full value. Summing vendor-reported revenue routinely exceeds total store revenue. **We must never let our number be summed with another vendor's number without a warning.**

**(d) Coupon-code override outside the window.**
Postscript documents that an order carrying a Postscript coupon is attributed to SMS *even outside the attribution window*. Coupon codes leak — to coupon-aggregator sites, to browser extensions like Honey, to friends. Every leaked redemption becomes SMS revenue, forever.

**(e) Bot and security-scanner clicks.**
Carrier link scanners, enterprise security gateways, and link-preview fetchers hit URLs without a human. They inflate the clicker pool, which inflates the click-attributed denominator and pulls in incidental buyers. Klaviyo adding bot-click filtering in 2024 is a tacit admission of the size of this problem.

**(f) The settings are tunable and retroactive.**
Attentive recalculates historical conversion data when you change your attribution window. That is the tell. **A measurement does not change when you change a reporting preference.** An attribution number that you can dial up by moving a dropdown is a preference, not a fact.

**(g) The model has no counterfactual at all.**
Even with a perfect, deterministic, zero-second click window, last-click answers "which link did they come through" — not "did the message cause the purchase." For a list of 390 *existing customers of a repeat-purchase product* (peptides are a consumable), the base rate of "would have bought anyway" is very high. This is the single largest source of overstatement and no window setting can fix it.

### 1.4 What we will do

- **Ship last-click with a short default window (72 hours), configurable, and label it "click-attributed" everywhere.** Never "revenue driven by SMS."
- **Ship view/delivered attribution as a separate, off-by-default, visually de-emphasised line called "associated revenue (not attributed)."** Do not put it in any headline, ROI calculation, or exported total.
- **Ship holdouts as the only source of any number labelled "incremental."**
- Never sum across channels without an explicit overlap disclosure.

---

<a name="2"></a>
## 2. Holdout groups — the honest answer, with the maths

### 2.1 Why a randomised holdout is the only defensible measure

Incremental revenue is defined as a difference between a factual and a counterfactual:

```
Incremental revenue = E[Revenue | message sent] − E[Revenue | message not sent]
```

The second term is unobservable for any individual. Random assignment is the only mechanism that makes an *observable* group an unbiased estimator of it, because randomisation guarantees the control group is identical in expectation on every variable — observed, unobserved, and unmeasurable — including the one that matters most: latent purchase intent.

Every non-experimental alternative fails on the same point. Pre/post comparison confounds seasonality and promotional calendar. Clickers-vs-non-clickers confounds intent. Matching on RFM confounds unobserved intent. Regression control confounds anything you did not put in the model. There is no clever statistic that recovers a causal effect from a non-randomised SMS send. The holdout is not one option among several; it is the only one.

**Estimator.** With `N_t` treated and `N_c` held out, randomly assigned:

```
RPR_t   = Σ revenue(treated,  window) / N_t          (revenue per recipient, treated)
RPR_c   = Σ revenue(holdout,  window) / N_c          (revenue per recipient, holdout)

Incremental revenue  =  (RPR_t − RPR_c) × N_t
Incremental ROI      =  (Incremental gross margin − Cost) / Cost
```

Note the denominators are **assigned** counts, not delivered counts. Analyse by intention-to-treat: a recipient whose message failed to deliver stays in the treated arm. Dropping failures breaks randomisation, because delivery failure correlates with number quality which correlates with customer value.

### 2.2 Power analysis — our actual numbers

**Assumptions (stated so they can be argued with):**

| Parameter | Value | Basis |
|---|---|---|
| List size `N` | 390 | Vici `sms_contacts` |
| Baseline conversion in window, `p₀` | 3% | "a few percent"; sensitivity run at 1–8% below |
| AOV | $150 | "low hundreds"; sensitivity at $250 |
| Coefficient of variation of order value, `c_v` | 0.6 | plausible for a store where people buy 1–3 units — **[UNVERIFIED]**, compute from `sms_orders.total` before relying on it |
| Significance | α = 0.05, two-sided | |
| Power | 1 − β = 0.80 | |

**Formulas.** For a two-sample proportion test with `n₁` treated and `n₂` control, the required detectable difference `δ = p₁ − p₀` satisfies:

```
δ  =  (z_{1−α/2} + z_{1−β}) · sqrt( p₁(1−p₁)/n₁  +  p₀(1−p₀)/n₂ )
```

which inverts to the familiar sample-size form (unpooled, control-group size `n₂`, allocation ratio `k = n₁/n₂`):

```
n₂  =  (z_{1−α/2} + z_{1−β})² · [ p₁(1−p₁)/k + p₀(1−p₀) ] / δ²
```

with `z_{0.975} = 1.959964`, `z_{0.80} = 0.841621`, so `(z_{1−α/2} + z_{1−β})² = 7.848880`.

For a continuous outcome (revenue per recipient) with variance `σ²` and equal arms of size `n`:

```
δ_R  =  (z_{1−α/2} + z_{1−β}) · sqrt( 2σ² / n )
n    =  2 · 7.848880 · σ² / δ_R²
```

where for a zero-inflated revenue variable, `R = 1{convert} × V`:

```
E[R]    =  p · AOV
Var(R)  =  AOV² · [ p(1 + c_v²) − p² ]
```

Derivation of `Var(R)`: `E[R²] = p · E[V²] = p · AOV²(1 + c_v²)`, and `Var(R) = E[R²] − E[R]² = p·AOV²(1+c_v²) − p²AOV²`.

---

#### Result 1 — MDE on conversion rate for a single 390-person send

`p₀ = 3%`, normal approximation, 80% power, α = 0.05 two-sided:

| Split | Treated | Held out | MDE `p₁` | Absolute lift | **Relative lift** | Expected conversions in control |
|---|---:|---:|---:|---:|---:|---:|
| 70/30 | 273 | 117 | 9.68% | +6.68 pp | **+223%** | 3.5 |
| **50/50** | **195** | **195** | **9.90%** | **+6.90 pp** | **+230%** | **5.9** |
| 80/20 | 312 | 78 | 10.24% | +7.24 pp | +241% | 2.3 |
| 90/10 | 351 | 39 | 12.07% | +9.07 pp | +302% | 1.2 |

**The normal approximation is optimistic here.** With ~6 expected events per arm it should not be trusted. A Monte-Carlo power simulation using **Fisher's exact test** (8,000 replicates per point, two-sided α = 0.05) gives:

```
p_treat =  9.90%  ->  power 76.4%     (normal theory claimed 80%)
p_treat = 10.35%  ->  power 80.1%     <- true 80%-power point
p_treat = 11.00%  ->  power 84.9%
p_treat = 12.00%  ->  power 91.5%
```

> **Honest headline #1.** With a 50/50 holdout on a 390-person list and a 3% baseline, a single campaign can only detect a lift if conversion goes from **3% to about 10.3%** — an absolute lift of **+7.3 percentage points**, a **relative lift of +245%**. The campaign must roughly **triple** the conversion rate before the test can see it. No SMS campaign does that. **Single-campaign holdouts on this list are theatre.**

Note also that the 90/10 holdout — the split every SMS vendor recommends because it "wastes" the fewest recipients — is the *worst* option. 39 controls yield 1.2 expected conversions. The control arm's variance dominates entirely and you learn nothing. **If you are going to hold out, hold out 50%. If you are not willing to hold out 50%, do not pretend the 10% holdout measures anything.**

#### Result 2 — base-rate sensitivity (50/50, 195 per arm, normal approx)

| Baseline `p₀` | MDE `p₁` | Absolute | Relative |
|---:|---:|---:|---:|
| 1% | 6.25% | +5.25 pp | +525% |
| 2% | 8.17% | +6.17 pp | +309% |
| 3% | 9.90% | +6.90 pp | +230% |
| 5% | 13.05% | +8.05 pp | +161% |
| 8% | 17.35% | +9.35 pp | +117% |

Relative MDE improves as the base rate rises, but never gets below "you must roughly double it". There is no baseline conversion rate at which a 390-person single-campaign holdout becomes useful.

#### Result 3 — the revenue metric is *worse* than the conversion metric

Using `p₀ = 3%`, AOV = $150, `c_v = 0.6`:

```
Var(R) = 150² × [0.03 × 1.36 − 0.03²] = 22,500 × 0.0399 = 897.75
SD(R)  = $29.96
E[R]   = $4.50
CV     = 29.96 / 4.50 = 6.66
```

A coefficient of variation of 6.7 on the per-person outcome is the whole problem in one number. Lewis & Rao make exactly this point across 25 large field experiments: individual-level sales are so volatile relative to per-capita ad spend that "a coefficient of variation of 10 is common", the median confidence interval on ROI is over **100 percentage points wide**, and informative experiments "can easily require more than 10 million person-weeks" ([QJE 130(4):1941–1973, 2015](https://academic.oup.com/qje/article-abstract/130/4/1941/1914592); [PDF](https://gwern.net/doc/economics/advertising/2015-lewis.pdf)).

Normal theory, 195 per arm:

```
δ_R = 2.801585 × sqrt(2 × 897.75 / 195) = 2.801585 × 3.0344 = $8.50 per recipient
```

But normal theory understates this badly because the revenue distribution has a heavy right tail. A Monte-Carlo simulation with lognormal order values (mean $150, cv 0.6), Welch t-test, 3,000 replicates per point:

```
true RPR lift $0.00  ->  power  3.9%   (i.e. the test is slightly conservative under the null — fine)
true RPR lift $4.50  ->  power 25.4%
true RPR lift $8.51  ->  power 57.1%   <- normal theory claimed 80%
true RPR lift $11.94 ->  power ~80%    <- true 80%-power point
```

> **Honest headline #2.** The true minimum detectable effect on revenue-per-recipient is **$11.94 against a $4.50 baseline — a +265% lift**. In absolute terms, the smallest incremental revenue a single 390-person campaign can prove is about **$2,300**, against a treatment arm whose *total* baseline revenue is only ~$878.
>
> **The revenue metric is less powerful than the binary conversion metric** (MDE +265% vs +245%) because order-value variance adds noise without adding signal. **Therefore: run the holdout test on the conversion indicator, not on dollars.** Report dollars descriptively; test on orders. (If you must test dollars, winsorise at the 95th percentile of the store's own order-value distribution first — the tail is pure noise.)

#### Result 4 — what a *realistic* campaign actually produces, versus the floor

A good promotional SMS to a warm buyer list plausibly lifts conversion by **+1 percentage point** (3% → 4%, a +33% relative lift — genuinely a strong campaign).

```
195 treated × 0.01  =  1.95 extra orders
1.95 × $150         =  $292 incremental revenue

Detection floor (one campaign, 50/50) = $2,329
$2,329 / $292 = 8.0
```

> **Honest headline #3.** A genuinely successful campaign produces about **$292** of incremental revenue. The detection floor is about **$2,329**. The real effect is **8× below the noise floor**. Not "borderline" — invisible.

#### Result 5 — how many campaigns until we can see anything

With a **permanent 50/50 holdout re-randomised every send**, each campaign contributes 195 observations per arm. Required per-arm `n` and campaign counts (conversion metric, `p₀ = 3%`, normal approximation, which is valid at these larger `n` because expected events per arm exceed 150):

| Target lift | Absolute | Relative | `n` per arm | **Campaigns at 195/arm** | Elapsed at 1/week | Elapsed at 2/month |
|---|---:|---:|---:|---:|---:|---:|
| 3% → 3.5% | +0.5 pp | +17% | 19,740 | **101** | 1.9 years | 4.2 years |
| 3% → 4.0% | +1.0 pp | +33% | 5,298 | **27** | 6.3 months | 14 months |
| 3% → 4.5% | +1.5 pp | +50% | 2,514 | **13** | 3.0 months | 6.5 months |
| 3% → 5.0% | +2.0 pp | +67% | 1,503 | **8** | 1.9 months | 4 months |
| 3% → 6.0% | +3.0 pp | +100% | 746 | **4** | 1 month | 2 months |

On the **revenue** metric the same targets need roughly 2× the sample (from the simulation's 1.97× inflation over normal theory), so +1 pp needs ~63 campaigns rather than 27.

> **Honest headline #4.** To prove that our SMS programme lifts conversion by one percentage point, at 80% power, we need roughly **27 campaigns with a 50/50 holdout** — about **six months of weekly sending**, or **over a year at a realistic two-sends-a-month cadence**. And that only proves it for the *programme in aggregate*, never for an individual campaign.

#### Result 6 — the ceiling, and why repeated measures make it worse

A full year of weekly sends with a 50/50 holdout gives 52 × 195 = 10,140 observations per arm:

```
δ_R = 2.801585 × sqrt(2 × 897.75 / 10,140) = $1.18 per recipient
    = 26% relative lift  =  0.79 pp on conversion rate
```

But those 10,140 observations are 52 repeated measurements on the same 195 people, not 10,140 independent people. The design effect for cluster-correlated repeated measures is:

```
DEFF = 1 + (m − 1)·ρ        m = observations per person = 52
                            ρ = intraclass correlation of purchase propensity
n_effective = n / DEFF
```

| ρ | DEFF | Effective `n`/arm | MDE on RPR | Relative |
|---:|---:|---:|---:|---:|
| 0.00 | 1.00 | 10,140 | $1.18 | 26% |
| 0.02 | 2.02 | 5,020 | $1.68 | 37% |
| 0.05 | 3.55 | 2,856 | $2.22 | 49% |
| 0.10 | 6.10 | 1,662 | $2.91 | 65% |

Purchase propensity is strongly person-specific in a repeat-purchase category, so ρ in the 0.05–0.15 range is realistic **[UNVERIFIED for Vici — estimate it from `sms_orders` history before quoting]**.

> **Honest headline #5.** Even after a full year of weekly sending with a 50/50 holdout, we can only detect roughly a **35–50% relative lift** in revenue per recipient. That is the ceiling for this client, ever, on this list size.

### 2.3 So what should a small-list operator actually do

Six things, in priority order. All are buildable.

**(1) Re-randomise the holdout every send and analyse within-person.**
Do *not* keep a fixed set of 39 people permanently excluded (which is also commercially unacceptable — you are permanently starving 10% of the list). Re-randomise every campaign. This turns the design into a **crossover**: each person is sometimes treated, sometimes control. Then analyse with person fixed effects:

```
revenue_{i,t} = α_i + β · treated_{i,t} + γ_t + ε_{i,t}
```

The person intercept `α_i` absorbs the between-person variance component, which is the dominant one when some customers buy 10× as often as others. This is a free and substantial precision gain and is the single highest-leverage statistical decision in the whole design. It also fixes the ρ problem above — within-person correlation stops being a penalty and becomes the source of the gain.

**(2) CUPED — covariate-adjust with pre-period revenue.**
Use each recipient's revenue in the 90 days *before* the campaign as a covariate:

```
R_adjusted = R − θ · (X − X̄)        where  θ = Cov(R, X) / Var(X)
Var(R_adjusted) = Var(R) · (1 − ρ_{R,X}²)
```

If pre-period and in-period revenue correlate at ρ = 0.4, variance drops 16%; at ρ = 0.6, 36%. Deng, Xu, Kohavi & Walker, *Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data*, WSDM 2013 ([PDF](https://exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf) — URL live, exact reported reduction percentages **[UNVERIFIED]**). This is a few lines of SQL and it is free power.

**(3) Test the programme, not the campaign.**
Pre-register one question — "does our SMS programme produce incremental revenue?" — and accumulate every send into it. Report a running estimate with a widening-then-narrowing interval and a **"measurable in ~N more sends"** progress indicator. Do not run a separate test per campaign. The wizard should say, before every send: *"This send contributes 1/27th of the evidence needed. It cannot be evaluated on its own."*

**(4) Prefer flows to campaigns for anything you want to learn from.**
Campaigns are one-shot: the whole list is exposed at once and the sample is capped at 390 forever. Flows (post-purchase, win-back, abandoned checkout, shipping) have **continuous arrivals** — every new order is a new randomisable unit. If Vici does ~60 orders/month, a post-purchase flow accumulates ~720 randomisable entrants per year with no list-size ceiling and no repeated-measures penalty. **Flows are where measurement is possible; campaigns are where it is not.** This should shape the product: the wizard should nudge users toward flows when the maths says a campaign is unmeasurable.

**(5) Pool across clients — hierarchical partial pooling.**
This is the strongest structural argument for building this as a *platform* rather than a tool. With `J` clients each running holdouts, fit a random-effects model:

```
logit(p_{jt}) = α_j + β_j · treated_{jt}
β_j ~ Normal(μ_β, τ²)
```

Each client's effect estimate shrinks toward the population mean by:

```
shrinkage weight  w_j = τ² / (τ² + σ_j²)
```

A client with huge `σ_j²` (Vici, at n=390) gets a posterior dominated by the cross-client prior `μ_β` — which is *correct*, and is enormously more informative than their own noisy estimate. Ten clients running holdouts produce a defensible estimate of "SMS win-back flows lift conversion by X%" that no individual client could ever produce. Vici then gets a *credible* number sooner, honestly labelled: *"Estimated from your data plus 9 comparable stores. Your own data alone would not support this yet."*

This requires: consistent metric definitions, consistent windows, and a per-client opt-in to contribute anonymised aggregates. Design for it from day one — retrofitting consistent definitions across clients later is painful.

**(6) Sequential / Bayesian monitoring instead of fixed-horizon peeking.**
Operators will look at the numbers every day. If you let them stop on a nominal p < 0.05 whenever they like, the actual type-I error rate is far above 5%. Two acceptable fixes:

- **Always-valid p-values / mSPRT** (Johari, Pekelis & Walsh, *Always Valid Inference: Continuous Monitoring of A/B Tests*, [Operations Research 70(3):1806–1821](https://pubsonline.informs.org/doi/pdf/10.1287/opre.2021.2135); [arXiv:1512.04922](https://arxiv.org/abs/1512.04922); [KDD'17 "Peeking at A/B Tests"](https://www.semanticscholar.org/paper/Always-Valid-Inference:-Bringing-Sequential-to-A-B-Johari-Pekelis/ff51ed3ad05067844da8d108a666bbdd4e900501)). Valid at any stopping time. Costs some power versus a fixed horizon, which is the price of being allowed to look.
- **Bayesian posterior with an expected-loss stopping rule** (§3.3). Easier to implement and easier to explain to a non-statistician.

Use the Bayesian version in the product UI and keep the frequentist holdout estimate as the "audited" number behind it.

**What we should refuse to do:** offer a per-campaign "incremental revenue: $X" number. It cannot be computed at this scale and offering it is the exact dishonesty we are differentiating against.

---

<a name="3"></a>
## 3. A/B testing at small n

### 3.1 When is an A/B test on 390 people meaningless

An A/B test is the same power calculation with both arms treated. Splitting 390 gives 195/195.

**On conversion / revenue:** identical to §2. MDE is +245% relative. **An A/B test of two message variants, judged on orders or revenue, on a 390-person list, is meaningless. Always. Under all circumstances.** Two subject lines do not differ by 245% in conversion. Any "winner" you observe is noise, and acting on it is worse than not testing, because you will systematically adopt whichever variant got lucky and then attribute the regression to the mean to "creative fatigue".

**On click rate it is marginal but not hopeless**, because click rates are an order of magnitude higher than conversion rates:

| Baseline CTR | MDE | Absolute | Relative |
|---:|---:|---:|---:|
| 8% | 17.35% | +9.35 pp | +117% |
| 10% | 20.04% | +10.04 pp | +100% |
| 12% | 22.63% | +10.63 pp | +89% |
| 15% | 26.38% | +11.38 pp | +76% |
| 20% | 32.35% | +12.35 pp | +62% |

At a 12% baseline you need roughly a **doubling** of CTR. A genuinely different hook — "Your peptide protocol is due for a refill" versus "20% off everything" — can plausibly do that. A punctuation change cannot.

> **Rule for the product.** A/B tests are permitted on **click rate only**. The UI must refuse to declare a revenue winner from a single 390-person split, and must say why.

**The caveat that must be shown alongside every CTR test:** click lift does not imply revenue lift. Discount-heavy copy reliably wins on clicks and can lose on margin. Every CTR winner must carry the label *"won on clicks; revenue effect unmeasured."*

### 3.2 Decision framework by list size

Implement this as a literal function in the wizard:

```
measurable_on(metric, n_per_arm, baseline):
    mde_rel = solve_mde(baseline, n_per_arm) / baseline
    if mde_rel > 1.5   ->  "NOT TESTABLE"  (refuse; explain)
    if mde_rel > 0.75  ->  "WEAK"          (Bayesian only, no frequentist claim)
    else               ->  "TESTABLE"
```

At n = 390 this returns NOT TESTABLE for conversion, WEAK for click rate. That is the correct answer and the product should say it out loud.

### 3.3 Bayesian A/B with informative priors — concrete spec

**Model.** Clicks are Binomial; use a conjugate Beta prior per variant.

```
prior_v  ~ Beta(α₀, β₀)
posterior_v | (k clicks, n delivered)  =  Beta(α₀ + k, β₀ + n − k)
```

**Prior selection — the recommendation.**

Set the prior mean to the client's own historical CTR and the prior's effective sample size (`ESS = α₀ + β₀`) to about **half of one campaign's per-arm sample**:

```
ESS = 100          (≈ half of 195)
α₀  = ESS × CTR_hist
β₀  = ESS × (1 − CTR_hist)
```

For a 12% historical CTR: **Beta(12, 88)**.

Prior selection ladder, in order of preference:

| Situation | Prior | ESS |
|---|---|---|
| Client has ≥ 5 prior campaigns | Beta(ESS·CTR_client, ESS·(1−CTR_client)) | 100 |
| Client has 1–4 prior campaigns | Blend client mean with cross-client mean, weight = n_client/(n_client+200) | 100 |
| New client, known vertical | Cross-client vertical posterior mean | 150 |
| New client, no vertical data | Beta(2, 13) — mean 13%, very weak | 15 |

**Never use Beta(1,1) at n=195.** The demonstration below shows why. With A = 20/195 and B = 31/195:

```
Beta(12,88) prior:  P(B > A) = 91.7%   expected loss of choosing B = 0.105 pp
Beta(1,1)  prior:  P(B > A) = 95.0%   expected loss of choosing B = 0.074 pp
```

The flat prior is 3.3 points more confident on identical data. At n=195 the prior is doing real work, and a flat prior is not "neutral" — it is an assertion that a 0.5% CTR and a 60% CTR are equally plausible, which is false and which manufactures overconfidence. The informative prior is the honest one.

**Stopping rule — expected loss.** Define the loss of shipping variant `v` as the expected forgone click rate:

```
L(v) = E[ max(p_other − p_v, 0) ]        (Monte Carlo over the posteriors, ≥ 50,000 draws)
```

Stop and ship the leader when **all** of:

1. `L(leader) < 0.005` (0.5 percentage points of CTR — the threshold of practical caring; make this a per-client setting)
2. Minimum sample floor reached: **≥ 30 total clicks across arms** and **≥ 100 delivered per arm**
3. A hard horizon has not been exceeded (max 3 campaigns per test — after that, declare inconclusive and move on)

If at the horizon `L(leader) ≥ 0.005`, the correct output is **"no detectable difference"**, shown as such, and the default action is to keep the incumbent. Never show a winner with no evidence.

**Reporting.** Show `P(B > A)`, the expected loss in percentage points, and the 90% credible interval on the *difference*. Do **not** show `P(B > A)` alone — 91.7% sounds decisive and is not, when the credible interval on the difference spans −1 pp to +12 pp.

### 3.4 Multi-armed bandits — where they work and where they do not

**They do not work for one-shot campaigns.** A bandit needs sequential feedback. A campaign to 390 people goes out in minutes; there is no meaningful "learn then exploit" loop inside a single send. You could send in 4 batches of ~100 with Thompson sampling between batches, but with ~12 clicks per batch the posterior barely moves and you have introduced hours of send delay for nothing.

**They work well for flows**, where recipients arrive continuously. Post-purchase, win-back, abandoned checkout, shipping notifications. Spec:

```
For each flow step, maintain K variants with Beta posteriors on the click indicator.
On each new entrant:
    for each variant v:  draw θ_v ~ Beta(α_v, β_v)
    assign the variant with max θ_v                      (Thompson sampling)
Update on click/no-click at the end of the attribution window.
```

Guards, all of which matter:

- **Floor allocation:** never let any variant drop below 5% traffic, so a variant that got unlucky early can recover, and so you keep detecting drift.
- **Sliding window / discounting:** decay the posterior counts with a half-life of ~90 days (`α ← α·0.5^(Δt/90d)`). Consumer response is non-stationary; a variant that won in January should not dominate in December on stale evidence.
- **Delayed reward:** a click can arrive 72 hours after the send. Do not update until the window closes; track pending assignments explicitly.
- **Do not bandit on revenue.** Same variance problem as everywhere else, plus the delay is longer. Bandit on clicks; audit revenue separately.
- **Minimum arm count:** with fewer than ~200 entrants/month, a bandit is indistinguishable from random. Show the operator the expected time to convergence before enabling it.

### 3.5 Pooled cross-client learning — spec

Fit a hierarchical logistic model over all consenting clients:

```
y_{ijv} ~ Bernoulli(p_{ijv})
logit(p_{ijv}) = μ + a_j + b_{archetype(v)} + c_{j,archetype(v)}
a_j                ~ Normal(0, σ_a²)        client random intercept
b_arch             ~ Normal(0, σ_b²)        creative-archetype effect (shared)
c_{j,arch}         ~ Normal(0, σ_c²)        client × archetype interaction
```

`archetype` is a small controlled vocabulary the wizard assigns to every message it generates: `{discount_offer, restock_alert, education, scarcity, social_proof, replenishment_reminder, winback, new_product, shipping_update}`. This is what makes pooling possible — you cannot pool over free text, you can pool over labelled archetypes.

Outputs:
- **Global archetype effects** → priors for new clients and for the wizard's copy generator.
- **Shrunk per-client effects** → each client's honest posterior, with the shrinkage weight surfaced in the UI: *"73% of this estimate comes from comparable stores, 27% from your own data."* That sentence is a feature, not an apology.

Fit weekly in batch (Stan / PyMC / `brms`, or a simple empirical-Bayes approximation if you want to keep it in Node). Empirical Bayes via method-of-moments on the archetype effects is sufficient for v1 and is ~50 lines.

---

<a name="4"></a>
## 4. Technical attribution plumbing and the data model

### 4.1 The click path, end to end

```
1. Campaign build
     For each recipient r in campaign c:
       - generate token = base62(random 64-bit)          (opaque; never sequential)
       - insert sms_campaign_links row (campaign_id, recipient_id, token, dest_url)
       - render https://go.vicipeptides.com/r/<token> into that recipient's message body

2. Click
     GET https://go.vicipeptides.com/r/<token>
       - look up token -> recipient_id, campaign_id, dest_url
       - bot filter (see 4.4); if bot, log with is_bot=true and still redirect
       - insert sms_link_clicks row, get click_id (uuid)
       - Set-Cookie: vk_click=<click_id>; Domain=.vicipeptides.com; Path=/;
                     Max-Age=2592000; Secure; HttpOnly=false; SameSite=Lax
       - 302 -> dest_url + ?vk=<click_id>&utm_source=sms&utm_medium=sms
                          &utm_campaign=<campaign_slug>&utm_content=<variant_slug>

3. Session on store
     - store-side JS snippet: read ?vk= from URL, else read vk_click cookie
     - persist to localStorage AND re-set the cookie (belt and braces)
     - POST /collect {click_id, session_id, user_agent, ts} -> sms_sessions

4. Checkout
     - hidden checkout field _vk_click_id populated from localStorage/cookie
     - WooCommerce stores it as order meta _vk_click_id

5. Order webhook
     - existing sync-woocommerce.js syncOrder() writes sms_orders
     - NEW: read order meta _vk_click_id -> deterministic Grade A attribution
     - NEW: if absent, run the identity matcher (4.3) -> Grade B/C/D
     - write sms_attributions rows
```

### 4.2 Redirect domain — the one decision that matters most

**Host the redirector on a subdomain of the store's own registrable domain** (`go.vicipeptides.com`, not `telynx.link/abc`). This is not cosmetic:

1. **First-party cookies.** A cookie set with `Domain=.vicipeptides.com` from `go.vicipeptides.com` is readable by `vicipeptides.com`. That is the entire session-stitching mechanism, and it works without any third-party cookie, which is dead in Safari and Firefox and dying in Chrome.
2. **Carrier deliverability.** Public shorteners (`bit.ly`, `tinyurl`) are widely filtered by US carriers on A2P traffic because spammers use them; branded/dedicated short domains are the standard remedy. **[UNVERIFIED — could not fetch CTIA/Twilio guidance during this research; verify against the current CTIA Messaging Principles and Best Practices and Telnyx's own guidance before shipping.]** Regardless, a branded domain also raises click-through because it is recognisable.
3. **Trust.** `go.vicipeptides.com` in a text message reads as legitimate; `tnyx.co/x9Fq2` reads as phishing.

**The Safari caveat, verified.** WebKit's ITP "caps the expiry of cookies set in so-called third-party CNAME-cloaked HTTP responses to 7 days", and applies the same 7-day cap to cookies set via JavaScript ([webkit.org/blog/11338](https://webkit.org/blog/11338/cname-cloaking-and-client-side-cookies/)). So:

- If `go.vicipeptides.com` is a **CNAME to our infrastructure**, Safari caps the cookie at 7 days.
- Setting the cookie via `document.cookie` also caps it at 7 days.
- **Therefore: keep the attribution window ≤ 7 days**, or accept degraded Safari coverage beyond 7 days, or serve the redirector from an A record on infrastructure that is not classified as a tracker. Given §2's finding that long windows are the main source of overstatement anyway, a **72-hour default window is both more honest and free of this problem.** Design constraint and correctness align — take the win.

Also: **always append `?vk=<click_id>` to the destination URL** as a cookie-independent fallback. If the store's JS reads the param on landing and stores it, the cookie becomes redundant for the common case.

### 4.3 Identity matching — cross-device, and the case where the cookie fails

A customer clicks on their phone and buys on their laptop. The cookie does not travel. This is common and must be handled, but handled *honestly*.

Match cascade, most to least reliable, applied in order and recorded as `match_method`:

| Order | Method | Key | Grade | Notes |
|---|---|---|---|---|
| 1 | Checkout click-id | `order.meta._vk_click_id` → `sms_link_clicks.id` | **A** | Deterministic. Same-device or same-browser. |
| 2 | Session stitch | `sms_sessions.click_id` where the session placed the order | **A** | Deterministic via first-party session. |
| 3 | Unique per-recipient coupon | `order.coupon_lines[].code` → `sms_campaign_recipients.coupon_code` | **B** | Deterministic but leakable. Never honour outside the window (contra Postscript). |
| 4 | Phone match | `normalize_e164(order.billing.phone)` = `sms_contacts.phone` | **B** | **This is the cross-device workhorse.** Requires the recipient clicked. |
| 5 | Email match | `lower(order.billing.email)` = `sms_contacts.email` | **B** | Same, weaker (shared inboxes). |
| 6 | Woo customer id | `order.customer_id` = `sms_contacts.woo_customer_id` | **B** | Only for logged-in customers. |
| 7 | Exposure only | recipient was *delivered* the message, no click, order within window | **D** | Correlational. Reported separately, never in headline. |

Grade B via phone/email requires **a recorded click by that recipient** within the window. Exposure-only matches (no click) are Grade D and are never counted as attributed revenue.

**We will not build a probabilistic device graph.** IP + user-agent fingerprint matching at n=390 produces false positives at a rate that swamps the signal, and it is a privacy liability. Refuse it.

Normalisation is load-bearing: the existing codebase already has `normalizePhone()` used in `sync-woocommerce.js`. Every phone key — `sms_contacts.phone`, `sms_orders.contact_phone`, `call_logs.contact_phone`, and the new tables — must be E.164 and normalised through the same function. Add a check constraint (`phone ~ '^\+[1-9][0-9]{7,14}$'`) so bad data cannot enter.

### 4.4 Bot and scanner filtering

Log every click, but mark `is_bot` and exclude bots from all rate denominators and from attribution:

- Click arriving **< 3 seconds** after `delivered_at` (human latency floor; carrier scanners are instant).
- Known scanner user agents: `curl`, `python-requests`, `HeadlessChrome`, `Slackbot`, `facebookexternalhit`, `Bitly`, `Barracuda`, `Proofpoint`, `Mimecast`, plus a maintained list.
- Datacenter ASNs (AWS/GCP/Azure/Cloudflare Workers) via IP-to-ASN lookup.
- `HEAD` requests, or `GET` with no `Accept: text/html`.
- More than one distinct token from the same campaign hit from the same IP within 10 seconds (a scanner walking the send).
- No subsequent `sms_sessions` row within 60 seconds (weak signal; use as a secondary flag, not a hard exclusion — some people click and immediately background the browser).

### 4.5 The data model

Naming follows the existing `sms_*` convention. Existing tables referenced: `sms_contacts` (PK `phone`, has `email`, `woo_customer_id`, `opted_out`, `unread_count`), `sms_orders` (`woo_order_id` UNIQUE, `contact_phone`, `total`, `status`, `items`, `created_at`), `sms_messages` (`telnyx_message_id`, `contact_phone`, `direction`, `body`, `status`, `media_urls`, `reply_to_message_id`, `reactions`), `sms_sent_log` (`order_id`, `flow_type`, `phone`, `message_body`, `sent_at`, unique on `(order_id, flow_type)`), `call_logs`, `sms_scheduled`, `sms_campaign_suggestions`.

```sql
-- ============================================================
-- 05: campaigns, sends, clicks, conversions, attribution
-- Postgres / Supabase. Run in order.
-- ============================================================

-- ---------- CAMPAIGNS ----------
CREATE TABLE sms_campaigns (
  id                BIGSERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,          -- stable, goes in utm_campaign
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('campaign','flow')),
  archetype         TEXT                            -- controlled vocab; enables cross-client pooling
                      CHECK (archetype IN ('discount_offer','restock_alert','education',
                                           'scarcity','social_proof','replenishment_reminder',
                                           'winback','new_product','shipping_update','other')),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','testing','scheduled','sending','sent','cancelled')),
  segment_definition JSONB NOT NULL,                -- the query that produced the roster, stored verbatim
  holdout_pct       NUMERIC(5,4) NOT NULL DEFAULT 0 -- 0.50 = 50% held out
                      CHECK (holdout_pct >= 0 AND holdout_pct < 1),
  randomisation_seed TEXT NOT NULL,                 -- so assignment is reproducible + auditable
  attribution_window_hours INT NOT NULL DEFAULT 72,
  scheduled_at      TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sms_campaigns_status_sent ON sms_campaigns(status, sent_at DESC);
CREATE INDEX idx_sms_campaigns_archetype   ON sms_campaigns(archetype);

-- ---------- VARIANTS (A/B) ----------
CREATE TABLE sms_campaign_variants (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       BIGINT NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,                  -- 'a','b',... goes in utm_content
  body              TEXT NOT NULL,
  media_urls        JSONB,
  weight            NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  encoding          TEXT CHECK (encoding IN ('GSM-7','UCS-2')),
  segment_count     INT,                            -- billable segments, computed at build time
  est_cost_cents    INT,
  UNIQUE (campaign_id, slug)
);

-- ---------- RECIPIENTS (the roster — INCLUDING holdouts) ----------
-- One row per assigned contact. Holdouts get a row with variant_id NULL and
-- arm='holdout'. This table IS the experiment log; without it there is no
-- defensible denominator and no defensible randomisation audit.
CREATE TABLE sms_campaign_recipients (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       BIGINT NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  contact_phone     TEXT   NOT NULL REFERENCES sms_contacts(phone) ON DELETE CASCADE,
  arm               TEXT   NOT NULL CHECK (arm IN ('treatment','holdout')),
  variant_id        BIGINT REFERENCES sms_campaign_variants(id),  -- NULL iff arm='holdout'
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- send outcome
  telnyx_message_id TEXT,
  sms_message_id    BIGINT REFERENCES sms_messages(id),
  send_status       TEXT CHECK (send_status IN
                      ('pending','sent','delivered','failed','rejected','suppressed','not_sent_holdout')),
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  failure_code      TEXT,
  suppression_reason TEXT,                          -- 'opted_out','quiet_hours','rate_limit','invalid'
  -- personalised assets
  link_token        TEXT UNIQUE,
  coupon_code       TEXT,
  -- pre-period covariate for CUPED, frozen at assignment time
  pre_period_revenue_cents INT NOT NULL DEFAULT 0,
  pre_period_orders        INT NOT NULL DEFAULT 0,
  CONSTRAINT holdout_has_no_variant
    CHECK ((arm = 'holdout') = (variant_id IS NULL)),
  UNIQUE (campaign_id, contact_phone)
);
CREATE INDEX idx_scr_campaign_arm     ON sms_campaign_recipients(campaign_id, arm);
CREATE INDEX idx_scr_phone            ON sms_campaign_recipients(contact_phone);
CREATE INDEX idx_scr_token            ON sms_campaign_recipients(link_token);
CREATE INDEX idx_scr_coupon           ON sms_campaign_recipients(coupon_code)
                                        WHERE coupon_code IS NOT NULL;
CREATE INDEX idx_scr_delivered        ON sms_campaign_recipients(delivered_at)
                                        WHERE delivered_at IS NOT NULL;
-- covering index for the attribution join (phone + time range scan)
CREATE INDEX idx_scr_phone_delivered  ON sms_campaign_recipients(contact_phone, delivered_at DESC);

-- ---------- CLICKS ----------
CREATE TABLE sms_link_clicks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- this uuid IS the click_id in the cookie
  recipient_id      BIGINT NOT NULL REFERENCES sms_campaign_recipients(id) ON DELETE CASCADE,
  campaign_id       BIGINT NOT NULL REFERENCES sms_campaigns(id),  -- denormalised for fast rollups
  contact_phone     TEXT   NOT NULL,                               -- denormalised
  clicked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dest_url          TEXT NOT NULL,
  ip                INET,
  ip_asn            INT,
  user_agent        TEXT,
  device_class      TEXT CHECK (device_class IN ('mobile','tablet','desktop','bot','unknown')),
  is_bot            BOOLEAN NOT NULL DEFAULT FALSE,
  bot_reason        TEXT,
  latency_seconds   INT           -- clicked_at - delivered_at; < 3 is a bot tell
);
CREATE INDEX idx_clicks_recipient ON sms_link_clicks(recipient_id);
CREATE INDEX idx_clicks_campaign  ON sms_link_clicks(campaign_id, clicked_at DESC)
                                    WHERE is_bot = FALSE;
CREATE INDEX idx_clicks_phone_time ON sms_link_clicks(contact_phone, clicked_at DESC)
                                    WHERE is_bot = FALSE;

-- ---------- SESSIONS (first-party stitching) ----------
CREATE TABLE sms_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  click_id          UUID REFERENCES sms_link_clicks(id) ON DELETE SET NULL,
  store_session_id  TEXT,                      -- whatever the storefront JS generates
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent        TEXT,
  device_class      TEXT,
  landing_url       TEXT
);
CREATE INDEX idx_sessions_click   ON sms_sessions(click_id);
CREATE INDEX idx_sessions_store   ON sms_sessions(store_session_id);

-- ---------- ATTRIBUTION LEDGER ----------
-- One row per (order, campaign) attribution claim. An order may produce several
-- rows (SMS + email + call) — that is the point. Nothing is ever silently merged.
CREATE TABLE sms_attributions (
  id                BIGSERIAL PRIMARY KEY,
  woo_order_id      BIGINT NOT NULL REFERENCES sms_orders(woo_order_id) ON DELETE CASCADE,
  campaign_id       BIGINT REFERENCES sms_campaigns(id),
  recipient_id      BIGINT REFERENCES sms_campaign_recipients(id),
  click_id          UUID   REFERENCES sms_link_clicks(id),
  call_log_id       BIGINT REFERENCES call_logs(id),
  contact_phone     TEXT   NOT NULL,
  channel           TEXT   NOT NULL
                      CHECK (channel IN ('sms_campaign','sms_flow','sms_conversation','voice','email_external')),
  grade             CHAR(1) NOT NULL CHECK (grade IN ('A','B','C','D','E')),
  match_method      TEXT   NOT NULL
                      CHECK (match_method IN ('checkout_click_id','session_stitch','coupon',
                                              'phone_identity','email_identity','woo_customer_id',
                                              'exposure_only','operator_declared','call_assisted')),
  order_total_cents INT    NOT NULL,
  order_margin_cents INT,                       -- populated when COGS is known; ROI should use this
  attributed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ordered_at        TIMESTAMPTZ NOT NULL,
  touch_at          TIMESTAMPTZ NOT NULL,       -- click / delivery / call timestamp
  window_hours      INT NOT NULL,
  hours_to_convert  NUMERIC(8,2)
                      GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ordered_at - touch_at))/3600) STORED,
  -- honesty flags
  had_email_touch   BOOLEAN NOT NULL DEFAULT FALSE,   -- another channel also qualifies
  is_repeat_buyer   BOOLEAN NOT NULL DEFAULT FALSE,
  baseline_p        NUMERIC(6,5),               -- modelled P(order anyway) in this window
  declared_by       TEXT,                       -- operator user id, for grade E
  declared_note     TEXT,
  UNIQUE (woo_order_id, campaign_id, channel, match_method)
);
CREATE INDEX idx_attr_order    ON sms_attributions(woo_order_id);
CREATE INDEX idx_attr_campaign ON sms_attributions(campaign_id, grade);
CREATE INDEX idx_attr_phone    ON sms_attributions(contact_phone, ordered_at DESC);
CREATE INDEX idx_attr_grade_ts ON sms_attributions(grade, ordered_at DESC);

-- ---------- COSTS ----------
CREATE TABLE sms_campaign_costs (
  campaign_id       BIGINT PRIMARY KEY REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  segments_sent     INT NOT NULL DEFAULT 0,
  mms_sent          INT NOT NULL DEFAULT 0,
  provider_cost_cents INT NOT NULL DEFAULT 0,   -- Telnyx base
  carrier_fee_cents   INT NOT NULL DEFAULT 0,   -- pass-through surcharges
  allocated_fixed_cents INT NOT NULL DEFAULT 0, -- prorated 10DLC + number rental
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- EXPERIMENT RESULTS (append-only, computed nightly) ----------
CREATE TABLE sms_experiment_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  experiment_key    TEXT NOT NULL,          -- e.g. 'programme_holdout' or 'flow:postpurchase:d7'
  as_of             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  n_treatment       INT NOT NULL,
  n_holdout         INT NOT NULL,
  conv_treatment    INT NOT NULL,
  conv_holdout      INT NOT NULL,
  rev_treatment_cents BIGINT NOT NULL,
  rev_holdout_cents   BIGINT NOT NULL,
  lift_pp           NUMERIC(8,5),
  ci_low_pp         NUMERIC(8,5),
  ci_high_pp        NUMERIC(8,5),
  p_value           NUMERIC(10,8),          -- always-valid (mSPRT), not naive
  posterior_p_positive NUMERIC(6,5),
  mde_pp_current    NUMERIC(8,5),           -- what we CAN currently detect
  campaigns_to_mde  INT,                    -- "measurable in N more sends"
  is_conclusive     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_expsnap_key ON sms_experiment_snapshots(experiment_key, as_of DESC);
```

**Join keys, explicitly:**

| From | To | Key |
|---|---|---|
| `sms_campaign_recipients` | `sms_contacts` | `contact_phone` = `phone` (E.164) |
| `sms_campaign_recipients` | `sms_messages` | `sms_message_id` = `id`, or `telnyx_message_id` |
| `sms_link_clicks` | `sms_campaign_recipients` | `recipient_id` = `id`; also `link_token` from URL |
| `sms_sessions` | `sms_link_clicks` | `click_id` = `id` (the cookie value) |
| `sms_attributions` | `sms_orders` | `woo_order_id` (already UNIQUE — good) |
| `sms_attributions` | `sms_link_clicks` | `click_id` |
| `sms_orders` | `sms_contacts` | `contact_phone` = `phone` |
| `sms_attributions` | `call_logs` | `call_log_id` = `id` |

**The attribution query (Grade B, phone identity, window-bounded):**

```sql
INSERT INTO sms_attributions (
  woo_order_id, campaign_id, recipient_id, click_id, contact_phone, channel,
  grade, match_method, order_total_cents, ordered_at, touch_at, window_hours
)
SELECT DISTINCT ON (o.woo_order_id)
  o.woo_order_id, r.campaign_id, r.id, cl.id, o.contact_phone, 'sms_campaign',
  'B', 'phone_identity', ROUND(o.total*100)::INT, o.created_at, cl.clicked_at, c.attribution_window_hours
FROM sms_orders o
JOIN sms_campaign_recipients r ON r.contact_phone = o.contact_phone
JOIN sms_campaigns           c ON c.id = r.campaign_id
JOIN sms_link_clicks        cl ON cl.recipient_id = r.id AND cl.is_bot = FALSE
WHERE r.arm = 'treatment'
  AND o.created_at >  cl.clicked_at
  AND o.created_at <= cl.clicked_at + (c.attribution_window_hours || ' hours')::INTERVAL
  AND o.status NOT IN ('cancelled','failed','refunded')
ORDER BY o.woo_order_id, cl.clicked_at DESC   -- last click wins
ON CONFLICT DO NOTHING;
```

`DISTINCT ON (woo_order_id) ... ORDER BY cl.clicked_at DESC` is the literal implementation of "last click within window". Grade A runs first and its `ON CONFLICT DO NOTHING` on the unique constraint prevents downgrade.

**Refunds.** Add a nightly reconciliation: when `sms_orders.status` moves to `refunded`/`cancelled`, mark the attribution row and subtract from all rollups. Attributed revenue must be net of refunds or the number is inflated by the refund rate — which for a supplement/peptide store is not trivial.

### 4.6 Attribution windows — recommended settings

| Touch | Default | Max allowed | Rationale |
|---|---|---|---|
| Click → order (Grade A/B) | **72 hours** | 7 days | Short enough to limit intent-selection; under Safari's 7-day cookie cap |
| Coupon redemption (Grade C) | **72 hours** | 7 days | **Never** honour outside the window (this is where Postscript goes wrong) |
| Exposure/delivered (Grade D) | **12 hours**, off by default | 24 hours | Reported separately; never in headline |
| Reply → manual sale (Grade E) | **7 days** | 14 days | Human-declared, longer sales cycle is legitimate |
| Call → order (Grade E) | **48 hours** | 7 days | Only for answered calls > 30s |

Make these per-client settings, but **log every change to an audit table and annotate the charts at the change point.** If a number can be tuned, the tuning must be visible. That is precisely the practice we criticise Attentive for; we should not repeat it silently.

---

<a name="5"></a>
## 5. The tricky cases

### 5.1 Direct replies leading to a manual sale

The inbox is two-way, so this will be the most common "real" conversion path for Vici: customer replies "do you have BPC-157 in stock?", operator answers, customer orders. There is no click.

**Handling.** Provide an explicit operator action in the inbox: **"Link an order to this conversation."** It creates a Grade **E** attribution with `match_method = 'operator_declared'`, `declared_by` = the user, and an optional note.

Guardrails:
- Only offer the action when an order from that `contact_phone` exists within 7 days *after* an inbound message.
- Show it as a suggestion the operator confirms, never as an automatic claim.
- Report Grade E in a **separate "conversation-assisted revenue"** line, never merged into campaign ROI.

**What we refuse to claim:** we will not auto-attribute an order just because an inbound reply exists. Customers reply "STOP", "thanks", "👍", and tapback reactions — the existing `reactions` column shows how much of that traffic is non-commercial. Auto-attribution here would be pure inflation.

**On measurability:** operator-declared attributions are self-reported and self-serving. Track them, show them, and label them *"declared by [user], not independently verified."* Exclude them from any incrementality calculation entirely — a human choosing which orders to link is the definition of selection bias.

### 5.2 Phone calls that convert

`call_logs` already exists with `direction`, `status`, `duration_seconds`, `started_at`, `contact_phone`.

**Rule.** An order qualifies for a Grade E `call_assisted` attribution when:
- `status = 'answered'` AND `duration_seconds >= 30` (filters voicemail and misdials), AND
- `ordered_at` is within 48 hours after `ended_at`, AND
- no Grade A/B SMS attribution already exists for that order.

Report as its own line: **"Call-assisted revenue."**

**Direction matters.** An *inbound* call that converts is largely demand the customer already had — the phone number being reachable is a service, not a campaign. An *outbound* call that converts is closer to a causal act. Split the reporting: `call_assisted_inbound` and `call_assisted_outbound`, and be sceptical of the former.

**What we refuse to claim:** any credit for an inbound call where the customer called to ask about an order they had already placed. Check `ordered_at < call.started_at` and exclude.

### 5.3 A customer who receives both an email and an SMS

This is the common case — Vici runs email (Klaviyo/Omnisend) alongside SMS, and both platforms will claim the same order at full value.

**Handling, in three parts:**

1. **Detect the overlap.** Ingest email send/click events (Klaviyo or Omnisend webhook, or a nightly CSV) into a lightweight `email_touches(contact_email, campaign, sent_at, clicked_at)` table. Set `sms_attributions.had_email_touch = TRUE` when an email touch falls in the same window.

2. **Report three numbers, never one:**
   - **SMS-exclusive revenue** — click-attributed orders with **no** qualifying email touch in the window. This is the number we defend.
   - **Shared revenue** — orders where both channels qualify. Shown once, in its own bucket, labelled *"also claimed by email."*
   - **Total store revenue** — the denominator, so the operator can see what fraction of the store's actual revenue we are claiming. **This single number does more to keep everyone honest than any methodology essay.** If your claimed SMS revenue is 60% of store revenue, the operator can see the claim is absurd without needing statistics.

3. **Never sum across vendors.** Add an explicit UI warning when the operator exports: *"Do not add this to your email platform's number. They overlap by X orders / $Y."*

**What we refuse to claim:** exclusive credit for a shared-touch order. We will not build a "we won the tiebreak" rule, because there is no principled tiebreak — the honest answer is "we don't know", and a shared bucket says that.

### 5.4 Repeat purchasers who would have bought anyway

The hardest case, the largest error term, and the one every vendor ignores. Peptides are consumable and reorder-driven, so a large fraction of "attributed" orders are scheduled replenishment.

**Three levels of honesty, in ascending order of rigour:**

**Level 1 — flag it.** Set `is_repeat_buyer` on every attribution and report *"X% of attributed revenue came from customers who had already ordered ≥ 2 times."* Costs nothing. Immediately reframes the conversation.

**Level 2 — baseline subtraction (an estimate, clearly labelled).** Fit a simple per-contact hazard model of "orders in the next W hours" from their own history — recency since last order, historical inter-order interval, order count, product replenishment cycle. A discrete-time logistic hazard is sufficient:

```
logit P(order in window | contact i) = γ₀ + γ₁·log(days_since_last_order)
                                          + γ₂·log(1 + order_count)
                                          + γ₃·(days_since_last / median_interorder_interval_i)
```

Then:

```
Expected baseline orders  =  Σ_{i in treated}  p̂_i
Excess orders             =  Attributed orders − Expected baseline orders
```

Store `p̂_i` in `sms_attributions.baseline_p`. Report as **"estimated excess above baseline"**, explicitly *not* as incremental revenue — the hazard model is fit on non-experimental data and inherits every confound. It is a sanity check, and its main job is to show the operator that the attributed number is much larger than the excess number. It is a better guess than "attributed revenue", and a worse guess than a holdout.

**Level 3 — the holdout.** The only real answer. §2.

**What we refuse to claim:** any assertion that attributed revenue from repeat buyers is incremental. And there is a specific case to hard-exclude: **subscription and recurring renewals.** If Woo processes a scheduled renewal, it gets zero attribution regardless of clicks. A renewal that fires on a schedule was not caused by a text.

### 5.5 The complete refusal list

We will never claim credit for:

1. Orders placed **before** `delivered_at`.
2. Orders where the only evidence is list membership (no click, no coupon, no delivery in window).
3. **Subscription/recurring renewals**, ever.
4. Orders matched only by a **bot click**.
5. Coupon redemptions **outside** the attribution window, or from a coupon code that has been redeemed by more contacts than it was issued to (leak detection: `redemption_count > issued_count` ⇒ quarantine the code).
6. Orders from a contact whose **last** click in the window was a non-campaign link (transactional, shipping, support).
7. **Inbound** calls where the order preceded the call.
8. Orders in a **holdout** arm (by definition — those are the counterfactual, not a conversion).
9. Any "incremental" figure produced without a randomised holdout, no matter how much the customer wants one.

---

<a name="6"></a>
## 6. Metrics that matter — exact formulas and denominator gotchas

Throughout: `R` = set of assigned recipients, `D` = delivered, `C` = unique non-bot clickers, `V` = converters, `S` = billable segments.

### Delivery rate

```
delivery_rate = |{r ∈ R : send_status = 'delivered'}| / |{r ∈ R : send_status ∈ ('sent','delivered','failed')}|
```

**Gotchas.**
- Denominator is **messages accepted by Telnyx**, not recipients assigned. Holdouts and suppressed contacts (opted out, quiet hours, invalid) are **excluded from the denominator** but must remain in the roster table.
- A carrier DLR of `delivered` means *accepted by the handset's network*, **not read, and not necessarily rendered**. Some carriers return positive DLRs for messages that were then silently filtered. **[UNVERIFIED for specific US carriers — verify against Telnyx's DLR documentation before making claims about it.]** Treat delivery rate as an upper bound on reach.
- Segments vs messages: a 3-segment message is one delivery event but three billable units. Report both and never mix them.
- Report `failure_code` breakdown alongside — an aggregate 96% with a rising `4720`/spam-filter code is a crisis that the headline hides.

### Click rate

```
click_rate = |unique non-bot clickers| / |delivered|
```

**Gotchas.**
- **Unique clickers**, not clicks. One person clicking five times is one clicker.
- Exclude `is_bot = TRUE` from the numerator. Publish the bot-exclusion count so the filter can be audited.
- Denominator is **delivered**, not sent. Using `sent` deflates the rate and mixes deliverability failure into a creative metric.
- Multi-link messages: dedupe at the recipient level, not the link level.
- A "click-to-open rate" is meaningless for SMS. There is no open event. Do not invent one.

### Conversion rate

```
conversion_rate           = |converters| / |delivered|        <- the default; state the denominator
click_to_conversion_rate  = |converters among clickers| / |unique clickers|
```

**Gotchas.**
- Always state which denominator. `click_to_conversion` is 10–30× larger and gets quoted without its qualifier constantly.
- A **converter** is a person, not an order. Two orders from one person is one converter and two orders — report `orders_per_converter` separately.
- For the holdout comparison, the denominator must be **assigned**, not delivered (intention-to-treat), or you have broken randomisation.

### Revenue per recipient (RPR)

```
RPR = Σ attributed_revenue (net of refunds) / |delivered recipients|
```

**Gotchas.**
- Net of refunds and cancellations, recomputed nightly.
- State the grade mix. RPR including Grade D is a different quantity from RPR at Grade A/B only, and must be labelled.
- For holdout comparison use **assigned** in the denominator for both arms — this is the single most common way people accidentally break an incrementality calculation.

### Revenue per message sent (RPM)

```
RPM = Σ attributed_revenue / |messages sent|
```

**Gotchas.** Messages, not segments; and not recipients. In a multi-message flow, a "recipient" receives several messages, so `RPM ≠ RPR`. Both are legitimate; conflating them is not.

### Cost per message

```
cost_per_message = (Σ_m [ segments(m) × price_per_segment
                        + segments(m) × carrier_surcharge ]
                    + prorated_fixed_costs) / |messages sent|
```

Telnyx US pay-as-you-go, from [telnyx.com/pricing/messaging](https://telnyx.com/pricing/messaging):

| Item | Price |
|---|---|
| Outbound SMS | **$0.004 per message part** + carrier fees |
| Inbound SMS | $0.004 per message part + carrier fees |
| Outbound MMS | **$0.015 per message part** + carrier fees |
| Inbound MMS | $0.005 per message part + carrier fees |
| AT&T outbound SMS carrier fee | $0.0035 per message part |
| AT&T outbound MMS carrier fee | $0.009 per message part |

10DLC carrier surcharges around $0.003/SMS (AT&T, T-Mobile) and ~$0.0031 (Verizon) plus a ~$10/month standard campaign fee are reported by third parties — **[UNVERIFIED against Telnyx's own current fee schedule; read it from the Telnyx billing API rather than hardcoding.]**

**Gotchas.**
- **Per message *part* (segment), not per message.** A message that tips into a second segment doubles its cost. This is why §7.3's encoding check is a cost feature, not a nicety.
- Include prorated fixed costs: 10DLC campaign fee, brand registration, phone number rental. At 390 recipients these dominate. A $10/month campaign fee across 4 sends of 390 single-segment messages is $10/1,560 = $0.0064/message — **more than the message itself.** Any cost model that ignores fixed costs is wrong by >2× at our scale.
- Include inbound cost. A two-way inbox pays for replies.
- Do **not** charge holdouts. They cost nothing, and including them deflates cost-per-message.

**Worked example — one 390-person send, 50/50 holdout, single-segment GSM-7:**

```
195 messages × ($0.004 + $0.003)            = $1.37
prorated 10DLC campaign fee ($10 / 4 sends) = $2.50
number rental ($1.00 / 4 sends)             = $0.25
                                       TOTAL ≈ $4.12   ($0.021 per message)
```

Against a treatment arm with ~$878 of baseline revenue. **Cost is not the interesting variable at this scale — measurement is.** SMS is so cheap here that even a badly-performing programme is profitable; the only reason to measure is to allocate effort, not to justify spend.

### ROI

```
ROI = (attributed_revenue − cost) / cost
```

**Gotchas.**
- **Use gross margin, not revenue.** Revenue-based ROI on a physical product overstates by `1/margin`. At 60% margin, a "50:1 ROI" is really 30:1.
- Attributed revenue is not caused revenue. Label this metric **"click-attributed ROI"** and never "ROI".
- At these cost levels ROI is a near-meaningless ratio: dividing by $4.12 makes everything look like 200:1. **Report absolute dollars alongside every ratio**, always.

### Incremental ROI

```
incremental_revenue = (RPR_treatment − RPR_holdout) × N_treatment
incremental_margin  = incremental_revenue × gross_margin_rate
incremental_ROI     = (incremental_margin − cost) / cost
```

**Gotchas.**
- Only computable with a randomised holdout. If `holdout_pct = 0`, this field is **NULL**, not zero, and the UI shows "not measured".
- Must ship with a confidence interval. A point estimate of incremental ROI without an interval is worse than no number, because it launders uncertainty into apparent precision.
- Both denominators are **assigned** counts.
- Aggregate across campaigns before reporting (§2.3(3)) — per-campaign incremental ROI is not estimable at n=390.

### Unsubscribe rate

```
unsub_rate = |STOP events in window| / |delivered|
```

**Gotchas.**
- **Carrier-level opt-outs may never reach our webhook.** Telnyx handles STOP at the platform level; if we only count application-level STOPs, we undercount. Reconcile against Telnyx's opt-out list via API, not just inbound message parsing.
- Per-campaign rate understates the real damage because opt-outs are **permanent and cumulative**. Always show cumulative list attrition alongside.
- Non-STOP opt-outs exist: "stop texting me", "unsubscribe", "remove me", and simply going quiet. Add a fuzzy detector that flags these for operator review.
- At n=390, one unsubscribe is 0.26%. Do not report this to two decimal places or draw a trend line through 3 events.

### List churn

```
period_churn = (opt_outs + hard_failures + manual_removals) / list_size_at_period_start
survival(t)  = Π_{k=1..t} (1 − period_churn_k)
```

**Gotchas.**
- Include hard delivery failures (disconnected numbers) — those are churn even without a STOP.
- Track **contactable** list size, not table row count. `sms_contacts` includes opted-out rows.
- The number that matters for a 390-person list is *"at this rate, the list is half gone in N months."* Report that, not the monthly percentage. At 1% per send and 4 sends/month, half the list is gone in about 17 months.

### LTV impact

```
LTV_impact(t) = cumulative_revenue_per_assigned(treatment, 0..t)
              − cumulative_revenue_per_assigned(holdout,   0..t)
```

**Gotchas.**
- Requires a **long-running holdout** — the same randomisation maintained for months. This conflicts with re-randomising per campaign, so run **two** holdouts: a per-campaign re-randomised one (for short-run lift, §2.3(1)) and a small permanent one (for LTV). The permanent one will be underpowered and must be labelled "directional only".
- **We cannot measure LTV impact at n=390 in under a year, and possibly not ever.** Say so. Show the two cumulative curves with confidence bands and let the operator see that the bands overlap. That picture is honest and is genuinely informative — it shows the shape even when it cannot prove the difference.
- Never quote an "LTV lift %" from a non-randomised comparison of engaged vs unengaged contacts. That comparison is pure selection bias and it is the single most common fake metric in the category.

---

<a name="7"></a>
## 7. The campaign test suite spec

"Test before sending" means: **prove the send is correct, affordable, compliant, deliverable, and — critically — tell the operator in advance whether it will be measurable.** Every check returns `PASS` / `WARN` / `BLOCK`. `BLOCK` prevents sending. The panel is a single screen.

### 7.1 Dry run against a real segment

**Output:**
- Exact recipient count, split by arm (`treatment` / `holdout`) with the randomisation seed shown.
- Full recipient table, paginated, sortable, exportable: phone (masked to last 4), name, last order date, lifetime value, last contacted, arm, resolved merge fields.
- **Exclusion ledger** — every contact who matched the segment but will not receive, with reason and count:
  ```
  Segment matched:            412
    − opted out:               14
    − invalid / unroutable:     3
    − quiet hours (deferred):   0   (would send at 09:00 local)
    − messaged in last 48h:     5
    − duplicate phone:          0
  = Eligible:                 390
    → treatment:              195
    → holdout:                195
  ```
- **Diff against the previous send**: "312 of these 390 received your last campaign 6 days ago." Fatigue is the main destroyer of small lists and the operator must see it before, not after.
- **Rendered preview per recipient** for the first 10 rows, with merge fields resolved against real data. Catches `Hi {{first_name}},` → `Hi ,` — the single most common embarrassing bug.
- `BLOCK` if any merge field resolves empty for any recipient without a declared fallback.

### 7.2 Seed list and test devices

- A `seed_contacts` set (operator's own devices, one per major carrier — AT&T, Verizon, T-Mobile — plus one iOS and one Android) that receives every campaign **before** the main send, appended to the roster and excluded from all metrics.
- A **"Send to me now"** button that delivers the exact rendered variant to the operator's device via the real Telnyx path — same sender number, same links, same encoding. Not a simulation. Rendering bugs live in the carrier and handset layers, not in our renderer.
- `BLOCK` on scheduling until at least one seed send has been delivered and acknowledged in the last 24 hours for the current body text.

### 7.3 Rendering, encoding, segment count, and cost

The check that pays for itself:

```
1. Classify every character against the GSM 03.38 basic table.
   - Extension-table characters { } [ ] ~ ^ | \ € count as TWO septets each.
2. If any character is outside GSM-7  ->  encoding = UCS-2.
3. Segment count:
     GSM-7:  len ≤ 160 -> 1 segment; else ceil(len / 153)
     UCS-2:  len ≤  70 -> 1 segment; else ceil(len /  67)
   (multi-part messages lose 7 septets / 3 UTF-16 units to the concatenation UDH)
4. Cost = segments × recipients × (base_rate + carrier_surcharge)
```

Segment lengths per [Twilio's SMS character limit reference](https://www.twilio.com/docs/glossary/what-sms-character-limit): 160 GSM-7 single, 153 GSM-7 concatenated, 70 UCS-2 single, 67 UCS-2 concatenated.

**The killer feature: the UCS-2 trap detector.** These characters are *invisible* to the writer and *halve* the message capacity:

| Character | Name | Usual source |
|---|---|---|
| `—` | em dash | word processors, LLM output, autocorrect |
| `–` | en dash | same |
| `'` `'` | curly apostrophes | Word, Google Docs, iOS autocorrect |
| `"` `"` | curly quotes | same |
| `…` | ellipsis | autocorrect of `...` |
| `°` `®` `™` `•` | symbols | copy-paste from product pages |
| any emoji | — | deliberate |

A 155-character message with one curly apostrophe silently becomes UCS-2, exceeds 70 characters, and costs **3 segments instead of 1 — a 200% cost increase for an invisible character.**

The panel must show:
```
⚠ UCS-2 forced by: ' (curly apostrophe, position 34), — (em dash, position 88)
  Current:  UCS-2, 155 chars, 3 segments, $4.10 for 195 recipients
  If fixed: GSM-7, 155 chars, 1 segment,  $1.37 for 195 recipients
  [ Auto-fix encoding ]   ← transliterates ' → ' and — → ", " or " - "
```

The auto-fix must **preview the diff** before applying, and must never silently alter meaning. (Note this also enforces the house style rule of no em dashes in client-facing content — the technical constraint and the style rule point the same way.)

`WARN` on UCS-2. `WARN` on segment count > 2. `BLOCK` on segment count > 4 (carriers throttle and customers hate it).

### 7.4 Link validation

For every link in every variant:

- Resolve the full redirect chain; assert final status **200** and ≤ 3 hops.
- Assert valid TLS with > 14 days to certificate expiry.
- Assert the destination preserves query parameters (some storefronts and CDNs strip `?vk=` — this silently kills Grade A attribution and is otherwise undetectable until you notice attribution is zero).
- Assert the short domain is the client's branded domain, not a public shortener. **`BLOCK` on `bit.ly`, `tinyurl.com`, `goo.gl`, `t.co`, `is.gd`** and similar. **[UNVERIFIED — the carrier-blocking rationale needs confirming against current CTIA/Telnyx guidance, but the deliverability risk is well-attested industry-wide and the branded domain is required for cookie stitching (§4.2) regardless.]**
- Assert the short domain resolves and the redirect service returns a 302 for a freshly-minted test token.
- Assert the destination is not a 404 for a logged-out visitor (a common failure: the operator links a page only visible when signed in).
- Assert every recipient got a **distinct** token (uniqueness check across the roster) — a shared token destroys per-recipient attribution.
- Preview the link exactly as it will appear in the message body.

### 7.5 Compliance lint

| Check | Level | Rule |
|---|---|---|
| Consent record | **BLOCK** | Every recipient must have a stored consent timestamp + source. No record, no send. |
| Opt-out honoured | **BLOCK** | Zero recipients with `opted_out = TRUE`. Cross-check against Telnyx's platform opt-out list, not just our column. |
| Quiet hours | **BLOCK** | No delivery outside 08:00–21:00 in the **recipient's** local time (TCPA). Derive timezone from area code, fall back to `sms_contacts.state`, then to the store's timezone; deferred sends must reschedule per recipient, not per campaign. **[UNVERIFIED — confirm current TCPA/state-law quiet-hour boundaries with counsel; several states are stricter than the federal window.]** |
| Brand identification | **WARN** | Sender identified in the first message of any new conversation. |
| STOP disclosure | **WARN** | "Reply STOP to opt out" present on the first message of a campaign sequence and at a set periodicity thereafter. |
| SHAFT-C content | **WARN** | Scan for Sex, Hate, Alcohol, Firearms, Tobacco, Cannabis terms. |
| **Regulated-product language** | **WARN** | Vici sells peptides. Carrier content policies and 10DLC campaign vetting treat supplements, "research chemicals", and health claims as high-risk. Lint for disease claims, "cure", "treat", dosage instructions, and prescription-drug names. **[UNVERIFIED — the specific 10DLC campaign classification and its content restrictions must be read from the registered campaign; this is a genuine business risk worth resolving before scaling sends.]** |
| Message length | WARN | > 2 segments |
| Shortener | BLOCK | §7.4 |
| Recipient count sanity | WARN | Recipient count differs from the last send of the same segment by > 30% (catches a broken segment query) |

### 7.6 Deliverability pre-checks

- 10DLC brand and campaign status = registered/approved; show the vetting score.
- Throughput: campaign TPM limit vs recipients. At 390 recipients this is never binding, but show the projected completion time so the operator is not surprised.
- Sending number health: 30-day delivery rate, failure-code breakdown, opt-out rate trend. `WARN` if delivery rate has dropped > 5 points month-over-month or opt-out rate exceeds 2%.
- Sender-number consistency: `WARN` if this segment previously received messages from a different number (recipients block unrecognised numbers).
- Recent send volume vs. the number's historical baseline — a sudden 10× spike triggers carrier filtering.

### 7.7 Projected cost and projected revenue, with an honest interval

**Cost** is deterministic — compute it exactly, no interval needed:

```
195 recipients × 1 segment × ($0.0040 base + $0.0030 carrier)  =  $1.37
prorated 10DLC campaign fee                                     =  $2.50
prorated number rental                                          =  $0.25
                                                          TOTAL =  $4.12
```

**Revenue is not deterministic, and the interval must be a *predictive* interval, not a confidence interval.** A confidence interval covers the unknown mean; the operator wants to know what *this send* will actually produce, which additionally carries binomial and order-value randomness. Predictive intervals are much wider, and that width is the honest part.

**Algorithm (10,000 Monte Carlo draws):**

```
Given: N recipients; history of k conversions in n prior exposures;
       the store's own empirical order-value distribution.

for i in 1..10000:
    p_i     ~ Beta(α₀ + k, β₀ + n − k)         # posterior on conversion rate
    orders_i ~ Binomial(N, p_i)                # this send's realisation
    rev_i    = Σ_{j=1..orders_i} bootstrap_sample(sms_orders.total)
report quantiles of rev_i: p05, p25, p50, p75, p95
```

Bootstrap real order totals from `sms_orders.total` rather than assuming a distribution — the client's actual order-value distribution is right there in the database and using it costs nothing.

**Worked output.** 390 recipients, 6 prior sends with 70 conversions in 2,340 exposures (3.0%), lognormal order values with mean $150 and cv 0.6:

```
Projected orders:            median 12    (90% range: 6 – 18)
Projected ATTRIBUTED revenue: median $1,715  (90% range: $834 – $2,886)
Projected cost:              $4.12  (exact)
```

Thin history (2 prior sends, 23/780) gives essentially the same interval — $770 to $3,037 — which is itself an important finding: **at this list size, the binomial and order-value randomness dominate the parameter uncertainty.** More history barely narrows the interval, because the irreducible randomness of "will 8 people or 15 people buy" is the binding constraint. Show this. It is the clearest possible demonstration of why per-campaign measurement is hopeless.

**The required disclaimer, rendered in the UI, not buried:**

> This projects **attributed** revenue — orders from people who clicked. It is **not** a projection of incremental revenue. Most of these orders would likely have happened anyway.

### 7.8 The measurability pre-flight — the differentiating feature

Before every send, compute and display the MDE for the configuration the operator has actually chosen:

```
Holdout: 50% (195 / 195)
Your baseline conversion rate: 3.0%

  This send can only detect a lift if conversion rises above 10.3%
  (+7.3 points, a 245% increase).

  A strong campaign produces roughly +1 point.
  → This send CANNOT be measured on its own.

  Running total: this is send 4 of the ~27 needed to detect a
  +1 point lift at 80% confidence.
  ████░░░░░░░░░░░░░░░░░░░░░░  4 / 27
  Estimated: measurable around February 2027 at your current cadence.

  [ What does this mean? ]
```

No competitor shows this because it undercuts the pitch. **It is the most trustworthy thing we can put on the screen**, and it converts the weakness (small list) into the product's credibility. It also creates the correct behavioural incentive: operators who see "4 of 27" keep the holdout running, which is exactly what we need them to do.

---

<a name="8"></a>
## 8. Dashboard spec — presenting uncertainty honestly

### 8.1 The three-tier money view

Never one number. Three, stacked, always visible together, in descending order of defensibility:

```
┌──────────────────────────────────────────────────────────────────────┐
│  SPRING RESTOCK  ·  sent 4 Aug  ·  195 messaged, 195 held out        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ① CLICK-ATTRIBUTED REVENUE                             $1,840       │
│     12 orders from people who clicked your link within 72h           │
│     Grade A (deterministic) $1,410 · Grade B (identity) $430         │
│     ✓ Every dollar traceable to a click    [ view the 12 orders ]    │
│                                                                      │
│  ② ASSOCIATED REVENUE (not attributed)                    $620       │
│     4 more orders from recipients who did NOT click.                 │
│     ⚠ Correlation only. These may have happened anyway.              │
│     Not included in ① or in any ROI figure.        [ off by default ]│
│                                                                      │
│  ③ INCREMENTAL REVENUE (measured vs holdout)      NOT YET MEASURABLE │
│     ░░░░░░░░░░░░░░░░░░░░░░░░  4 of ~27 sends                         │
│     Best estimate so far:  +$180  (90% interval: −$1,900 to +$2,300) │
│     ⚠ This interval includes zero. We cannot yet distinguish this    │
│       campaign's effect from no effect at all.                       │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  Cost $4.12   ·   Click-attributed return 447×   ·   ⓘ not the same  │
│                                                     thing as ROI     │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Rules for presenting uncertainty

1. **Every dollar figure carries an evidence grade badge.** Hovering shows the rule that produced it and links to the underlying rows. Any number a user cannot drill into does not belong on the screen.
2. **Intervals, not points, for anything estimated.** Where an interval crosses zero, say so in words: *"We cannot distinguish this from no effect."* Do not print a positive point estimate next to an interval spanning zero without that sentence — people read the point estimate and ignore the interval.
3. **Never hide the width by rounding.** `+$180 (−$1,900 to +$2,300)` is honest. `+$180` is a lie of omission.
4. **Progress toward measurability is a first-class UI element**, on every campaign card and on the programme dashboard.
5. **Show total store revenue as the denominator.** A persistent line: *"Click-attributed SMS revenue is 11% of total store revenue this month."* If that figure ever exceeds ~30%, the dashboard should flag it as implausible and prompt an attribution audit. This is a self-check against our own inflation.
6. **Annotate configuration changes on every time series.** If someone changes the attribution window from 72h to 7 days, a vertical marker appears on the chart reading "attribution window changed — figures before and after are not comparable."
7. **Refuse to render a trend line through fewer than 8 points**, and never render one through counts under 30 events.
8. **Separate the channels.** SMS-exclusive, shared-with-email, call-assisted, conversation-assisted. Never a single "revenue" number.
9. **Colour the uncertainty.** Grade A solid, Grade B hatched, Grade D outline only. Uncertainty should be legible at a glance without reading a legend.

### 8.3 Claims we can and cannot defensibly make

**We CAN say:**

- "12 orders totalling $1,840 were placed by people who clicked this campaign's link within 72 hours."
- "This campaign cost $4.12 to send."
- "Click-attributed revenue was 447× the send cost." *(with the caveat attached, and absolute dollars shown)*
- "Variant B was clicked by 15.9% of recipients versus 10.3% for variant A. There is a 92% probability B has the higher true click rate."
- "Across 27 sends with a randomised holdout, recipients who received messages ordered 1.2 percentage points more often than those who did not, 90% interval 0.3 to 2.1 points. That is roughly $X of incremental revenue over the period."
- "0.5% of recipients opted out. At this rate half your list is gone in 17 months."
- "This send cannot be measured on its own. Here is what it contributes to the running measurement."

**We CANNOT say, and the UI must not imply:**

- ❌ "This campaign made you $1,840." — Attribution is not causation.
- ❌ "SMS drove $12,400 in revenue this quarter." — Not without a holdout, and not without disclosing email overlap.
- ❌ "447× ROI." — Not without margin adjustment, and never without the absolute dollars and the caveat.
- ❌ "Variant B generates 34% more revenue." — Not measurable at n=195. Clicks only.
- ❌ "SMS subscribers have 3× the LTV of non-subscribers." — Pure selection bias. Your best customers subscribe; subscribing does not make them your best customers.
- ❌ "Incremental revenue: $X" for a single campaign. — Not estimable at this scale. The field must render "not yet measurable".
- ❌ Any figure that changes when the operator adjusts a dropdown, presented without a visible annotation that it changed.

### 8.4 The trust ledger

An always-available audit view listing **every** attributed order with: order id, contact, order total, grade, match method, touch timestamp, order timestamp, hours-to-convert, whether an email touch also qualified, and whether the buyer is a repeat purchaser. Exportable to CSV.

**Every dollar in the headline must be traceable to a row in this table.** If it cannot be traced, it does not go in the headline. This constraint, enforced in code as a reconciliation test in CI (`SUM(headline) == SUM(ledger rows)`), is what makes the whole system defensible — and it is a genuinely differentiated product claim.

---

<a name="9"></a>
## 9. Build order

| Phase | Deliverable | Why first |
|---|---|---|
| **1** | Redirect service on `go.<client-domain>`, `sms_campaigns` / `sms_campaign_variants` / `sms_campaign_recipients` / `sms_link_clicks` tables, per-recipient tokens, bot filter | Nothing else works without click data. Start collecting immediately — data accumulates in calendar time and cannot be backfilled. |
| **2** | `sms_attributions` ledger, Grade A/B matchers wired into `sync-woocommerce.js`, refund reconciliation, trust-ledger view | Turns the $0 dashboard into a real, defensible number. |
| **3** | Test suite: encoding/segment/cost, link validation, dry run, exclusion ledger, seed sends, compliance lint | Prevents expensive and embarrassing mistakes. Independently valuable, ships fast. |
| **4** | Holdout assignment with reproducible seed, per-campaign re-randomisation, `sms_experiment_snapshots`, the measurability pre-flight widget | The honest measurement layer, and the differentiating UI. |
| **5** | Bayesian A/B on clicks with informative priors and the expected-loss stopping rule | Makes testing meaningful at small n. |
| **6** | Flow-level Thompson sampling; email-touch ingestion and overlap reporting; CUPED adjustment | Precision and honesty improvements. |
| **7** | Cross-client hierarchical pooling | Needs several clients' data. Design the schema for it in phase 1; build it when `J ≥ 5`. |

**Do not build:** media mix modelling, probabilistic device graphs, per-campaign incremental revenue estimates, or a view-through-attribution headline.

---

<a name="10"></a>
## 10. Sources

**Platform attribution documentation**
- Postscript — Customize Your Attribution Windows: https://help.postscript.io/en/articles/13563857-customize-your-attribution-windows
- Postscript — Customize Your Attribution Windows (legacy): https://help.postscript.io/hc/en-us/articles/4402883425051-Customize-Your-Attribution-Windows
- Attentive — FAQs: Attentive's attribution model: https://help.attentive.com/hc/en-us/articles/7050482152212-FAQs-Attentive-s-attribution-model *(returns HTTP 403 to automated fetch; contents obtained via search extraction — re-verify manually)*
- Attentive — Configure your attribution settings: https://help.attentive.com/hc/en-us/articles/37873174009620-Configure-your-attribution-settings *(same caveat)*
- Attentive — The Truth About Marketing Attribution: How SMS & Email Work Together: https://www.attentive.com/blog/marketing-attribution-with-email-and-sms
- Klaviyo — Understanding Klaviyo message attribution: https://help.klaviyo.com/hc/en-us/articles/1260804504250
- Klaviyo — Understanding message conversion tracking: https://help.klaviyo.com/hc/en-us/articles/115005248128
- Klaviyo — How to change your attribution model: https://help.klaviyo.com/hc/en-us/articles/11118357030555
- Klaviyo — Klaviyo's Updated Attribution Model For Precise Measurement: https://www.klaviyo.com/blog/introducing-attribution-model-updates-to-reporting
- Klaviyo — 6 Email & SMS Attribution Questions You Need To Ask: https://www.klaviyo.com/blog/email-sms-attribution

**Causal measurement / experimental design**
- Lewis, R. A. & Rao, J. M. (2015). *The Unfavorable Economics of Measuring the Returns to Advertising.* QJE 130(4):1941–1973. https://academic.oup.com/qje/article-abstract/130/4/1941/1914592 · PDF: https://gwern.net/doc/economics/advertising/2015-lewis.pdf
- Blake, T., Nosko, C. & Tadelis, S. (2015). *Consumer Heterogeneity and Paid Search Effectiveness: A Large-Scale Field Experiment.* Econometrica 83(1):155–174. https://onlinelibrary.wiley.com/doi/abs/10.3982/ECTA12423 · NBER: https://www.nber.org/papers/w20171 · PDF: https://faculty.haas.berkeley.edu/stadelis/BNT_ECMA_rev.pdf
- Johari, R., Pekelis, L. & Walsh, D. (2022). *Always Valid Inference: Continuous Monitoring of A/B Tests.* Operations Research 70(3):1806–1821. https://pubsonline.informs.org/doi/pdf/10.1287/opre.2021.2135 · arXiv: https://arxiv.org/abs/1512.04922
- Johari, Koomen, Pekelis & Walsh. *Peeking at A/B Tests: Why It Matters, and What to Do About It.* KDD '17. https://www.semanticscholar.org/paper/Always-Valid-Inference:-Bringing-Sequential-to-A-B-Johari-Pekelis/ff51ed3ad05067844da8d108a666bbdd4e900501
- Deng, Xu, Kohavi & Walker (2013). *Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data (CUPED).* WSDM 2013. https://exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf *(URL live; specific reported variance-reduction percentages [UNVERIFIED])*
- Zembula — Email Holdout Testing: When It's Worth Running and When It's a Waste of Time: https://www.zembula.com/blog/email-holdout-testing-when-it-s-worth-running-and-when-it-s/
- Right Side Up — Guide to Marketing Incrementality Testing: https://www.rightsideup.com/blog/guide-to-marketing-incrementality-testing

**Technical**
- Telnyx — SMS and MMS Pricing: https://telnyx.com/pricing/messaging
- Twilio — How long can a message be? (GSM-7 / UCS-2 segment lengths): https://www.twilio.com/docs/glossary/what-sms-character-limit
- WebKit — CNAME Cloaking and Client-Side Cookies (7-day ITP cookie cap): https://webkit.org/blog/11338/cname-cloaking-and-client-side-cookies/
- Messente — SMS Length Calculator: https://messente.com/sms-length-calculator

**Statistical working**
All power calculations, MDE figures, Monte Carlo simulations, and predictive intervals in §2, §3 and §7.7 were computed for this document. Formulas are given inline in §2.2 so every figure can be reproduced. The exact-test and revenue-simulation results (which materially contradict the normal approximation at these sample sizes) used Fisher's exact test at 8,000 replicates per point and a Welch t-test on lognormal-order-value draws at 3,000 replicates per point respectively.

**Explicitly unverified claims, collected**
- Attentive's exact per-touchpoint default window table (help centre blocks automated fetch).
- Klaviyo's delivered-SMS default window — sources give both 12 hours and 1 day.
- Vici's true baseline conversion rate, AOV, order-value coefficient of variation, and intraclass correlation ρ — all assumed here, all computable from `sms_orders` before any of these figures are quoted to the client.
- CTIA / carrier policy on public URL shorteners in A2P SMS.
- Current TCPA and state-level quiet-hour boundaries.
- Carrier DLR semantics for filtered-but-reported-delivered messages.
- 10DLC content restrictions applicable to Vici's registered campaign given the peptide product category.
- CUPED's reported variance-reduction percentages.
