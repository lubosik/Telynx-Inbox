# Competitive Landscape — SMS Marketing, AI Campaign Tooling, and the High-Risk Wedge

**Prepared:** 2026-08-11
**Scope:** Where Telynx Inbox + the AI wizard actually sits against incumbents, and which of our assumed advantages survive contact with evidence.
**Status of claims:** Every URL below carries the date it was fetched. Anything I could not verify from a primary source is marked `[UNVERIFIED]`.

---

## 0. Read this first — the four findings that should change the plan

**1. The cost argument is much weaker than it looks, and it only works because we chose Telnyx over Twilio.**
Postscript's Professional tier lands at roughly **$0.0112 per SMS segment all-in**, which is *below Twilio's own retail list price* of ~$0.0118–0.0128. Against Twilio, "own your infrastructure" saves you the platform fee and nothing else. Against **Telnyx** at **$0.0075 all-in**, there is a real ~1.5x gap. That gap is the entire commercial basis for the infrastructure pitch, and it exists because Telnyx's base rate is ~45% under Twilio's — not because SaaS vendors are gouging. After we take our own software margin out of that gap, the customer's net saving at 10,000 contacts is approximately **zero**. See §5.

**2. The high-risk thesis does not survive as stated, and two parts of it are false.** Attentive and Postscript **actively serve supplement brands today** — verified by live tags on Bloom, Jocko Fuel, Legion Athletics, OLLY, Ghost Lifestyle and Transparent Labs, plus published case studies including The Vitamin Shoppe (Attentive) and Bare Performance Nutrition (Postscript). Attentive even publishes a **telehealth pharmacy** case study covering HRT, ED and weight loss — the exact vertical Klaviyo bans by name. CBD, vape and adult *are* genuinely excluded, but at the **carrier** layer, so no platform can serve them, us included. Research peptides *are* genuinely unserved — but because they plausibly fail T-Mobile's "legal across all 50 states" rule, not because incumbents are squeamish. See §2.

**3. The most uncomfortable finding: Telnyx prohibits our beachhead in writing.** Telnyx's forbidden-use-cases article bans *"unregulated or prohibited supplements"* and *"substances that are not legally approved for sale"*, and separately bans *"third-party traffic or passthrough messaging sent on behalf of unregistered businesses"* — which describes an ISV reselling SMS. **On this exact vertical Telnyx is stricter than Twilio and Bandwidth** (Sinch's policy renders client-side and could not be assessed). The carrier choice that makes the cost model work is also the one that forbids the customers. See §2.6.

**4. The strongest evidence we have is not about price — it is about consent portability.** Attentive's own subscriber export omits opt-in timestamp, IP, source, and the disclosure text shown at signup, and Attentive warns in writing that the exported list may be legally unsafe to message elsewhere. That is a documented, quotable, structural failure every incumbent shares — and the one peptide operator we found had to write his own TCPA compliance gate because nobody would sell him one. See §4 and §5.

---

## 1. Incumbent deep-dive

### 1.1 Structural note — one competitor has left the field

