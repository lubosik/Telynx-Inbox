# Phase 1 — AI Campaign Wizard & Activity Center: Research Index

**Completed:** 11 August 2026
**Status:** Investigative only. No code was written. Nothing here is approved to build.
**Volume:** 8 documents, ~106,000 words, ~200 cited sources.

This index is the synthesis. Read it first, then go to the source documents for detail.

---

## The documents

| # | File | Words | What it settles |
|---|---|---:|---|
| 00 | `00-current-state.md` | 2,165 | What we actually have — verified against the live database, not memory |
| 01 | `01-sms-copywriting-craft.md` | 11,950 | Direct-response canon applied to SMS; scoring rubric; draft system prompt |
| 02 | `02-campaign-flows-and-segmentation.md` | 11,462 | Flow taxonomy, replenishment maths, segmentation SQL, fatigue, projection |
| 03 | `03-compliance-and-high-risk.md` | 22,370 | A2P 10DLC, TCPA, carrier policy, and whether peptides can run US SMS |
| 04 | `04-competitive-landscape.md` | 15,416 | Incumbents, pricing, AI features, and where our edge is real |
| 05 | `05-attribution-and-testing.md` | 13,962 | Attribution models, holdout maths at our N, test-suite spec, data model |
| 06 | `06-activity-center.md` | 16,129 | Auth prerequisite, prior art, event taxonomy, phased scope |
| 07 | `07-source-doc-digest.md` | 12,440 | Digest of the client-supplied SMS Marketing transcript |

---

## The five findings that should change the plan

### 1. The high-risk wedge is falsified as stated

The premise was that high-risk verticals are underserved because incumbents won't take them. **They will.** Attentive and Postscript actively serve supplement brands — verified from live tags on Bloom, Jocko Fuel, Legion, OLLY, Ghost Lifestyle and Transparent Labs, plus published case studies for The Vitamin Shoppe and Bare Performance Nutrition. Attentive publishes a **telehealth pharmacy** case study (MintRx: HRT, ED, weight loss) — a vertical Klaviyo bans by name.

Worse, the arrow points the other way: **Telnyx, our own carrier, prohibits the beachhead in writing.** Its forbidden-use-cases policy bans "unregulated or prohibited supplements", "substances not legally approved for sale", and — relevant to us as a platform — "third-party traffic on behalf of unregistered businesses". On this vertical Telnyx is *stricter* than Twilio and Bandwidth.

The carrier that makes our cost model work forbids the customers the model was built to serve. (§04.2, §03.2)

### 2. The cost arbitrage is 1.4–2.6×, not 10×

Telnyx at $0.0075/segment against Postscript at $0.01118. After a normal software margin the customer nets roughly **0% at 10k contacts** and ~21% at 100k. The saving is real only against Attentive's non-refundable $2–3k quarterly minimums.

"Own your infrastructure" also has no demonstrated demand: the top open-source SMS marketing repo has 26 stars and died in 2018, against listmonk's 22,705 for email. No agency sells it; no merchant asks for it. The email analogy fails because SES costs $0.0001/email and carriers are never free. (§04.5)

### 3. Nothing about a 847-contact list can be measured per campaign

At this size, with a 50/50 holdout at 80% power, the minimum detectable effect is a **+245% relative lift**. A realistic good campaign produces ~$292 incremental — about 8× below the detection floor. Detecting a +1pp improvement would take ~27 campaigns, six to fourteen months.

Meanwhile the incumbents' numbers are inflated by construction: Postscript credits 24-hour *views*, Klaviyo counts SMS *opens*, Attentive recalculates history when you change a setting. At Vici's order rate a single blast auto-claims ~2 orders (~$300) before doing anything.

So "test different creatives and copy" cannot honestly ship as a per-campaign feature for this client. It can ship at the flow level, over months. (§05.3, §05.5, §02.9)

### 4. Compliance is the product, and we currently have less of it than the client needs

Three items, all independent of the wizard, all higher priority than it:

- **Telnyx under-implements the FCC opt-out rule.** It matches stop words only when they are the entire message, misses `revoke` and `opt out`, and scopes blocks to the messaging profile rather than the brand. 47 CFR 64.1200(a)(10) requires honouring anything a reasonable person would read as revocation. **We must run our own free-text detection and own the suppression list.**
- **Vici has no opt-out column and no consent record.** `scripts/add-optout-column.sql` was written and never applied. There is no defensible audit trail today.
- **TCR brands must be registered under the client's EIN, never ours.** Fines attach to the EIN on the brand. Registering under our own entity makes every client's violation our liability.

Separately, the FDA overlay is the real exposure on peptides, not the carriers: the Summit Research Peptides warning letter (Dec 2024) shows FDA treats "RESEARCH USE ONLY" as irrelevant and quotes the vendor's own marketing as proof of intended human use. Promotional SMS manufactures exactly that evidence, and we host the logs. (§03.3, §03.2, §03.8)

### 5. The Activity Center is 6–8 weeks and mostly auth

