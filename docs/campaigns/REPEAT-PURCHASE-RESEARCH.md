# Repeat purchase, and what to do about 504 one-time buyers

Researched 2026-08-23. Source tiers are on every claim and are not decoration:
**[A]** peer-reviewed or regulatory primary. **[B]** large-sample industry
study with disclosed method. **[C]** vendor or agency, method undisclosed.
**[U]** could not confirm against a primary source.

Companion to `SMS-COPY-RESEARCH.md` (copy and compliance) and
`TRACKING-AND-LEARNING-RESEARCH.md` (measurement). This document is
authoritative on repeat-purchase strategy.

## The measured shape of the business

Run against the live database on 2026-08-23. These are counts, not estimates.

```
paid orders                1288
distinct buyers             781

orders per buyer   buyers
      1              504
      2              157
      3               70
      4               25
      5               10
      6                6
      7                4
      8                2
      9                1
     10                1
     11                1

ONE-TIME BUYERS   504 of 781   64.5%
REPEAT BUYERS     277
```

An earlier figure of roughly 700 one-time buyers was wrong. It counted
customer-PRODUCT pairs, not customers. The distinction matters enormously:
1689 pairs across 781 buyers is 2.2 distinct products each, so a person who
bought BPC-157 once and GHK-Cu once is a repeat customer with two one-time
products.

**That is the finding.** Repeat behaviour here is CROSS-PRODUCT, not
same-product. It is why a reorder engine measuring same-product intervals
found nine people and was right to. It also reframes the problem: this is not
a retention failure, it is a catalogue-navigation and trust problem, and the
compliant levers address that directly where dose-based levers never could.

## DECISIONS

1. **Cohorts are defined at the CUSTOMER level, never customer-product.**
2. **Tenure cuts on time since the only order:** 0 to 30 days, 31 to 90,
   91 to 365, beyond 365. Roughly half of all second orders that ever happen
   occur inside the first 30 days and the hazard decays monotonically, so
   effort is front-loaded. `[C]` on the exact percentages, `[A]` on the shape.
3. **Beyond 365 days gets no flow.** Around 4% of available second orders,
   against real deliverability cost from mailing a stale segment.
4. **Never discount an established repeat buyer.** Three field experiments
   found deeper discounts INCREASED future purchases by first-time customers
   and DECREASED them among established ones. `[A: Anderson & Simester,
   Marketing Science 23(1), 2004]` This is the cleanest split in the
   discounting literature and it maps exactly onto the 504 / 277 divide.
5. **A single event-triggered offer to a first-time buyer is supported. A
   recurring calendar discount to the whole list is not.** The reference-price
   erosion finding is about a sustained promotional regime over years, not one
   well-targeted offer. `[A: Mela, Gupta & Lehmann, JMR 34(2), 1997]`
6. **Do not build RFM.** A 5x5x5 grid over 781 buyers averages six per cell.
   Tenure cohorts plus at most a binary above or below median order value.
7. **Do not build a CLV or propensity model.** At this n with a dominant
   zero-repeat class it fits noise, and its per-person output would be too
   imprecise to target on even if it did not.
8. **Do not act on any cohort under about 100 people.** A 50-person cohort
   showing 8% is genuinely consistent with anything from 3% to 19%.
9. **Do not run multi-arm offer tests.** At ~350 per arm on an 8% baseline the
   minimum detectable effect is a 56% relative lift. A four-arm test at this
   size produces four confident-looking wrong answers.
10. **Hold out 20% permanently, from the first send.** Much of the apparent
    lift from converting one-time buyers is selection, not treatment: second
    purchasers were already the higher-propensity customers. The holdout is
    the only thing that separates the two.
11. **Success metric: incremental second orders per 1000 contacts, treated
    minus holdout, over 60 days.** Not opens, not attributed revenue.

### Permitted mechanisms

In priority order. These map to `lib/campaigns/proposal-mechanisms.js`.

| Mechanism id | Why it is permitted |
|---|---|
| `plain_check_in` | No product claim at all. The control arm, and it answers whether the cohort needs an offer in the first place. |
| `product_education` | Batch COA, third-party HPLC and mass-spec results, storage and shipping-integrity documentation. Quality documentation, no use claim. **The highest-value lever available** and the one buyers in this category actually select on. |
| `free_shipping` | A logistics term carrying no product claim. The zero-price effect is real and replicated `[A: Shampanier, Mazar & Ariely, Marketing Science 26(6), 2007]`, and extra costs are the top cited abandonment reason at 40% `[B: Baymard, 50 studies, updated 2025-09-22]`. |
| `first_reorder_incentive` | A fixed-dollar credit framed as an account balance rather than a sale. Lower reference-price risk than a percentage. Permitted once, to a first-time buyer only. |
| `ask_what_stopped_them` | **Only when scoped to logistics.** Delivery, packaging, documentation. See the prohibition on experience questions below. |
| `bundle` | **Only as a volume price break on a single SKU.** A price schedule, not a promotion. See the hard prohibition on cross-product bundling below. |

### Ruled out. Do not build.

- **Any "how did it work" or "how are you feeling" message.** It solicits a
  testimonial, and a solicited testimonial is attributable to the marketer
  under FTC endorsement rules. `[A: FTC Health Products Compliance Guidance,
  Dec 2022]` The compliant substitute asks about delivery and packaging only.
- **Any replenishment or "running low" reminder.** The mechanism is a
  consumption-rate assumption, which is a dosing claim. Substitute a restock
  notice about OUR stock, which moves the trigger from their usage to our
  supply.
- **Any bundle pairing a peptide with bacteriostatic water.** See the exposure
  section. This is not a grey area.