**Yotpo / SMSBump is discontinued.** Yotpo sunset its native SMS and Email products, with services ending **31 December 2025** ([checkthat.ai/brands/yotpo/pricing](https://checkthat.ai/brands/yotpo/pricing), fetched 2026-08-11): *"Yotpo permanently discontinued its native Email and SMS products on December 31, 2025."* Yotpo now sells only Reviews/UGC and Loyalty. Attentive is its preferred migration partner for annual customers; Klaviyo offered a 12-month price match to switchers; Omnisend offered 30% off for 12 months.

This matters for two reasons. It removed a mid-market player and pushed a cohort of displaced brands into the market during 2026 — brands that have just been burned by platform risk and are unusually receptive to a portability argument. It is also a reminder that SMS as a bolt-on to a non-SMS platform has already failed once at scale.

### 1.2 Pricing models and real costs

Scenario definitions used throughout: **A** = 400 contacts / ~1,600 messages per month · **B** = 10,000 contacts / ~40,000 messages · **C** = 100,000 contacts / ~400,000 messages, all at four sends per contact per month.

**A critical methodological point that most published comparisons get wrong:** almost everyone bills per **segment**, not per message, and carrier fees are usually **additive**. Postscript's own footnote, verbatim ([postscript.io/pricing](https://postscript.io/pricing), fetched 2026-08-11):

> "Postscript allows 160 characters per SMS message without emojis, and 70 characters per SMS message with emojis. SMS messages exceeding those character counts are split into multiple message segments, each of which is charged at the per-SMS rate."

> "Average US Carrier fees are $0.00418 for SMS and $0.00841 for MMS & Listed Rates are for US - 50 States/Canada only"

A typical marketing text with a link and a STOP disclosure runs 1.3–2.0 segments, and a single emoji collapses the limit from 160 to 70 characters. **Segment count is the largest single swing factor in every cost comparison in this document.** I model 1.3 segments and show sensitivity in §5.

---

#### Attentive

- **Positioning:** Enterprise and upper-mid-market DTC/retail. Multi-channel: SMS, email, RCS, push. Sold with a dedicated CSM.
- **Model:** Usage-based, custom quoted, no public rate card. From [attentive.com/pricing](https://www.attentive.com/pricing) (fetched 2026-08-11): *"Attentive's pricing is tailored to your business needs based on your message volume, subscriber list size, number of channels, and AI products selected."* and *"Attentive offers usage-based pricing, so you only pay for what you actually use—no credit system required."* Notably, **AI Journeys is priced per click**; AI Pro / AI Grow are flat monthly fees. The early-years revenue-share model is gone.
- **Real costs** `[UNVERIFIED — all third-party]`: Vendr buyer data reports a median annual contract of **~$40,000**, range **$1,800–$72,000/yr** ([vendr.com/marketplace/attentive](https://www.vendr.com/marketplace/attentive), fetched 2026-08-11). Agency analysis reports a platform fee of *"around $300 to $500/month"*, SMS at *"$0.010 to $0.025 per message"*, MMS *"$0.020 to $0.050"*, and one-time setup of *"$2,000 to $25,000"* ([eightx.co](https://eightx.co/blog/compare/how-much-does-attentive-cost), fetched 2026-08-11).
  - **A:** effectively unavailable. A ~$667–1,000/mo floor makes 400 contacts absurd.
  - **B:** ~$950–1,500/mo · **C:** ~$3,000–8,000/mo
- **Minimums and contract:** quarterly minimum commitment of **$2,000–3,000**, "use it or lose it"; **6–12 month terms** with auto-renewal unless cancelled 60–90 days prior; MSA language reported as *"All Fees are non-cancellable and non-refundable"* ([checkthat.ai/brands/attentive/pricing](https://checkthat.ai/brands/attentive/pricing), fetched 2026-08-11) `[UNVERIFIED]`.
- **Carrier fees:** passed through on top. Attentive publishes its own table: AT&T $0.0035 SMS / $0.0090 MMS; T-Mobile $0.0045 / $0.0100; Verizon $0.0040 / $0.0065 `[UNVERIFIED, via checkthat.ai]`. Dedicated short code **$750/mo** non-vanity, **$1,250/mo** vanity ([help.attentive.com FAQs: Shortcodes](https://help.attentive.com/hc/en-us/articles/360041541572-FAQs-Shortcodes), fetched 2026-08-11).
- **Free tier:** none. No self-serve trial; all enquiries route through a sales demo.

#### Postscript

- **Positioning:** Shopify-native SMS for SMB and mid-market DTC. The most transparent pricing in the category, and the most realistic direct competitor for a small brand.
- **Model:** flat platform fee + per-segment rate + additive carrier fees. No per-contact charge, no revenue share. ([postscript.io/pricing](https://postscript.io/pricing), fetched 2026-08-11)

| Plan | Platform | SMS (US/CA) | MMS | All-in SMS/segment |
|---|---|---|---|---|
| Starter | $0/mo, **$49/mo minimum spend** | ~~$0.015~~ **$0.009** | $0.045 | $0.01318 (promo) / $0.01918 (list) |
| Growth | $100/mo | ~~$0.01~~ **$0.008** | $0.03 | $0.01218 (promo) / $0.01418 (list) |
| Professional | $500/mo | $0.007 | $0.024 | **$0.01118** |
| Enterprise | Contact sales | — | — | — |

  The strikethroughs are on the live page: **Starter and Growth rates are promotional**, with list rates of $0.015 and $0.01. Budget against list.
- **Real costs** (my computation at 1.3 segments): **A** $49 (minimum binds against ~$27 of usage) · **B** ~$733/mo (Growth) · **C** ~$6,314/mo (Professional).
- **Contract:** none required. The page offers *"the option to get on a contract"* but states *"we do not require it."* No onboarding fee. No subscriber limits on any plan.
- **Carrier fees:** additive, as quoted above. **No charge for inbound or failed messages.** Toll-free number free on all plans; dedicated short code $750/mo.
- **Free tier:** *"When you start a free trial, you'll receive a credit equal to $100 that you can use during your first 30 days"*, covering message and carrier fees.

#### Klaviyo SMS

- **Positioning:** email + SMS + CDP for ecommerce at every size. The default consolidation play, and now moving into service (see §6).
- **Model:** hybrid, and structurally punitive at scale — you pay a **per-contact email plan** whether or not you use email, then stack **prepaid SMS credits** on top. [klaviyo.com/pricing](https://www.klaviyo.com/pricing) (fetched 2026-08-11) no longer renders a static table; it is a plan calculator.
- **Credit mechanics:** US SMS ≤160 chars = 1 credit; longer messages split into 153-char segments at 1 credit each; **US MMS = 3 credits**; emoji drops the cap to 70 chars and can double burn. **Credits do not roll over.** 150 credits/mo included on paid plans. International multipliers: Canada 3x, Australia 4x, UK 5x.
- **Credit ladder** `[UNVERIFIED — third-party]`: 1,250 = $15 · 5,000 = $45 · 10,000 = $90 · 50,000 = $450 · 100,000 = $900, settling at **~$0.009/credit** above 5,000 ([firstpier.com](https://www.firstpier.com/resources/sms-klaviyo-pricing), fetched 2026-08-11).
- **Email contact tiers** `[UNVERIFIED — third-party]`: 500 = $20 · 5,000 = $100 · 10,000 = $150 · 50,000 = $720 · 100,000 = $1,380 ([omnisend.com](https://www.omnisend.com/blog/klaviyo-pricing/), fetched 2026-08-11).
- **Real costs (stacked):** **A** ~$45/mo · **B** ~$510/mo · **C** ~$4,980/mo. Klaviyo is the **cheapest option at tiny scale and among the most expensive at 100k**, because the email contact tier rides along regardless.
- **Contract:** month-to-month self-serve, no minimum. **Carrier fees:** absorbed into the credit. **Free tier:** yes — 250 profiles, 500 emails/mo, **$5 of mobile messages/mo** (confirmed on-page).

#### Emotive

- **Positioning:** SMB/mid-market ecommerce SMS, sold on conversational two-way messaging. Aggressively positions against annual-contract incumbents.
- **Model:** flat monthly fee + per-message rate, tiered by list size. **Verified: Emotive is no longer revenue-share** — the historical performance-pricing model has been replaced by a published rate card ([emotive.io/pricing](https://emotive.io/pricing), fetched 2026-08-11).

| Tier | List size | Monthly | SMS | MMS |
|---|---|---|---|---|
| Starter | <2,000 | $100 | $0.015 | $0.025 |
| Pro | 2,000–5,000 | $200 | $0.01 | $0.02 |
| Advanced | 5,000–10,000 | $300 | $0.008 | $0.016 |
| Enterprise | >10,000 | Custom | — | — |

- **Real costs:** **A** ~$200/mo (minimum spend binds) · **B** ~$620/mo · **C** custom, unpublished.
- **Contract:** monthly, no long-term lock-in. They advertise a **contract buyout** — *"We'll meet or beat any price, anytime"* — a direct raid on Attentive and Postscript. Also a **"5x SMS ROI guarantee"** and a 14-day free trial.
- Separate product **CartAI** at **$50 per 100 tracked users**, requiring ≥10,000 monthly unique visits ([emotive.io/pricing/cartai](https://emotive.io/pricing/cartai), fetched 2026-08-11).

#### Sendlane

- **Positioning:** unified email + SMS + reviews for ecommerce. Differentiates on **unlimited contacts** and at-cost SMS.
- **Model:** priced on **send volume, not contacts** — a genuinely different axis. From [sendlane.com/pricing](https://www.sendlane.com/pricing) (fetched 2026-08-11): *"Unlimited Contacts — Pay for sends, not profiles."* SMS: *"Direct Rate SMS: You pay what we pay — not a penny more"* at **$0.009/credit inclusive of carrier fees**, plus a **$10/mo activation fee**. SMS requires a paid account and is excluded from the trial.
- **Real costs (SMS component):** **A** ~$24 + email plan · **B** ~$370 + email plan · **C** ~$3,610 + email plan. Email plan entry is **$100/mo**; higher tiers conflict across sources and are `[UNVERIFIED]`.
- **Contract:** monthly or annual, annual discount unspecified. **Free tier:** 60 days free, capped at 100 contacts / 500 email sends, SMS excluded.

#### Recart

- **Positioning:** SMS + list growth for Shopify DTC, heavy on opt-in optimisation and managed onboarding. Mid-market only.
- **Model:** flat fee with a bundled message allotment, carrier fees additive ([recart.com/pricing](https://recart.com/pricing), fetched 2026-08-11).

| Plan | Monthly | Included SMS | Rate | MMS |
|---|---|---|---|---|
| Starter | $299 | 23,000 | $0.0100 | $0.0280 |
| Pro | $499 | 41,583 | $0.0085 | $0.0265 |
| Scale | $999 | 100,000 | $0.0070 | $0.0240 |
| Enterprise | Custom | — | from $0.0045 | from $0.0190 |

- **Real costs:** **A** $299/mo — you buy 23,000 messages to send 1,600; Recart does not serve small brands. **B** ~$679/mo · **C** ~$4,900/mo.
- **Contract:** **12-month commitment** on published rates — the only self-serve vendor here with a mandatory annual term. No setup fee; migration and onboarding included. All plans include *"Unlimited Active Subscribers."*
- **Carrier fees:** additive — *"Avg. US carrier fees: $0.0045/SMS, $0.011/MMS."* **Free tier:** none; demo only.

#### Community.com

- **Positioning:** conversational SMS for creators, celebrities, artists, athletes and political campaigns. Audience-relationship-led, not ecommerce-conversion-led. Genuinely a different category and **not a direct competitor**.
- **Model:** three plan-based tiers (Small Business, Mid Market, Enterprise), **contact-sales only** ([community.com/pricing](https://www.community.com/pricing), fetched 2026-08-11): *"Plan-based pricing scales with your needs. Get your tailored quote."* No fees, rates, contract length or trial terms published.
- **Real costs:** could not be established. Two conflicting third-party figures — **$199/month** starting ([GetApp](https://www.getapp.com/marketing-software/a/community/), updated March 2026) and *"flat at $99"* ([messagemyfans.com](https://messagemyfans.com/blog/best-sms-platform-for-community-building/)) — neither authoritative. `[UNVERIFIED]`

#### Twilio (raw infrastructure baseline)

- **Positioning:** raw CPaaS. No segmentation, flows, popups or attribution. This is the "build it yourself" floor.
- **Pricing** ([twilio.com/en-us/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us), fetched 2026-08-11): outbound and inbound SMS **$0.0083** across long code, toll-free and short code; outbound MMS **$0.022**. Carrier pass-through additive: AT&T $0.0035 out, T-Mobile $0.0045, Verizon $0.0045. Numbers: long code **$1.15/mo**, toll-free **$2.15/mo**, short code **$1,000/quarter** random or **$1,500/quarter** vanity. Failed message processing $0.001.
- **All-in ≈ $0.0118–0.0128 per outbound SMS segment.**
- **The decisive observation:** **Twilio raw is not cheaper than Postscript.** Postscript Professional at $0.01118 all-in undercuts Twilio's own retail. Postscript, Sendlane and Klaviyo have negotiated better-than-retail aggregator rates and pass most of them through **with a marketing platform attached**. Building on Twilio buys control, not savings.
- **Real costs:** **A** ~$25–30 · **B** ~$480 · **C** ~$4,800 — with no marketing features whatsoever.

#### Telnyx (our own baseline, for comparison)

- **Pricing** ([telnyx.com/pricing/messaging](https://telnyx.com/pricing/messaging), fetched 2026-08-11): local 10DLC outbound and inbound SMS **$0.004/segment**; outbound MMS **$0.015**; inbound MMS $0.005. Toll-free SMS $0.0055; short code $0.007. Numbers **$1.00/mo + $0.10** for SMS/MMS capability.
- **10DLC fees** ([support.telnyx.com/en/articles/5634625](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges), fetched 2026-08-11): brand registration **$4.50** one-time, campaign review **$15** one-time, standard campaign **$10/mo**, low-volume mixed $1.50/mo. Carrier surcharges passed through at cost: T-Mobile $0.003 send and receive; AT&T $0.003 send, free receive; Verizon $0.0045 send, free receive. MMS: AT&T $0.0090, T-Mobile $0.010, Verizon $0.0070.
- **All-in ≈ $0.0075 per outbound SMS segment, $0.0237 per MMS.**
- **Telnyx is ~45% below Twilio on the base rate.** This single fact is what makes the infrastructure model arithmetically viable at all. See §5.

### 1.3 Comparison matrix — pricing and terms

| Platform | Model | Scale A (400) | Scale B (10k) | Scale C (100k) | Minimum / contract | Carrier fees | Free tier |
|---|---|---|---|---|---|---|---|
| **Klaviyo** | contact tier + credits | **~$45** | ~$510 | ~$4,980 | none | absorbed | 250 profiles, $5 msgs/mo |
| **Postscript** | platform + per-segment | $49 (min binds) | ~$733 | ~$6,314 | none | **additive** | $100 credit / 30 days |
| **Sendlane** | send volume, unlimited contacts | ~$124 w/ email | ~$470 w/ email | ~$3,610 + email | none | absorbed | 60 days, no SMS |
| **Emotive** | flat tier + per-msg | ~$200 (min) | ~$620 | custom | monthly | not stated | 14 days |
| **Recart** | flat + allotment | $299 | ~$679 | ~$4,900 | **12 months** | **additive** | none |
| **Attentive** | custom usage | unavailable | ~$950–1,500 | ~$3,000–8,000 | **$2–3k/qtr, 6–12 mo, non-refundable** | **additive** | none |
| **Community.com** | flat, undisclosed | unknown | unknown | unknown | undisclosed | unknown | unclear |
| **Twilio raw** | pure usage, no features | ~$25–30 | ~$480 | ~$4,800 | none | additive | trial credit |
| **Telnyx raw (ours)** | pure usage, no features | **~$27** | **~$410** | **~$3,984** | none | additive at cost | none |
| **Yotpo / SMSBump** | — | \- | \- | \- | **DISCONTINUED 2025-12-31** | — | — |

**The structural gap this reveals:** the 400-contact tier is essentially unserved by the mid-market. Recart ($299 floor), Attentive (~$667+ floor) and Emotive ($200 minimum) all price a small brand out. Only Klaviyo (~$45) and Postscript ($49) compete there, and Postscript's $49 is a *minimum spend* against ~$27 of real usage. That is the clearest pricing wedge in the market — and it is worth about $20/month per customer, which is not a business. See §5 for why.

---

## 2. The high-risk gap — testing the central thesis

This section decides whether the strategy is sound. I tested it as hard as I could and the answer is **partially confirmed, with an important correction and a serious caveat.**

### 2.1 The correction: the CTIA standard does not prohibit supplements or peptides

I fetched and extracted the full text of the **CTIA Messaging Principles and Best Practices, May 2023** — the current published version — from [api.ctia.org](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf) (fetched and text-extracted 2026-08-11).

A full-text search of the 22-page document returns **zero occurrences** of: SHAFT, cannabis, CBD, tobacco, firearm, alcohol, prescription, controlled substance, "prohibited", or "restricted". The single occurrence of "supplement" is the ordinary English verb.

Section 5.3.1 is the **only** content restriction in the document, and it is a general standard, quoted in full:

> "Message Senders should take affirmative steps and employ tools that can monitor and prevent Unwanted Messages and content, including for example content that: (1) is unlawful, harmful, abusive, malicious, misleading, harassing, excessively violent, obscene/illicit, or defamatory; (2) deceives or intends to deceive (e.g., phishing messages intended to access private or confidential information); (3) invades privacy; (4) causes safety concerns; (5) incites harm, discrimination, or violence; (6) is intended to intimidate; (7) includes malware; (8) threatens Consumers; or (9) does not meet age-gating requirements."

**Implication.** "SHAFT" is not an industry standard codified by CTIA. It is **platform acceptable-use language and individual carrier policy**. The gate that keeps a peptide brand off Klaviyo is a **commercial and discretionary** decision, not a regulatory prohibition. This is genuinely good news for the thesis — a discretionary gate is one a differently-motivated operator can choose to open. It is also the reason the position is fragile: what discretion opens, discretion closes.

### 2.2 Klaviyo — verified verbatim, and it is a direct hit

From [klaviyo.com/legal/acceptable-use-policy](https://www.klaviyo.com/legal/acceptable-use-policy) (fetched 2026-08-11). Prohibited product and service categories include, verbatim:

> "Prescription medications, pharmaceutical products or services, medical therapies, telehealth"

and:

> "we reserve the right to evaluate and restrict any use cases related to illegal or controlled substances"

**SMS is held to a stricter standard than email.** For short codes and toll-free numbers in the US and Canada, Klaviyo additionally prohibits:

> "Illegal substances" including "CBD, marijuana/cannabis, prescription medication that cannot legally be sold over the counter, Kratom, vaping/e-cigarettes, THC"

> "Sex, hate, alcohol, firearms, and tobacco (SHAFT)"

**Honest reading of this.** Telehealth is banned outright — that is unambiguous and it is a whole vertical. CBD, cannabis, kratom and vape are banned on SMS specifically. But **dietary supplements are not named anywhere**, and neither are research peptides. A supplement brand can use Klaviyo. A research-peptide brand falls into an unnamed grey zone where "medical therapies" and "controlled substances" are the clauses a reviewer would reach for, and the outcome depends on how the brand's own site describes the product. A store selling "research chemicals, not for human consumption" reads differently from one selling a GLP-1 protocol with dosing guidance — and the second is the one that gets removed.

So the thesis holds for **telehealth, CBD/hemp, kratom, vape, and aggressively-marketed peptides**. It does **not** hold for plain supplements, which are served fine today.

### 2.3 Attentive — verified verbatim, and it lands the same way as Klaviyo

Attentive has **no page at `/legal/acceptable-use-policy`** — it 404s. The prohibited-content list lives at [attentive.com/legal/content-policy](https://www.attentive.com/legal/content-policy) (fetched 2026-08-11). Its SMS/MMS-specific prohibitions:

> **SHAFT Content:** Sex, Hate, Alcohol, Firearms, Tobacco

> "Alcohol restriction does not apply where client has implemented an age gate"

> "Includes vaping products" (tobacco category)

> "Endorsement of illegal or illicit drugs, including cannabis and CBD"

> "Gambling: the gambling category is prohibited"

Plus, across all products: *"Protected Health Information"* (HIPAA-regulated data), *"Sensitive Data"*, pornographic/obscene content, hate and violence, illegal content, high-risk financial services (payday lending, debt collection), debt forgiveness, affiliate marketing, sweepstakes, and *"Companies selling personal information."*

**Read this carefully, because it is the same pattern as Klaviyo and it constrains the pitch.** Attentive bans **CBD and cannabis** outright on SMS, bans **vape and tobacco**, bans **alcohol without an age gate**, and bans **gambling**. It does **not name supplements, nutraceuticals, peptides, prescription drugs, or telehealth** anywhere. The PHI clause constrains what a telehealth brand can *say* but is not a categorical ban on the vertical.

### 2.4 The empirical test: who is actually running these brands today?

Policy text is weaker evidence than deployed tags. Live page-source fingerprinting (all fetched 2026-08-11) settles the question:

**Attentive is live on supplement brands right now.** `bloomnu.com` loads `cdn.attn.tv/bloomnu/dtag.js?shop=bloomnutrition.myshopify.com`; `jockofuel.com` loads `cdn.attn.tv/jockofuel/dtag.js`. Also fingerprinted: **Legion Athletics**, **OLLY**, **Beam**. Attentive *publishes* supplement case studies, including [The Vitamin Shoppe](https://www.attentive.com/case-studies/how-the-vitamin-shoppe-prioritizes-subscriber-quality-and-retention-in-a-volume-driven-market) (28x ROI, 171k new subscribers in six months) and a dedicated [fitness and wellness industry page](https://www.attentive.com/fitness-wellness-marketing).

**Postscript is live on supplement brands.** `ghostlifestyle.com` and `transparentlabs.com` both load the Postscript SDK. Published case studies include **Bare Performance Nutrition** ($1M SMS revenue in four months) and **Insane Labz** (50,000+ SMS subscribers, ~$200K/month SMS-attributed revenue). Recart published a **BulkSupplements** case study — *"85k Subscribers & Generated $853k from SMS"*, 44x ROI (retrieved via web.archive.org; the live page now 404s).

**And the single most damaging data point: Attentive publishes a telehealth pharmacy case study.** [MintRx](https://www.attentive.com/case-studies/how-mintrx-connects-every-step-of-the-patient-journey-with-sms-email-powered-by-attentive) is described by Attentive as *"a rapidly expanding e-commerce and telehealth pharmacy brand"* fulfilling through its own Arizona pharmacy, specialising in *"hormone replacement therapy (HRT), erectile dysfunction (ED), dermatology, longevity treatments, and weight loss"*, running Attentive SMS and email for refill reminders and treatment-segmented campaigns. **That is precisely the vertical Klaviyo bans by name, running on Attentive, in a published reference customer.**

**Where the thesis does hold: research peptides.** Zero Attentive, zero Postscript, zero Klaviyo SMS across every reachable peptide storefront — Behemoth Labz, Core Peptides, Limitless Life Nootropics, Loti Labs, Swiss Chems, Sports Technology Labs. All are on **Omnisend or hand-built SMS**, and all are **WooCommerce/WordPress rather than Shopify**, which structurally excludes them from the Shopify app ecosystem where Attentive and Postscript live.

**The clearest demand signal in this entire document:** Loti Labs carries full TCPA consent copy delivered by custom WordPress plugins named `sp-mailman` and `sp-compliance-gate`, alongside a high-risk payment stack (NMI + Authorize.net). **An operator wrote their own TCPA compliance gate because nobody would sell them one.**

### 2.5 The scorecard

| Vertical | Carrier / TCR level | Platform level | **Telnyx** | Verdict |
|---|---|---|---|---|
| **Dietary supplements** | Not prohibited anywhere — CTIA 0, T-Mobile 0, TCR 0, DCA codes 0 | **Permitted and actively served** by Attentive, Postscript, Klaviyo, Recart | *"Unregulated or prohibited supplements"* prohibited | **Thesis FALSE. Not a wedge.** |
| **Research peptides / SARMs** | Not named, but FDA-unapproved → fails T-Mobile's "legal across all 50 states" | Not named by anyone; **empirically zero incumbent presence** | *"Substances that are not legally approved for sale"* — direct hit | **Thesis TRUE — but the block is legality, not squeamishness** |
| **Compounded GLP-1 / telehealth / Rx** | 10DLC: no prohibiting code. **Toll-free: code 1702 hard reject** | **Klaviyo bans outright. Sendlane bans pharmaceuticals. Attentive publicly serves MintRx** | *"Controlled or prescription drugs without proper authorization"* | **Thesis PARTLY TRUE.** Must use 10DLC, never toll-free |
| **CBD / hemp** | **Hard banned** — DCA code 701 (10DLC) and 1701 (toll-free) | Banned by Attentive, Postscript and Klaviyo explicitly | Explicitly banned, including *"CBD wellness or supplement products"* | **Thesis TRUE — but no platform can fix it** |
| **Kratom** | Not in any carrier document, but illegal in 9 states → fails the 50-state rule | **Klaviyo names it**; Attentive and Postscript do not | Not named | **Thesis PARTLY TRUE** |
| **Nicotine / vape** | 10DLC code 707 age-gate, resubmittable. **Toll-free 1806 hard ban**, including cessation products | All three ban it (tobacco includes vape) | *"Strictly prohibited"* | **Thesis TRUE** |
| **Adult** | DCA 703 / 1801 hard ban | All ban | **Banned outright, *"regardless of whether such activity is lawfully permitted"*** | **Thesis TRUE — and Telnyx is the blocker** |
| **Affiliate marketing** (overlay) | **Hard banned**, DCA 708/709, plus a written attestation required at TCR registration | All three ban | Prohibited | **Structural blocker for affiliate-driven models** |

**The honest reading.** The thesis **fails outright for dietary supplements** — the market leaders do not merely tolerate them, they market to them with published case studies. It **fails partly for telehealth**, because Attentive takes that business even though Klaviyo will not. It **holds for CBD, vape and adult**, but in those categories the block is at the carrier layer, so **no platform can solve it and neither can we**. It **holds cleanly for research peptides** — but for the uncomfortable reason that peptides plausibly fail a legality test, not because incumbents are squeamish.

### 2.6 Telnyx is a problem, not a permission

**This inverts the assumption the strategy rests on.** Telnyx's [acceptable use policy](https://telnyx.com/acceptable-use-policy) (fetched 2026-08-11) is indeed thin — no SHAFT list, no vertical blocklist, only an outright prohibition on *"any pornographic and/or adult entertainment industry purpose, regardless of whether such activity is lawfully permitted"*, plus incorporation of carrier and CTIA rules by reference and a reservation of enforcement *"in its sole discretion."*

**But the AUP is not the operative document.** [Forbidden Messaging Use Cases in the US and Canada](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code) (fetched 2026-08-11) states, verbatim:

> **Illegal Products and Substances** — Messages promoting or facilitating the sale of illegal goods are not allowed, including: • Controlled or prescription drugs without proper authorization • **Substances that are not legally approved for sale** • **Unregulated or prohibited supplements** — These restrictions apply **regardless of business licensing status.**

> **Cannabis, CBD, and Related Products** — ... prohibited across all US and Canada messaging channels, **regardless of state or provincial legalization status.** This includes ... **CBD wellness or supplement products** ...

> **Restricted Business Models** — Certain business types are not supported for messaging, **even if individual messages appear compliant** ... Businesses operating primarily in prohibited verticals ... **Third-party traffic or passthrough messaging sent on behalf of unregistered businesses**

**Three things follow, and none of them is comfortable.**

1. **Telnyx is one of only two vendors in this entire study that prohibits supplements by name** — the other being Postscript, and only for its AI features. On the exact vertical this strategy targets, **Telnyx is stricter than Twilio and Bandwidth**, whose policies are thinner here. Sinch's compliance pages render client-side and could not be assessed `[UNVERIFIED]`. Twilio prohibits prescription drugs but says nothing about supplements.
2. **Research peptides land squarely inside two Telnyx clauses** — *"substances that are not legally approved for sale"* and *"unregulated supplements"*. Compounded GLP-1 lands inside *"controlled or prescription drugs without proper authorization."* The beachhead vertical is prohibited by our own supplier.
3. **"Third-party traffic or passthrough messaging sent on behalf of unregistered businesses" describes an ISV reselling SMS** — which is what we are. Whether we fall foul of it depends entirely on whether each tenant is separately registered, which is another reason per-tenant brand and campaign registration is not optional.

**This is now the largest single risk in the plan, and it is a supply problem rather than a demand problem.** Two consequences, neither optional:

- **Re-examine the carrier choice before building further.** If the positioning depends on serving peptides or unregulated supplements, Telnyx is the first thing to revisit, not the last. Note the trade-off: §5.2 shows Telnyx's price is what makes the cost model work at all, so a move to Bandwidth or Sinch weakens §5 further.
- **Multi-carrier abstraction from day one.** Write the messaging layer so a tenant can be re-homed without a rewrite. Single-sourcing on a supplier that both prohibits our vertical and reserves sole discretion is not a platform, it is concentration risk with a UI.

### 2.7 The carrier layer — where the gate actually is

**T-Mobile's Code of Conduct v2.2 (November 2020)** ([t-mobile.com](https://www.t-mobile.com/support/public-files/attachments/T-Mobile%20Code%20of%20Conduct.pdf), fetched and text-extracted 2026-08-11) is the most consequential carrier document. Its §5.2 "Disallowed Content" list in full: high-risk financial services, debt forgiveness, **"Illegal Substances — Cannabis, Illegal Prescriptions"**, work and investment opportunities, gambling, and third-party lead generation. **A term scan returns zero mentions of supplement, nutraceutical, vitamin, weight loss, peptide, SARM, kratom, telehealth, CBD, vape or nicotine.** Note the wording is *"Illegal Prescriptions"*, not "prescriptions".

The operative teeth are elsewhere, in §5.1:

> "Programs must operate according to all applicable federal and state laws and regulations. **In addition, the content must be legal across all 50 states.**"

**That single sentence is the real gate.** It is what excludes SARMs (FDA-unapproved) and kratom (illegal in nine states) without either ever appearing on a list. It is a legality test, not a vertical blocklist.

**SHAFT is not in the CTIA Messaging Principles** (§2.1) — it lives in the **CTIA Short Code Monitoring Handbook v1.9** ([api.ctia.org](https://api.ctia.org/wp-content/uploads/2024/01/CTIA-Short-Code-Monitoring-Handbook-v1.9-FINAL.pdf), fetched 2026-08-11), and even there it is an **age-gate test rather than a ban**: content that is *"not federally illegal, but exists without a functioning age gate"* is remedied by *"Add a functioning age gate"*.

**The Campaign Registry has no vertical list at all.** Its CSP User Guide (July 2026 v2) returns zero hits for SHAFT, cannabis, CBD, supplement, prescription, telehealth, peptide, kratom or "high risk", and states plainly: *"TCR is not a compliance house and therefore we cannot comment on compliance matters."* A supplement or peptide brand registers as **Marketing**, a Standard use case with no pre-approval.

**Rejection actually happens at the Direct Connect Aggregator vetting layer**, and the code space is public ([bandwidth.com, dated 2026-03-17](https://www.bandwidth.com/support/en/articles/12823079-dca2-vetting-rejection-reasons), fetched 2026-08-11). There are exactly nine prohibited-content codes: 701 Cannabis, 702 Guns (age gate), 703 Explicit sexual, 704 Gambling, 705 Hate, 706 Alcohol (age gate), 707 Tobacco/Vape (age gate), 708 Lead gen/affiliate, 709 Lead gen/high-risk financial.

**There is no rejection code for supplements, peptides, SARMs, research chemicals, kratom, telehealth or prescription drugs on 10DLC. A vetting agent has no code to assign.**

Two operational details that matter more than any policy:

- **Code 701 contaminates the entire website, not just the message.** Verbatim: *"This content is not allowed to be on the customer's website at all. Example: If a chiropractor's office has CBD oils on its website, this is prohibited, and the campaign will be denied, even if not directly related to CBD marketing."* Many supplement and peptide sellers carry one CBD SKU. **That single SKU ends their entire messaging programme** — and this is likely a bigger practical blocker than anything on any prohibited list.
- **Toll-free is materially stricter than 10DLC.** Code **1702 hard-rejects prescription drugs and controlled substances**, and 1806 hard-rejects tobacco, vape and nicotine *including cessation products*, where 10DLC allows the latter with an age gate. **For any pharma-adjacent brand, 10DLC is the only viable route, and the toll-free loophole is closing** — Telnyx notes the Business Registration Number became mandatory on 2026-02-17 ([support.telnyx.com](https://support.telnyx.com/en/articles/13765655-compliance-catch-up-why-toll-free-verification-now-mirrors-10dlc), fetched 2026-08-11).

**Verizon defers wholesale to the CTIA handbook** and publishes no vertical list of its own. **AT&T has no discoverable public messaging code of conduct** — treat it as unknown, not permissive. `[UNVERIFIED — largest gap in the carrier research]`

**And the process is fuzzy by design.** A Hacker News thread, *"Ask HN: Do 10DLC Requirements make it impossible for hobby projects to send SMS?"* (2024-10-02, 45 points, 19 comments, [item 41717873](https://hn.algolia.com/api/v1/items/41717873), fetched 2026-08-11), has commenters describing repeated rejection cycles, penalties cited at *"$10k fine per offending message"*, and requirements *"fuzzy around the edges"*. Bandwidth's own prose even contradicts its own codes — its best-practices article says SHAFT-C is banned outright while codes 702/706/707 permit those categories with an age gate. **Manual vetting means outcomes vary by reviewer**, and that is the part a specialist can genuinely own.

### 2.8 Two things worth copying

- **Postscript legitimately unlocked a restricted vertical, and published how.** In January 2023 ([postscript.io/blog](https://postscript.io/blog/postscript-now-supports-alcohol-brands), fetched 2026-08-11) it announced alcohol support, having previously blocked it because there was *"not a cross-carrier solution—which meant those messages had a low deliverability rate."* The fix was to **partner with carriers to build in-thread age verification**: *"Postscript is able to verify subscriber age within the text thread, which has opened up alcohol messaging across all US carriers."* **That is the template**: build the carrier-required control, get carrier sign-off, then open the vertical. It is slow, unglamorous, and defensible.
- **The existing high-risk specialists have publicly given up on SMS.** **Alpine IQ** serves cannabis and firearms, but its own blog advises *"Removing your brand name or logo from all text message content is the most effective workaround here"*, and its CEO describes carrier behaviour as *"another escalation in their war on highly regulated markets"*, advising clients to *"diversify your channels to email or push as soon as possible"* — reporting **72% of client messages sent as email**. **Springbig** pitches its native app to *"break through carrier restrictions with push notifications."* **OtterText** maintains explicit `/shaft/` and `/non-shaft/` industry sections and **rejects cannabis, CBD, vape, kratom and peptides.** Nobody has solved SHAFT-C SMS. Assume we will not either.

### 2.9 The throughput ceiling

- **Throughput is a real, unengineerable ceiling.** A2P 10DLC throughput is set by TCR Trust Score, not by our software ([help.gohighlevel.com A2P MPS table](https://help.gohighlevel.com/support/solutions/articles/155000004527-message-throughput-mps-and-trust-scores-for-a2p-10dlc-in-the-us), fetched 2026-08-11): standard brand with Trust Score 75–100 gets **225 MPS**; 50–74 gets 120; 1–49 gets **12**; low-volume mixed gets 3.75 regardless; sole proprietor gets 2.25. A 400,000-segment send takes ~30 minutes at 225 MPS and **9.3 hours at 12 MPS**. A newly-registered high-risk brand starts low-trust. We cannot engineer around this, and we must not sell as if we can.

### 2.10 Verdict on the thesis — it does not survive as stated

**Falsified.** "Incumbents won't take supplement brands" is simply untrue. Attentive and Postscript actively market to supplements, publish case studies about them, and have their tags live on Bloom, Jocko Fuel, Legion, OLLY, Ghost Lifestyle and Transparent Labs today. Attentive even publishes a **telehealth pharmacy** reference customer. **Delete every claim that depends on this from all materials.**

**Confirmed but unfixable.** CBD, hemp, vape, nicotine and adult are genuinely excluded — at the **carrier** layer, by DCA codes 701/703/707 and their toll-free equivalents. No platform can serve them, including us. These are not addressable markets, they are closed ones.

**Confirmed, and this is the only real opening.** Research peptides have **zero incumbent presence** — verified across six storefronts. But the reason is uncomfortable: they plausibly fail T-Mobile's *"legal across all 50 states"* test and Telnyx's *"substances not legally approved for sale"* clause. **The vertical is empty because it is legally marginal, not because incumbents are fussy.** Serving it means underwriting a legality risk that better-capitalised companies have declined, on a carrier that prohibits it in writing.

**The reframe that is actually defensible.** The gate is not a vertical blocklist — it is a **legality test plus a registration-integrity test**. What kills these campaigns in practice is not the product category but the mechanics: website/brand/sample-message inconsistency, weak privacy policies, unverifiable calls to action, reseller KYC failures, and one stray CBD SKU triggering code 701. **Those are solvable, and solving them repeatedly is a product.** Add that T-Mobile explicitly sells exceptions — §5.2 names *"an official T-Mobile exception approval process"*, priced by Bandwidth at **$500 one-time per brand** for Special Business Review.

So the honest positioning is not "we take the clients they reject". It is: **"we get you registered, keep you registered, isolate you from everyone else's traffic, and hand your consent records back if it ever goes wrong."** That is a compliance-operations business. It is smaller and less glamorous than the original thesis, and it is the one the evidence supports.

### 2.11 Policy appendix — the remaining platforms

**Postscript** — [postscript.io/content-policy](https://postscript.io/content-policy), last updated 2023-01-09 (fetched 2026-08-11). Bans SHAFT, with alcohol permitted *"provided that there is robust in-thread age verification"*, firearms extended to *"non-cooking knives, tasers, stun guns, swords, pepper spray, toy weapons"*, and tobacco including *"all vaping products"*. Illegal content covers *"cannabis, CBD, cannabis derivatives (like Delta-8), hemp seed oil, hemp powder, and prescription drugs that cannot be sold over-the-counter"*. Its help centre adds: *"Beginning in May 2021, Postscript can no longer service brands that offer or communicate about sex, hate, firearms, or tobacco (CBD--included) products."*

**No mention of supplements, nutraceuticals, kratom, telehealth or peptides** — consistent with Postscript actively serving supplement brands. But note one revealing clause buried in the Postscript **Terms of Service**, AI Addendum §A, which refers to *"restricted product categories such as supplements or medical devices"* being excluded from AI features. Supplements are barred from AI-generated messaging specifically — **which only makes sense if supplement brands are customers.** They are.

**Sendlane** — [sendlane.com/terms](https://www.sendlane.com/terms) (fetched 2026-08-11) is the only platform with a flat pharmaceutical ban: businesses offering *"(b) pharmaceutical products"* cannot use the service, alongside escort/dating, work-from-home, day trading, gambling, credit repair, mortgages and loans, adult novelty, and list brokers. No SHAFT list, no supplement mention, no CBD mention.

**Plivo** — [plivo.com/legal/aup](https://www.plivo.com/legal/aup/) is the only vendor anywhere in this study that names **steroids**: *"narcotics, cannabis, steroids, or other controlled substances"*. Directly relevant, since SARMs and many research peptides are marketed adjacent to anabolic compounds.

**Twilio** — prohibits *"Illegal substances"* including cannabis, CBD and **prescription drugs**, plus SHAFT with age-gating permitted on long and short code. A term scan of its current US SMS guidelines returns **zero** hits for supplement, nutraceutical, prescription, telehealth, peptide or kratom in the restriction list. **Twilio does not prohibit supplements. Telnyx does.**

**Emotive, Yotpo/SMSBump, Recart and Community.com publish no locatable vertical policy.** Emotive's terms are boilerplate and its compliance page is JS-rendered; Yotpo's legal pages render client-side; Recart has no terms-of-service page at all (its sitemap contains only `/privacy-policy`); Community.com's terms reference an acceptable use policy whose every candidate URL 404s. **Any claim about what these four ban would be fabrication.** `[UNVERIFIED]`

---

## 3. AI feature audit — what "AI" concretely means today

### 3.1 Two corrections before anything else

**"Postscript Cami" does not exist.** No mention on postscript.io, its AI page, its help centre, or in any search result. **Postscript's AI sales associate is called `Shopper`** ([postscript.io/shopper](https://postscript.io/shopper), fetched 2026-08-11). Any internal planning built on "Cami" should be corrected. `[The "Cami" premise is UNVERIFIED and appears to be false]`

**Twilio ConversationRelay is voice-only.** [twilio.com/docs/voice/conversationrelay](https://www.twilio.com/docs/voice/conversationrelay) (fetched 2026-08-11): *"Twilio's Conversation Relay empowers you to build powerful AI voice experiences."* No messaging capability is documented. It is not an SMS-agent competitor.

### 3.2 The classification

Using strict buckets: **1** template/copy generation · **2** variant generation and A/B · **3** send-time optimisation · **4** natural-language segment discovery · **5** autonomous agents that plan an entire campaign or calendar · **6** conversational AI that replies to inbound customer texts · **7** analytics narration · **8** creative/image generation.

| | 1 copy | 2 variants | 3 send time | 4 NL segments | 5 autonomous campaigns | 6 inbound 2-way AI | 7 insight narration | 8 image gen |
|---|---|---|---|---|---|---|---|---|
| **Attentive** | GA | partial | GA (Send Time AI) | propensity only | **announced, NOT shipped** | **GA — Concierge (AI + human)** | announced only | none found |
| **Postscript** | GA (Brand Center) | **GA — Infinity Testing + Synthetic Controls** | partial | partial | no | **GA — Shopper** | GA (Conversation Insights) | none found |
| **Klaviyo** | GA | GA | GA | **GA — Segments AI** | **public beta — Composer** | **public beta — Customer Agent** | GA | **GA — Image Remix** |
| **Emotive** | none | none | none | none | none | **none — humans by choice** | none | none |
| **Recart** | GA | partial | GA | GA | partial | **no inbound AI** | no | partial |
| **Community.com** | GA (message generator) | no | no | no | no | no | no | no |
| **Twilio** | no | no | no | no | no | voice agents only | Conversational Intelligence | no |
| **OneText** | GA | no | no | no | no | **GA — and completes the purchase** | no | no |
| **Sendlane** | `[UNVERIFIED]` — `sendlane.com/features/ai` returns 404 | | | | | | | |
| **Yotpo / SMSBump** | — discontinued — | | | | | | | |

### 3.3 The single most important finding: nobody has shipped a GA bucket-5 agent

- **Attentive's "AI Campaigns"** — the genuinely agentic product, *"fully orchestrate end-to-end campaign creation using customer signals"* — was announced at Thread 2026 on **2026-05-26** as coming *"ahead of BFCM 2026"* ([attentive.com press release](https://www.attentive.com/press-releases/attentive-unveils-next-generation-of-agentic-ai-marketing-innovation-at-thread-2026), fetched 2026-08-11). **It is not GA.** So are their Reporting Agent, Brand Voice 2.0 and Predictive Analytics.
- **Klaviyo's Composer** moved to **public beta on 2026-06-30** ([digitalcommerce360.com](https://www.digitalcommerce360.com/2026/07/01/klaviyo-launches-beta-for-marketing-ai-agents/), fetched 2026-08-11) — roughly six weeks before this document. It *"audits campaigns and flows"* and drafts them.

**The window is real but narrow, and it is closing on a schedule we can read off a press release.** Building an AI wizard as *the* differentiator means shipping into a category where the two largest players have already announced the same product for this quarter.

### 3.4 What Attentive and Postscript actually ship (and what it cost them)

**Attentive**, from [attentive.com/pricing](https://www.attentive.com/pricing) (fetched 2026-08-11): AI Essentials (copy) on all plans; **AI Pro** as a flat monthly fee bundling Brand Voice AI, Send Time AI, Audiences AI (purchase-propensity segment membership, *not* natural-language discovery) and Identity AI; **AI Grow** for sign-up units; **AI Journeys priced per click**, choosing timing, frequency, copy, images and product recommendations per shopper for triggered messages; **Concierge**, enterprise-only, custom-priced — *"live agents and conversational AI working together"*, 24/7. Concierge launched people-powered in June 2022 with AI added April 2023. I found no documentation that Concierge independently completes a transaction `[UNVERIFIED]`.

**Postscript** ships the more interesting product. **Shopper** is GA with full production documentation ("Testing Shopper Before You Go Live", "Keeping Shopper Accurate Over Time"), replies *"in your brand voice in under 1 minute"*, pulls recommendations from Shopify metafields, is aware of sitewide sales, and escalates to Gorgias and Zendesk. **Infinity Testing** generates and evolves hundreds of on-brand variants and — uniquely in this category — ships **Synthetic Controls** for automation flows, with vendor-claimed *"20% revenue lift for Automations"* and *"38% EPM lift for Campaigns"*.

**And here is the fact that should shape our thinking most.** Postscript ran a ~100-person human sales centre in Phoenix for about three and a half years, then wound it down and replaced it with Shopper — which *was trained on the transcripts that centre produced*. From an interview with cofounder Alex Beller published 2026-04-11 ([twosetai.com](https://www.twosetai.com/insights/human-sales-center-to-ai-agents-ecommerce/), fetched 2026-08-11): *"Shopper handled simple conversations, humans handled escalations and complex cases. Over time, as Shopper improved, that ratio shifted."*

**The defensible AI in this category is bucket 6, and the moat is made of labour, not model access.** Three and a half years of human conversation transcripts is not something a competitor buys with an OpenRouter key. This is the clearest statement in this document of why "we have an AI wizard" is not a strategy.

### 3.5 Emotive has deliberately gone the other way

From [emotive.io](https://emotive.io/) (fetched 2026-08-11): *"We promise that we'll always have a human to help you, not an AI bot that causes frustration."* They market **TextPros™** — *"A dedicated staff of ex-agency SMS experts focused on optimizing your SMS account, included for free"*, claimed at ~$5,000/mo of value. No AI feature pages exist. Whether Emotive runs any customer-facing AI is `[UNVERIFIED]`; a third-party roundup describes their two-way conversations as dialogue trees, i.e. rules rather than an LLM.

That a funded competitor is actively positioning **against** AI is worth sitting with. It is at minimum evidence that "AI" is not yet the axis on which this market is won.

### 3.6 Notable entrants

- **OneText** ([home.onetext.com](https://home.onetext.com/), fetched 2026-08-11) — *"Shoppers can reply and buy with just one text"*, with **AI Smart Replies** and live concierge staff for complex cases. **This is the only product I verified that actually closes a transaction inside the SMS thread.** Claims *"up to 15% more total revenue from text to buy"* and *"16x more cart recoveries"* (vendor figures). Pricing not published.
- **LiveRecover** — human agents, no AI, priced **free plus 10% commission on recovered sales**. The cleanest performance-pricing precedent in the category and a useful model to study.
- **Siena** (formerly Cartloop) pivoted to AI CX and **deprecated its outbound SMS product**, stranding customers `[UNVERIFIED — sourced from a competitor's blog]`.
- **TxtCart** ($29–$999/mo, 10x ROI guarantee), **TextYess**, **Konvo AI**, **Charles** — inbound conversational commerce, mostly WhatsApp-led.

### 3.7 Do users think the AI is any good?

**Almost nobody is talking about it.** Across Shopify App Store reviews for Attentive, Postscript, Klaviyo, Emotive and Recart, merchants discuss pricing, contracts, billing and support constantly and **AI essentially never** — including for an app literally titled *"Attentive: AI-led Email & SMS"*. The six most recent Attentive reviews (March–May 2026, all 5-star) do not mention AI, Concierge or attribution once.

`[Coverage gap: G2, Trustpilot, TrustRadius, Capterra and Reddit were all unreachable (403) during this research. There are no verified G2 ratings or Reddit quotes anywhere in this document. This is a real hole, not a null result.]`

Verified Shopify App Store ratings (fetched 2026-08-11):

| App | Rating | Reviews |
|---|---|---|
| Klaviyo | 4.7 | 2,956 |
| Postscript | 4.7 | 1,146 |
| Recart | 4.7 | 447 |
| Attentive | 4.8 | 106 |
| **Emotive** | **3.7** | 89 |

Attentive's 106 reviews for a company of that size means Shopify is not where its customers live; a third-party aggregator reports **NPS +6** from 54 rated mentions over the year to 2026-07-10 `[UNVERIFIED — methodology unpublished]`, which is far less flattering.

**The practitioner verdict on the agents is consistent: useful assistant, not autonomous.** The sharpest critique, from Retenso (2026-07-06, [retenso.com/blog/klaviyo-composer](https://retenso.com/blog/klaviyo-composer/)):

> "The agent inherits your account's data quality completely and uncritically."
> "Messy accounts will get confident, well-formatted extrapolations of the mess."

It will, they note, *"build a beautiful abandoned-checkout campaign on top of a Placed Order metric that your payment provider never actually fires"*, and on scaling campaign volume: *"quintupling volume is the fastest route to the spam folder ever built."*

**And one finding that lands directly on our beachhead.** GOSH Digital, a Klaviyo Gold Partner with 150+ audits (2026-07-12, [goshdigital.co](https://www.goshdigital.co/blog/klaviyo-composer-review-2026-when-ai-beats-manual)):

> "Composer doesn't reliably insert the specific compliance language these verticals require"

— naming **supplements**, cannabis and financial services explicitly. A campaign-drafting agent that reliably inserts vertical-correct compliance language for regulated products is a narrow, credible, defensible thing to build. That is a much better description of our AI opportunity than "AI wizard".

---

## 4. What nobody does well — the recurring pain points

Counts below are distinct verbatim reviews retrieved, mostly from 1–2 star Shopify App Store slices. They are a floor, not a population estimate.

| Theme | Evidence strength | Distinct reviews |
|---|---|---|
| **Contract lock-in / cancellation** | **Very strong — dominant complaint** | 9 |
| **Pricing surprises / billing mechanics** | **Very strong** | 8 |
| Support quality | Strong | 6 |
| **Data portability / list release** | **Strong — confirmed by a competitor's own doc** | 2 + vendor documentation |
| Reliability / silent failure | Moderate (mostly historical) | 4 |
| Attribution inflation | Moderate-strong | 2 + 2 analytical sources |
| **No holdouts / incrementality** | **Structural and verified** | 0 (merchants don't know to ask) |
| **AI quality** | **Weak — nobody is discussing it** | ~0 merchant, 3 agency |
| Segment control | **Weak — do not build a thesis on this** | 1–2 |
| 10DLC pain | Real but blamed on carriers, not vendors | 1 quantified study |
| **Self-host / bring-your-own-carrier** | **No evidence at all** | **0** |

### 4.1 Contract lock-in — the dominant complaint, and it is not close

**Attentive** ([apps.shopify.com/attentive/reviews](https://apps.shopify.com/attentive/reviews), fetched 2026-08-11):

> "Run…don't walk away from this company. I asked if I could get out of my contract and they said no... Then a few weeks later I got a bill for $11k which was the remaining of my contract." — US merchant, 2025-07-10

> "coming from a store owner, this is the WORST company to work with. Stay far, far away. Lock you in contracts, tech is TERRIBLE, wasted so much time, energy and resources with this company." — Barre Definition, US, 2025-05-15

`[Data-integrity note: two fetches of the same page attributed the "$11k" review to different store names. The text is verbatim; do not cite a store name for it.]`

**Emotive** is the worst by concentration, which explains its 3.7 rating:

> "PREDITORY CONTRACT, DO NOT USE. This app does work well but if you are not aware of their exact contract terms you are screwed." — The Groovy Plants Ranch LLC, US, 2023-06-27

> "I have been trying to cancel my subscription with Emotive for months now and they keep charging me." — The Fantasy Box, US, 2025-10-10

Note the asymmetry: Postscript explicitly advertises *"we do not require"* a contract; Attentive publishes nothing and enforces 6–12 month terms with quarterly minimums billed regardless of usage.

### 4.2 Pricing surprises — and one specific, exploitable mechanic

**Postscript's minimum spend catches people:**

> "they offer a 'free plan' but charge you $49 even if you didnt send any text messages. a scam for small business owner." — JADE, US, 2026-04-16

**Klaviyo's per-profile billing combined with bot signups is a live 2026 wound** — four independent merchants raised the same mechanic within four months:

> "Last year, my monthly price went from 80usd to 150usd. And if I pause and resubscribe, it would be 200usd. That is a 250% price increase." — North Ones, SE, 2026-05-15

> "They make it impossible to clear all inactive profiles to suspended. This way they can keep increasing your monthy charge." — House of Dasein, AU, 2026-07-27

> "A large number of bots from Miami are signing up and creating fake email addresses, and there's no solution." — Tennail, UK, 2026-08-03

When billing is per-profile and bot signups inflate profile count, **the vendor has no incentive to help you purge.** That is a structural conflict of interest, and pricing on sends rather than profiles neutralises it. Sendlane already does this (*"Pay for sends, not profiles"*); so should we.

**Carrier fee transparency is near-universal poor.** Only Postscript publishes a number ($0.00418 SMS / $0.00841 MMS). On a 100,000-message send that is ~$418 nobody quoted.

### 4.3 Data portability — the best-evidenced structural finding

**Postscript's own migration documentation says Attentive has no self-service list export** ([help.postscript.io — Migrating from Attentive to Postscript](https://help.postscript.io/en/articles/13563832-migrating-from-attentive-to-postscript), fetched 2026-08-11):

> "At this time, Attentive requires that you request your subscriber list from your account representative."

Merchants corroborate:

> "They deal terribly when you decide to go. They didn't release our list on time and porting the number takes weeks (unnecessarily)." — GRIP6, US, 2024-04-05

> "If I could give no stars, I would. DO NOT use this company if you want to retain subscriber data..." — Common Good, US, 2023-10-04

Attentive does publish a segment-level export, and I retrieved its exact field list and disclaimer in §5.5 — but **a segment export is not a full list, and neither is a portable consent record.** Reconciling both sources: you can self-serve a partial export with no consent metadata, or ask your account rep and wait.

**Across every platform examined, none documents exporting timestamped opt-in proof.** `[UNVERIFIED for every vendor — the absence of documentation is itself the finding.]` Without it you cannot defend a TCPA claim after migrating.

### 4.4 No holdouts — the sharpest structural gap in the category

**Klaviyo gates incrementality testing at 400,000 profiles** ([help.klaviyo.com/hc/en-us/articles/18138290642971](https://help.klaviyo.com/hc/en-us/articles/18138290642971), fetched 2026-08-11):

> "You must have at least 400,000 profiles (note that this is total profile count) to qualify for holdout groups."

> "You can only have one active holdout group at a time"

> "Once you have chosen your holdout group percentage, it cannot be modified"

> "A holdout group applies to all channels used in a campaign or flow; it cannot be turned on for one specific channel vs. another."

**So: no SMS-specific incrementality at all, one experiment at a time, immutable design, and nothing whatsoever below 400k profiles.** A $5m/year brand with 80,000 profiles has no way to know whether its SMS programme is incremental. That is essentially the entire mid-market.

**Attentive: no holdout or incrementality product found** `[UNVERIFIED — absence of evidence, but I looked]`. **Postscript is the honourable exception**, shipping Synthetic Controls in Infinity Testing and having run *"a gold standard A/B holdout test… over 60 days"* for every SMS Sales onboarding — and they do not market it loudly.

### 4.5 Attribution

Klaviyo's defaults are **5 days for email (open or click) and 24 hours for SMS**, last-click ([orangefox.io](https://orangefox.io/how-klaviyo-calculates-revenue/), fetched 2026-08-11). The same analysis notes that moving the email window to 30 days *"can show email driving roughly 20 percent more sales"* and shortening to one day *"can cut it in half"* — the same programme, a different number, chosen by the vendor. On double counting: *"If you added up every channel's attributed revenue across your entire stack, the total would almost certainly exceed your actual store revenue."* Their working benchmark is that attributed email/SMS revenue should be **25–40% of total Shopify revenue**, with above 50% *"usually signals double counting"* `[agency analysis, methodology unpublished — UNVERIFIED]`.

Merchant-level complaints exist but are older, mostly against Recart, including one merchant reporting that ~80% of claimed "Extra Sales" did not match actual Shopify sales data (Jabees Store, HK, 2021-01-04).

**Attribution disputes are real but under-articulated by merchants** — they suspect the number is generous, they cannot prove it, and no vendor gives them the holdout that would settle it. §4.4 and §4.5 are the same problem.

### 4.6 10DLC registration

Best available data, from 47 real submissions over 12 months ([readysms.io](https://readysms.io/blog/10dlc-rejection-what-actually-gets-approved), fetched 2026-08-11): **70% approved on first submission, 19% rejected then approved on resubmit, 11% never approved.** Timeline **10–15 business days to first send**. Top rejection causes: sample messages lacking opt-out language, use case not matching sample content, vague opt-in descriptions, and brand-name mismatch between the legal entity and the public-facing business.

**Nearly one in three first attempts fails.** No merchant reviews blame a specific platform — the pain is attributed to carriers. That is an opportunity: registration success is a service outcome a specialist can own and sell, and it is exactly where a high-risk brand is most likely to fail alone.

### 4.7 Self-hosting and bring-your-own-carrier: zero evidence

Searched specifically. **No forum threads, no reviews, no merchants asking to bring their own Twilio account or self-host.** Two readings are possible — no demand, or demand invisible because no product offers it — and the research cannot distinguish them, especially with Reddit unreachable. Combined with the open-source evidence in §5.1, I lean strongly toward **no demand**. See §5.

---

## 5. The "own your infrastructure" angle — the cost model, computed carefully

This is presented as the strongest commercial argument. **The numbers do not support that claim.** They support a weaker, narrower, but still real one.

### 5.1 Is there demand? The evidence says almost none

- **Open-source energy is a proxy for builder demand, and the gap is three orders of magnitude.** A GitHub search for `sms marketing campaign in:name,description` sorted by stars ([api.github.com](https://api.github.com/search/repositories?q=sms+marketing+campaign+in:name,description&sort=stars&order=desc), fetched 2026-08-11) returns a top result of **26 stars, last pushed 2018-01-29**. The equivalent email search returns Ghost at **54,741 stars**, listmonk at **22,705** (pushed the same day it was fetched), BillionMail 15,408, Mailtrain 5,744, Keila 2,182. There is no self-hosted SMS marketing movement. There is a thriving self-hosted email one.
- **No agency sells it.** Four separate query formulations for agencies offering "we build SMS on your own Twilio account" returned **zero productized offerings**. What surfaced instead was the inverse: TextUs positioning itself as the *no-technical-setup* alternative at **$749/month** ([textus.com/blog/twilio-pricing](https://www.textus.com/blog/twilio-pricing), fetched 2026-08-11). The market prices "don't make me touch Twilio" *above* the SaaS, not below it. `[UNVERIFIED — absence of evidence, not evidence of absence]`
- **The builder community isn't discussing it.** A Hacker News Algolia search for "SMS marketing Twilio Attentive" returns **one hit, from 2013**, unrelated. Attentive and Postscript are essentially unmentioned on HN.
- **When developers do discuss SMS cost, the answer is procurement, not self-hosting.** *"Ask HN: How to send SMS cheaper than Twilio?"* (2022-02-01, 61 points, 67 comments, [item 30162963](https://hn.algolia.com/api/v1/items/30162963), fetched 2026-08-11) concerns 250k messages/month. The consensus is **negotiate with an aggregator** — SignalWire, Bandwidth, Telnyx and Teli are all named — with one commenter reporting **70% off list** at multi-million monthly volume. Nobody recommends building.

**Why the email analogy fails.** Sendy ([sendy.co](https://sendy.co/), fetched 2026-08-11) charges **"$69 One time fee"**, **"No monthly fees, no subscriptions"**, and sends at **"$1 per 10,000 emails via Amazon SES"** — $0.0001 per email, against ESP effective rates 20–100x higher. Self-hosted email exists because **SES is nearly free and ESPs charge rent on a commodity**. In SMS, the marginal cost is set by carriers, not by the vendor, and the vendor's negotiated rate is *better* than yours. The arbitrage that powers Sendy and listmonk simply is not there.

### 5.2 The unit economics

**Telnyx all-in, verified rates** (fetched 2026-08-11). Carrier surcharges blended at approximately T-Mobile 34% / Verizon 31% / AT&T 28% / other 7% `[UNVERIFIED — subscriber shares are approximate]`, giving a blended SMS send surcharge of **$0.0035** (band $0.0030–$0.0045):

| Unit | Telnyx | + carrier | **All-in** |
|---|---|---|---|
| Outbound SMS segment | $0.0040 | $0.0035 | **$0.0075** |
| Outbound MMS | $0.0150 | $0.0087 | **$0.0237** |
| Inbound SMS segment | $0.0040 | $0.0010 | **$0.0051** |

Fixed: number $1.10/mo · brand registration $4.50 once · campaign review $15 once · standard campaign $10/mo.

**Ratio against Postscript, per unit:**

| Unit | Telnyx | Postscript Pro | Postscript Growth (promo) | Postscript Starter (list) |
|---|---|---|---|---|
| SMS segment | $0.0075 | $0.01118 (**1.49x**) | $0.01218 (1.62x) | $0.01918 (2.56x) |
| MMS | $0.0237 | $0.03241 (**1.37x**) | $0.03841 (1.62x) | $0.05341 (2.25x) |

**The markup is 1.4–2.6x, not 10x.** Anyone pitching "SaaS SMS vendors are ripping you off" is wrong on the facts.

### 5.3 Scenario comparison

Assumptions: 4 sends per contact per month, **1.3 segments average per SMS**, 2–3% inbound reply rate. Two message mixes shown because MMS is where the markup is worst and the mix drives the answer.

| Scenario | Mix | Telnyx all-in | Postscript | Gross gap |
|---|---|---|---|---|
| **A** — 400 contacts, 1,600 msgs | all-SMS | **$26.94** | $49.00 (minimum binds) | $22 (45%) |
| **A** | 70/30 SMS/MMS | **$33.64** | $49.00 (minimum binds) | $15 (31%) |
| **B** — 10,000 contacts, 40,000 msgs | all-SMS | **$409.58** | $733.36 (Growth) | $324 (44%) |
| **B** | 70/30 | **$576.98** | $1,004.27 (Growth) | $427 (43%) |
| **C** — 100,000 contacts, 400,000 msgs | all-SMS | **$3,983.80** | $6,313.60 (Professional) | $2,330 (37%) |
| **C** | 70/30 | **$5,657.80** | $8,458.72 (Professional) | $2,801 (33%) |

**Sensitivity to the segment assumption**, which is the biggest swing factor. At Scenario B, all-SMS: at 1.0 segments Telnyx is $316 and Postscript $587; at 2.0 segments Telnyx is $616 and Postscript $1,074. **The absolute numbers move a lot; the ratio stays at 1.7–1.9x.** Quote ratios, not absolutes.

### 5.4 The caveat that kills the pitch

The gross gap is 33–45%. **But we have to take our software margin out of that gap.** If the customer pays Telnyx directly at cost and pays us a platform fee:

| Scenario | Telnyx at cost | + our platform fee | Total to customer | Postscript | Customer's net saving |
|---|---|---|---|---|---|
| **B** (70/30) | $576.98 | $400 | $976.98 | $1,004.27 | **~3% — parity** |
| **C** (70/30) | $5,657.80 | $1,000 | $6,657.80 | $8,458.72 | **~21%** |

**At 10,000 contacts, a customer switching to us from Postscript saves essentially nothing.** At 100,000 contacts they save about a fifth — real money ($21,600/year) but not a category-defining argument, and it evaporates if we price the software higher or if Postscript discounts.

Against **Attentive** the picture is different and better, because Attentive's cost driver is not messages — it is the **$2,000–3,000 non-refundable quarterly minimum** and a 6–12 month term. A brand paying Vendr's median $40,000/year that actually sends Scenario B volume is paying roughly 3.4x our all-in cost. **The cost pitch works against Attentive and fails against Postscript and Klaviyo.** Segment accordingly: our cost story is for brands leaving an enterprise contract, not for brands on a self-serve plan.

### 5.5 Where the "ownership" argument genuinely wins — and it is not price

The durable version of this pitch is **consent and data portability**, and the evidence here is unusually strong because it comes from the incumbents' own documentation.

**Attentive's subscriber export omits every field that matters for TCPA defence.** From [help.attentive.com — Export subscriber details for specific segments](https://help.attentive.com/hc/en-us/articles/39531032469524-Export-subscriber-details-for-specific-segments) (fetched 2026-08-11), the complete exportable field list is:

> First Name · Last Name · Subscriber Phone Number · Subscriber Email · SMS Marketing Status · SMS Marketing Opted Out · Email Marketing Status · Email Marketing Opted Out

**Not exportable: opt-in timestamp, IP address, opt-in source, or the consent language displayed at signup.** And Attentive's own disclaimer on that page, verbatim:

> "List exports may include subscribers who've opted out of your program and/or are on Attentive's proprietary internal known litigator list. You should seek the advice of your legal counsel about the sufficiency of consent and potential compliance risks if you intend to contact these subscribers outside the Attentive platform."

That is a vendor telling customers in writing that the list they just exported may not be safe to use.

**Postscript's own migration guide corroborates it** ([help.postscript.io — Migrating from Attentive to Postscript](https://help.postscript.io/hc/en-us/articles/7761230691099-Migrating-from-Attentive-to-Postscript), fetched 2026-08-11). It instructs brands to separately request the **"SMS Consent Timestamp"** from Attentive — a field the self-service export does not contain — and to:

> "take screenshots and/or photos of your opt-in forms with compliance language present so you can continue to keep your subscriber collection records."

A competitor telling your customers to photograph their own opt-in forms is a tacit admission that consent records are not portable through **either** platform. The guide also notes imported subscribers face a **1–3 business day compliance review**, and warns brands to exit subscribers from old flows so they don't receive messages from both numbers — confirming that in the typical case **the brand ends up on a new number, not a ported one.**

**Number porting is not unilateral.** From [help.postscript.io — Transferring Your Toll-Free Number from Klaviyo](https://help.postscript.io/hc/en-us/articles/13721821498395-Transferring-Your-Toll-Free-Number-from-Klaviyo-to-Postscript) (fetched 2026-08-11): *"Your requested date/time will be honored so long as Klaviyo provides the necessary approvals."* It requires a signed Letter of Authorization plus a phone bill, takes two business days if Twilio-hosted and **1–2 weeks otherwise**, and *"you may experience up to 1 hour of downtime."* **Attentive publishes no porting-out documentation at all.**

**This is the argument to lead with.** It is documented, quotable, verifiable by the prospect, and shared by every incumbent. And it is far more acute for a high-risk brand, because a brand that gets removed from a platform loses its list *and* its consent records at the same moment — exactly when it can least afford to. Note the uncomfortable corollary in §7: **we do not currently solve this either.**

---

## 6. Voice + SMS + inbox in one — is it valuable or a feature in search of a problem?

**Short answer: mostly a feature in search of a problem, with one narrow exception that happens to align with our beachhead.** I would not lead with it.

### 6.1 Who occupies the "unified customer conversation" space

All fetched 2026-08-11. "Native voice" means the product carries telephony itself. "Bulk marketing" means promotional sends to thousands, not 1:1 threads.

| Product | Positioning | Price | Native voice | Mobile app with real calls | Bulk SMS marketing |
|---|---|---|---|---|---|
| [Front](https://front.com/pricing) | Shared inbox for ops/support | $25 / $65 / $105 per seat/mo annual; Autopilot from $0.05/conversation; Copilot $20/seat | **No** — *"Manage calls and voicemails with integrations like Aircall and Dialpad"* | integration-dependent | No |
| [Missive](https://missiveapp.com/pricing) | Small-team shared inbox | $14 / $24 / $36 per user/mo | **No** — SMS via **your own Twilio** | iOS, Android, desktop | No |
| [Intercom](https://www.intercom.com/pricing) | Support + AI deflection | $29 / $85 / $132 per seat/mo; **Fin from $0.99 per outcome** | No — phone is usage-based add-on | Yes | Outbound exists, not a campaign engine |
| [Podium](https://www.podium.com/pricing/) | Local services, **per location** | Hidden. `[UNVERIFIED]` Core $399 / Pro $599 per location/mo, 12-mo auto-renew, Phones $500 setup + $30/user | **Yes** — Podium Phones VoIP | **Yes** | **Yes but capped at 250–500 msgs/mo** `[UNVERIFIED]` |
| [Heymarket](https://www.heymarket.com/pricing/) | Business texting for teams | $49 / $99 / $199 per user/mo, 2-seat min; SMS **$0.03/segment**; 10DLC $10/mo per campaign; AI messages 3x rate | No evidence | Yes | Yes — list broadcasts |
| [Text Request](https://www.textrequest.com/pricing) | SMB texting | `[UNVERIFIED]` $59–$1,400/mo, 6 tiers | Unknown | Yes | Yes, volume-gated |
| [Quo](https://www.quo.com/pricing) (was OpenPhone) | Business phone for SMBs | $19 / $33 / $47 per user/mo | **Yes** | **Yes** | No campaign tooling; API SMS $0.01 |
| [Gorgias](https://www.gorgias.com/pricing) | **Ecommerce helpdesk** — *"40% of Shopify brands"* | Tiers not extractable; *"AI Agent on every plan, pay only when it resolves"* | **Yes — native** Voice and SMS add-ons | Not documented | **No** — inbound only |
| [Zendesk](https://www.zendesk.co.uk/pricing/) | Enterprise support | £45 / £89 per agent/mo annual | **Yes** | Yes | No |
| [Chatwoot](https://www.chatwoot.com/pricing) (OSS, 35.7k stars) | Self-hostable Intercom alternative | Free / $19 / $39 / $99 per agent/mo | **Yes but browser only** — *"Calls run in your browser. No softphone, nothing to install"* | **No** | Yes — SMS campaigns |
| [Klaviyo](https://www.klaviyo.com/solutions/customer-service) | Ecommerce marketing → now service | per-product usage metric | **No** | Unknown | Yes |
| Attentive / Postscript / Emotive | Ecommerce SMS marketing | see §1 | **None** | n/a | **Yes — this is the category** |
| **Telynx Inbox (ours)** | — | — | **Yes, native CallKit** | **Yes, native SwiftUI** | **No — not built** |

### 6.2 Exactly one competitor does all three, and it fails instructively

**Podium** ships shared inbox, real VoIP with mobile calling, and bulk messaging. But bulk is capped at roughly **250 messages/month on Core and 500 on Pro** `[UNVERIFIED — third-party]`. A brand with 50,000 subscribers exhausts a Pro month's entire bulk allowance on **1% of one campaign**. Podium's bulk SMS is a "text our 300 regulars about the holiday special" feature for a dental practice. It was never a marketing engine.

Podium is also priced **per location** — which only makes sense with physical locations. Ecommerce brands have one warehouse. Podium is structurally unable to serve our market even if it wanted to.

Everyone else picks a side: bulk marketing without voice (Attentive, Postscript, Emotive, Klaviyo, Heymarket), or native voice and inbox without bulk marketing (Gorgias, Zendesk, Quo, Aircall, Dialpad, Chatwoot), or inbox with voice outsourced to integrations (Front, Missive, Intercom).

### 6.3 Why the gap exists — it is distribution, not product

The pricing metrics give it away:

| Side | Priced per | Buyer's metric |
|---|---|---|
| Marketing (Attentive, Postscript, Klaviyo, Emotive) | contact, message, attributed revenue | **revenue generated** |
| Support (Gorgias, Zendesk, Intercom, Front) | seat, ticket, **resolution** | **cost per contact avoided** |

Intercom charges **$0.99 per Fin outcome**; Gorgias and Zendesk charge per resolution. **These vendors earn more when more conversations happen.** Attentive earns more when more revenue is attributed. A product doing both must tell a CMO "this generates revenue" and a CX lead "this reduces cost per ticket" in the same sentence — two buyers, two budget lines, two ROI models, usually two approval chains.

Podium escapes this only because at a six-person dental practice **the marketer, the support rep and the owner are the same person**. Above roughly 20 employees the buyer splits in two. That is the real reason nobody has built this, and **it applies to us too** — with one important exception, below.

### 6.4 Both sides are converging anyway, with distribution we don't have

- **Klaviyo has entered the shared inbox.** [klaviyo.com/solutions/customer-service](https://www.klaviyo.com/solutions/customer-service) (fetched 2026-08-11) advertises a *"Unified inbox for email, chat, SMS, WhatsApp, and Instagram DMs"* alongside Customer Hub and AI agents, launched as **K:Service**. **Voice is not a channel.** The largest ecommerce marketing platform built the inbox and stopped precisely at the telephony line.
- **Gorgias has entered voice** — native Voice and SMS add-ons, on a base of *"40% of Shopify brands."*

Whoever wins the converged category will win it by cross-selling an installed base, not by building the feature first.

### 6.5 The marketing incumbents already solved this problem — with humans on SMS, not voice

- **Postscript Sales** ([postscript.io/sales](https://postscript.io/sales), fetched 2026-08-11): *"a team of highly trained SMS Sales Associates"*, US-based, 7-day coverage, **sub-5-minute average response**, engaging *"subscribers who aren't converting through marketing"* to *"address their buying objections."*
- **Attentive Concierge**: a hybrid where conversational AI and live human agents share a two-way SMS thread `[UNVERIFIED — Attentive's Concierge page 404'd on direct fetch]`.

**This is the most important evidence against the voice thesis.** The two companies with the most data about consultative closing in ecommerce both concluded the job is better done **asynchronously, on SMS, in the channel the customer already opted into** — and they staffed it with humans rather than building telephony. They are not ignoring voice out of oversight. Attentive, Postscript, Emotive and Klaviyo have collectively raised billions, hold deep ecommerce customer data, and have every incentive to expand ARPU. **Not one has shipped a voice product.** That is a market verdict.

### 6.6 Does ecommerce actually want to call customers?

The bullish statistics circulating on this are almost entirely vendor content and should be discounted to zero: *"76% of customers prefer phone support for complex issues"* comes from [agentzap.ai](https://agentzap.ai/blog/ecommerce-phone-statistics), which sells AI voice agents; *"88% of customers still call for help"* from [ringly.io](https://www.ringly.io/blog/phone-support-statistics-2026), which also sells AI voice agents; a *"86% of Gen Z prefer voice"* claim traces to a PR Newswire release that 404'd `[UNVERIFIED]`.

The one credible source is Invoca's **DTC eCommerce Lead Conversion Benchmarks Report 2026** (published July 2026, [invoca.com](https://www.invoca.com/reports/the-invoca-dtc-ecommerce-lead-conversion-benchmarks-report-2026), fetched 2026-08-11), drawn from a dataset of 70M+ calls and 600M+ minutes: **53%** of callers to DTC brands reach a person, **34%** of calls from digital marketing are qualified leads, and **54% of those leads convert on the call**. But note the selection bias — **Invoca's dataset consists entirely of brands that already bought call tracking**, i.e. brands that already believe in phone. It says nothing about the median DTC brand.

**The structural read.** Voice correlates with **consideration and ticket size**, not with the channel itself. Every product in the matrix shipping native voice sells to local services, enterprise retail, or sales teams. For a $40 supplement reorder nobody calls. For a $400 multi-month peptide protocol with dosing questions, a phone call is plausibly the highest-converting interaction available — high-ticket ecommerce converts at 0.5–1.5% against 2–4% standard ([fyresite.com](https://www.fyresite.com/average-ecommerce-conversion-rate-for-high-ticket-sales/), fetched 2026-08-11), a gap wide enough for human intervention to pay for itself.

### 6.7 The narrow, honest conclusion on voice

There **is** one unserved slot: **native voice with real mobile call handling attached to an ecommerce conversation record.** Gorgias Voice is helpdesk-bound with no documented mobile app; Chatwoot's voice is explicitly browser-only; Klaviyo has no voice. A founder or rep taking the call on their phone with full order history in front of them is genuinely not offered by anyone.

But: it is unserved because demand is thin, not because it is hard. And **our own voice product does not currently work multi-device** — `HANDOFF-CODEX.md`, investigated against the live database on 2026-08-06, documents that two users who both have the app installed cannot call each other; the outbound SIP leg fails. Voice today is a single-device product with a known open defect.

**Recommendation: keep voice, scope it deliberately to high-AOV consultative selling in the beachhead, and do not put it on the front of the pitch.** If it converts there, it becomes a wedge into a vertical. If we lead with it, we will spend the sales conversation explaining a capability the buyer did not ask for.

---

## 7. Honest verdict

### 7.1 What we actually have today

Audited directly in `/Users/ghost/telynx-inbox` on 2026-08-11 — 116 commits, last commit the same day. Node/Express on Railway, Supabase, Telnyx.

**Present and real:** two-way SMS/MMS inbox with tapbacks and read state; order-triggered flows (`flows/confirmed.js`, `failed.js`, `hold.js`, `shipped.js`); WooCommerce, ShipStation and GHL webhook integration; a genuinely native SwiftUI iOS client with CallKit and PushKit for incoming calls, APNs message alerts, and call logs.

**The AI today is thinner than the pitch implies.** `intelligence.js` is **188 lines** containing two OpenRouter calls — `analyseConversation()` and `generateCampaignBrief()` — defaulting to `anthropic/claude-3.5-haiku`. That is a thin LLM wrapper, not a system.

**Absent.** Grepping the whole JavaScript tree: `consent` 0 files, `attribution` 0 files, `holdout` 0 files, `segment` 1 file. There is no campaign engine, no segment builder, no list-growth or opt-in capture, no attribution, no A/B testing, no quiet-hours enforcement, and no throughput-aware send scheduler.

**And the consent ledger is one boolean.** The entire opt-out schema is `scripts/add-optout-column.sql`:

```sql
ALTER TABLE sms_contacts ADD COLUMN IF NOT EXISTS opted_out BOOLEAN DEFAULT FALSE;
```

There is no opt-in timestamp, source, IP, or record of the disclosure text shown at signup. **TCPA defence requires proof of prior express written consent.** A boolean is not that. This is the sharpest irony in the document: §5.5 identifies consent portability as our best argument, and **we do not currently solve it either.** Until we do, that pitch is not available to us honestly.

### 7.2 Differentiators ranked by defensibility

**1. Registration and compliance operations for marginal brands — MEDIUM-HIGH defensibility, and it is not technical.**
Note this is a **narrowing** of the original "we take clients they reject" thesis, which §2.10 falsifies. What survives is narrower and better evidenced: getting a legally-marginal brand *registered* and *kept* registered. Nearly one in three 10DLC campaigns fails first submission (§4.6); rejection is driven by website/brand/sample-message inconsistency, weak privacy policies and unverifiable calls to action rather than by product category; manual vetting means outcomes vary by reviewer; and T-Mobile explicitly sells exceptions at $500 per brand. **That is a repeatable operational skill, and repetition is the moat.**
It is also a risk-appetite moat at the margin: Attentive, Klaviyo and Postscript are venture-scale companies whose downside from carrier action against their shared sending estate vastly exceeds the revenue from a peptide brand. That asymmetry is a board decision, not a sprint.
**Price this as underwriting and operations, not as SaaS.**
*Fragility, and it is severe:* **Telnyx prohibits our beachhead in writing** (§2.6) — *"unregulated or prohibited supplements"*, *"substances that are not legally approved for sale"*, and *"third-party traffic or passthrough messaging sent on behalf of unregistered businesses"*. We are not sitting closer to the underwriting decision than the incumbents; we are sitting on a supplier that has already written the refusal down.

**2. Per-tenant carrier isolation — MEDIUM defensibility.**
Separate 10DLC brand and campaign registrations, separate number pools per customer, so one brand's suspension does not poison the estate. Incumbents deliberately pool sending reputation because it buys better deliverability and costs less to operate; unpooling it for a small high-risk segment is a trade they will not make. This is the technical expression of #1 and the thing that makes #1 survivable at more than three customers. **Build this first.**

**3. Consent and data portability — LOW-MEDIUM as a feature, MEDIUM as a contract.**
The evidence in §5.5 is excellent and quotable. But nobody switches vendors *for* portability; they switch after being burned once, then they never leave. It is a retention and trust argument, not an acquisition argument — and it only becomes ours once we build a real consent ledger.

**4. Incrementality and holdouts for the mid-market — MEDIUM defensibility, and the most under-rated item on this list.**
This did not start as one of our claimed differentiators, and on the evidence it should be. **Klaviyo gates holdout groups at 400,000 profiles**, permits one active experiment at a time, makes the split immutable, and **cannot scope a holdout to SMS alone** (§4.4). Attentive appears to have no holdout product at all. Postscript is the only vendor shipping synthetic controls, and does not market it. That leaves essentially **the entire mid-market unable to prove whether its SMS programme is incremental** — while §4.5 shows attribution numbers are vendor-tunable by a factor of two.
Why it is defensible: it is not a feature, it is a *posture*. A vendor paid on attributed revenue has a direct conflict of interest in giving you the tool that would shrink the attributed number. We do not have that conflict if we price on sends or seats. An incumbent can copy the feature in a quarter but cannot comfortably adopt the posture.
And it compounds: holdouts are the feedback loop that makes the AI wizard actually improve rather than just generate. **Build this alongside the wizard, not after it.**

**5. Unified voice + SMS + inbox with native CallKit — LOW-MEDIUM.**
The iOS work is genuine and would take a competitor a quarter or two to match properly. But §6 is clear that demand is thin, the two companies closest to the data chose humans-on-SMS instead, and our own implementation has an open multi-device defect. Defensible to build, hard to sell.

**6. The AI wizard itself — NEAR-ZERO defensibility.**
An LLM that drafts campaigns, proposes segments and writes variants is a weekend of prompt engineering on top of an existing data model. Every incumbent ships some version already, and the two largest have announced the fully agentic version for this quarter (§3.3). **The moat is never the model — it is the data underneath and the feedback loop on top.** Postscript proves the point: Shopper is defensible because it was trained on three and a half years of transcripts from a 100-person human sales centre (§3.4), not because of model access. We have unusually good data (Woo order history, ShipStation fulfilment, reorder cadence, a real 1:1 conversation record) but **no measurement layer**, so the wizard cannot learn from outcomes and is currently just a copy generator.

*The one narrow exception worth building:* a Klaviyo Gold Partner with 150+ audits reports that Composer *"doesn't reliably insert the specific compliance language these verticals require"*, naming **supplements** explicitly (§3.7). A campaign generator that is correct-by-construction on disclosure language, quiet hours, and per-state rules for regulated products is narrow, credible, and directly aligned with the beachhead. That is a defensible AI product. "AI wizard" is not.

### 7.3 Table stakes we are missing

Every item verified absent in §7.1. These are not enhancements — a brand cannot run SMS marketing without them:

- Campaign engine with scheduled bulk send and Trust-Score-aware throughput pacing
- Segment builder over order and behavioural data
- **Consent ledger** — opt-in timestamp, source, IP, disclosure text (currently one boolean)
- Quiet hours and per-state TCPA time-window enforcement
- Attribution, with an honest and configurable window
- Holdout / control groups — without which no claim about incremental revenue is defensible
- A/B testing infrastructure
- List growth: popups, keyword opt-in, two-tap, checkout capture
- Deliverability reporting and carrier error surfacing
- Self-serve onboarding with 10DLC brand and campaign registration automation

### 7.4 What an incumbent copies in a quarter

**Already doing it:** the AI wizard. Attentive announced "AI Campaigns" for **before BFCM 2026**; Klaviyo's Composer went **public beta on 2026-06-30**. This is not a future risk, it is a current race we are behind in.

**Would and could:** conversational AI reply handling; anything campaign-drafting shaped. Assume all of it is commoditised within two quarters.

**Could but won't:** native CallKit voice — technically a quarter or two, but there is no demand in their installed base and §6.5 shows they have already chosen a different answer.

**Won't at any timeline:** taking research-peptide clients, and per-tenant carrier isolation. The first is a board-level risk decision; the second degrades the pooled-reputation deliverability model their whole customer base depends on.

### 7.5 The realistic wedge

**Not "cheaper SMS."** The arithmetic in §5.4 kills it — at 10,000 contacts a Postscript customer switching to us saves roughly nothing once our margin is priced in.

**Not "AI campaigns."** Everyone has one.

**Not "voice."** Nobody is asking.

**And not "the incumbents reject you."** §2.4 falsifies it for supplements and telehealth, and §2.7 shows CBD/vape/adult are blocked at the carrier layer where we are just as powerless.

**The wedge that survives is registration integrity and survivability:** get a marginal brand registered and keep it registered, isolate its traffic so one suspension does not cascade, and hold its consent records in a form that is genuinely portable when something goes wrong.

**Beachhead:** research peptides and legally-marginal wellness brands on **WooCommerce/WordPress** — which is where every peptide storefront we found actually lives, and which structurally excludes them from the Shopify app ecosystem where Attentive and Postscript operate. Our existing WooCommerce integration is a better-aligned asset than anything in the AI roadmap. The proof of demand is that one such operator wrote his own TCPA compliance gate as a WordPress plugin because nobody would sell him one (§2.4).

**But be clear-eyed about what this beachhead is.** It is empty because it is legally marginal. Serving it means underwriting a legality risk that better-capitalised firms declined, on a carrier that prohibits it in writing, in a segment where the existing specialists (Alpine IQ, Springbig) have publicly retreated from SMS to email and push. That is a defensible position and a genuinely uncomfortable one. **Decide deliberately whether that is the business you want.**

### 7.6 Where we are deluding ourselves

Stated plainly, because this is the point of the document:

1. **The cost arbitrage is not a business.** It is 1.4–2.6x on wire cost, and after our margin the customer nets ~0% at 10k contacts and ~21% at 100k. It works only against Attentive's minimum-commitment contracts.
2. **"Own your infrastructure" has no demonstrated demand — from two independent research passes.** The top open-source SMS marketing project has 26 stars and died in 2018, against listmonk's 22,705. No agency sells it. Hacker News does not discuss it. And a targeted search of merchant reviews and forums for anyone asking to bring their own carrier account or self-host returned **literally zero results** (§4.7). The email analogy fails because SES is nearly free and carriers are not (§5.1). We may be the only people who want this.
3. **We are claiming an AI wizard as a differentiator while shipping 188 lines of LLM calls** and no measurement layer to make it improve — into a category where Attentive has announced the same product for this quarter and Klaviyo shipped it to public beta six weeks ago.
4. **We identify consent portability as the incumbents' great weakness while storing consent as a single boolean.** We are currently worse at this than Attentive, whose export at least includes opt-out status.
5. **The central premise was wrong.** "Incumbents won't take these clients" is falsified for supplements and telehealth by live tags and published case studies (§2.4), and for CBD/vape it is true but unfixable by anyone. Only peptides survive, and only because they are legally marginal.
6. **Our own carrier prohibits our own beachhead.** Telnyx names supplements and unapproved substances in its forbidden-use-cases article, and is stricter here than Twilio and Bandwidth. We built the cost model on the cheapest carrier without checking whether it would carry the customers.
7. **Voice may never earn its keep.** Four well-funded incumbents with better data than us have all declined to build it.
8. **The market may be too small, and the specialists are leaving it.** Alpine IQ reports 72% of its regulated clients' messages now go out as email and advises stripping brand names from texts. If the people who have served high-risk longest are retreating from the channel, we should weigh that heavily. This could be a good $1–3m/year operator-run business and a poor venture one. Decide that deliberately rather than discovering it in year three.

### 7.7 What I would do next

**Do this before writing another line of the AI wizard:**

- **Resolve the carrier question first, because it gates everything else.** Telnyx prohibits *"unregulated or prohibited supplements"* and *"substances not legally approved for sale"* in writing (§2.6). Either get an explicit written position from a Telnyx account manager on the exact vertical, or move. Twilio and Bandwidth have thinner written policies on this specific point — though Twilio's pricing weakens §5 further and Bandwidth's vetting codes are the strictest operationally. **This is a supply decision that determines whether the business exists.**
- **Build the consent ledger next.** Cheapest item on the list, converts our best argument from hypocrisy into a demo, and reduces our own TCPA exposure in exactly the vertical where litigation risk is highest.
- **Build per-tenant carrier isolation third.** It is the only differentiator an incumbent structurally will not copy, and it is also how we stay inside Telnyx's *"third-party traffic ... on behalf of unregistered businesses"* clause.
- **Add multi-carrier abstraction fourth.** Write the messaging layer so a tenant can be re-homed without a rewrite.
- **Productise 10DLC registration success.** Nearly one in three campaigns fails first submission, rejection turns on website/brand/message consistency rather than vertical, and T-Mobile sells exceptions at $500 per brand (§2.7, §4.6). This is the most concrete, sellable, repeatable thing in the whole analysis.
- **Add holdout groups alongside the wizard, not after it.** Without incrementality measurement the wizard cannot learn, and "AI-generated campaigns" is an unfalsifiable claim we will get challenged on. This is also a live competitive gap: Klaviyo gates holdouts at 400k profiles and cannot scope them to SMS; Attentive appears to have none (§4.4). "We will show you what your SMS programme is actually worth, and we are not paid on the answer" is a sharper pitch than anything in the AI roadmap.
- **Narrow the AI wizard to compliance-correct generation for regulated verticals.** Vertical-correct disclosure language, quiet hours and per-state rules, correct by construction. A Klaviyo Gold Partner has publicly documented that Composer fails at exactly this for supplements (§3.7). This is buildable, checkable, and aligned with the beachhead in a way that generic campaign drafting is not.
- **Price on sends or seats, never on stored profiles.** Klaviyo's per-profile billing plus bot signups is a live 2026 grievance with four independent merchant complaints in four months (§4.2), and it creates a conflict of interest we can credibly claim not to have.
- **Re-price against Attentive, not Postscript.** Our cost story only works against minimum-commitment enterprise contracts.
- **Stop claiming incumbents reject supplement and telehealth brands.** They demonstrably do not (§2.4). Rewrite any positioning that depends on it. The replacement pitch is registration integrity, traffic isolation and portable consent records.
- **Target WooCommerce, not Shopify.** Every peptide storefront found runs WooCommerce/WordPress, which is precisely why the Shopify-native incumbents cannot reach them. Our existing WooCommerce integration is better aligned with the beachhead than anything in the AI roadmap.
- **Get first-hand accounts of actual suspensions.** The single most valuable missing evidence in this document is testimony from a brand that was onboarded by a major platform and later cut (§8). Reddit was unreachable throughout. One afternoon of founder interviews would be worth more than another research pass.

---

## 8. Research limitations — what this document does not know

Stated plainly so nobody over-reads it.

**Sources that were unreachable (HTTP 403) and therefore contribute nothing:**
- **G2, Trustpilot, TrustRadius, Capterra.** There are **no verified G2 ratings or review counts anywhere in this document.** All quantitative review data comes from the Shopify App Store, which over-represents small merchants and under-represents the enterprise accounts Attentive actually serves.
- **Reddit**, in every form tried. **There is not one Reddit quote in this document.** For questions like "did anyone actually leave Attentive for a DIY stack" and "is the AI any good", Reddit is where that conversation happens, and we did not reach it. This is the single largest evidence gap.
- Attentive's help centre and Concierge pages on direct fetch; some were recovered via a text-extraction proxy and are marked where used.

**Method note:** the session's web-search budget was exhausted early, so much discovery ran through DuckDuckGo Lite and the Hacker News Algolia and GitHub APIs as fetch proxies. Primary vendor pages were fetched directly wherever possible, and every pricing and policy quote in §1, §2 and §5 comes from a directly-fetched primary source.

**Specific things that remain unverified and matter:**
1. **Emotive, Yotpo/SMSBump, Recart and Community.com publish no locatable vertical policy** (§2.11). Klaviyo, Attentive, Postscript, Sendlane, Twilio, Plivo and Telnyx are all now confirmed verbatim. Do not make any claim about what the remaining four prohibit.
2. **Zero first-hand accounts of any brand being onboarded and later suspended.** Reddit returned 403 on every endpoint tried across three separate research passes. Live tag fingerprinting proves a brand is *currently* on a platform; it cannot show who was removed. **This is the single most valuable missing evidence in the document** and it is what would confirm or kill the "they may remove you later" pitch that §2.10 and §7.5 now rest on. Worth a dedicated pass, or better, founder interviews.
3. **AT&T publishes no discoverable messaging code of conduct.** Treat as unknown, not permissive.
4. **T-Mobile's published Code of Conduct is dated November 2020**, yet its fine schedule and $10,000 content-violation fee appear only in aggregator documentation. T-Mobile's operative policy is partly unpublished.
5. **Everything about peptides and SARMs at carrier level is an argument from silence.** No carrier or TCR document names them. That means no reviewer has a code to reject you with — *and* no rule protects you from a discretionary catch-all. Both readings are available and neither is proven.
6. **Klaviyo and Yotpo tags found on CBD and kratom sites prove installation, not SMS enablement.** Email-only is entirely plausible and would not contradict their policies.
7. **Cloudflare blocked roughly ten target storefronts** (Hims, Ro, Charlotte's Web, cbdMD, Paradigm Peptides, Peptide Sciences, AG1 and others). Absence of a tag there is not evidence of absence.
8. **Whether consent obtained on one platform is legally transferable** to a new sender and number under TCPA. Inferred from vendor UX documentation, not legal authority, and it is the highest-stakes unknown in §5.5.
9. **Attentive's contract terms, minimums and real pricing** — entirely third-party reconstruction from Vendr and agency blogs.
10. **Podium's pricing and its bulk-message caps** — their site is a lead-capture wall. The 250/500 monthly bulk caps drive the §6.2 conclusion and are third-party only.
11. **Whether Postscript's Shopper inherits SMS Sales' revenue-share pricing**, and what that percentage is. Never published.
12. **Klaviyo Customer Agent pricing** — sources conflict between "$200/mo for 200 resolved conversations" and "$200/mo for 50, plus $0.70 each thereafter".
13. **Sendlane's AI feature set** — `sendlane.com/features/ai` returns 404 and no reliable source was found. We do not know what it does.
14. **US carrier subscriber shares** used to blend the carrier surcharge in §5.2 are approximate. The sensitivity band is given; the ratios are robust, the absolute figures less so.

**The honest summary of confidence:** the pricing arithmetic (§1, §5) and the policy quotes actually reproduced (§2.2, §2.3, §2.6, §2.7) are solid and primary-sourced. The AI audit (§3) is well-evidenced from vendor documentation. The pain-point tallies (§4) are a floor drawn from a biased sample. The conclusions about demand for owning infrastructure (§5.1) rest partly on absence of evidence, which is weaker than evidence of absence — though two independent research passes found the same nothing.