Authentication is 22 lines and a shared password. There are **16 catalogued action sites with no attributable actor**. Voice is worse than the rest: one shared SIP credential is handed to every iPhone, so "Dominic answered" is impossible at the telephony layer, not just in the app.

Only weeks 4–5 of the estimate produce anything visible. And at two users, **collision detection ("Dominic is already replying to this") is worth more than the feed** — the feed's value scales with headcount. (§06.1, §06.3, §06.10)

---

## What survives, and is genuinely worth building

The research did not come back empty. Four things hold up:

**Measurability honesty as a feature.** A pre-flight that tells the operator *"this is send 4 of ~27 before we can prove this works"*, and a dashboard with three tiers — click-attributed, associated, incremental-or-not-yet-measurable. No competitor ships this, and it is hard to copy because copying it means admitting your own numbers were inflated. (§05.10)

**Incrementality for the mid-market.** Klaviyo gates holdout testing at **400,000 profiles**, one test at a time, immutable, and cannot scope it to SMS. Attentive appears to have none. The entire mid-market currently cannot prove SMS is incremental. This is the clearest unclaimed gap found. (§04.8)

**Consent portability.** Attentive's export omits opt-in timestamp, IP and source, and warns the resulting list may be legally unsafe to use. Every incumbent's exit is deliberately lossy. A rigorous, portable consent ledger is a real wedge — though note our own is currently one boolean, so we do not solve this yet either. (§04.10)

**Replenishment for consumables.** We have 1,497 orders across 847 contacts with line items and totals. Per-customer reorder intervals are computable today. The maths is worked out (§02.3): log-space median interval, MAD dispersion, empirical-Bayes shrinkage toward a cohort ladder, plus a dose-based estimator for single-order customers. This is the highest-value flow available and the data already exists.

**The timing window is real but closing on a published schedule.** Nobody has shipped a GA autonomous campaign agent: Attentive's "AI Campaigns" is a BFCM-2026 promise; Klaviyo's Composer went public beta on 30 June 2026. (§04.6)

---

## Contradictions and open questions Phase 2 must resolve

**A genuine conflict between two of our own documents.** §03 treats SHAFT-C as a live carrier content standard. §04 extracted the full CTIA PDF and found **no SHAFT list in it at all** — SHAFT lives in the Short Code Handbook as an age-gate test, and there is no DCA rejection code for supplements, peptides, kratom or telehealth on 10DLC. §04's claim is that the operative gate is T-Mobile's "legal across all 50 states" rule. These cannot both be right and the difference matters. Resolve before writing any compliance linter.

**Unresolved, blocking:**
1. Telnyx's written position on Vici's traffic. Ask them directly. Everything downstream depends on the answer.
2. Fork vs. shared core vs. multi-tenant. Every week of delay doubles the port cost. (§00.7)
3. Whether the product is sold at all, or built for two clients we already have.

**Unresolved, non-blocking:**
4. `OPENROUTER_MODEL` 404s in production — likely why `sms_customer_profiles` has 1 row.
5. FCC docket 02-278 for Feb–Aug 2026 action.
6. The April 2026 TCR CSP User Guide would not text-extract; needs manual reading.
7. Whether personalisation by first name helps at all. Evidence is genuinely contested (+8pts to slightly negative across four SMS RCTs). Flagged as experiment #1. (§01.6)

**The biggest research gap:** zero first-hand carrier-suspension accounts. Reddit returned 403 across all three passes. Founder interviews would now be worth more than another research pass.

---

## Things to fix regardless of what Phase 2 decides

These are small, independent, and valuable on their own:

- **Encoding validator in the send path.** One curly apostrophe silently converts a 1-segment message to 3 — a 3× cost multiplier, invisible to the author. Applies to the existing flows too, not just wizard output. (§01.8)
- **Free-text opt-out detection + our own suppression list.** (§03.3)
- **Apply `add-optout-column.sql`.** It has been sitting unapplied.
- **Do not build a banned-words list.** The standard lists trace to vendor blogs citing vendor blogs. Carrier filtering is mostly infrastructure — branded short domain, campaign-type match, trust score. Only 3 of 9 real factors touch copy. (§01.10)
- **Register TCR brands under client EINs.** (§03.7)

---

## Note on the client-supplied source document

"SMS Marketing.docx" is **three concatenated transcripts** from three people selling three different products, whose advice contradicts in places. V2 (DTC e-commerce) is the relevant one; V1 is B2B appointment-setting and much of its timing does not transfer.

Three of its claims should not be built on: that three replies permanently removes the Report Junk button (no evidence, yet the whole three-reply doctrine rests on it); that one or two junk reports poison a number forever; and that switching to iMessage removes the legal opt-out obligation (it conflates a regulatory duty with a transport protocol, and is asserted by the person selling iMessage sending).

In 27,000 words it never mentions quiet hours, STOP/HELP handling, or consent records. Useful as a message bank and flow inventory; not a compliance reference. (§07)
</content>