- **A referral programme.** Referrers make outcome claims you cannot control.
- **A subscription product.** It implies ongoing personal consumption, the
  exact inference the catalogue is structured to avoid.
- **Anything premised on reminding someone how good they felt.** Roughly 70%
  of the standard retention playbook runs on that mechanism and none of it is
  available here. The honest response is to do fewer things properly.

## The exposure that outranks the campaign

Two findings from this research are more consequential than anything about
repeat purchase, and both are pre-existing rather than created by any campaign.

### FDA warning letters, 31 March 2026

CDER issued seven warning letters to online peptide sellers, published
2026-04-07. `[A: FDA warning letter index, MARCS-CMS 721088, 721806, 721805,
721709]`

**Abbreviated product names did not help.** Pink Pony Peptides listed products
as "GLP-2 TZ" and "GLP-3 RT". Gram Peptides used "GLP-1-R peptide". FDA
identified them as unapproved new drugs under FDCA 505(a) regardless. The Vici
catalogue uses the same RT / TZ / SM convention.

**Research-use disclaimers were dismissed outright.** From the letters:
"Despite statements on your product labeling marketing your products for
'Research Use Only,' evidence obtained from your website establishes that your
products are intended to be drugs for human use."

**Selling bacteriostatic water alongside peptides was itself cited** as
demonstrating intended use for injection.

Measured against the live order data on 2026-08-23:

```
paid orders containing BAC Water                     553
of those, also containing another product            520
```

520 orders carry the exact pattern the letters name. The governing standard is
21 CFR 201.128, under which intended use is established by the totality of
evidence including advertising and written statements by the firm. Marketing
email and SMS are written statements by the firm and are in scope.

### Platform policy

| Platform | Policy | In the current stack |
|---|---|---|
| Klaviyo | Acceptable Use Policy prohibits prescription medications and pharmaceutical products | Yes, email |
| Telnyx | Forbidden use cases, updated 2026-07-23, name controlled or prescription drugs without authorisation, substances not legally approved for sale, and unregulated or prohibited supplements | Yes, SMS |

Both are standing account-termination risks independent of any campaign. Get
written confirmation from both account teams before increasing volume, and
identify a fallback.

## What second purchases are actually worth here

The benchmark spread is definition, not reality. 18.8% `[C]`, 28.2% `[C]`,
32% `[B: RJMetrics 2015, 176 retailers, 18M customers, primary no longer
retrievable]`, 30 to 38% for health and wellness `[C]`. Different denominators,
different windows, different verticals. None of them is Vici's number, which
is measurable directly and is the only one that matters.

There is no reliable repeat-purchase data for research peptides. It does not
exist publicly. Borrowing supplement benchmarks would be the confident wrong
number this document exists to avoid: that category has subscription
infrastructure, defined daily consumption and mainstream payment rails, and
this one has none of them.

The one robust structural finding: repeat probability rises with purchase
count, and this falls out of the NBD/Dirichlet family where observed count is
the best estimator of latent rate. `[A: Fader & Hardie]` Which is exactly why
the holdout matters. Much of the second-purchase "lift" is the campaign
surfacing people who were going to buy anyway.

**The realistic ceiling.** On a 504-person cohort, a good campaign might
convert an incremental 3 to 8 points above baseline. That is roughly 15 to 40
incremental orders, once. Worth building. Not worth three months.

The largest body of empirical repeat-purchase evidence, the Ehrenberg-Bass
NBD-Dirichlet work, finds that most of a brand's buyers are very light buyers,
that this is structural rather than a marketing failure, and that growth comes
overwhelmingly from penetration rather than from lifting loyalty. `[A]` At 1.65
orders per buyer, Vici may be near the structural norm for a category people
buy on a project basis.

## Could not verify

The RJMetrics primary (11 years old, secondary reporting only). The Decile
supplements figure. "72% chance of a fourth purchase after a third" (no
primary, do not use). A "Shopify Plus 2024 free shipping study" that does not
appear to exist. "15 to 30% of lapsed customers can be reactivated" (no
holdout, no methodology, anywhere). "Loyalty freebies increase repeat sales by
90%" (folklore, and contradicted by Raghubir 2004, which found free gifts are
valued LESS and depress willingness to pay for that item afterwards `[A]`).
Verbatim text of the March 2026 letters: FDA.gov returned 404 on direct fetch,
so content is from the warning-letter index and secondary legal analysis. Pull
the primaries before quoting them to anyone.

## Sources

Anderson & Simester, Marketing Science 23(1):4-20, 2004. Mela, Gupta &
Lehmann, JMR 34(2):248-61, 1997. Shampanier, Mazar & Ariely, Marketing Science
26(6):742-757, 2007. Raghubir, JCP 14(1&2):181-186, 2004. Thomas, Blattberg &
Fox, JMR 41(1):31, 2004. Kumar, Bhagwat & Zhang, Journal of Marketing 79(4),
2015. Yi & Yoo, Psychology & Marketing, 2011. Langen & Huber, arXiv:2204.10820.
Fader & Hardie, Probability Models for Customer-Base Analysis, Wharton. Sharp,
Loyalty Limits for Repertoire Markets, Ehrenberg-Bass. van de Ven & Koenraadt,
Int. J. Drug Policy, 2017. Turnock et al., Performance Enhancement & Health,
2021. Trends in Organized Crime, 2023. FTC Health Products Compliance Guidance,
Dec 2022. FDA warning letters MARCS-CMS 721088, 721806, 721805, 721709,
2026-03-31. Klaviyo Acceptable Use Policy. Telnyx forbidden messaging use
cases, 2026-07-23. Baymard Institute cart abandonment, updated 2025-09-22.
