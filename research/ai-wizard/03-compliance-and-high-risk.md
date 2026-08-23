# Compliance & High-Risk Verticals — A2P SMS Reference (US)

**Document:** `research/ai-wizard/03-compliance-and-high-risk.md`
**Last verified:** **11 August 2026**
**Platform context:** Telnyx-based SMS platform. Live clients: Vici Peptides (US research-peptide e-commerce, high risk), The Shore Academy (ocean-safety school, low risk).
**Audience:** engineers building the AI wizard's compliance layer, and whoever decides which verticals we sell into.

---

> ## ⚠️ THIS IS RESEARCH, NOT LEGAL ADVICE
>
> Nothing in this document is legal advice and no attorney-client relationship arises from it. It is a research digest assembled from carrier, registry, regulator and vendor documentation so that engineers can build guardrails and so that commercial decisions are made with eyes open. **Every item marked as a legal conclusion below must be confirmed by qualified TCPA counsel before it is relied on.** Several areas — quiet hours under consented messaging, the scope of consent revocation, whether texts are "calls" under § 227(c) — are genuinely unsettled as of August 2026, and this document says so rather than picking a side.
>
> Where I could not verify something against a source I could actually read, it is marked `[UNVERIFIED]`. Do not silently promote an `[UNVERIFIED]` item to fact.

---

## 0. How to read this document

### 0.1 Source hierarchy used

| Tier | What it is | How much weight |
|---|---|---|
| **A — Regulator primary** | eCFR / Cornell LII CFR text, FCC orders (docs.fcc.gov PDFs), FDA warning letters, Supreme Court slip opinions | Authoritative. Quoted verbatim where load-bearing. |
| **B — Registry / industry primary** | CTIA Messaging Principles and Best Practices, The Campaign Registry, Campaign Verify | Authoritative for industry rules, but voluntary in form. |
| **C — Provider documentation** | Telnyx help centre and developer docs, Bandwidth, Twilio, Plivo, Infobip, Aerialink | Contractually binding on *us* (Telnyx especially). Frequently the only public statement of carrier rules. |
| **D — Secondary** | Law-firm alerts, CPaaS marketing blogs, compliance roundups | Used only where A–C were unreachable, and always labelled. **A large amount of stale and wrong 10DLC/TCPA content circulates at this tier — see §0.3.** |

### 0.2 Primary sources obtained, and what could not be

**Obtained and verified directly (HTTP 200 and text-extracted on 11 Aug 2026):**

| Document | URL |
|---|---|
| **CTIA Messaging Principles and Best Practices, May 2023** — the current edition | [`api.ctia.org/.../230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf`](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf) |
| CTIA Messaging Security Best Practices, Oct 2025 | [`api.ctia.org/.../Messaging-Security-Best-Practices-_October-2025.pdf`](https://api.ctia.org/wp-content/uploads/2025/10/Messaging-Security-Best-Practices-_October-2025.pdf) |
| T-Mobile Code of Conduct v2.2, Nov 2020 | [`t-mobile.com/support/public-files/attachments/T-Mobile Code of Conduct.pdf`](https://www.t-mobile.com/support/public-files/attachments/T-Mobile%20Code%20of%20Conduct.pdf) — ⚠️ returned **403** to my own direct fetch on 11 Aug 2026; retrieved by a parallel research pass. Open in a browser. |
| AT&T Code of Conduct re: 10DLC A2P, 1 Mar 2021 | [mirror at docs.intelepeer.com](https://docs.intelepeer.com/Atmosphere/Content/Resources/Files/att_bulk_messaging_code_of_conduct_re_10dlc_a2p_messages__03.2.pdf) |
| AT&T Code of Conduct, 1 Jun 2020 (superseded — useful for diffing) | [mirror at sinch.github.io](https://sinch.github.io/docs/sms/sms-other/downloads/ATT_Code_of_Conduct_062020.pdf) |
| FCC Order DA 26-12 (consent revocation waiver extension) | [`docs.fcc.gov/public/attachments/DA-26-12A1.pdf`](https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf) |
| 47 CFR § 64.1200 current text | [Cornell LII](https://www.law.cornell.edu/cfr/text/47/64.1200) — note **ecfr.gov redirected to a bot-block page**; Cornell was used instead and cross-checked |
| FDA Warning Letter, Summit Research Peptides | [fda.gov](https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/summit-research-peptides-695607-12102024) |
| Telnyx help centre and developer docs | multiple, cited inline |

**CTIA currency check:** the May 2023 MPBP is still cited as the operative document by a May 2026 Holland & Knight publication. **It remains current as of mid-2026.** The October 2025 "Messaging Security Best Practices" is a **separate, narrower** document about threat detection and forensics — it does **not** contain consumer disclosure or URL rules. Claims circulating that "an October 2025 CTIA update tightened URL handling and sender identification" conflate the two documents and are `[UNVERIFIED]`.
Currency source: [Holland & Knight, May 2026](https://www.hklaw.com/en/insights/publications/2026/05/beyond-tcpa-compliance-why-ctia-messaging-principles) *(secondary)*

**Could NOT be obtained:**

1. **Verizon code of conduct.** Not retrievable at all, and secondary sources indicate Verizon does not publish one — it reportedly uses the CTIA Short Code Monitoring Handbook instead. `[UNVERIFIED]` Verizon is the carrier we have least visibility into.
2. **TCR CSP User Guide (April 2026 edition)** — exists at `campaignregistry.com/wp-content/uploads/CSP-User-Guide_Apr_2026-v2_comp.pdf` but would not text-extract. **This is the current authoritative registry document and someone should read it manually.** It would settle: identity statuses, the full use-case code list, the sole-proprietor EIN question, and the "specialty review" use-case list.
3. **Any carrier fine schedule as a carrier document.** I extracted the T-Mobile and AT&T codes of conduct in full and confirmed: **neither contains a single dollar figure.** All monetary schedules reach the market via carrier bulletins to aggregators and are only visible in aggregator republication. **Every dollar figure in §3 is therefore secondary-sourced by necessity.** Cross-checked across three or more independent aggregators wherever possible.
4. **Twilio's canonical "Forbidden Message Categories" support article** — HTTP 403 on every route. Quotes attributed to it here come from secondary reproductions and are labelled.

### 0.3 Three errors that are everywhere in secondary sources — do not repeat them

1. **"FCC one-to-one consent takes effect January 2026."** **FALSE.** The rule was vacated by the Eleventh Circuit on 24 January 2025 and the FCC formally deleted the language from the CFR effective 29 August 2025. See §4.2. One of the compliance blogs consulted during this research still asserts the January 2026 effective date. It is wrong.
2. **"The TCPA revoke-all rule took effect April 2025 / April 2026."** **Partly false.** The revocation rules took effect 11 April 2025, but the *cross-category* "revoke one thing, revoke everything" provision has been waived twice and now has an effective date of **31 January 2027**. See §4.3.
3. **"T-Mobile's top brand tier is 2,000,000 messages/day."** **Unsupported.** No source found documents a 2M tier. The published ladder tops out at 200,000/day with Special Business Review as the only route above. See §1.3.

### 0.4 Volatility index — what to re-check before launch, and how often

| Item | Volatility | Re-check cadence |
|---|---|---|
| Carrier per-message pass-through fees | **Very high** — four separate revisions in 2026 alone | Every quarter, and before any pricing commitment |
| TCR campaign/brand/vetting fees | High | Quarterly |
| FCC consent-revocation rule shape (docket 02-278) | **Very high** — active FNPRM, record closed Feb 2026, no final order found | Monthly until resolved |
| Quiet-hours legal position | **Very high** — one district decision, FCC petition pending, no appellate law | Monthly |
| State mini-TCPA statutes | High — 3 new/amended in 2025–26 | Quarterly, plus each state legislative session |
| Carrier prohibited-content lists | Medium | Semi-annually |
| Throughput tiers | Medium — stable since 2023 | Semi-annually |
| Telnyx AUP and forbidden use cases | Medium — the forbidden-use-cases article was updated within the last month | Quarterly |
| CTIA Messaging Principles edition | Low but currently **unknown** | Resolve once, then annually |

---

## 1. A2P 10DLC as it stands (2026)

### 1.1 The shape of the system

10DLC is the carrier-mandated registration framework for application-to-person SMS/MMS sent from US ten-digit long codes. It is administered by **The Campaign Registry (TCR)**, a third party appointed by the mobile network operators. Registration is two-level:

- **Brand** — the legal entity sending messages. One brand per EIN. ([Telnyx 10DLC FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc))
- **Campaign** — the declared use case. Max **5 campaigns per brand**; max **49 phone numbers per campaign** (a T-Mobile limit); a number can belong to exactly one campaign. (same source)

**The hard deadline already passed.** Telnyx: *"From February 3rd 2025, any 10DLC traffic which is not registered will be blocked altogether."* Bandwidth: *"As of February 1, 2025, unregistered outbound traffic is being blocked in the industry."* There is no longer an unregistered grey path with a surcharge — unregistered traffic simply does not deliver.
Sources: [Telnyx](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc) · [Bandwidth 10DLC FAQ](https://www.bandwidth.com/support/en/articles/12823085-10dlc-faq)

**Everything a business sends is A2P.** Telnyx: *"According to guidelines as of 2023, virtually all SMS and MMS sent by a business—even if manually triggered by a human—is considered A2P."* The P2P carve-out requires, cumulatively: no messages on behalf of any business, not a cloud communication suite, all messages written and sent by individuals to individuals, roughly symmetrical traffic (1:1 to 1:3), and an excellent compliance history. **Assume no client qualifies.**

### 1.2 Brand registration and vetting

**Brand identity statuses** (Bandwidth's enumeration, corroborated by TCR's Auth+ page):

| Status | Meaning |
|---|---|
| `PENDING` | Queued; campaigns cannot be created |
| `UNVERIFIED` | Did not verify — almost always a legal-name/EIN mismatch |
| `VERIFIED` | Minimum state required to register campaigns and send |
| `VETTED_VERIFIED` | Identity confirmed through external vetting |

Sources: [Bandwidth 10DLC FAQ](https://www.bandwidth.com/support/en/articles/12823085-10dlc-faq) · [The Campaign Registry — Authentication Plus](https://www.campaignregistry.com/authentication-enhances-a2p-10dlc-security/)

**Top causes of brand rejection:** legal company name and EIN not matching the IRS filing (use the **CP-575** letter as the source of truth for exact legal name and address); registered address differing from the EIN address (this also depresses trust score); failure to complete Auth+ 2FA in window.

**Authentication+ (Auth+) — mandatory since 1 August 2025 for public brands.** TCR sends a 2FA email from `noreply@auth.campaignregistry.com`; a representative must click through and enter name and title. The initial email expires in **7 days**; a CSP can resend up to **30 days** from registration before the brand must be resubmitted. **Existing public brands already in `VERIFIED` or `VETTED_VERIFIED` must still complete Auth+ before registering new campaigns.** Fee: **$12.50** per public brand. Originally launched 17 October 2024 for publicly traded companies; Auth+ 2.0 extended it to all public brands and to newly registered nonprofit brands.
Sources: [The Campaign Registry](https://www.campaignregistry.com/authentication-enhances-a2p-10dlc-security/) · [Twilio changelog](https://www.twilio.com/en-us/changelog/introducing-authentication--for-public-brand-a2p-10dlc-registrat)

**Vetting.** Three classes: **standard**, **enhanced**, **political**. Standard vetting is an automated compliance review; enhanced is a manual deep-dive offered only by **Aegis** after standard vetting, with a **2–3 month** timeline. Political vetting runs through **Campaign Verify** (for FEC/state-registered 527s) or Aegis.

⚠️ **Vetting can hurt you.** Bandwidth's warning, verbatim: *"scores can decline."* Vetting is not a one-way ratchet. Do not vet a marginal brand casually.

**Vetting remains optional for standard brands as of August 2026.** No 2026 mandatory-vetting requirement was found. But Telnyx: *"a Brand without a Vetting Score will tend to lead to low throughput for complex Campaign Use Cases like Marketing."*

**Trust Score mechanics.** Telnyx: *"Trust Scores are assigned when a Brand is registered via a reputation algorithm. The score does NOT change over time."* As of mid-2023, Brand Score was deprecated in favour of **Brand Tier**, derived from Vetting Score. The algorithm is undisclosed; it is believed to weight brand footprint (larger = higher) and registration consistency (fewer discrepancies = better). **Practical consequence: registration accuracy on day one is permanent. There is no reputation-building path.**
Sources: [Telnyx Trust Scores & Use Cases](https://support.telnyx.com/en/articles/6325747-10dlc-trust-scores-use-cases) · [Telnyx FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc)

### 1.3 Trust score → throughput

Carriers use **different units**. This is the single most confusing part of 10DLC.

- **AT&T** rate-limits by **campaign**, in **TPM** (transactions/message-parts per minute), keyed to a "Message Class" derived from use case + vetting score.
- **T-Mobile** rate-limits by **brand**, as a **daily cap** shared across every campaign under that brand and across SMS and MMS combined.
- **Verizon** publishes **no throughput tiers at all** and relies on content-based filtering plus a per-message surcharge.

#### AT&T — TPM per campaign

| Segment | SMS TPM | MMS TPM |
|---|---|---|
| Standard, vetting score 75–100 | 4,500 | 2,400 |
| Standard, vetting score 50–74 | 2,400 | 1,200 |
| Standard, vetting score 1–49 | 240 | 150 |
| Low Volume Mixed (any score) | 75 | 50 |
| **Sole Proprietor** | **15** | 50 |
| Social | 9,000 | 2,400 |
| Political / Emergency-Public Safety | 4,500 | 2,400 |
| Charity / Nonprofit | 2,400 | 1,200 |
| Proxy, Agents & Franchises | 60 per number | 50 per number |
| Basic / Unregistered (Class T) | 75 | 50 |

Sources: [Telnyx 10DLC rate limits](https://developers.telnyx.com/docs/messaging/10dlc/10dlc-rate-limits) · [Telnyx FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc) · corroborated by [Infobip 10DLC throughput reference](https://www.infobip.com/docs/usa-sender-registration/10dlc/10dlc-throughput-reference) (Class A = 4,500/2,400)

#### T-Mobile — Brand Daily Cap (per brand / per EIN)

| Brand Tier | Vetting score | Daily cap |
|---|---|---|
| Top | 75–100 | 200,000 |
| High Mid | 50–74 | 40,000 |
| Low Mid | 25–49 | 10,000 |
| Low (default for unvetted, non-Russell-3000) | 1–24 | 2,000 |
| Sole Proprietor | — | 1,000 |

- Cap resets at **midnight US Pacific**.
- Russell 3000 businesses default to 200,000/day.
- Exceeding 200,000/day requires a **Special Business Review (SBR)**, which requires completing external brand vetting first.

Sources: [Telnyx FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc) · [Bandwidth T-Mobile 10DLC](https://www.bandwidth.com/support/en/articles/12823101-t-mobile-10dlc) · [Telnyx rate limits](https://developers.telnyx.com/docs/messaging/10dlc/10dlc-rate-limits)

> ⚠️ **CONFLICT — tier score boundaries.** Bandwidth/Telnyx/Infobip give 75/50/25/1. A Twilio-mirrored source gives 76/51/26/16 and has no band for scores 1–15. **The caps themselves (2,000 / 10,000 / 40,000 / 200,000) are consistent across every source** — use those confidently; treat the exact boundaries as unresolved.
> Conflicting source: [SuperPhone, mirroring Twilio](https://support.superphone.io/en/articles/5571196-t-mobile-daily-message-limits-for-us-long-code-messaging-with-10dlc)

> ⚠️ **The "2,000,000/day" tier does not exist in any source I could reach.** Every source — Bandwidth, Telnyx, Infobip, Twilio mirrors — tops out at 200,000/day plus SBR. A 2M figure may be an SBR-granted ceiling rather than a published tier. **Do not assert it.** `[UNVERIFIED]`

#### Verizon and US Cellular

Telnyx, verbatim: *"No published rate limits. Uses content-based filtering; compliant messages typically deliver without throttling."* Verizon joined TCR but has never declared a throughput method. **This means for Verizon, content quality is the only lever — there is no tier to buy your way into.** US Cellular: no throughput table found anywhere. `[UNVERIFIED]`

#### MMS throughput

Undeclared industry limits, Telnyx's April 2023 estimate: AT&T/T-Mobile ~0.84 MMS/sec, 50 MMS/min per number; Verizon ~25 MMS/sec. Treat as stale but directionally correct.

### 1.4 Fee structure

**Telnyx does not mark these up:** *"Telnyx does not currently charge a markup on 10DLC fees. All 10DLC-related fees are passed on to the customer at cost."* ([Telnyx 10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges))

#### Registration and vetting (TCR)

| Item | Fee | Frequency | Source |
|---|---|---|---|
| Brand registration | **$4.50** | One-time per brand | [Telnyx fees](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges) · [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Brand registration appeal | $11.00 | One-time | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Authentication+ verification | $12.50 | Per public brand | [SIPNEX tracker](https://www.sipnex.ca/blog/a2p-10dlc-news) *(secondary)* |
| Campaign review (manual) | **$15.00** | **Per submission AND per resubmission** | [Telnyx fees](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges) |
| Expedited campaign review | $50.00 | Per submission (since 10 Apr 2025) | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Campaign migration vetting | $15.00 | Per vet (**new, 19 Jan 2026**) | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Standard external brand vetting | $41.50 | One-time (was $40 before Aug 2025) | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Enhanced external brand vetting | $101.50 | One-time | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Political brand vetting | $66.00 | 12-month validity | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Express political brand vetting | $96.00 | 12-month validity | [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) |
| Campaign Verify token (political 527s) | $95.00 | Per entity per 2-year cycle | [campaignverify.org](https://www.campaignverify.org/) |

**Engineering note:** the $15 campaign review fee is charged **per resubmission**. A wizard that lets a user fire off five badly-formed campaign registrations costs them $75 and burns carrier goodwill. Pre-validate hard before submission (see §8).

Telnyx clarifies the trigger: *"The $15 campaign verification fee is only charged when the campaign is sent downstream to the aggregator for carrier review. Reviews performed at the Telnyx level are not charged."*

#### Campaign monthly fees, by use case (TCR, as published by Telnyx effective 22 July 2025)

| Use case | $/month |
|---|---|
| Agents & Franchises | 30.00 |
| **All standard use cases** (2FA, Account Notifications, Carrier Exemptions, Customer Care, Delivery Notifications, Fraud Alert, Higher Education, K-12, **Marketing**, Mixed, Political, Polling & Voting, Proxy, Public Service Announcements, Regular, Security Alert, Social, Sweepstakes) | **10.00** |
| Emergency | 5.00 |
| Charity | 3.00 |
| Sole Proprietor | 2.00 |
| Low Volume Mixed | 1.50 |
| Platform Free Trial | 0.00 |

Billing: *"Campaign fees are billed for three months initially, then subsequently on a monthly recurring basis."*
Source: [Telnyx 10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges), corroborated by [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/), [Salesmsg](https://help.salesmessage.com/en/articles/6001981-sms-mms-and-a2p-10dlc-carrier-fees), [HighLevel](https://help.gohighlevel.com/support/solutions/articles/155000005200-a2p-10dlc-messaging-fees-registration-monthly-and-carrier-costs)

> **Telnyx's own warning, verbatim:** *"DO NOT declare a false Use Case to achieve lower charges or higher throughput. Carriers and intermediaries inspect Campaigns and traffic and charge hefty fines for non-compliance including false declarations."*
> The wizard must never suggest Low Volume Mixed to a client who plans marketing volume. That is an $8.50/month saving against a four-figure fine.

#### Carrier structural fees

| Carrier | Item | Fee |
|---|---|---|
| T-Mobile | Campaign Service Activation | **$50 per campaign** (excludes Sole Proprietor/Starter) |
| T-Mobile | Number Pool Request (50+ numbers on a brand) | **$50** one-time *(Telnyx)* — ⚠️ one stale source says $2,000/campaign |
| T-Mobile | Special Business Review (>200k/day) | **$5,000** one-time, *"currently waived until further notice"* *(Telnyx)* — ⚠️ Bandwidth says $500 one-time per brand |
| T-Mobile | NNID Registration | $2,000 per NNID |
| Number Registry | 10DLC number registration | $0.02 per number/month |
| AT&T / Verizon | One-time campaign activation | **None found in any source** |
| AT&T / Verizon | Recurring monthly per-campaign fee | **None found in any source** — if our pricing model assumes one, it is wrong `[UNVERIFIED]` |

Sources: [Telnyx fees](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges) · [Bandwidth T-Mobile 10DLC](https://www.bandwidth.com/support/en/articles/12823101-t-mobile-10dlc) · [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/)

#### Per-message carrier surcharges (10DLC, registered)

Telnyx's published table:

| Carrier | SMS | MMS |
|---|---|---|
| T-Mobile (incl. former Sprint) | $0.003 send **and receive** | $0.010 send and receive |
| AT&T | $0.003 send, free to receive | $0.0090 send, free to receive |
| Verizon Wireless | $0.0045 send, free to receive | $0.0070 send, free to receive |
| US Cellular | $0.005 send, free to receive | $0.010 send, free to receive |

Source: [Telnyx 10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)

> ⚠️ **These figures are the least stable numbers in this document.** Four carrier revisions landed in 2026 alone and Telnyx's table may not reflect all of them:
> - **19 Jan 2026** — T-Mobile A2P pass-through increase across short code, 10DLC and toll-free. 10DLC/toll-free SMS **MO** set at $0.0025. MT costs increased. Exact MT/MMS figures published only as an image. `[UNVERIFIED]`
> - **19 Jan 2026** — US Cellular new pass-through fees for SMS *and* MMS, MT and MO. `[UNVERIFIED]`
> - **1 Apr 2026** — AT&T pass-through revision across all channels, inbound and outbound, SMS and MMS. `[UNVERIFIED]`
> - **1 May 2026** — Verizon pass-through revision, SMS and MMS. `[UNVERIFIED]`
>
> Cross-source comparison shows **SMS outbound converges tightly** ($0.003 AT&T/T-Mobile, $0.003–0.0045 Verizon, $0.005 US Cellular) but **MMS does not converge at all** — published Verizon MMS ranges $0.0025–$0.007 and one source lists T-Mobile MMS at $0.001 (a 10× outlier, almost certainly a typo). **Never quote a client a fixed MMS margin without re-pulling current rates.**
> Sources for the 2026 revisions: [Telgorithm — T-Mobile](https://www.telgorithm.com/news/t-mobile-announces-new-2026-a2p-sms-pass-through-fees) · [Telgorithm — US Cellular](https://www.telgorithm.com/news/us-cellular-announces-new-a2p-pass-through-fees-for-short-code-and-toll-free-messaging) · [SIPNEX tracker](https://www.sipnex.ca/blog/a2p-10dlc-news) *(secondary)*

### 1.5 Use cases

**Standard (all $10/mo):** 2FA · Account Notification · Carrier Exemptions · Customer Care · Delivery Notification · Fraud Alert Messaging · Higher Education · K-12 Education · Machine-to-Machine (M2M) · Marketing · Mixed (2–5 sub-use-cases) · Polling & Voting · Proxy · Public Service Announcement · Security Alert · Social · Sweepstakes

**Special / lower-cost:** Low Volume Mixed ($1.50, max 5 sub-use-cases, **under 6,000 messages/month**) · Sole Proprietor ($2.00) · Charity ($3.00) · Emergency ($5.00) · Agents & Franchises ($30.00)

**Requiring pre-approval, post-approval, and/or special vetting** — Telnyx names these explicitly: **Agents and Franchises, Carrier Exemptions, Charity, Conversational Messaging, Emergency, Political, Social, Sweepstake**. Political additionally requires a Campaign Verify token or Aegis political vetting.

**Critical operational constraint:** *"use cases cannot be changed post-registration without creating a new campaign."* ([Telnyx campaign registration docs](https://developers.telnyx.com/docs/messaging/10dlc/campaign-registration)) The wizard must get the use case right the first time — changing it later means a new campaign, a new $15 review, and reassigning every number.

**Mixed vs Low Volume Mixed.** A single number can only sit on one campaign, so businesses that want one number for both notifications and promotions register Mixed. Mixed and Marketing campaigns receive **lower throughput** than a single declared use case at the same trust score. There is a real trade-off between number simplicity and throughput.

### 1.6 Sole proprietor

For individuals with **no EIN**. Telnyx's stated criteria: no EIN; a single individual operating a business; low-volume needs (~1,000 messages/day). Requires legal name matching government ID, a mobile number capable of receiving SMS, a physical address (*"PO Boxes/PMBs are not accepted"*), and a website or professional social profile.

**OTP loop:** Telnyx sends a PIN to the registered mobile; it must be returned within **24 hours** or the brand must be recreated. API endpoints exist (`POST/GET/PUT /v2/10dlc/brand/{brand_id}/smsOtp`).

**Hard limits:** one campaign only per sole-proprietor brand (including campaigns created on other platforms); T-Mobile 1,000 msgs/day; AT&T 15 SMS TPM.

**Disqualifying terms.** If the legal name or website contains any of these, the entity does **not** qualify and must register with an EIN — a directly regex-able check for the wizard:

```
LLC, Inc, Ltd, Corp, Company, LLP,
School, College, University, Academy,
Bank, Loan, Mortgage, Cash, Money, Fund, Wealth, Investment, Capital,
  Credit, Union, Lending, Financial, Collections, Insurance,
Hospital, Clinic, Vet, Health, Spa,
Property, Real Estate, Management, Agency, Home, Buyer,
Church, Club, Group, Charity, Center, Ministry, Ministries, Chamber,
County, .gov, .org,
Software, Marketing, Media, Employees, Staff, .ai
```

Source: [Telnyx sole proprietor guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration)

> ⚠️ **CONFLICT.** Telnyx says sole proprietor is *for* entities **without** an EIN. One 2026 compliance roundup asserts *"Sole proprietors now mandatory EIN requirement for new registrations"* ([Apten](https://www.apten.ai/blog/a2p-dlc-compliance-2026), secondary). Telnyx is our actual provider and its guide was updated within the last month. **Follow Telnyx, but resolve against the April 2026 TCR CSP User Guide.** `[UNVERIFIED]`

> **Bandwidth does not support sole proprietor at all.** If we ever add Bandwidth as a second upstream, sole-proprietor clients cannot be migrated.

### 1.7 What changed most recently

| Date | Change |
|---|---|
| 1–3 Feb 2025 | **Unregistered 10DLC traffic blocked outright.** No more grey path. |
| 10 Apr 2025 | Expedited manual campaign review introduced, $50/submission |
| **1 Aug 2025** | TCR fee increase (brand $4.00→$4.50, vetting $40→$41.50) + **Auth+ 2.0 mandatory 2FA for all public brands**, including existing verified ones |
| Sept 2025 | TCR began *optional* collection of Business Registration Number, country, entity type for toll-free |
| Oct 2025 | ToS and Privacy Policy URLs required on opt-in forms |
| 5 Nov 2025 | Campaign Verify began issuing tokens for short code and toll-free |
| **19 Jan 2026** | T-Mobile and US Cellular A2P pass-through fee increases; new TCR Campaign Migration Vetting fee ($15) |
| Jan 2026 | Toll-free verification: Business Registration Number, country, entity type became **mandatory** |
| **17 Feb 2026** | ⭐ **Campaign Verify token now required for ALL political channels — 10DLC, short code AND toll-free.** Previously 10DLC only. **Any existing political traffic on toll-free became non-compliant on this date.** |
| 1 Apr 2026 | AT&T pass-through fee revision |
| 1 May 2026 | Verizon pass-through fee revision |
| **30 Jun 2026** | Twilio hard-enforces working privacy policy and T&C URLs on new campaign submissions. (Relevant as an industry signal even though we are on Telnyx — the direction of travel is that link validity is now machine-checked at submission.) |
| 22 Jul 2026 | FCC FNPRM proposing broader Robocall Mitigation Database filing requirements. **Not final.** |

Sources: [Telnyx FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc) · [Bandwidth FAQ](https://www.bandwidth.com/support/en/articles/12823085-10dlc-faq) · [campaignverify.org](https://www.campaignverify.org/) · [Aerialink](https://docs.aerialink.net/industry-fees/code-number-fees/) · [The Campaign Registry](https://www.campaignregistry.com/authentication-enhances-a2p-10dlc-security/) · [SIPNEX tracker](https://www.sipnex.ca/blog/a2p-10dlc-news) *(secondary)*

**Not found, despite looking:** any change to the T-Mobile Brand Daily Cap ladder in 2025–26; any new mandatory vetting requirement for standard brands; any Verizon move toward trust-score throughput; any change to the DCA/CNP fee structure. All `[UNVERIFIED]` as to whether such changes exist and were simply not published.

---

## 2. Prohibited and restricted content — and the research-peptide question

### 2.1 SHAFT and SHAFT-C

**SHAFT** = **S**ex, **H**ate, **A**lcohol, **F**irearms, **T**obacco. The industry increasingly writes **SHAFT-C**, adding **C**annabis — and this is not informal usage. Telnyx's published pass-through description of the T-Mobile content-violation fine names it directly:

> *"This content includes SHAFT-C (sex, hate, alcohol, firearms, tobacco, cannabis) violations, spam, phishing, and messaging that meets the Severity 0 violation threshold."*
> — [Telnyx, 10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)

The important nuance: **SHAFT is not a uniform ban.** CTIA's framework historically treats Alcohol, Firearms and Tobacco as *age-gateable* rather than prohibited. Aggregators have diverged sharply from that, and from each other. See §9.

**CTIA's actual content language** is much broader and vaguer than "SHAFT" — and note that **CTIA never uses the word "SHAFT" at all.** [CTIA MPBP May 2023](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf), § 5.3.1, verbatim (text unchanged from the 2019 edition):

> *"Message Senders should take affirmative steps and employ tools that can monitor and prevent Unwanted Messages and content, including for example content that: (1) is unlawful, harmful, abusive, malicious, misleading, harassing, excessively violent, obscene/illicit, or defamatory; (2) deceives or intends to deceive (e.g., phishing messages intended to access private or confidential information); (3) invades privacy; (4) causes safety concerns; (5) incites harm, discrimination, or violence; (6) is intended to intimidate; (7) includes malware; (8) threatens Consumers; or **(9) does not meet age-gating requirements**."*

Note CTIA is explicitly **voluntary**: *"As a set of voluntary best practices, CTIA's Principles and Best Practices do not impose, prescribe, or require contractual or technical implementation."* The binding rules are the carrier codes of conduct (unpublished) and our contract with Telnyx.

### 2.2 Telnyx's forbidden list — the rules that actually bind us

This is the operative document for our platform. Quoted verbatim from [Telnyx, "Forbidden Messaging Use Cases in the US and Canada (10DLC, Toll-Free, and Short Code)"](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code) (updated within the last month as of 11 Aug 2026):

> **Illegal Products and Substances**
> *"Messages promoting or facilitating the sale of illegal goods are not allowed, including:*
> - *Controlled or prescription drugs without proper authorization*
> - *Substances that are not legally approved for sale*
> - *Unregulated or prohibited supplements*
>
> ***These restrictions apply regardless of business licensing status.***"

> **Cannabis, CBD, and Related Products**
> *"Messaging related to cannabis, CBD, hemp-derived products, and related accessories is prohibited across all US and Canada messaging channels, regardless of state or provincial legalization status."* Includes dispensary promotions/menus/delivery, CBD wellness or supplement products, cannabis-adjacent accessories marketed alongside cannabis, and delivery/pickup notifications. *"Carriers filter cannabis-related content at the network level. State-level legalization does not override carrier messaging policies."*

> **Gambling and Betting** — online casinos, sports betting, betting tips/odds. *"Some exceptions may exist for approved short code programs, but these require prior carrier approval."*

> **SHAFT Categories**
> - *Sex: Adult content or services*
> - *Hate: Hate speech or discriminatory content*
> - *Alcohol: Conditionally restricted — may be permitted in certain US cases with appropriate age verification and compliance controls, but policies vary by carrier*
> - *Firearms: Weapons and related products — strictly prohibited across standard messaging channels*
> - *Tobacco: Including vape, e-cigarette, and related products — strictly prohibited across standard messaging channels*

> **Deceptive or High-Risk Content** — phishing/impersonation; *"Misleading financial offers or 'guaranteed' returns"*; *"Cryptocurrency schemes, ICO promotions, or high-risk investment opportunities"*; *"Lead generation practices that obscure intent"*; anything designed to manipulate or deceive.

> **Restricted Business Models** — *"Certain business types are not supported for messaging, even if individual messages appear compliant."* Securities/stock trading incl. day-trading alerts and market signals; **SEO services and link-building outreach**; businesses operating primarily in prohibited verticals; **debt collection agencies and payday lending**; use cases evading carrier or regulatory safeguards; third-party passthrough messaging for unregistered businesses.

> *"Carriers evaluate both message content **and overall use case** when determining compliance."*
> *"Enforcement can occur even if content is not explicitly listed above."*

**Read those last two lines carefully.** The list is not exhaustive and the brand itself — not just the message — is in scope.

### 2.3 Where research peptides, supplements and nutraceuticals actually fall

**The honest starting point: no carrier or aggregator policy document I could reach names "peptides", "SARMs", "research chemicals", or "nutraceuticals" verbatim.** That is a genuine negative finding and it matters. This category is not enumerated; it is caught (or not) by catch-all clauses, at the discretion of a campaign reviewer.

What *is* enumerated, and reaches it:

| Clause | Source | Reaches research peptides because… |
|---|---|---|
| *"Substances that are not legally approved for sale"* | Telnyx | FDA has not approved research peptides for human use; several (semaglutide, tirzepatide) are prescription-only, and the rest are unapproved new drugs |
| *"Controlled or prescription drugs without proper authorization"* | Telnyx | GLP-1 analogues are prescription-only |
| *"Unregulated or prohibited supplements"* | Telnyx | Squarely on point |
| *"These restrictions apply regardless of business licensing status"* | Telnyx | Being a lawfully incorporated business with a reseller licence is explicitly not a defence |
| *"Illegal Prescriptions"* named in T-Mobile's $1,000 illegal-content fine tier | Telnyx pass-through of T-Mobile CoC | Direct hit |
| *"Offers for any drug that cannot be sold over-the-counter in the US and Canada are forbidden"* | Twilio-derived *(secondary)* | Direct hit |
| *"narcotics, cannabis, **steroids**, or other controlled substances"* | [Plivo AUP](https://www.plivo.com/aup/) | Only source naming steroids; reaches SARMs by function |

**Kratom** is the one adjacent term that *is* named — but only in Twilio's forbidden-categories article, which I could not fetch directly (403) and which is quoted here from a secondary reproduction. `[SECONDARY-SOURCED]`

**Ordinary vitamins and lawful dietary supplements** are not named as prohibited anywhere and appear to be permitted normally. But note Bandwidth's brand-level standard (below) — a supplement brand whose site also sells SARMs, CBD or unapproved peptides fails on the website, not the message.

**The brand-level review standard.** Bandwidth is the strictest and clearest: prohibited content *"is also not allowed to be on the customer's website at all."* Their worked example is a chiropractor who sells CBD oil online — campaign denied, even though the messaging never mentions CBD. Telnyx's decline codes point the same way (601 "Campaign Attributes Do Not Match Website", 603 "Inconsistent Website and Sample Messages", 804 "Unable to Verify Website/CTA Information"). **Assume the reviewer opens the client's storefront.**
Source: [Bandwidth 10DLC campaign vetting tips](https://www.bandwidth.com/support/en/articles/12823092-10dlc-campaign-vetting-tips-and-tricks)

### 2.4 The FDA overlay — and why our SMS copy is the evidence

This is the part that most SMS compliance discussion misses, and it is the larger risk for Vici Peptides.

The FDA does not care what the label says. It cares what the *marketing* says. From the FDA's warning letter to **Summit Research Peptides** (MARCS-CMS 695607, 10 December 2024) — a research-peptide e-commerce store structurally identical to Vici Peptides:

> *"Despite statements on your product labeling marketing your products as **'RESEARCH USE ONLY'** and **'INTENDED AS A RESEARCH CHEMICAL ONLY,'** evidence obtained from your websites establish that your products are intended to be drugs for human use. Your products are drugs as defined by section 201(g)(1) of the FD&C Act 21, U.S.C. 321(g)(1), because they are intended to prevent, treat, or cure disease conditions and/or affect the structure or function of the body."*

The FDA then quoted the vendor's own product-page copy back at them — phrases like *"Supports weight management in obesity"*, *"Achieve Your Weight Loss Goals Faster"*, *"Enhances insulin secretion"* — and concluded the products were **unapproved new drugs introduced into interstate commerce in violation of FD&C Act §§ 505(a) and 301(d) (21 U.S.C. §§ 355(a), 331(d))**, with the closing threat: *"Failure to adequately address this matter may result in legal action including, without limitation, seizure and injunction."*
Source: [FDA Warning Letter — Summit Research Peptides](https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/summit-research-peptides-695607-12102024)

**The implication for an SMS platform is direct and severe:**

Every promotional SMS a peptide brand sends is *additional written marketing evidence of human intended use*. A text saying "Restock on Sema — hit your goals faster" is precisely the kind of statement the FDA quoted in that letter. **An SMS program does not merely carry the risk; it manufactures the evidence.** And because we host the message logs, that evidence is discoverable from us.

Context: the FDA issued **50+ warning letters in September 2025** to companies compounding or manufacturing semaglutide, and removed semaglutide and tirzepatide from the shortage list, which eliminated the legal basis for bulk compounding. Enforcement pressure in this category is rising, not falling. *(Enforcement volume figure is secondary-sourced; the Summit letter itself is primary.)*

### 2.5 Honest assessment: can a research-peptide brand legitimately run A2P 10DLC SMS in the US?

**Short answer: no — not for marketing traffic, not defensibly.** There is a narrow, fragile position for pure transactional messaging, and it is not a business we should build on.

Taking it apart:

**1. Can a peptide brand get a campaign approved? Yes, sometimes. That is not the same as compliance.**
The category is not enumerated in any prohibited list, so approval depends on whether a human reviewer classifies the storefront as "substances that are not legally approved for sale". Some get through. **An approval obtained because a reviewer did not look closely is not a compliance position — it is unpriced risk with no notice period.** Telnyx reserves the right to act on content *"even if content is not explicitly listed"*, and carriers can suspend a campaign or blocklist a brand without warning.

**2. Telnyx's own published policy, read plainly, prohibits it.**
*"Substances that are not legally approved for sale"* + *"Unregulated or prohibited supplements"* + *"These restrictions apply regardless of business licensing status."* If Telnyx compliance is asked the direct question — "may our client sell research peptides including semaglutide analogues over SMS?" — the documented answer is no. **We should ask that question in writing, and we should expect an answer we do not like.** Getting it in writing is still better than not knowing: it converts an unbounded surprise into a known constraint.

**3. Promotional content is unrunnable.**
Any message with a product name, a price, a discount, a restock alert, or a benefit claim is simultaneously: (a) a carrier content violation candidate under the illegal-substances clause; (b) FDA evidence of human intended use; (c) potentially an FTC deceptive-advertising issue if it carries an efficacy claim. There is no version of "SMS marketing for research peptides" that is clean.

**4. The narrow transactional position — and why it is still fragile.**
The most defensible construction is:
- Transactional only: order confirmation, shipping, delivery, support replies. No promotions, no restocks, no win-backs, no cart abandonment.
- No drug or compound names in message bodies. No "Sema", "Tirz", "Reta", "BPC", peptide names of any kind.
- No health, benefit, dosage, efficacy or outcome claims of any kind.
- No links to product pages. Link only to an order-status page.
- Express written opt-in captured at checkout, SMS-specific, unchecked by default.
- Registered as a **Delivery Notification** or **Customer Care** use case, never Marketing or Mixed.

Even executed perfectly, this fails if the reviewer applies a Bandwidth-style **brand-level** standard, because the storefront itself is the disqualifying artefact. It survives on the reviewer looking at the messages rather than the business. **That is a coin-flip dressed up as a control.**

**5. Toll-free and short code are not escape hatches.** Telnyx's forbidden-use-case article is explicitly scoped to *"10DLC (long code), Toll-Free numbers, Short Codes"* alike. Toll-free verification has, per Telnyx's own framing, come to *"mirror 10DLC"*.

**6. What this means commercially.**

| | Recommendation |
|---|---|
| **Vici Peptides** | Operate with eyes open, ring-fenced. Transactional-only ruleset, hard content blocks on compound names and health claims, its own brand/campaign/messaging profile so a suspension cannot cascade to other clients. Written acknowledgement from the client that carrier suspension is a live possibility and that we do not indemnify it. Get Telnyx's position in writing. |
| **Selling this vertical** | **Do not.** Research peptides must not appear in any ICP list, landing page, or outbound pitch. Marketing ourselves as the peptide-friendly SMS platform would make us the party that knowingly facilitated the traffic — which is exactly the posture that turns a client's carrier fine into our AUP termination and our FDA/FTC exposure. |
| **The compliance layer as product** | This is the actual lesson. What we learned building for a genuinely hard vertical is worth selling. The vertical itself is not. |

**Where I might be wrong, stated plainly:** no rule anywhere says "peptides are banned". A reasonable person could argue that a transactional-only delivery-notification campaign for a lawfully incorporated business selling lawfully-imported research chemicals, with no drug claims in any message, is not what the illegal-substances clause was aimed at. That argument is not frivolous. It is also not a defence you get to make before your campaign is suspended — carrier enforcement is administrative, immediate, and not adversarial. **Plan for the enforcement mechanism, not the merits.**

---

## 3. Carrier violation penalties

### 3.0 The headline correction

Two figures circulate constantly and are frequently misattributed. **Both the $2,000 and the $10,000 are T-Mobile's**, from two different schedules that operate concurrently. **Sources attributing a $10,000 content-violation fine to AT&T are wrong.** AT&T publishes no monetary fine schedule at all.

**Neither the T-Mobile Code of Conduct nor either version of the AT&T Code of Conduct contains any dollar figure.** Both were extracted in full to confirm this. Monetary schedules are distributed to aggregators via carrier bulletins and appear publicly only in aggregator republication. Every figure below is therefore **secondary-sourced by necessity**, cross-checked across independent aggregators.

### 3.1 T-Mobile — the complete schedule

Telnyx publishes the fullest table, and is the only source showing **both** schedules side by side, which is what resolves the escalation question:

| Violation | Amount | Telnyx wording (verbatim) |
|---|---|---|
| **Text Enablement** | **$10,000** per violation | *"applied if T-Mobile receives a complaint where you or your message sender text-enables a 10-digit NANP telephone number and sends messages prior to verification of message sender ownership and/or letter of authorization"* |
| **Content Violation** | **$10,000** per violation | *"applied for each unique instance of the **third or any subsequent notification** of content violating the T-Mobile Code of Conduct involving the same content provider. This content includes SHAFT-C (sex, hate, alcohol, firearms, tobacco, cannabis) violations, spam, phishing, and messaging that meets the Severity 0 violation threshold."* |
| **10DLC Long Code Program Evasion** | **$1,000** per violation | *"applied if a program is found to be using techniques like snowshoeing, dynamic routing, or non-approved number replacement"* |
| **Fraud** (Sev-0 Tier 1) | **$2,000** | *"Attempted phishing, smishing, social engineering or similar practices that manipulate individuals to reveal credit card details, social security numbers or other private information."* |
| **Illegal content, especially cannabis** (Sev-0 Tier 2) | **$1,000** | *"Any content which is not legal according to Federal or State (must be all 50 states) law. This includes Cannabis, Marijuana, **Illegal Prescriptions** and Solicitation."* |
| **Other illegal content, including SHAFT** (Sev-0 Tier 3) | **$500** | *"Other content violations, including SHAFT, that does not follow federal and state law / regulations."* |
| **Grey route** | **$10 per message** | Telnyx notes *"currently waived"* |
| **Campaign non-use / dormancy** | **$250 per month per campaign** | Telnyx suspends dormant campaigns preemptively to avoid this |

Source: [Telnyx, 10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)

**Note the "must be all 50 states" standard.** T-Mobile's illegality test is not "legal where the customer is". It is legal *federally and in all fifty states*. That is why state cannabis legalisation is irrelevant, and it is the same clause that reaches unapproved-drug sales.

**Sev-0 tiers are corroborated by three independent aggregators**, all agreeing exactly: [TSG Global](https://support.tsgglobal.com/hc/en-us/articles/21870835442075-T-Mobile-Non-Compliance-Fees-Sev-0-s) · [Textel](https://support.textel.net/article/895843/us-mobile-network-operator--mno--codes-of-conduct-and-non-compliance-fines) · [ExpertTexting](https://www.experttexting.com/blog/10dlc-text-messaging-compliance-and-t-mobile-violation-fees/)

⚠️ **Textel's Tier 1 wording confirms that simulated phishing sent for security-awareness training is fineable at $2,000** — *"phishing (including simulated phishing sent for security testing or similar purposes)"*. If we ever sell to a security-training vendor, this is a live and non-obvious exposure.

### 3.2 First violation vs. repeated — how the ladder actually works

This is the question the brief asked, and the answer is now clear:

```
Incident 1  →  Sev-0 tier fine ($500 / $1,000 / $2,000 by category)
               + IMMEDIATE campaign suspension
               + Root Cause Analysis (RCA) due in 24–48 hours
Incident 2  →  same
Incident 3+ →  $10,000 per unique instance, per the Content Violation schedule
Severe/chronic → brand-level blocklisting; every campaign under the EIN suspended
```

**There is no warning stage for a Sev-0.** TSG Global, verbatim: *"Severity-0 (Sev-0) are the most extreme violations which demand immediate escalation"* and *"Immediate suspension of messaging campaign"*. The cure window is **24–48 hours to complete the correct action and return the RCA**. A warning-then-fine model does not apply to this severity class.
Source: [TSG Global — T-Mobile Non-Compliance Fees (Sev-0's)](https://support.tsgglobal.com/hc/en-us/articles/21870835442075-T-Mobile-Non-Compliance-Fees-Sev-0-s)

**Effective date — minor conflict, resolved.** TSG Global says the schedule took effect 1 Jan 2024; Textel says 15 Feb 2024. Most likely reconciliation: T-Mobile's schedule commenced 1 Jan 2024 and 15 Feb 2024 is Textel's own pass-through start date. Not a carrier-level disagreement.

**Currency:** these figures are still published as current on Telnyx and TSG Global as of 11 Aug 2026. I found **no evidence of revision since 2024, and no 2025/2026 carrier bulletin confirming they are unchanged.** Treat as current-but-unrefreshed.

### 3.3 AT&T

**AT&T publishes no fine schedule.** Enforcement is non-monetary and escalating. AT&T Code of Conduct, verbatim:

> *"Failure to comply with this Code including but not limited to its Policies may result in: Downgrade in Message service class(es), Suspension of Messaging campaign(s), or Termination"*

The June 2020 version adds that AT&T may act *"without prior notice"* and that *"Chronic non-compliance may result in suspension or termination of the Messaging Partner's messaging privileges."*

The practical severity of an AT&T **service-class downgrade** is easy to underestimate: it silently drops the campaign from 4,500 TPM to 240 TPM or lower without any fine, notification, or error code that says "you were downgraded". The only symptom is throughput collapse.

AT&T's only per-message charge is a **pass-through fee, not a fine** — reportedly $0.004/SMS on unregistered traffic, now largely academic since unregistered traffic is blocked.

Sources: [AT&T Code of Conduct, 1 Mar 2021](https://docs.intelepeer.com/Atmosphere/Content/Resources/Files/att_bulk_messaging_code_of_conduct_re_10dlc_a2p_messages__03.2.pdf) · [AT&T CoC, 1 Jun 2020](https://sinch.github.io/docs/sms/sms-other/downloads/ATT_Code_of_Conduct_062020.pdf)

### 3.4 Verizon

**No monetary penalties. Enforcement is blocking-based and abrupt.** Bandwidth, verbatim:

> *"Spam monitoring is in place, and if any campaigns are found to be spam or fraudulent, either through detection or through complaints received, the campaigns will be shut down immediately."*

Verizon maintains *"a zero-tolerance policy regarding spam, particularly with phishing."* Recovery requires **a full RCA within 48 hours**, with restoration at Verizon's sole discretion.
Source: [Bandwidth — Verizon 10DLC](https://www.bandwidth.com/support/en/articles/12823103-verizon-10dlc)

### 3.5 Who actually pays — the single most important commercial fact here

**The fine is levied on the aggregator/CSP and passed through contractually to the end customer, attaching to the EIN on the TCR brand registration.**

T-Mobile's reserved rights, as republished: T-Mobile *"reserves the right to permanently suspend brand, campaigns, and or Company's access to the T-Mobile Network"* and may **"Pass through fines to the Business (EIN as per 10DLC brand information)."**

Telnyx's position: *"Telnyx fines customers for major compliance violations"* — the fine schedule appears in Telnyx's own fees article as pass-through.

**Consequences for how we build the business:**

1. **Register brands against the client's EIN, never ours.** If we register a client brand under our own EIN for convenience, we become the party the fine attaches to.
2. **Our terms of service need a matching indemnity** for carrier fines, and it must survive termination.
3. **One messaging profile and one brand per client.** A brand-level blocklisting suspends every campaign under that EIN. If clients share a brand, one client's violation kills all of them.

Sources: [Textel](https://support.textel.net/article/895843/us-mobile-network-operator--mno--codes-of-conduct-and-non-compliance-fines) · [ExpertTexting](https://www.experttexting.com/blog/10dlc-text-messaging-compliance-and-t-mobile-violation-fees/) · [Telnyx](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)

### 3.6 Consolidated enforcement ladder

| Trigger | Consequence |
|---|---|
| Unregistered traffic | **Blocked outright** since Feb 2025 |
| T-Mobile daily brand cap exhausted | Rejection with error `(4)780` / Telnyx `40016`; resets midnight PT. **No fine** |
| AT&T per-minute limit exceeded | Rejection, Telnyx `40018`. No fine |
| Campaign idle >60 days (T-Mobile: 15 days dormancy trigger at Telnyx) | $250/month non-use fee |
| Content/policy violation, 1st–2nd notice | Sev-0 tier fine $500 / $1,000 / $2,000 + immediate suspension + RCA in 24–48h |
| Content violation, 3rd+ notice | $10,000 per unique instance |
| Snowshoeing / dynamic routing / number replacement | $1,000/violation (T-Mobile); campaign disablement; AT&T service-class downgrade |
| Text-enabling a NANP number without authorisation (on complaint) | $10,000 per violation |
| Spam/phishing detected (Verizon) | Immediate shutdown, RCA in 48h, discretionary restoration |
| Chronic non-compliance (AT&T) | Service-class downgrade → suspension → termination |
| Severe / repeat, any carrier | **Brand-level blocklisting — all campaigns under the EIN** |

---

## 4. TCPA

### 4.1 Prior express written consent — 47 CFR § 64.1200(f)(9)

> ⚠️ **The CFR text of (f)(9) changed twice in 18 months.** The 2023 one-to-one version was vacated and the FCC reverted the text effective 29 August 2025. **Static CFR snapshots — including the govinfo 2024 annual edition — still show the vacated wording.** Do not build against a cached CFR.

**Current operative text**, verbatim from [Cornell LII 47 CFR § 64.1200](https://www.law.cornell.edu/cfr/text/47/64.1200):

> *"(9) The term prior express written consent means an agreement, in writing, bearing the signature of the person called that clearly authorizes the seller to deliver or cause to be delivered to the person called advertisements or telemarketing messages using an automatic telephone dialing system or an artificial or prerecorded voice, and the telephone number to which the signatory authorizes such advertisements or telemarketing messages to be delivered."*
>
> *"(i) The written agreement shall include a clear and conspicuous disclosure informing the person signing that:*
> *(A) By executing the agreement, such person authorizes the seller to deliver or cause to be delivered to the signatory telemarketing calls using an automatic telephone dialing system or an artificial or prerecorded voice; and*
> *(B) The person is not required to sign the agreement (directly or indirectly), or agree to enter into such an agreement as a condition of purchasing any property, goods, or services."*
>
> *"(ii) The term 'signature' shall include an electronic or digital form of signature, to the extent that such form of signature is recognized as a valid signature under applicable federal law or state contract law."*

The (ii) cross-reference picks up the **E-SIGN Act (15 U.S.C. § 7001 et seq.)** — a checkbox, form submission, or keypress qualifies *provided it can be attributed to the signer and the record is retained*.

**"Clear and conspicuous"** is defined at (f)(3) as *"a notice that would be apparent to the reasonable consumer, separate and distinguishable from the advertising copy or other disclosures."*

**Why a pre-checked box fails.** Two independent reasons: (a) the rule requires an *agreement bearing the signature* — an affirmative act; a pre-ticked box records no act by the consumer, so there is no signature to attribute under E-SIGN; (b) (f)(9)(i) requires the disclosure be clear and conspicuous and that consent not be a condition of purchase, and a pre-checked box buried in checkout is neither "separate and distinguishable" nor evidence of knowing authorisation. This is long-standing FCC guidance and universal industry practice rather than a phrase in the rule text itself. `[Treat as well-settled practice, not a quoted prohibition.]`

**The burden of proving consent is on the sender.** That is the whole reason §8's audit-log spec exists.

### 4.2 One-to-one consent is DEAD. It is not in force in 2026.

| Date | Event |
|---|---|
| Dec 2023 | FCC adopts **FCC 23-107**: one-to-one consent + "logically and topically associated" limit, aimed at the lead-generator loophole |
| Jan 2025 | FCC postpones the effective date days before it was to bite |
| **24 Jan 2025** | **Eleventh Circuit vacates the rule** — *Insurance Marketing Coalition Ltd. v. FCC*, No. 24-10277 |
| 30 Apr 2025 | Mandate issued; FCC declines further review |
| 14 Jul 2025 | FCC order conforming the CFR to the mandate |
| **29 Aug 2025** | Federal Register final rule effective — vacated language deleted, pre-2023 definition restored |

The Eleventh Circuit held the FCC **exceeded its statutory authority**: the new restrictions *"impermissibly conflict with the ordinary statutory meaning of 'prior express consent.'"* It vacated **both** the one-to-one requirement and the "logically and topically related" requirement.

**Has the FCC re-proposed anything? No.** No 2025 or 2026 proposal to reinstate was found. The October 2025 FNPRM moves in the opposite, deregulatory direction.

> ⚠️ **Multiple compliance blogs still assert one-to-one consent took effect 27 January 2026.** This is false. One such source was encountered during this research. If a client or a vendor cites this rule as live, correct them.

**What this does and does not mean for lead-gen / affiliate flows:** federal law does not currently require seller-by-seller consent, and bundled consent across a disclosed partner list is not federally prohibited. **But** the consent must still identify the seller(s) clearly enough that the consumer "clearly authorizes the seller"; several state statutes are stricter; and **carrier/TCR rules independently forbid this outright** (Telnyx bans *"third-party traffic or passthrough messaging"*, Bandwidth bans *"sharing data to sell consumer information (leads) to third parties"*). **Vacatur is not permission. The carrier ban is the binding constraint here, not the TCPA.**

Sources: [Federal Register 2025-16641, eff. 29 Aug 2025](https://www.federalregister.gov/documents/2025/08/29/2025-16641/delete-delete-delete-targeting-and-eliminating-unlawful-text-messages-rules-and-regulations) · [EPIC case page](https://epic.org/documents/insurance-marketing-coalition-v-fcc/) · [Wiley](https://www.wiley.law/alert-UPDATE-11th-Circuit-Vacates-FCCs-One-to-One-TCPA-Consent-Rule) *(secondary)* · [Goodwin](https://www.goodwinlaw.com/en/insights/blogs/2025/09/the-fcc-issues-final-rule-formally-eliminating-the-one-to-one-consent-requirement) *(secondary)*

### 4.3 Consent revocation — highest priority, and the April 2026 deadline did NOT hold

**The order:** **FCC 24-24**, Report and Order + FNPRM, released 16 February 2024, CG Docket Nos. 02-278 and 21-402. Codified at 47 CFR § 64.1200(a)(10)–(a)(12).

#### What is in force right now (effective 11 April 2025)

**§ 64.1200(a)(10), verbatim** — read every sentence, several are directly implementable:

> *"A called party may revoke prior express consent, including prior express written consent, to receive calls or text messages made pursuant to paragraphs (a)(1) through (3) and (c)(2) of this section by using **any reasonable method** to clearly express a desire not to receive further calls or text messages from the caller or sender. Any revocation request made using an automated, interactive voice or key press-activated opt-out mechanism on a call; using the words **"stop," "quit," "end," "revoke," "opt out," "cancel," or "unsubscribe"** sent in reply to an incoming text message; or pursuant to a website or telephone number designated by the caller to process opt-out requests constitutes a reasonable means **per se** to revoke consent. If a called party uses any such method to revoke consent, that consent is considered definitively revoked and the caller may not send additional robocalls and robotexts.*
>
> ***"If a reply to an incoming text message uses words other than "stop," "quit," "end," "revoke," "opt out," "cancel," or "unsubscribe," the caller must treat that reply text as a valid revocation request if a reasonable person would understand those words to have conveyed a request to revoke consent."***
>
> *"Should the text initiator choose to use a texting protocol that does not allow reply texts, it must provide a clear and conspicuous disclosure on each text to the consumer that two-way texting is not available due to technical limitations of the texting protocol, and clearly and conspicuously provide on each text reasonable alternative ways to revoke consent.*
>
> *"All requests to revoke prior express consent or prior express written consent made in any reasonable manner must be honored within a reasonable time **not to exceed ten business days** from receipt of such request.*
>
> ***"Callers or senders of text messages ... may not designate an exclusive means to request revocation of consent."***

**§ 64.1200(a)(11) — rebuttable presumption**, verbatim:

> *"The use of any other means to revoke consent not listed in paragraph (a)(10) of this section, such as a voicemail or email to any telephone number or email address intended to reach the caller, creates a rebuttable presumption that the consumer has revoked consent when the called party satisfies their obligation to produce evidence that such a request has been made, absent evidence to the contrary. In those circumstances, a totality of circumstances analysis will determine whether the caller can demonstrate that a request to revoke consent has not been conveyed in a reasonable manner."*

**§ 64.1200(a)(12) — the one confirmation message**, verbatim:

> *"A one-time text message confirming a request to revoke consent ... does not violate paragraphs (a)(1) and (2) of this section as long as the confirmation text merely confirms the text recipient's revocation request and **does not include any marketing or promotional information**, and is the only additional message sent to the called party after receipt of the revocation request. **If the confirmation text is sent within five minutes of receipt, it will be presumed to fall within the consumer's prior express consent.** If it takes longer, however, the sender will have to make a showing that such delay was reasonable. To the extent that the text recipient has consented to several categories of text messages from the text sender, the confirmation message may request clarification as to whether the revocation request was meant to encompass all such messages; the sender must cease all further texts for which consent is required absent further clarification that the recipient wishes to continue to receive certain text messages."*

#### The scope provision — delayed to 31 January 2027

The *cross-category* "revoke one thing, revoke everything from that sender" requirement has been waived **twice**. Verified against the primary order:

**FCC Order DA 26-12, adopted and released 6 January 2026**, CG Docket No. 02-278, by the Chief, Consumer and Governmental Affairs Bureau, verbatim:

> *"In this Order, we extend the waiver of section 64.1200(a)(10) of the Commission's rules to the extent the rule requires callers to treat a request to revoke consent made by a called party in response to one type of informational message as applicable to all future robocalls and robotexts from that caller on unrelated matters. Specifically, we find that good cause exists to extend the effective date for this requirement until **January 31, 2027**, to allow sufficient time to review the record compiled in response to a recent Further Notice of Proposed Rulemaking and to avoid imposing potentially unnecessary compliance costs on affected parties."*

Timeline: 11 Apr 2025 original effective date → 2025 Waiver Order (DA-25-312, 7 Apr 2025) pushed to 11 Apr 2026 → **DA 26-12 (6 Jan 2026) pushed to 31 Jan 2027.**

Source: [FCC DA 26-12](https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf) *(primary, extracted and verified)* · [FCC 24-24](https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf) · [DA-25-312](https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf)

#### The scope rule that IS live today — and is the most under-implemented rule in commercial SMS

From FCC 24-24: revoking **telemarketing** consent does **not** automatically revoke consent for exempted informational/transactional communications. **But the reverse is not symmetrical** — if the consumer revokes **in direct response to an exempted informational call or text**, that *"constitutes an opt-out request from the consumer and all further non-emergency robocalls and robotexts must stop."*

**In plain terms:** a customer who replies STOP to a *shipping notification* has revoked **everything**, marketing included, right now, today. A customer who replies STOP to a *promotional* message has revoked marketing but not necessarily transactional. Most platforms implement neither direction correctly.

#### Where this is heading

The **Ninth FNPRM** (adopted 28 Oct 2025, released 29 Oct 2025, CG Docket 02-278, FCC 25-76) seeks comment on **deleting** the all-or-nothing revocation rule outright — the FCC's framing is that a blanket stop-all can cut consumers off from pharmacy reminders and bank fraud alerts they want. Comments closed 5 Jan 2026; replies 3 Feb 2026. **No final order as of 11 Aug 2026 that could be located.**

> `[UNVERIFIED]` — whether anything issued in docket 02-278 between February and August 2026. **Check ECFS docket 02-278 before launch.** This is the highest-volatility item in this document.

### 4.4 Quiet hours — genuinely unsettled, and I am not picking a side

**The rule, verbatim, 47 CFR § 64.1200(c)(1):**

> *"No person or entity shall initiate any telephone solicitation to: (1) Any residential telephone subscriber before the hour of 8 a.m. or after 9 p.m. **(local time at the called party's location)**"*

**Whose time?** Unambiguous on the face of the text: **the called party's**. The real difficulty is evidentiary — how does a sender know where the recipient is? Mobile numbers travel. Industry practice uses the **area code** as a proxy, described by practitioners as defensible partly because plaintiffs typically plead that they live in their area code's region. **It is a proxy, not a safe harbour.**

**Does it apply to texts?** On the regulation's own terms, yes. "Telephone solicitation" is defined at (f)(15), verbatim:

> *"The term telephone solicitation means the initiation of a telephone call **or message** for the purpose of encouraging the purchase or rental of, or investment in, property, goods, or services, which is transmitted to any person, but such term does not include a call or message: (i) To any person with that person's **prior express invitation or permission**; (ii) To any person with whom the caller has an established business relationship; or (iii) By or on behalf of a tax-exempt nonprofit organization."*

**Does express written consent exempt you? THIS IS THE DISPUTE.**

- **Defence position:** the (f)(15)(i) carve-out excludes messages sent with "prior express invitation or permission". A consumer who gave PEWC *a fortiori* gave invitation or permission, so the message is not a "telephone solicitation" at all and (c)(1) never applies. Note the asymmetry the defence leans on: the quiet-hours rule does **not** incorporate the signed-writing standard that DNC claims require — it is a lower bar, more easily met.
- **Plaintiff position:** consent to receive marketing is not consent to receive it at 11 p.m.; the time restriction operates independently of the consent analysis.
- **Also live:** the (f)(15)(ii) *established business relationship* carve-out, which would sweep in most e-commerce transactional and post-purchase messaging.

**Case law:** *King v. Bon Charge*, No. 25-cv-00105-SB (D. Del., **30 April 2026**) (Bibas, J., sitting by designation) **dismissed** a quiet-hours claim, holding a consumer who texted in to subscribe for a discount gave "prior express invitation or permission", removing the messages from the definition. Commentators on both sides describe this as the first squarely-on-point answer and expect a split. **There is no appellate authority. This is one persuasive district court decision, not settled law.**

**FCC:** the Ecommerce Innovation Alliance and others petitioned in March 2025 for a declaratory ruling that PEWC messages are outside quiet hours. Comments closed April 2025. **No ruling found as of August 2026.** `[UNVERIFIED]` And note §4.6 — post-*McLaughlin*, even a favourable FCC ruling would not bind district courts.

**Litigation reality:** quiet-hours class actions have been the fastest-growing TCPA theory since late 2024 and drove much of the 2025–26 filing spike.

> **Engineering recommendation, notwithstanding the legal dispute:** hard-block outside **8 a.m.–9 p.m. recipient local time**, derived from area code, with a stricter per-state override table. There is no commercial upside to testing *King v. Bon Charge* with a client's money.

Sources: [Cornell LII 47 CFR 64.1200](https://www.law.cornell.edu/cfr/text/47/64.1200) *(primary)* · [Nixon Peabody on *King v. Bon Charge*](https://www.nixonpeabody.com/insights/alerts/2026/05/13/a-loud-decision-on-tcpa-quiet-hours) *(secondary)* · [Privacy World](https://www.privacyworld.blog/2025/03/new-class-action-threat-tcpa-quiet-hours-and-marketing-messages/) *(secondary)* · [Troutman on the EIA petition](https://www.troutman.com/insights/fcc-seeks-comments-on-petition-to-address-tcpa-quiet-hours/) *(secondary)*

### 4.5 Damages and litigation exposure

**47 U.S.C. § 227(b)(3)** — the provision most SMS claims run through — verbatim: recover *"actual monetary loss from such a violation, or to receive **$500 in damages for each such violation**, whichever is greater"*; for a willful or knowing violation the court *"may, in its discretion, increase the amount of the award to an amount equal to **not more than 3 times** the amount available."*

**§ 227(c)(5)** (DNC / telephone solicitation) is parallel but reads *"up to* $500", a drafting difference some defendants argue gives courts discretion to award less.

- **$500 per negligent violation; up to $1,500 per willful or knowing violation. No cap.**
- **Each message is a separate violation.** This is the mechanic that makes TCPA existential. A single non-compliant blast to 50,000 numbers is **$25M** nominal exposure at the negligent rate, **$75M** trebled.
- Willfulness does **not** require knowledge that the conduct was unlawful — only that the act was intentional. A low bar, routinely pleaded.

**Filing volume — two sources disagree, and both are reported honestly because they count different things:**

- Plaintiff/defence tracker (TCPAWorld) reports records: 507 TCPA class actions in Q1 2025 vs 239 in Q1 2024 (+112%); **Mar 2026: 283 cases / 220 class actions (record)**; **Apr 2026: 330 cases / 255 class actions (+40% YoY)**. Q1 2026 the highest quarter in history.
- Goodwin's 2025 year-in-review reports **2,588 total TCPA lawsuits Jan–Nov 2025, a 0.4% *decrease*** from 2024.

**These are not contradictory.** Total case volume is roughly flat; the **class-action share has exploded**. Roughly **80% of TCPA suits are now class actions**, against 2–5% for other consumer statutes. **The risk shift is in severity, not frequency.**

**Recent settlements:** Kaiser Permanente $10.5M (marketing texts); Wilshire Law Firm up to $5.975M; NexGen HVAC $3.8M+; Farmers Insurance $2.87M; OptumRx $1.86M. Per-claimant recovery is typically ~$20 — the cost driver is defence fees and class counsel fees, not consumer payouts.

Sources: [Cornell LII 47 U.S.C. § 227](https://www.law.cornell.edu/uscode/text/47/227) *(primary)* · [TCPAWorld filing trackers](https://tcpaworld.com/2026/06/04/april-tcpa-filings-off-the-chart-330-tcpa-cases-255-tcpa-class-actions-filed-in-april-2026-up-40-from-2025/) *(secondary)* · [Goodwin 2025 YIR](https://www.goodwinlaw.com/en/insights/publications/2026/03/insights-finance-cfs-yir-telephone-consumer-protection-act) *(secondary)*

### 4.6 *McLaughlin Chiropractic Assocs. v. McKesson Corp.* (2025) — the most consequential TCPA decision in a decade

**606 U.S. ___ (20 June 2025), No. 23-1226. Held 6–3 (Kavanaugh, J.; Kagan, J. dissenting, joined by Sotomayor and Jackson):** the **Hobbs Act does not bind district courts** in civil enforcement proceedings to an agency's interpretation of a statute. District courts *"must independently determine the law's meaning under ordinary principles of statutory interpretation while affording appropriate respect to the agency's interpretation."*

**Why this cuts both ways — and the downside is the part people miss:**

- **Upside for defendants:** FCC orders *expanding* TCPA liability (the 2003 ruling that texts are "calls", revocation interpretations, the 2015 omnibus) are no longer immune from collateral attack.
- **Downside for us:** FCC orders that *limit* liability, or create safe harbours and exemptions, are **equally non-binding**. **A platform can no longer rely on a favourable FCC interpretation as a shield.** If the FCC grants the quiet-hours declaratory ruling businesses want, a district court is free to disregard it.
- **Net:** more circuit-level fragmentation, less national uniformity, higher unpredictability.

> **Design consequence:** build compliance to the **strictest plausible reading of the statutory text**, not to the FCC's most business-friendly gloss. "The FCC said it was fine" is no longer a defence.

Source: [Supreme Court slip opinion, No. 23-1226](https://www.supremecourt.gov/opinions/24pdf/23-1226_1a72.pdf) *(primary)*

### 4.7 Live circuit split: are texts "calls" under § 227(c)?

A direct consequence of *McLaughlin*.

**Seventh Circuit, *Steidinger v. Blackstone Medical Services*, 2026 WL 2028517 (7th Cir., 14 July 2026):** text messages *"do not fall within the private right of action created by § 227(c)(5)."* Textualist reasoning — in 1991 "telephone" meant an instrument reproducing *sounds* at a distance; texts reproduce no sounds. The court also noted Congress used the narrower "call" in § 227(c) while using broader language elsewhere.

**Effect in Illinois, Indiana, Wisconsin:** no private § 227(c)(5) claim for text-based **DNC registry**, **internal DNC**, or **quiet hours** violations.

**The split:** the court acknowledged contrary holdings from the **First, Second, Ninth and Eleventh Circuits** — notably *Howard v. Republican National Committee* (9th Cir., Jan 2026), holding texts **are** calls.

> **Do not design around the Seventh Circuit view.** § 227(b) autodialer/prerecorded claims for texts are unaffected everywhere, and every state mini-TCPA independently regulates texts. This is cert-worthy and could flip.

Sources: [Cooley](https://www.cooley.com/news/insight/2026/2026-07-21-seventh-circuit-holds-texts-not-telephone-calls-under-key-tcpa-provision) *(secondary)* · [Duane Morris](https://blogs.duanemorris.com/classactiondefense/2026/07/17/seventh-circuit-holds-that-the-tcpas-do-not-call-provision-does-not-cover-text-message/) *(secondary)*

### 4.8 State mini-TCPA laws

Federal compliance is the floor. In practice the state statutes generate most demand letters against SMS platforms, because several apply to **any** marketing text regardless of dialing technology.

| State | Statute | Key deltas from federal |
|---|---|---|
| **Texas** | **SB 140, eff. 1 Sept 2025** — the most significant new law | Expanded "telephone solicitation" to cover **texts and images**; private right of action; statutory damages **up to $5,000 per violation**; recovery per separate violation; adds a registration/bond regime |
| **Florida** | FTSA, Fla. Stat. § 501.059 (amended May 2023) | PEWC for automated telephonic sales calls incl. texts; **8 a.m.–8 p.m.**; max **3 calls/day** same subject; private right of action $500/$1,500 trebled. The 2023 amendment narrowed the technology trigger and added a **15-day pre-suit notice + cure** for texts, which cut filings sharply but did not eliminate them |
| **Oklahoma** | Telephone Solicitation Act of 2022 | Near word-for-word Florida clone incl. 3 calls/day and 8 a.m.–8 p.m.; private right of action. Now a leading filing venue as Florida cooled |
| **Washington** | CEMA + Commercial Telephone Solicitation Act | Broad "commercial solicitation" definition sweeping in more outreach than federal; private right of action; damages **up to $1,000 per violation** for repeat conduct. CEMA separately regulates commercial texts |
| **Oregon** | **HB 3865, eff. 1 Jan 2026** | **8 a.m.–8 p.m.**; max 3 calls/day; expressly covers text messages |
| **Connecticut** | SB 1058 | PEWC for any telephonic sales call; broadened telemarketer and covered-technology definitions; penalties **up to $20,000 per violation** |
| **Maryland** | Maryland Telephone Solicitations Act | Mini-TCPA applying stricter standards to calls and texts to MD residents |
| **New Jersey** | N.J.S.A. 56:8-119 et seq. | Telemarketing restrictions incl. call-time limits. `[UNVERIFIED — not checked against primary text]` |
| **Michigan / Pennsylvania** | MI Home Solicitation Sales Act; PA Telemarketer Registration Act | Both have telemarketing statutes with consumer remedies; text applicability `[UNVERIFIED]` |

**Watch list (all in committee, `[UNVERIFIED]` whether they advanced in 2026 sessions):** North Carolina HB 936 (would swap "express invitation or permission" for PEWC and broadly redefine "robocalls"); South Carolina HB 3323; Washington HB 1103 (would bar solicitations incl. texts to National DNC registrants without consent).

**The practical binding constraint:** the strictest common window across FL / OK / OR is **8 a.m.–8 p.m.**, so a platform serving national traffic should default to that rather than the federal 9 p.m.

Sources: [Goodwin 2025 YIR](https://www.goodwinlaw.com/en/insights/publications/2026/03/insights-finance-cfs-yir-telephone-consumer-protection-act) *(secondary)* · [Potomac Law on Texas SB 140](https://www.potomaclaw.com/news-Texas-Mini-TCPA-Now-Covers-Marketing-Text-Messages) *(secondary)*

---

## 5. Opt-out handling

### 5.1 The three overlapping rule sets

Opt-out is governed by three separate regimes that **do not agree**, and a compliant implementation must satisfy the strictest of each:

| Regime | Keywords | Timing | Scope |
|---|---|---|---|
| **FCC / TCPA** (binding law) | 7 per-se keywords **+ any free text a reasonable person would read as revocation** + email, voicemail, web form, phone (rebuttable presumption) | ≤ 10 business days | May not designate an exclusive means |
| **CTIA MPBP** (voluntary industry) | stop, end, unsubscribe, cancel, quit, "please opt me out"; insensitive to capitalisation and punctuation | Immediately; one final confirmation, then nothing | Per campaign; multiple mechanisms incl. phone and email |
| **Telnyx platform** (what actually executes) | stop, stopall, stop all, unsubscribe, cancel, end, quit — **only if they are the only words in the message** | Real-time | Per **messaging profile** |

### 5.2 Mandatory keywords

**FCC per-se list, § 64.1200(a)(10)** — these seven are conclusive:
`stop` · `quit` · `end` · `revoke` · `opt out` · `cancel` · `unsubscribe`

Note `revoke` and `opt out` appear in the FCC list but **not** in Telnyx's default stop-word list. See §6.4.

**CTIA, § 5.1.3**, verbatim:

> *"Message Senders should state in the message how and what words effect an opt-out. Standardized "STOP" wording should be used for opt-out instructions, however opt-out requests with normal language (i.e., stop, end, unsubscribe, cancel, quit, "please opt me out") should also be read and acted upon by a Message Sender except where a specific word can result in unintentional opt-out. The validity of a Consumer opt-out should not be impacted by any de minimis variances in the Consumer opt-out response, such as capitalization, punctuation, or any letter-case sensitivities."*

**CTIA also requires multiple channels**, verbatim:

> *"Message Senders should support multiple mechanisms of opt-out, including phone call, email, or text"*

Twilio, for comparison, requires honouring `STOP, STOPALL, UNSUBSCRIBE, OPTOUT, CANCEL, END, REVOKE, QUIT`, and requires opt-out be **single-step**. Aggregator guidance flags *"creative variations like 'Reply 2 to unsubscribe'"* as non-compliant — **never replace STOP with a numeric reply.**

### 5.3 HELP requirements

Telnyx's required 10DLC template:

> *Help Keyword:* `HELP` or similar
> *Help confirmation message:* `[Brand name]: Please reach out to us at [website/email/phone number] for help.`
> *"Websites are permissable so long as they have clear contact information at the link provided."*

The short-code standard is stricter and is the better default:

> *"The help source MUST be either a Toll-Free phone number or a support email address. Other forms of help are permissible, but one of these options is required at a minimum."*
> *"A compliant response is also necessary whenever recipients text HELP to your short code, **regardless of their subscription status**."*

Same applies to STOP: *"It's required by industry standards to send a compliant response whenever an end user texts STOP or similar keywords ... **regardless of whether they were previously subscribed**."*

Source: [Telnyx — Standards for US Short Code Keywords](https://support.telnyx.com/en/articles/9311492-standards-for-us-short-code-keywords-help-stop-and-opt-in-confirmation) · [Telnyx — 10DLC Keywords and Confirmation Messages](https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages)

### 5.4 How quickly must an opt-out be honoured?

| Standard | Deadline |
|---|---|
| FCC / TCPA (legal maximum) | **10 business days** |
| CTIA | Immediately — one final confirmation message, *"No further messages should be sent following the confirmation message"* |
| Healthcare-provider exemption, § 64.1200(a)(9)(v)(H) | *"A healthcare provider must honor opt-out requests **immediately**"* |
| Confirmation message safe harbour, § 64.1200(a)(12) | **5 minutes** for the presumption to apply |
| Practical engineering target | **Real-time, synchronous, before the next send** |

**Ten business days is a legal ceiling, not a target.** Any platform that takes more than seconds is choosing to accumulate liability, and every message sent in the gap is a separate $500–$1,500 exposure.

### 5.5 Carrier vs. sender: who handles it?

**Both, at different layers — and neither is sufficient alone.**

- **Carrier/network layer:** for **toll-free** numbers, carriers independently send `NETWORK MSG` responses that Telnyx cannot prevent or customise. For **10DLC**, there is no carrier-level opt-out — it is entirely the sender/platform's job.
- **Telnyx platform layer:** Telnyx auto-detects its stop-word list, adds the number to an opt-out list scoped to the **messaging profile**, sends a generic auto-response, and returns error `40300` on any subsequent send attempt.
- **Sender/application layer:** **this is where the legal obligation actually sits.** Telnyx's own short-code guidance says so plainly: *"your application must process this request and maintain the opt-out list"* and *"These legal stipulations could require you to offer more comprehensive opt-out mechanisms than a mere STOP reply."*

> **Design conclusion: never rely on Telnyx's built-in opt-out handling for compliance.** It is a useful backstop and a last-resort send blocker. It is not a TCPA control. Maintain your own suppression list, in your own database, as the authority. See §6.4 for the specific gaps.

### 5.6 What a compliant opt-out audit trail looks like in a database

Two tables plus an append-only event log. Everything is append-only; nothing is ever hard-deleted or updated in place.

```sql
-- 1. CONSENT RECORDS (append-only; never UPDATE, never DELETE)
consent_events
  id                    uuid pk
  contact_id            uuid
  phone_e164            text            not null   -- +1XXXXXXXXXX
  brand_id              uuid            not null   -- TCR brand
  campaign_id           uuid            not null   -- TCR campaign
  event_type            enum            not null   -- opt_in | opt_out | opt_in_reconfirm
  consent_type          enum                       -- express_written | express | implied
  consent_scope         enum            not null   -- marketing | transactional | all
  occurred_at           timestamptz     not null   -- when the consumer acted
  recorded_at           timestamptz     not null   -- when we wrote the row
  -- PROOF OF THE ACT
  channel               enum            not null   -- web_form | sms_keyword | verbal | paper | api | pos
  source_url            text                       -- exact URL of the opt-in page
  form_id               text
  disclosure_text       text            not null   -- VERBATIM text shown at the moment of consent
  disclosure_version    text            not null   -- hash or version id of that copy
  affirmative_action    text            not null   -- 'checkbox_checked' | 'keyword_START_replied' | ...
  ip_address            inet
  user_agent            text
  session_id            text
  identity_asserted     text                       -- name/username/email the consumer gave
  screenshot_uri        text                       -- immutable object-store ref (for TCR + litigation)
  -- REVOCATION SPECIFICS
  revocation_method     enum                       -- sms_keyword | sms_freetext | email | voice
                                                   --   | web_form | agent | carrier | manual
  revocation_raw_text   text                       -- the consumer's EXACT words
  revocation_matched_by text                       -- 'per_se_keyword' | 'nlp_intent' | 'human_review'
  honored_at            timestamptz                -- when suppression became effective
  confirmation_sent_at  timestamptz                -- must be <= honored_at + 5 min
  -- INTEGRITY
  actor                 text            not null   -- system component or operator id
  prev_hash             text                       -- hash chain over the row, for tamper evidence
  row_hash              text            not null

-- 2. SUPPRESSION LIST (the fast read path; derived, but authoritative for sends)
suppressions
  phone_e164            text
  brand_id              uuid
  scope                 enum                       -- marketing | all
  suppressed_at         timestamptz     not null
  source_consent_event  uuid            not null   fk -> consent_events.id
  primary key (phone_e164, brand_id, scope)

-- 3. SEND LOG (proves what was sent, to whom, under which consent)
message_events
  id, phone_e164, brand_id, campaign_id, direction,
  body_rendered         text            not null   -- the EXACT bytes sent
  template_id, template_version,
  consent_event_id      uuid            not null   -- WHICH consent authorised this send
  suppression_checked_at timestamptz    not null   -- proves we checked
  recipient_tz_source   text                       -- 'area_code' | 'profile' | 'zip'
  recipient_local_time  timestamptz     not null   -- proves quiet-hours compliance
  telnyx_message_id, telnyx_status, telnyx_error_code
```

**The eight fields that actually win a TCPA case.** If a plaintiff's counsel sends a demand letter, this is what you produce:

1. `disclosure_text` — the verbatim words the consumer saw, not a description of them
2. `occurred_at` + `ip_address` + `user_agent` — attribution of the act to a person at a time
3. `affirmative_action` — proof it was an act, not a default
4. `source_url` + `screenshot_uri` — what the page looked like
5. `consent_event_id` on every outbound message — the chain from consent to send
6. `suppression_checked_at` — proof the suppression check ran before each send
7. `recipient_local_time` — quiet-hours defence
8. `row_hash` / `prev_hash` — tamper evidence, which is what turns "our records say" into "our records provably say"

**Retention:** the CTIA-recommended fields are a subset of the above (*"Timestamp of consent acquisition; Consent acquisition medium; Capture of experience (e.g., language and action) used to secure consent; Specific campaign for which the opt-in was provided; IP address used to grant consent; Consumer phone number...; Identity of the individual who consented"* — CTIA § 5.1.2). **Retain for at least 5 years** — longer than the TCPA's 4-year federal statute of limitations, with margin for state statutes and tolling. Never purge consent records when a contact is deleted; that destroys the defence.

**One more CTIA obligation people forget**, § 5.1.5, verbatim:

> *"Message Senders should process telephone deactivation files regularly (e.g., daily) and remove any deactivated telephone numbers from any opt-in lists."*

A recycled number that reaches a new subscriber is a classic TCPA claim. Consume a deactivation/reassigned-numbers feed.

---

## 6. Telnyx specifics

### 6.1 The AUP and the messaging content policy

Telnyx's [Acceptable Use Policy](https://telnyx.com/acceptable-use-policy) is broad and generic. Notable for us:
- prohibits violating *"spam laws (CAN-SPAM Act, TCPA)"*
- prohibits *"10DLC traffic which is designated or could reasonably be expected to be spam"*
- prohibits unsolicited communications *"designed to provoke complaints"*
- prohibits *"Auto-dialing or predictive-dialing (sometimes referred to as 'robo-dialing')"* and abandoned calls above Telnyx thresholds

**The AUP itself contains no SHAFT, controlled-substances or vertical-specific list.** Those live in the [Forbidden Messaging Use Cases article](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code), quoted at length in §2.2, which is the document that actually governs vertical eligibility.

### 6.2 Registration flow

```
1. Register Brand              Mission Control → Messaging → 10DLC → Create a brand
                               Legal name (must match EIN exactly), DBA, entity type,
                               vertical, EIN, website, address, brand email + phone,
                               optional webhook URL. $4.50 one-time.
                               → Public_Profit brands must clear Auth+ 2FA first.
2. Campaign compliance prep    CTA, opt-in form, privacy policy, T&C, keywords,
                               sample messages — MUST exist BEFORE registering.
                               Telnyx: "mechanisms should be in place before
                               registering, not added after."
3. Create Campaign             Use case → carrier T&Cs → campaign details form:
                               description (40–4096 chars), message flow / CTA
                               (40–2048 chars), keywords, auto-responses,
                               sample messages, privacy policy URL, T&C URL.
4. Telnyx internal review      Free. Telnyx may resubmit multiple times — email
                               10dlcquestions@telnyx.com to opt out of that.
5. Downstream carrier review   $15 charged HERE. ~72 business hours.
6. Assign numbers              Max 49/campaign (T-Mobile limit). Active in minutes.
```

**Campaign registration API:** `developers.telnyx.com/docs/messaging/10dlc/campaign-registration`. Sole-proprietor OTP: `POST/GET/PUT /v2/10dlc/brand/{brand_id}/smsOtp`.

**Porting gotcha:** create and get campaigns approved on Telnyx *before* porting numbers in, and have the losing carrier remove the campaigns from their system first — otherwise numbers cannot be assigned.

**Dormancy auto-suspension.** Telnyx proactively suspends campaigns that have had **no activity for 15 consecutive days AND no active numbers AND are deployed with T-Mobile**, to avoid T-Mobile's **$250/month** dormancy fine. Recovery: assign numbers **twice** (the first attempt reactivates and fails; the second succeeds). A webhook fires with `{"status":"DORMANT"}` if configured. **Configure that webhook — the wizard should surface dormancy before a client's campaign silently dies.**
Source: [Telnyx — 10DLC Campaign Suspended](https://support.telnyx.com/en/articles/10723378-10dlc-campaign-suspended)

### 6.3 Campaign decline codes — the most useful debugging table in this document

These are Telnyx's published explanations for TCR/carrier campaign rejections. The wizard should pre-validate against every one of them before submission.
Source: [Telnyx — 10DLC Carrier Error Codes Explanations](https://support.telnyx.com/en/articles/10547022-10dlc-carrier-error-codes-explanations) (updated 1 Dec 2025)

| Code | Reason | Notes that matter |
|---|---|---|
| **701** | Prohibited Content; Cannabis | *"Any submission related to cannabis, including CBD, hemp, teas, beauty products, or derivatives, is subject to automatic rejection. This also includes shipping services."* |
| **702** | Prohibited Content; Guns/Ammo | *"Educational content is acceptable if it does not engage in sales."* |
| **703** | Prohibited Content; Explicit Sexual | Includes *"content appearing family-friendly but containing adult themes"* |
| **704** | Prohibited Content; Gambling | *"Bingo promotions may be allowed under certain conditions with age gating."* |
| **705** | Prohibited Content; Hate | Includes profanity |
| **706** | Alcohol (age-gated) | *"the website needs a DD/MM/YYYY age gate as opposed to 'Are you ever 21?' button"* |
| **707** | Tobacco/Vape (age-gated) | |
| **708** | Lead Gen/Affiliate Prohibited | ⚠️ *"Any mention of lead generation or SEO on the website would lead to a decline of this nature."* |
| **709** | Lead Gen/Affiliate — High-Risk Financial | *"payday loans, non-direct lenders, debt collection, credit repair programs, and debt forgiveness... This includes Crypto related traffic or traffic related to stock trading."* |
| **601** | Campaign attributes don't match website/samples | *"If the Embedded Link/Embedded Phone number attributes are marked as YES, then the message samples must contain a link/phone number"* |
| **602** | Inconsistent sample message and use-case | *"Most common with a marketing use case chosen for the campaign that is not specifically mentioned in the Call to Action online or the Message Flow section"* |
| **603** | Inconsistent website and sample messages | |
| **611** | Opt-in message requirements not met | Must include program name, frequency, HELP, opt-out, msg/data rates. *"Opt in must also meet express consent standard. IE, a checkbox next to the call to action verbiage"* |
| **710** | Reseller / non-compliant KYC | *"The brand sending the messages must be the one registered, not the agency behind it."* ⚠️ **directly relevant to us as a platform** |
| **711** | Repeated use of same EIN for multiple brands | |
| **712** | Misleading registration | *"Direct lenders and regulated entities must mark themselves as such"* |
| **713** | Large companies using non-official email domains | |
| **801** | Not sole proprietor | |
| **802** | Sole proprietor not yet authorized | Requires Syniverse authorisation |
| **803** | Opt-in language required on website | *"If the website requires a phone number for contact, it must include opt-in language."* |
| **804** | Unable to verify website/CTA | Broken links, inaccessible CTA |
| **805** | Non-compliant privacy policy | Must state SMS opt-in data is not shared with third parties |
| **806** | Needs compliant and accurate CTA info | Missing HELP/STOP/frequency/data-rates/privacy from message flow or on-site CTA |
| **807** | Inauthentic website | *"Specifically for real estate and insurance companies using incomplete websites"* |
| **851 / 852 / 861** | Privacy policy and CTA completeness variants | |

### 6.4 Opt-out handling at the platform level — and its three compliance gaps

**How it works.** Telnyx auto-detects stop words, adds the number to an opt-out list scoped to the **messaging profile**, sends a generic auto-response, and returns error `40300` on further sends. Advanced Opt-In/Out (`/autoresp_configs`) allows custom keywords (max 20), custom auto-responses (min 20 characters), and country-specific rule sets. Inbound webhooks carry an `autoresponse_type` field of `STOP` / `START` / `HELP`.

**Default stop words:** `stop`, `stopall`, `stop all`, `unsubscribe`, `cancel`, `end`, `quit`
**Default opt-in words:** `start`, `unstop`
**Default auto-response:** *"You have successfully been unsubscribed, you will not receive any more messages from this number. Reply START to re-subscribe."*

Sources: [Telnyx — SMS Opt-Out Keywords and Stop Words](https://support.telnyx.com/en/articles/1270091-sms-opt-out-keywords-and-stop-words) (updated 20 May 2026) · [Telnyx — Advanced Opt-In/Out](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out)

> ### ⚠️ THREE GAPS BETWEEN TELNYX'S BEHAVIOUR AND THE FCC RULE
>
> **Gap 1 — Exact-match only.** Telnyx, verbatim: *"stop words are only recognized if they are the only words in the message. For example, 'stop all' is recognized but 'please stop all messages' would not be recognized."*
>
> The FCC rule, verbatim: *"If a reply to an incoming text message uses words other than 'stop,' 'quit,' 'end,' 'revoke,' 'opt out,' 'cancel,' or 'unsubscribe,' the caller must treat that reply text as a valid revocation request if a reasonable person would understand those words to have conveyed a request to revoke consent."*
>
> **"Please stop all messages" is unambiguously a valid revocation under federal law and Telnyx will not catch it.** CTIA independently lists *"please opt me out"* as an opt-out that should be honoured. **We must run our own free-text revocation detection on every inbound message.** This is the single most important engineering finding in this document.
>
> **Gap 2 — Two FCC per-se keywords are missing.** `revoke` and `opt out` are in the FCC's per-se list and are **not** in Telnyx's default list. Add them via Advanced Opt-In/Out **and** in our own detector.
>
> **Gap 3 — Wrong scope boundary.** Telnyx block rules operate at the **messaging profile** level. The TCPA operates at the level of the **caller/sender** (and from 31 Jan 2027, across all message categories from that sender). If one client's brand spans two messaging profiles, an opt-out on one does not suppress the other. **Our suppression list must be keyed on `(phone, brand_id)`, not on the Telnyx messaging profile.**
>
> Also note: opt-in re-subscription requires the consumer to text `START` **to the exact same number** they opted out from. With number pooling this is often not knowable to the consumer. Our application should handle re-subscription itself rather than relying on this.

### 6.5 Error codes — what actually indicates carrier filtering

The brief asked about "30007-class errors" — that is **Twilio's** numbering. **Telnyx uses a different scheme.** The mapping:

| Telnyx code | Meaning | Twilio near-equivalent | What it actually tells you |
|---|---|---|---|
| **40002** | **Blocked as spam — Temporary** | 30007 | Carrier spam filter hit. *"Temporarily halt sending and reassess your recipients to ensure their consent."* |
| **40003** | **Blocked as spam — Permanent** | 30007 | **Originating number permanently blocked.** Escalate to Telnyx support. |
| **40015** | Blocked as spam — **internal** | — | Telnyx's own filter, not the carrier's. Different remediation: this is an AUP problem, not a carrier reputation problem |
| **40322** | **Blocked due to content** | 30007 | Content-level rejection. Points at the Acceptable Use Policy |
| **40009** | Invalid message body | 30044-ish | *"The message body doesn't align with certain carrier rules"* |
| **40017** | **AT&T 10DLC Spam Message Rejected** | — | AT&T specifically classified this content as spam |
| **40008** | Undeliverable | 30008 | Generic carrier rejection, reason not disclosed |
| **40010** | Unregistered 10DLC message | 30032 | Number not attached to a campaign |
| **40016** | **T-Mobile 10DLC sending limit reached** | — | **Brand daily cap exhausted.** Resets midnight PT. Not a failure — a scheduling signal |
| **40018** | **AT&T 10DLC sending limit reached** | — | Per-minute TPM exceeded for the campaign |
| **40011** | Too many requests | — | Upstream rate limit; *"flagging the message as SPAM"* |
| **40300** | **Blocked due to STOP message** | 21610 | Suppressed by Telnyx's opt-out list |
| **40305** | Invalid 'from' address | — | ⚠️ Also fires when number pooling + skip-unhealthy is on: *"Telnyx will remove numbers from the pool if we detect that **75% or more of messages are being marked as spam**"* |
| **40315** | **Unhealthy 'from' address** | — | *"failed a health check due to low deliverability or high spam rates"* — the earliest reputation warning we get |
| **40004** | Rejected by destination | 30006 | Recipient server declined |
| **40001** | Not routable | 30006 | Landline or non-messaging-capable |
| **40012** | Invalid destination number | 30003/30005 | Unowned, deactivated, or no credit |
| **40014** | Message expired in queue | — | Our send rate exceeded our throughput. **Not billed.** |
| **40329** | Toll-free number not yet verified | 30032 | Verification not submitted or pending |

Source: [Telnyx Messaging Error Codes](https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes)

**Billing gotcha, verbatim:** *"messages that fail due to the message failing off the Telnyx network will result in charges as they have left the Telnyx network."* Carrier-filtered messages are billed. Filtering costs money as well as reach.

### 6.6 What visibility Telnyx actually gives into filtering

**Honest assessment: enough to detect a problem, not enough to diagnose it.**

**What we get:**
- Discrete error codes distinguishing temporary vs permanent spam blocks (40002 vs 40003), carrier-side vs Telnyx-side (40002 vs 40015), and content vs reputation (40322 vs 40315)
- One carrier-attributed code: `40017` names AT&T explicitly
- Codes in Message Detail Records (MDRs) and `message.finalized` webhooks
- `40315` as a leading indicator of number-health degradation
- The 75% spam-marking threshold that pulls numbers from a pool — a concrete, quantified signal

**What we do not get:**
- **No carrier attribution on 40002/40003/40322.** We cannot tell whether T-Mobile, AT&T or Verizon filtered the message. Since each has different rules, this is a real diagnostic hole.
- **No reason string.** No indication of *which* content triggered the filter.
- **No pre-send scoring.** No dry-run or content-risk API.
- **No silent-filtering visibility.** The hardest case is a message accepted upstream, marked delivered, and never shown to the user. Nothing surfaces that.
- **No opt-out list retrieval yet.** Telnyx's doc still says *"Coming soon: You will soon be able to retrieve all phone numbers that are on the opt-out list."* `[Verify current status]` **This is precisely why we must own the suppression list.**

**Mitigation:** infer carrier from the destination number's carrier lookup at send time and store it on `message_events`, so that error codes can be attributed to a carrier retrospectively. Track delivery rate per carrier per campaign per day as a leading indicator.

---

## 7. Deliverability engineering

### 7.1 URL shorteners

**AT&T Code of Conduct (1 Mar 2021), verbatim — this is a prohibition, not a discouragement:**

> *"The practice of using public URL shorteners in bulk Messaging is prohibited"*
> *"Messages must not contain URLs that redirect to landing websites that do not unambiguously identify the website owner"*

This was a **hardening**. The June 2020 AT&T text said public shorteners were *"highly discouraged, and messages containing them may be subject to blocking."* March 2021 changed it to *prohibited*. **Treat public shorteners as a hard block on AT&T, not a risk factor.**

**T-Mobile Code of Conduct §4.7 "URL Cycling", verbatim:**

> *"The practice of using multiple FQDNs (i.e. host.domain) in bulk messaging with similar message content...is prohibited."*

T-Mobile's stance on public shorteners is "highly discouraged"; the operative trap is the **URL cycling** ban — rotating short domains to dodge filters is explicitly prohibited and rolls up under Long Code Program Evasion ($1,000/violation).

**CTIA MPBP § 5.3.2 — the definitional standard, verbatim:**

> *"Where a web address (i.e., Uniform Resource Locator (URL)) shortener is used, Message Senders should use a shortener with a web address **and IP address(es)** dedicated to the exclusive use of the Message Sender. Web addresses contained in messages as well as any websites to which they redirect should unambiguously identify the website owner (i.e., a person or legally registered business entity) and include contact information, such as a postal mailing address."*

⚠️ **Note "and IP address(es)."** A branded CNAME pointing at a shared shortening service's shared IP pool arguably does not satisfy § 5.3.2 as written. Nobody enforces this today, but it is what the standard says.

**Telnyx's own guidance:**
> *"Avoid using generic or public URL shorteners (bit.ly, tinyurl, etc.) — these are frequently flagged by carrier filters and are a major source of message blocking"*
> *"If you need short links, use a branded short domain (e.g., yourbrand.co) rather than a public shortener"*
> *"Ensure all linked pages are live, accessible without login, and consistent with your registered use case"*

**Bitly concedes the problem itself:** *"Many mobile carriers block text messages that include links shortened with publicly-accessible link shorteners. Links with the bit.ly domain may be marked as spam."*

**Dedicated short domain mechanics** (Twilio's implementation, as the best-documented reference): domain must be *"Proprietary – a dedicated custom domain that belongs to your business"* and *"properly branded – the domain aligns with the message sender identified in the text message itself"*; must be *"only used for Link Shortening"*; verified by DNS record or HTML file upload; CNAME for subdomains, CNAME-flattening or A records for roots; TLS certificate required.

**Concrete deny-list** (26 domains, from [Text-Em-All](https://support.text-em-all.com/article/572-sending-urls-in-text-messages)) — usable as a hard block at message-submit time:

```
9qr.de, alturl.com, app.link, bc.vc, bit.do, bit.ly, bitly.com, bitly.ws,
budurl.com, clicky.me, cutt.ly, is.gd, lc.chat, linki.la, lnkd.in, minm.xyz,
ow.ly, rb.gy, rebrand.ly, s2r.co, serveirc.com, shrtco.de, soo.gd, t.ly,
tiny.cc, tinyurl.com
```

Note `rebrand.ly` and `bitly.ws` are on the list — **the free tier of a branded-link vendor is still a shared domain.**

> ### Commonly-asserted "rules" that DO NOT survive verification
> Mark these as internal heuristics, never cite them as rules:
> - **"The short domain must be registered with the 10DLC campaign."** `[UNVERIFIED]` — no such field or requirement in Twilio's link-shortening docs or either carrier CoC.
> - **"Domain must be N days old."** `[UNVERIFIED]` — no figure in any source. Any specific number is folklore.
> - **"Free/cheap TLDs (.xyz, .top, .link, .info) get filtered."** `[UNVERIFIED]`, with **counter-evidence**: Twilio's own link-shortening walkthrough uses `twilio.midshipman.xyz` as its worked example.
> - **"The link must be on the same domain as the campaign's registered website."** `[UNVERIFIED]` as a rule. The nearest documented standard is *identifiability* (AT&T: "unambiguously identify the website owner"), not domain equality.

### 7.2 Cloaking, redirect chains, link hygiene

**T-Mobile:** URLs that redirect more than once *"can hide the real website destination from the consumer, possibly resulting in a fraudulent destination."*

**AT&T** frames it as destination identity, and applies the same logic to phone numbers: *"Messages must not contain phone numbers that are assigned to or forward to unpublished phone numbers."*

**What "cloaking" means to a carrier is filter evasion, not marketing cloaking.** AT&T: *"Sending mechanisms designed to evade spam controls are prohibited."* AT&T additionally prohibits **automatically supplying replacement phone numbers when originals get blocked**.

> ⚠️ **If our platform has automatic failover-number logic, it is a compliance hazard.** AT&T prohibits it explicitly; T-Mobile prices it at $1,000 under "non-approved number replacement". **Remove it or gate it behind explicit human authorisation.**

**File-sharing links** — empirical, from a provider's blocked-URL observations: Google Drive links and Google Sites links are currently blocked; **Google Docs links work**. Dropbox: `[UNVERIFIED]`.

**Raw IP-address URLs and embedded-credential URLs (`user:pass@host`):** `[UNVERIFIED]` — no carrier or aggregator doc addresses either. Both are near-certainly filtered in practice. **Block them on security grounds, do not cite a compliance rule you cannot produce.**

### 7.3 Content, templating, and the spintax question

**Snowshoeing is defined identically across all three primary sources — and note it is defined by number spread, not content:**

- **T-Mobile CoC § 4.3:** *"Snowshoe sending is defined as a technique used to spread messages across many source phone numbers, specifically to dilute reputation metrics and evade filters."*
- **AT&T CoC:** *"Snowshoe sending is a technique used to send Messages from more source phone numbers than are needed to support an application's function."*
- **CTIA MPBP § 5.5.2:** *"Message Senders should not engage in Snowshoe Messaging, which is a technique used to spread messages across many sending phone numbers or short codes."*
- **Twilio Messaging Policy:** *"Spreading similar or identical messages across multiple phone numbers with the **intent or effect** of evading unwanted messaging detection and prevention mechanisms, also known as snowshoeing"* is prohibited.

⚠️ **Twilio's "intent or effect" phrasing means there is no good-faith defence. Accidental snowshoeing is still snowshoeing.**

**Documented content triggers:** *"Emojis, excessive punctuation, or CAPS"*; *"Misspellings or poor grammar"*; *"obfuscated links or suspicious redirects"*. Named trigger tokens from aggregator guidance: `"gift"` alongside a `$` symbol, `"CBD"`, `"10% off"`, `"free offer"`, aggressive language and hyperbole. *(secondary)*

**The spintax question — direct answer.**

**No carrier or CTIA document describes content fingerprinting mechanics, or endorses or prohibits content variation.** Filtering algorithms are deliberately undocumented. But the risk is inferable from documented text. The distinction that matters:

| | |
|---|---|
| **Legitimate** | Genuine personalisation — recipient name, order number, appointment time — that varies because the underlying data varies |
| **Evasion** | Synthetic variation — synonym rotation, invisible characters, random padding — applied to an otherwise-identical body for the purpose of defeating fingerprinting |

The second falls squarely inside AT&T's *"sending mechanisms designed to evade spam controls are prohibited"* and T-Mobile § 4.7's ban on cycling with *"similar message content"*, even though "spintax" is never named.

> **Treat spintax as a filtering signal and a policy risk, not a mitigation.** The documented remedy for volume filtering is registration and trust score, not obfuscation. **The wizard must not offer a "vary my message to improve deliverability" feature.**

### 7.4 Sender identification

**In the messages themselves.** Twilio Messaging Policy is the clearest operative rule:

> *"Except for follow-up messages to an ongoing conversation, every message that you send via the Twilio Messaging Services must clearly identify you"*

**Every message must identify the sender, except continuation messages within an active conversation.** Not "first message only", and not "marketing only". Telnyx's own best-practice list agrees: *"Clearly identify your brand in each message."*

**CTIA MPBP § 5.1.1** requires the CTA disclose *"the specific identity of the organization or individual being represented in the initial message"*.

**Required elements — CTA vs. in-message.** This is where most people go wrong, so the distinction is set out precisely:

| Element | Required in the opt-in CTA | Required in the opt-in confirmation message | Required in every marketing message |
|---|---|---|---|
| Program/brand name or product description | Yes | Yes | Brand identification, yes |
| Telephone number(s)/short code(s) messages will come from | Yes | — | — |
| Message frequency disclosure | Yes (recurring programs; not required for single-message programs) | Yes | No |
| "Standard message and data rates may apply" | Yes — **non-FTEU only** | Yes — **non-FTEU only** | No |
| "Reply STOP to opt out" | Yes (may appear in T&C) | Yes | Periodically — see below |
| "Reply HELP for help" | Yes | Yes (customer care contact) | No |
| Customer care contact | — | Yes | — |
| Terms & Conditions link (**not a pop-up**) | Yes | — | — |
| Privacy policy link | Yes | — | — |
| Consent not a condition of purchase | Yes | Recommended | — |

**Important correction on "Msg&data rates may apply".** **The CTIA MPBP does not mandate that literal string.** §§ 5.1.1 and 5.1.2 both use the broader formulation *"clear and conspicuous language about any associated fees or charges."* The verbatim phrase is a convention inherited from the CTIA Short Code Monitoring Handbook and enforced downstream by aggregators and TCR reviewers — **so use it anyway**, because TCR decline code 806 fires on its absence. But know why.

**CTIA § 5.1.2 — the opt-in confirmation message must include**, verbatim: *"(1) the program name or product description; (2) customer care contact information (e.g., a toll-free number, 10-digit telephone number, or HELP command instructions); (3) how to opt-out; (4) a disclosure that the messages are recurring and the frequency of the messaging; and (5) clear and conspicuous language about any associated fees or charges and how those charges will be billed."*

**STOP language cadence:** aggregator guidance says STOP language must appear **at least once every 30 days**. `[UNVERIFIED against a primary source]` but a safe implementation default, and it also satisfies the FCC's no-exclusive-means posture if paired with other channels.

### 7.5 Throughput pacing, warm-up and number rotation

**Two independent throughput models must both be implemented.** They cannot be collapsed into one abstraction:

- **T-Mobile:** per-**brand daily cap**, shared across every campaign under the EIN and across SMS+MMS, resetting midnight Pacific. Exhaustion returns `(4)780` / Telnyx `40016`.
- **AT&T:** per-**campaign TPM** (message parts per minute). Exhaustion returns Telnyx `40018`.
- **Verizon:** per-**TN** — reportedly SMS 6,000 TPM, MMS 25 TPS, *"measured at the TN level"* per Bandwidth. `[Bandwidth-sourced; Telnyx says Verizon publishes nothing]` ⚠️ conflict — treat Verizon as content-filtered rather than rate-limited.

**`(4)780` / `40016` is not a failure. It is a "cap exhausted" signal.** Queue to next midnight PT rather than retrying same-day.

**Number rotation and pooling — the official position is unambiguous, and it is worth being blunt.** **Spreading volume across numbers to increase throughput is the textbook definition of the violation.** Telnyx confirms rotation does not even work: *"This MPS limit is shared across all numbers attached to your Campaign and all wireless Carriers. The same MPS limit applies whether you send all traffic through one number or split it up across multiple numbers."*

AT&T additionally requires **single stable routing**: *"Each 10DLC or short code must have a single route (i.e., ordered sequence of Service Providers, Aggregators and Inter-Carrier Vendors)"*, with rerouting permitted for outages but *"MUST not occur to circumvent accidental or intentional spam blocking."*

Both carriers ban **shared** codes — T-Mobile § 4.6: *"Shared 10DLC, shortcodes, and Toll-Free numbers are prohibited."* AT&T: *"Shared 10DLC or short codes are prohibited, although AT&T reserves the right to grant an exception."*

T-Mobile *"actively monitors and reserves the right to disable campaigns upon discovery"* (§ 4.3).

> **The legitimate path to higher throughput is brand vetting to raise the trust score. Not more numbers. There is no other path.**

**Warm-up guidance is weakly evidenced.** **No carrier or CTIA document prescribes a warm-up schedule.** Vendor guidance only: *"Gradually ramp traffic for new campaigns"*, *"Avoid massive first-day sends"*, *"Avoid frequent number switching"*, *"Maintain consistent sending behavior"* — with no numbers. One secondary source suggests *"each long code phone number should stay under 15 to 60 messages per minute and under 200 unique recipients a day"* — **single source, uncorroborated, and plainly inconsistent with T-Mobile's brand caps, which permit far more.** Treat as a conservative heuristic, never as a carrier limit.

**Our own default (an internal heuristic, labelled as such):** ramp a new campaign over 7–14 days — day 1 at ~5% of intended daily volume, doubling every 2 days, holding at each step if delivery rate drops below 95% or opt-out rate rises.

### 7.6 Segmentation, encoding and other factors

| Encoding | Single segment | Concatenated (per segment) | Max total |
|---|---|---|---|
| GSM-7 | 160 | 153 | 1,600 |
| UCS-2 (any emoji, accented or non-Latin character) | 70 | 67 | 700 |

The 7-byte User Data Header consumes payload in concatenated messages, which is why 160 becomes 153 and 70 becomes 67. Telnyx supports up to **10 segments** before rejecting for length (`40302`, `40328`).

**Does emoji-forced UCS-2 hurt?** It hurts on **cost and segment count** — a single emoji cuts capacity by 56% and can turn a one-segment message into three, tripling carrier surcharges and consuming three times the T-Mobile daily cap. On *filtering*, the documented trigger is *"excessive"* emoji, not the encoding. `[UNVERIFIED]` that UCS-2 per se increases filtering.

> **The wizard must show live segment count and per-carrier cost as the user types.** A copywriter adding one emoji to a 155-character message and tripling the client's bill is the most common avoidable failure in SMS marketing.

**Opt-out rate thresholds:** `[UNVERIFIED — no numeric threshold is published by any carrier, CTIA, or aggregator source.]` Guidance is qualitative: high opt-out rates from unrecognised sender numbers trigger flags; monitor opt-out spikes campaign by campaign. **If you have seen "1–3%" quoted, it is not attributable to a published source.** Set our own internal alerting thresholds and label them as ours.

**Unknown/invalid number rates as a filtering input:** `[UNVERIFIED]` — no source found. List hygiene is still worth doing for cost reasons alone (40012 is billed).

---

## 8. Compliance-guardrail spec for the AI wizard

This is written to be implemented directly. Three enforcement levels:

| Level | Behaviour | Override |
|---|---|---|
| **HARD BLOCK** | Refuse. The action does not happen. Log the attempt. | **None.** Not by the user, not by an admin, not by a flag. |
| **WARN** | Show the risk, require explicit acknowledgement, record who acknowledged and when. | User acknowledgement, logged. |
| **SIGN-OFF** | Queue for a named human compliance reviewer. Cannot proceed on the user's own authority. | Named reviewer, logged, with reason. |

### 8.1 HARD BLOCK — onboarding and campaign registration

| # | Check | Trigger | Why |
|---|---|---|---|
| B1 | **Cannabis / CBD / hemp** anywhere in brand name, website, campaign description, or sample messages | regex below | TCR decline 701; T-Mobile $1,000 tier; universally banned |
| B2 | **Firearms / ammunition** sales (educational content is permitted — sales are not) | regex below | TCR decline 702; Telnyx "strictly prohibited" |
| B3 | **Adult / sexual services** | regex below | TCR decline 703 |
| B4 | **Gambling / sportsbook / casino** on 10DLC | regex below | TCR decline 704 |
| B5 | **Payday / high-interest lending, debt collection, debt relief, credit repair** | regex below | TCR decline 709; Telnyx Restricted Business Models |
| B6 | **Third-party lead generation, affiliate marketing, list rental, SEO/link-building outreach** | regex below | TCR decline 708; CTIA § 5.1.4 |
| B7 | **Crypto/ICO promotion, stock alerts, day-trading signals, "guaranteed returns"** | regex below | TCR decline 709; Telnyx Restricted Business Models |
| B8 | **MLM / work-from-home / get-rich-quick** | regex below | Universally banned |
| B9 | **Prescription drug promotion; unapproved substances; research chemicals; peptides; SARMs** | regex below | Telnyx "substances not legally approved for sale"; T-Mobile "Illegal Prescriptions" $1,000 tier; FDA § 505(a) exposure. **See §2.5 — for Vici Peptides this is enforced as a content block on marketing copy, with the account itself under a documented exception** |
| B10 | **Consent checkbox pre-checked** in the client's opt-in form | form scrape / declared config | 47 CFR § 64.1200(f)(9) — invalidates PEWC for every contact collected |
| B11 | **SMS consent bundled** with email/phone consent or with T&C acceptance | form scrape / declared config | Telnyx: *"opt-in language must be specific just for text messages"*; TCR decline 611 |
| B12 | **SMS consent mandatory** to submit the form | form scrape | § 64.1200(f)(9)(i)(B) — consent may not be a condition of purchase |
| B13 | **Privacy policy URL missing, 404, or behind a login** | HTTP check | TCR declines 804, 805, 852 |
| B14 | **T&C URL missing, 404, or presented only as a pop-up** | HTTP check + config | TCR decline 806; Telnyx: *"Popups are not a method for displaying terms and conditions"* |
| B15 | **Privacy policy lacks the third-party SMS data clause** | text match on the fetched policy | TCR declines 805, 852. Must cover **sharing**, not only **selling** |
| B16 | **Sole-proprietor registration where the legal name or website contains a disqualifying term** | §1.6 term list | TCR decline 801 |
| B17 | **Use case declared as Low Volume Mixed while projected volume ≥ 6,000/month** | declared volume | Telnyx: false use-case declaration draws *"hefty fines"* |
| B18 | **Marketing content declared under a non-marketing use case** | classifier on sample messages vs use case | TCR decline 602 — the single most common rejection |
| B19 | **Brand registered under our EIN rather than the client's** | field check | §3.5 — fines attach to the registered EIN |
| B20 | **Agency/reseller registering a brand in its own name on behalf of a client** | field check | TCR decline 710 |

### 8.2 HARD BLOCK — message send time

| # | Check | Trigger |
|---|---|---|
| B21 | **Recipient is on the suppression list** for `(phone, brand_id, scope)` | DB lookup, synchronous, before every send. Never cached beyond the request. |
| B22 | **Quiet hours** — outside 08:00–21:00 recipient local time (08:00–20:00 for FL, OK, OR area codes and any recipient with a known address in those states) | Area-code → timezone map, with per-state override table |
| B23 | **Public URL shortener** present in the body | Domain deny-list (§7.1), extended with any host whose registrable domain is not on the brand's allow-list |
| B24 | **No sender identification** in a message that is not a reply within an open conversation window | Brand name / registered DBA must appear in the body |
| B25 | **Prohibited-content term** in the body (per the brand's vertical ruleset) | Regex + classifier |
| B26 | **Message exceeds 10 segments** | Segment calculator |
| B27 | **Send to a number with no `consent_event_id`** — i.e. no provable consent record | Referential integrity: `message_events.consent_event_id NOT NULL` |
| B28 | **Send from a number not assigned to an approved campaign** | Campaign status check |
| B29 | **Exclusive-opt-out language** — copy stating STOP is the only way to opt out | Regex (§8.5) — violates § 64.1200(a)(10) |
| B30 | **Numeric or non-standard opt-out substitution** ("Reply 2 to unsubscribe") | Regex |
| B31 | **Second message after a revocation**, other than the single permitted confirmation | Suppression + confirmation-sent flag |
| B32 | **Marketing content in a revocation confirmation message** | § 64.1200(a)(12) — content classifier on confirmation templates |

### 8.3 WARN — acknowledge and log

| # | Condition | Message to the user |
|---|---|---|
| W1 | Alcohol, tobacco, vape, or nicotine content | Age-gate required; **Telnyx prohibits tobacco/vape outright** and permits alcohol only conditionally. Aggregators disagree — see §9. Requires SIGN-OFF, not just a warning, if the brand's primary business is in this category |
| W2 | Message contains an emoji or non-GSM-7 character | Segment count and cost impact shown live; "this message is now N segments and costs $X more per recipient" |
| W3 | Message > 160 characters | Segment count shown |
| W4 | ALL CAPS words, ≥3 consecutive punctuation marks, or ≥3 emoji | Documented filtering triggers |
| W5 | Spam-trigger tokens present (`free`, `winner`, `guaranteed`, `act now`, `$` adjacent to `gift`, `100% free`, `risk free`, `limited time`) | Elevated filtering risk |
| W6 | More than one URL in the body | Elevated filtering risk |
| W7 | Link domain differs from the brand's registered website domain | `[UNVERIFIED as a rule]` but a documented identifiability standard (AT&T). Flag, do not block |
| W8 | Projected send would exceed 60% of the T-Mobile brand daily cap | Cap is shared across all campaigns under the EIN |
| W9 | New campaign sending > 5% of projected daily volume in its first 48 hours | Warm-up heuristic (ours, labelled as such) |
| W10 | Campaign has had no traffic for 10 days | Telnyx auto-suspends at 15 days to avoid T-Mobile's $250/month dormancy fine |
| W11 | Delivery rate for a campaign drops below 95%, or opt-out rate exceeds our internal threshold | `[No published carrier threshold exists]` — this is our number, labelled as ours |
| W12 | Error `40315` (unhealthy from-address) or `40002` seen in the last 24h | Leading indicator of reputation damage |
| W13 | Recipient's last inbound message was > 12 months ago | Consent staleness — not a legal rule, a litigation-risk heuristic |
| W14 | Campaign resubmission attempt | Each resubmission costs $15 |
| W15 | Message would be sent between 20:00–21:00 local | Legal under federal law, prohibited in FL/OK/OR. Flag even for non-FL/OK/OR recipients, since area code is only a proxy for location |

### 8.4 SIGN-OFF — named human compliance reviewer required

| # | Condition | Why a human |
|---|---|---|
| S1 | Onboarding any brand in a vertical marked **R** or **conditional** in §9 | Aggregator sources disagree; needs a judgement call and a written record of it |
| S2 | Alcohol, tobacco, vape, nicotine, or firearms-adjacent brand | See W1. Requires verified age-gate evidence (a DD/MM/YYYY date-of-birth gate, per TCR decline code 706 — **not** an "Are you over 21?" button) |
| S3 | Any healthcare, telehealth, pharmacy, or supplement brand | The rule attaches to the *drug*, not the licence; the line between permitted clinical messaging and prohibited drug promotion is a judgement |
| S4 | Political campaign | Campaign Verify token must be verified as present and current. **Since 17 Feb 2026 this applies to toll-free and short code too** |
| S5 | Charity/nonprofit fundraising | `[UNVERIFIED]` vertical — no primary source obtained |
| S6 | Any campaign whose message flow relies on **verbal** consent for a marketing use case | Requires a documented double opt-in (verbal + SMS confirmation reply) per Telnyx |
| S7 | Any first send to a list imported from outside the platform | Consent provenance cannot be validated by the system; a human must attest to it |
| S8 | Any list import larger than 10,000 contacts | Blast-radius control: this is the shape of a $25M TCPA exposure |
| S9 | Any change to a brand's vertical ruleset or content deny-list | Prevents a user disabling their own guardrails |
| S10 | Any campaign for Vici Peptides or any future peptide/research-chemical account | Ring-fenced exception per §2.5 |
| S11 | Any attempt to enable failover/replacement-number logic | AT&T prohibits it; T-Mobile prices it at $1,000 |
| S12 | Any template containing a health, medical, efficacy, dosage, or outcome claim | FDA/FTC exposure independent of carrier rules |

### 8.5 Regex triggers

Case-insensitive, Unicode-aware, applied after normalising homoglyphs, zero-width characters and leetspeak substitutions (`0`→`o`, `1`/`!`→`i`, `3`→`e`, `$`→`s`, `@`→`a`). **Evasion normalisation is not optional** — spam classifiers that skip it are trivially defeated and the evasion itself is a documented violation.

```regex
# --- REVOCATION DETECTION (highest priority; MUST run on every inbound message) ---
# Tier 1: FCC per-se keywords (whole message, whitespace/punctuation tolerant)
^\s*[\p{P}\p{S}]*\s*(stop\s*all|stopall|stop|quit|end|revoke|opt[\s\-]?out|cancel|unsubscribe|arret|arrête)\s*[\p{P}\s]*$

# Tier 2: free-text revocation — REQUIRED by 47 CFR 64.1200(a)(10),
#         NOT caught by Telnyx. Matches anywhere in the message.
\b(
  (please\s+)?(stop|quit|cease|halt)\s+(all\s+)?(the\s+)?(text|message|msg|sms|contact)\w*
  | (take|get)\s+me\s+off
  | (remove|delete)\s+me\s+(from|off)
  | (opt|sign)\s+me\s+out
  | (don'?t|do\s+not|no\s+more|never)\s+(text|message|msg|contact|send)\b
  | (i\s+)?(want\s+to\s+)?unsubscribe
  | (i\s+)?(do\s+not|don'?t)\s+(want|wish)\s+(to\s+receive|these|any)
  | leave\s+me\s+alone
  | lose\s+my\s+number
  | (withdraw|revoke)\w*\s+(my\s+)?consent
)\b
# Tier 2 matches MUST route to human review within one business day if not
# auto-suppressed. Default posture: auto-suppress, then review. Over-suppression
# costs a contact; under-suppression costs $500-$1,500 per subsequent message.

# --- HELP ---
^\s*(help|info|aide)\s*[\p{P}\s]*$

# --- EXCLUSIVE OPT-OUT LANGUAGE (BLOCK in outbound templates) ---
\b(only|sole|exclusive(ly)?)\s+(way|method|means)\s+to\s+(opt[\s\-]?out|unsubscribe|stop)
| \bmust\s+(reply|text)\s+stop\b
| \breply\s+stop\s+is\s+the\s+only\b

# --- NON-STANDARD OPT-OUT SUBSTITUTION (BLOCK) ---
\breply\s+(?!stop\b)(\d+|[a-z]{1,3})\s+to\s+(unsub|unsubscribe|opt[\s\-]?out|stop|cancel)

# --- CANNABIS / CBD / HEMP (BLOCK) ---
\b(cannabis|cannabinoid|marijuana|mari?juana|weed|ganja|dispensar\w+|thc|cbd|cbn|cbg
 |hemp|delta[\s\-]?[89]|delta[\s\-]?10|hhc|thca|edible\s+gumm\w+|pre[\s\-]?roll
 |flower\s+(strain|eighth|ounce)|indica|sativa|kush|blunt|bong|dab\s+rig|vape\s+cart)\b

# --- FIREARMS / AMMUNITION (BLOCK on sales; educational content is permitted) ---
\b(firearm|handgun|shotgun|rifle|pistol|revolver|ar[\s\-]?15|ak[\s\-]?47|glock
 |ammo|ammunition|magazine\s+(capacity|round)|silencer|suppressor|ffl\b
 |bump\s+stock|lower\s+receiver)\b

# --- ADULT (BLOCK) ---
\b(escort|porn\w*|xxx|adult\s+(content|entertainment|video|dating)|camgirl|onlyfans
 |sugar\s+(daddy|baby)|hookup|nsfw|nude[sz]?)\b

# --- GAMBLING (BLOCK on 10DLC) ---
\b(casino|sportsbook|betting|wager|parlay|odds\s+boost|slots?\s+(bonus|spin)
 |poker\s+(room|tournament)|roulette|blackjack|lottery|daily\s+fantasy|dfs\b
 |free\s+spins|deposit\s+match|bookmaker)\b

# --- HIGH-RISK FINANCIAL / DEBT / LENDING (BLOCK) ---
\b(payday\s+loan|cash\s+advance|title\s+loan|debt\s+(relief|settlement|consolidat\w+
 |forgiveness|collection)|credit\s+repair|erase\s+your\s+debt|tax\s+(relief|forgiveness)
 |wage\s+garnish\w+|bad\s+credit\s+ok|no\s+credit\s+check\s+loan)\b

# --- CRYPTO / SECURITIES PROMOTION (BLOCK) ---
\b(crypto\w*|bitcoin|btc\b|ethereum|eth\b|altcoin|ico\b|token\s+(sale|presale)
 |nft\b|airdrop|defi\b|yield\s+farm\w+|stock\s+(alert|pick|tip|signal)
 |day[\s\-]?trad\w+|forex\s+signal|guaranteed\s+return|\d+x\s+(gain|return))\b

# --- LEAD GEN / AFFILIATE / MLM (BLOCK) ---
\b(lead\s+gen\w*|affiliate\s+(program|link|marketing)|list\s+rental
 |buy\s+leads|sell\s+leads|mlm\b|multi[\s\-]?level\s+market\w+|downline
 |work\s+from\s+home\s+(opportunity|income)|be\s+your\s+own\s+boss
 |passive\s+income\s+(system|opportunity)|link[\s\-]?building|seo\s+(service|outreach))\b

# --- PRESCRIPTION / UNAPPROVED SUBSTANCES / RESEARCH CHEMICALS (BLOCK) ---
\b(semaglutide|sema\b|tirzepatide|tirz\b|retatrutide|reta\b|cagrilintide|mazdutide
 |liraglutide|glp[\s\-]?1|ozempic|wegovy|mounjaro|zepbound|saxenda
 |bpc[\s\-]?157|tb[\s\-]?500|cjc[\s\-]?1295|ipamorelin|sermorelin|tesamorelin
 |epitalon|melanotan|mt[\s\-]?2\b|pt[\s\-]?141|ghrp[\s\-]?[26]|hexarelin
 |kisspeptin|thymosin|selank|semax|dsip\b|aod[\s\-]?9604|mots[\s\-]?c
 |sarms?\b|ostarine|mk[\s\-]?2866|mk[\s\-]?677|ligandrol|lgd[\s\-]?4033
 |rad[\s\-]?140|testolone|cardarine|gw[\s\-]?501516|yk[\s\-]?11|s[\s\-]?23
 |anabolic|steroid|hgh\b|hcg\b|clenbuterol|clomid|nolvadex|tamoxifen
 |research\s+(chemical|peptide|compound)|not\s+for\s+human\s+consumption
 |prescription\s+(drug|med)|rx\s+(drug|med)|kratom|mitragyn\w+
 |adderall|xanax|oxycodone|tramadol|viagra|cialis|sildenafil|tadalafil)\b

# --- HEALTH / EFFICACY CLAIMS (SIGN-OFF; and BLOCK for any peptide/supplement brand) ---
\b(cure[sd]?|treat(s|ed|ment)?|prevent[s]?|heal[s]?|reverse[s]?|reduce[s]?\s+(fat|weight|pain)
 |lose\s+\d+\s*(lb|lbs|pound|kg)|burn\s+fat|boost\s+(metabolism|testosterone|immunity)
 |clinically\s+proven|fda[\s\-]?approved|doctor\s+recommended|scientifically\s+proven
 |anti[\s\-]?aging|muscle\s+(gain|growth)|appetite\s+suppress\w+
 |blood\s+sugar|insulin|weight\s+loss)\b

# --- PUBLIC URL SHORTENERS (BLOCK) ---
\bhttps?://(www\.)?(9qr\.de|alturl\.com|app\.link|bc\.vc|bit\.do|bit\.ly|bitly\.com
 |bitly\.ws|budurl\.com|clicky\.me|cutt\.ly|is\.gd|lc\.chat|linki\.la|lnkd\.in
 |minm\.xyz|ow\.ly|rb\.gy|rebrand\.ly|s2r\.co|serveirc\.com|shrtco\.de|soo\.gd
 |t\.ly|tiny\.cc|tinyurl\.com|goo\.gl|t\.co|buff\.ly|shorturl\.at|shorte\.st)/

# --- RAW IP / CREDENTIALED URL (BLOCK — security grounds, not a cited rule) ---
https?://(\d{1,3}\.){3}\d{1,3}(:\d+)?/
https?://[^/@\s]+:[^/@\s]+@

# --- SPAM-TRIGGER TOKENS (WARN) ---
\b(free\s+(gift|offer|money|trial)|100%\s+free|risk[\s\-]?free|act\s+now|limited\s+time
 |winner|you'?ve\s+won|congratulations\s+you|claim\s+your|urgent|final\s+notice)\b
\$\s*\d+.{0,20}\bgift\b
[A-Z]{6,}                      # shouty run
[!?]{3,}                       # excessive punctuation
(\p{Emoji_Presentation}.*){3,} # 3+ emoji
```

### 8.6 The privacy-policy clause the system must verify

Fetch the client's privacy policy URL and require **all three** conditions, or HARD BLOCK (B15):

1. Reachable, HTTP 200, no login wall, not a generic third-party template.
2. Contains language covering **both** selling and sharing. "We do not sell your information" alone is insufficient — Telnyx: *"if it only says data won't be 'sold,' that is insufficient. It must also cover 'sharing' (e.g., transfers between affiliates)."*
3. Contains an SMS-specific carve-out. Telnyx's accepted wording: *"All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties."* or *"We will not share your opt-in to an SMS campaign with any third party for purposes unrelated to providing you with the services of that campaign."*

### 8.7 Required message templates the wizard must generate and lock

Per Telnyx's mandated format ([10DLC Keywords and Confirmation Messages](https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages)):

```
Opt-in confirmation:
  [Brand]: Thanks for subscribing to [use case]! Reply HELP for help.
  Message frequency may vary. Msg&data rates may apply.
  Consent is not a condition of purchase. Reply STOP to opt out.

Opt-out confirmation:
  [Brand]: You are unsubscribed and will receive no further messages.
  (NO marketing content — 47 CFR 64.1200(a)(12). Send within 5 minutes.)

HELP:
  [Brand]: Please reach out to us at [toll-free number or support email] for help.
```

**Compliant opt-in form spec** (HARD BLOCK if any element is missing):
- Phone field; SMS consent checkbox **unchecked by default**, **optional**, **separate** from T&C acceptance, and **not** buried in terms
- Disclaimer containing: brand name · use case(s) · "Message frequency may vary" · "Standard Message and Data Rates may apply" · "Reply STOP to opt out" · "Reply HELP for help" · "We will not share mobile information with third parties for promotional or marketing purposes"
- Working links to privacy policy and T&C (**not** pop-ups)
- Marketing campaigns additionally: explicit marketing-consent language and "Consent is not a condition of purchase"
- Form must not sit behind a login wall

### 8.8 Audit-log fields needed to defend a TCPA claim

See the schema in §5.6. The minimum defensible record, restated as a checklist:

- [ ] `disclosure_text` — the **verbatim** copy shown at the moment of consent, with a version hash
- [ ] `occurred_at` (UTC, with source clock recorded)
- [ ] `ip_address` and `user_agent`
- [ ] `source_url` and `form_id`
- [ ] `affirmative_action` — what the consumer actually did
- [ ] `consent_type` (express written / express / implied) and `consent_scope` (marketing / transactional / all)
- [ ] `screenshot_uri` — immutable capture of the opt-in experience, also required by TCR
- [ ] `identity_asserted` — name, email, or username given at opt-in
- [ ] `campaign_id` and `brand_id` — CTIA: consent applies only to the campaign for which it was obtained
- [ ] Per outbound message: `consent_event_id`, `body_rendered` (exact bytes), `template_id` + `template_version`, `suppression_checked_at`, `recipient_local_time`, `recipient_tz_source`
- [ ] Per revocation: `revocation_raw_text`, `revocation_method`, `revocation_matched_by`, `honored_at`, `confirmation_sent_at`
- [ ] Append-only with `prev_hash` / `row_hash` chaining — **this is what converts "our records say" into "our records provably say"**
- [ ] Retention ≥ 5 years, never purged on contact deletion
- [ ] Daily consumption of a deactivated/reassigned-numbers file (CTIA § 5.1.5)

### 8.9 Things the wizard must never offer

These are worth stating as product constraints because each is a plausible feature request:

1. **Message variation / spintax "to improve deliverability."** It is filter evasion (§7.3).
2. **Number rotation to raise throughput.** It is snowshoeing, it is fined at $1,000, and per Telnyx **it does not even work** — MPS is shared across all numbers on a campaign.
3. **Automatic failover to a replacement number when one is blocked.** Explicitly prohibited by AT&T.
4. **"Reply 2 to unsubscribe"** or any non-STOP opt-out substitution.
5. **Copy stating STOP is the only way to opt out.** Violates § 64.1200(a)(10)'s no-exclusive-means rule.
6. **Suppression-list export/import that can remove entries.** Suppression must be append-only and one-way.
7. **A "resend to non-responders" that ignores suppression.**
8. **Bulk import with an "assume consent" option.** No such thing exists.

---

## 9. High-risk verticals — addressability matrix

**Status key:** **P** = prohibited outright · **R** = restricted, permitted with conditions · **OK** = permitted normally · **?** = no primary source found

| # | Vertical | Status | Conditions / notes | Channel differences | Named by |
|---|---|---|---|---|---|
| 1 | **Cannabis, dispensaries, delivery** | **P** | No exception for state-legal, transactional, or 2FA. TCR 701 auto-rejects, *"including shipping services"* | None — 10DLC, toll-free, short code alike | Telnyx, Twilio, Bandwidth, Plivo, Dialpad; T-Mobile CoC (2nd-hand) |
| 2 | **CBD, hemp, delta-8/9** | **P** | Bandwidth extends the ban to the **brand's website**, not just the messages | Same across all channels | Telnyx, Twilio, Bandwidth, Dialpad |
| 3 | **Kratom** | **P** | Named only in Twilio's list `[SECONDARY-SOURCED]` | — | Twilio |
| 3b | **Supplements / nutraceuticals (lawful dietary)** | **OK** | Not named as prohibited anywhere. **But fails Bandwidth-style brand review if the site also sells SARMs, CBD, or unapproved peptides** | — | none — negative finding |
| 3c | **Research peptides / SARMs / research chemicals** | **P in effect** | **Named by nobody**, caught by catch-all clauses. See §2.3–2.5 for the full assessment | Toll-free is not an escape hatch | Telnyx catch-all; Plivo names "steroids"; T-Mobile "Illegal Prescriptions" |
| 4 | **Vape / e-cig / tobacco / nicotine** | **P** at Telnyx, Twilio, Dialpad; **R** at Bandwidth | ⚠️ **Genuine conflict.** Bandwidth: *"can be supported with robust age-gating and proper opt-in."* Telnyx: *"strictly prohibited."* Nicotine pouches named by nobody | — | all four disagree |
| 5 | **Alcohol** | **R** | Age verification required. TCR 706 requires a **DD/MM/YYYY date-of-birth gate**, not an "Are you over 21?" button. Telnyx: *"policies vary by carrier."* Canada stricter | — | Telnyx, Bandwidth, Twilio |
| 6 | **Firearms, ammo, FFL** | **P** | No conditional path at any aggregator, despite being an age-gateable SHAFT letter. TCR 702: *"Educational content is acceptable if it does not engage in sales"* | — | Telnyx, Bandwidth, Plivo |
| 7 | **Gambling / sportsbook / casino** | **P** on 10DLC | Telnyx: *"Some exceptions may exist for approved short code programs, but these require prior carrier approval"* | ⚠️ **The one real channel split.** Sweepstakes reportedly allowed **on short code only** `[conflicting sources]` | Telnyx, Plivo, Dialpad, Twilio |
| 7b | **Sweepstakes / contests** | **R** | TCR has a Sweepstakes use case at $10/mo, so 10DLC registration is possible. Dialpad groups it with prohibited gambling. **Conflict** | Short code safest | conflicting |
| 7c | **Bingo** | **R** | TCR 704: *"Bingo promotions may be allowed under certain conditions with age gating"* | — | Telnyx |
| 8 | **Debt collection / relief / credit repair** | **P** | ⚠️ **Conflict:** Plivo prohibits outright; a TCR-derived secondary claims third-party collectors *may* send opted-in transactional messages so long as SMS is not the collection channel itself. `[UNVERIFIED]` — **escalate to Telnyx in writing before onboarding** | — | Plivo, Telnyx, Dialpad; TCR 709 |
| 9 | **Payday / high-interest lending** | **P** | Bandwidth requires disclosure of *any* lending activity **even if the campaign is unrelated** — e.g. a dental practice offering in-house financing must declare it. Plivo distinguishes **"third-party"** brokers from direct lenders; TCR 712 requires direct lenders to self-identify as such | — | Telnyx, Plivo, Dialpad, Twilio |
| 10 | **Crypto / digital assets / NFT** | **P** | ⚠️ **Scope conflict:** Telnyx targets *"Cryptocurrency **schemes**, ICO promotions"* — narrower wording that arguably leaves room for a regulated exchange's 2FA. Plivo and Dialpad list "cryptocurrency" flat. NFTs named by nobody `[UNVERIFIED]` | — | Telnyx, Plivo, Dialpad, Twilio; TCR 709 |
| 11 | **Adult / escort-adjacent** | **P** | The "S" in SHAFT. No age-gating remedy exists anywhere. TCR 703 catches *"content appearing family-friendly but containing adult themes."* Mainstream dating apps are not named and generally operate | — | all |
| 12 | **Telehealth / clinical messaging** | **OK by inference** ⚠️ | **No source explicitly permits or bans it.** Healthcare messaging operates at scale on 10DLC (appointment reminders, results, care coordination), which is strong circumstantial evidence. **Mark as inference, not verified policy** | — | negative finding |
| 12b | **Prescription drug promotion / online pharmacy** | **P** | The rule attaches to the **drug**, not the sender's licence. Twilio-derived: *"Offers for any drug that cannot be sold over-the-counter in the US and Canada are forbidden"* | — | Telnyx, Plivo, Twilio |
| 12c | **Compounded GLP-1 (semaglutide/tirzepatide) DTC** | **P in effect** | Named by **no** carrier or aggregator. But FDA removed both from the shortage list, eliminating the legal basis for bulk compounding — so it now falls under *"substances that are not legally approved for sale."* **Highest-risk category in this table**: prescription-drug promotion + contested legal status + active FDA enforcement | — | inference from Telnyx catch-all + FDA |
| 13 | **MLM / work-from-home / get-rich-quick** | **P** | No exception | — | Plivo, Dialpad, Twilio |
| 14 | **Third-party lead gen / affiliate** | **P** | Bandwidth is clearest: *"the fundamental practice of sharing data to sell consumer information (leads) to third parties is a prohibited campaign type and will be rejected"* — with the carve-out that *"it's permissible for a business to share end-user data essential for business operations."* ⚠️ TCR 708: *"Any mention of lead generation or SEO on the website would lead to a decline"* | — | Bandwidth, Plivo, Dialpad, Twilio |
| 14b | **SEO / link-building outreach** | **P** | Named explicitly by Telnyx as a Restricted Business Model and by TCR 708 | — | Telnyx |
| 15 | **Political** | **OK, gated** | Campaign Verify token mandatory. Eligibility: *"Any candidate, party, PAC, or other committee that is a 527 tax-exempt organization and registered with the FEC or a State, Local, or Tribal Election Authority."* $95 per entity per 2-year cycle. Approval *"minutes to two business days"*, but postal-PIN delivery takes 5–10 business days | ⭐ **Since 17 Feb 2026, the token is required on short code and toll-free too** — previously 10DLC only | [campaignverify.org](https://www.campaignverify.org/) *(primary)* |
| 16 | **Charity / nonprofit fundraising** | **?** | **`[UNVERIFIED]`** — no primary source obtained. TCR does have a Charity use case at $3/mo, and 501(c)(3) fundraising is generally accepted, but I have no quote. Open questions: does TCR require proof of 501(c)(3) status, and do throughput/consent rules differ? | — | none |
| 17 | **Securities / stock alerts / day trading** | **P** | Telnyx names *"day-trading alerts, stock tips, or real-time market signals"* | — | Telnyx, Dialpad; TCR 709 |
| 18 | **Real estate / insurance** | **R** | Not prohibited, but TCR 807 specifically targets *"real estate and insurance companies using incomplete websites that don't allow business verification."* Website quality is the gating factor | — | Telnyx |

### 9.1 Which markets are actually addressable

Working backwards from the table, and being blunt about it:

**Genuinely addressable and worth pursuing:**
- **Political** — gated but *legitimately* gated. A known process, a known fee, a known lead time. The 17 Feb 2026 toll-free/short-code mandate created a compliance scramble that is a real wedge: there are political senders currently non-compliant on toll-free who need help. **This is the strongest high-risk vertical on the list.**
- **Telehealth and clinical messaging** — large, high-value, and the compliance burden (HIPAA + TCPA + carrier) is exactly the kind of thing a good compliance layer sells against. But **get Telnyx's position in writing first** — permission is inferred, not documented.
- **Alcohol** — the one SHAFT letter with a reliable conditional path, provided a real date-of-birth gate exists. Wineries, breweries, DTC spirits.
- **Real estate and insurance** — not high-risk in content terms at all; they fail on website quality. That is a solvable onboarding problem and a genuine differentiator.
- **Sweepstakes/contests on short code** — viable if we add short code, which is a different product.

**Not addressable, do not pursue:**
Cannabis · CBD/hemp · firearms · adult · gambling on 10DLC · crypto promotion · payday/debt · lead gen/affiliate · MLM · SEO outreach · prescription/pharmacy · research peptides. Every one of these is a documented prohibition somewhere in our own supply chain. Selling into them means selling a product we cannot deliver.

**Ambiguous — needs a written answer from Telnyx before any commitment:**
- **Debt collection** (opted-in transactional only) — commercially significant, genuinely unresolved
- **Vape/tobacco** — Bandwidth permits with age-gating, Telnyx prohibits. If we ever move upstream, the answer changes
- **Regulated crypto exchanges** (transactional/2FA only) — Telnyx's "schemes" wording is narrower than the flat bans elsewhere
- **Charity/nonprofit** — almost certainly fine, but entirely unverified

**The strategic read.** The compliance layer is the product; the high-risk vertical is not. Every genuinely prohibited vertical above is prohibited *by our own supplier*, which means we cannot serve it at any price and cannot fix it with better engineering. What we *can* sell is the thing that makes the **permitted-but-hard** verticals tractable: political, telehealth, alcohol, franchise/agent networks, and any business whose website is currently failing TCR review. That is a large market and none of it requires us to take on unpriced legal risk.

---

## 10. Open questions and pre-launch checklist

### 10.1 Must be resolved before launch

| # | Question | Owner | Why it blocks |
|---|---|---|---|
| 1 | **Telnyx's written position on research-peptide traffic** | Commercial | Determines whether Vici Peptides is a client or a liability. Ask directly; expect an unwelcome answer; get it anyway |
| 2 | **Check ECFS docket 02-278** for any FCC action Feb–Aug 2026 on consent revocation | Compliance | The revoke-all rule's final shape drives the suppression architecture |
| 3 | **Read the TCR CSP User Guide, April 2026** manually | Compliance | Settles identity statuses, full use-case list, sole-proprietor EIN question, specialty-review list |
| 4 | **Obtain the current T-Mobile and AT&T codes of conduct from Telnyx** under our partner agreement | Commercial | Public copies are T-Mobile v2.2 (Nov 2020) and AT&T (Mar 2021). Both are 5+ years old |
| 5 | **Confirm the T-Mobile fine schedule is unchanged since 2024** | Compliance | No 2025/2026 bulletin found confirming currency |
| 6 | **Re-pull all carrier per-message surcharges** post-Apr/May 2026 revisions | Finance | Four revisions in 2026; current published tables may be stale |
| 7 | **Confirm whether Telnyx has shipped opt-out list retrieval** | Engineering | Doc still says "coming soon"; affects reconciliation design |
| 8 | **Telnyx's written position on telehealth and on opted-in debt collection** | Commercial | Two commercially attractive verticals with no verifiable published answer |
| 9 | **Audit any existing political traffic on toll-free** for a Campaign Verify token | Compliance | The mandate took effect 17 Feb 2026; non-token traffic is already non-compliant |
| 10 | **Have TCPA counsel review §8** before it ships | Legal | This document is research; the guardrails are the thing that gets litigated |

### 10.2 Everything marked `[UNVERIFIED]` in this document

**Regulatory / legal:**
- FCC action in docket 02-278 between Feb and Aug 2026
- Whether the FCC ruled on the EIA quiet-hours petition
- New Jersey, Michigan, Pennsylvania mini-TCPA statutory text
- Whether NC HB 936, SC HB 3323, WA HB 1103 advanced in 2026 sessions

**10DLC mechanics:**
- The 2,000,000/day T-Mobile tier — **found in no source**
- T-Mobile tier score boundaries (75/50/25/1 vs 76/51/26/16)
- T-Mobile SBR fee ($5,000 vs $500)
- T-Mobile Number Pool Request fee ($50 vs $2,000)
- Sole-proprietor EIN requirement (Telnyx says no EIN; one secondary source says EIN now mandatory)
- Existence of a `SELF_DECLARED` brand identity status
- Whether `CONVERSATIONAL_MESSAGING` is a distinct TCR use-case code
- Exact figures for the Jan/Apr/May 2026 carrier fee revisions (published as images)
- Which specific use cases count as "specialty" for extended review
- Whether a screenshot (as opposed to a URL) is formally required as opt-in proof

**Deliverability:**
- Short domain registration with the campaign
- Minimum domain age
- Free-TLD filtering — **with active counter-evidence**
- Short domain matching the campaign's registered website domain
- Any numeric opt-out rate threshold
- Unknown/invalid number rate as a filtering input
- Raw-IP and embedded-credential URLs as documented violations
- Dropbox link filtering
- UCS-2 encoding itself as a reputational signal
- The "STOP language every 30 days" cadence
- An October 2025 CTIA MPBP revision — **the Oct 2025 CTIA doc is a different publication**

**Verticals:**
- Charity/nonprofit — entirely unverified
- Gambling state-by-state geo requirements
- Telehealth explicit permission — inferred only
- Compounded GLP-1, peptides, SARMs, research chemicals — named by zero carrier policies
- Delta-8/delta-9 as named categories
- NFTs as a distinct category
- A Verizon-published code of conduct
- AT&T's alleged $10,000 fine — **almost certainly a misattribution of T-Mobile's figure**

### 10.3 Re-check calendar

| Cadence | Items |
|---|---|
| **Monthly** | FCC docket 02-278; quiet-hours case law and the EIA petition; TCPA circuit split (§4.7) |
| **Quarterly** | Carrier per-message fees; TCR fee schedule; Telnyx forbidden-use-cases article; state mini-TCPA sessions |
| **Semi-annually** | Carrier prohibited-content lists; throughput tiers; CTIA MPBP edition; carrier codes of conduct |
| **Before every new vertical** | Written position from Telnyx compliance; the full §9 table for that vertical |
| **Before every client launch** | §8 guardrail checklist; opt-in form audit; privacy policy audit |

---

## Appendix — source index

### Regulator primary
- [47 CFR § 64.1200 (Cornell LII)](https://www.law.cornell.edu/cfr/text/47/64.1200) — note ecfr.gov bot-blocks automated fetches
- [47 U.S.C. § 227 (Cornell LII)](https://www.law.cornell.edu/uscode/text/47/227)
- [FCC 24-24 — TCPA Consent Order, 16 Feb 2024](https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf)
- [FCC DA-25-312 — 2025 Waiver Order, 7 Apr 2025](https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf)
- [FCC DA 26-12 — waiver extension to 31 Jan 2027, 6 Jan 2026](https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf)
- [Federal Register 2025-16641 — one-to-one deletion, eff. 29 Aug 2025](https://www.federalregister.gov/documents/2025/08/29/2025-16641/delete-delete-delete-targeting-and-eliminating-unlawful-text-messages-rules-and-regulations)
- [*McLaughlin Chiropractic v. McKesson*, No. 23-1226 (2025)](https://www.supremecourt.gov/opinions/24pdf/23-1226_1a72.pdf)
- [FDA Warning Letter — Summit Research Peptides, 10 Dec 2024](https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/summit-research-peptides-695607-12102024)

### Industry primary
- [CTIA Messaging Principles and Best Practices, May 2023](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf) — **current edition**
- [CTIA Messaging Security Best Practices, Oct 2025](https://api.ctia.org/wp-content/uploads/2025/10/Messaging-Security-Best-Practices-_October-2025.pdf) — separate, narrower document
- [T-Mobile Code of Conduct v2.2, Nov 2020](https://www.t-mobile.com/support/public-files/attachments/T-Mobile%20Code%20of%20Conduct.pdf)
- [AT&T Code of Conduct re 10DLC A2P, 1 Mar 2021](https://docs.intelepeer.com/Atmosphere/Content/Resources/Files/att_bulk_messaging_code_of_conduct_re_10dlc_a2p_messages__03.2.pdf)
- [AT&T Code of Conduct, 1 Jun 2020 (superseded)](https://sinch.github.io/docs/sms/sms-other/downloads/ATT_Code_of_Conduct_062020.pdf)
- [The Campaign Registry — Authentication Plus](https://www.campaignregistry.com/authentication-enhances-a2p-10dlc-security/)
- [Campaign Verify](https://www.campaignverify.org/)

### Telnyx
- [Acceptable Use Policy](https://telnyx.com/acceptable-use-policy)
- [Forbidden Messaging Use Cases in the US and Canada](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code)
- [10DLC Campaign Compliance Guide](https://support.telnyx.com/en/articles/16256133-10dlc-campaign-compliance-guide)
- [10DLC Campaign Compliance Requirements](https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements)
- [10DLC Carrier Error Codes Explanations](https://support.telnyx.com/en/articles/10547022-10dlc-carrier-error-codes-explanations)
- [Telnyx Messaging Error Codes](https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes)
- [10DLC Fees and Charges](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges)
- [Frequently Asked Questions about 10DLC](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc)
- [10DLC: Trust Scores & Use Cases](https://support.telnyx.com/en/articles/6325747-10dlc-trust-scores-use-cases)
- [10DLC rate limits (developer docs)](https://developers.telnyx.com/docs/messaging/10dlc/10dlc-rate-limits)
- [Campaign registration (developer docs)](https://developers.telnyx.com/docs/messaging/10dlc/campaign-registration)
- [SMS Opt-Out Keywords and Stop Words](https://support.telnyx.com/en/articles/1270091-sms-opt-out-keywords-and-stop-words)
- [Advanced Opt-In/Out Management](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out)
- [10DLC Keywords and Confirmation Messages](https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages)
- [10DLC Opt-in Form](https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form)
- [Guide to 10DLC Message Flow Field](https://support.telnyx.com/en/articles/10562019-guide-to-10dlc-message-flow-field)
- [Guide to Sole Proprietor 10DLC Registration](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration)
- [10DLC Campaign Suspended](https://support.telnyx.com/en/articles/10723378-10dlc-campaign-suspended)
- [Standards for US Short Code Keywords](https://support.telnyx.com/en/articles/9311492-standards-for-us-short-code-keywords-help-stop-and-opt-in-confirmation)
- [Messaging - 10DLC Campaign Checklist](https://support.telnyx.com/en/articles/9038141-messaging-10dlc-campaign-checklist)
- [10DLC Use Cases](https://support.telnyx.com/en/articles/10684248-10dlc-use-cases)

### Other aggregators
- [Bandwidth 10DLC FAQ](https://www.bandwidth.com/support/en/articles/12823085-10dlc-faq) · [T-Mobile 10DLC](https://www.bandwidth.com/support/en/articles/12823101-t-mobile-10dlc) · [Verizon 10DLC](https://www.bandwidth.com/support/en/articles/12823103-verizon-10dlc) · [Campaign vetting tips](https://www.bandwidth.com/support/en/articles/12823092-10dlc-campaign-vetting-tips-and-tricks)
- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) · [US SMS Guidelines](https://www.twilio.com/en-us/guidelines/us/sms) · [Link Shortening](https://www.twilio.com/docs/messaging/features/link-shortening) · [Error 30459](https://www.twilio.com/docs/api/errors/30459)
- [Plivo AUP](https://www.plivo.com/aup/) · [US messaging best practices](https://www.plivo.com/docs/messaging/concepts/us-messaging-best-practices)
- [Infobip US brand vetting](https://www.infobip.com/docs/essentials/usa-and-canada-registration/us-brand-vetting) · [10DLC throughput reference](https://www.infobip.com/docs/usa-sender-registration/10dlc/10dlc-throughput-reference) · [US content requirements](https://www.infobip.com/docs/essentials/usa-and-canada-compliance/usa-messaging-content-requirements)
- [Aerialink industry fees](https://docs.aerialink.net/industry-fees/code-number-fees/)
- [TSG Global — T-Mobile Sev-0 fees](https://support.tsgglobal.com/hc/en-us/articles/21870835442075-T-Mobile-Non-Compliance-Fees-Sev-0-s)
- [Textel — MNO codes of conduct and fines](https://support.textel.net/article/895843/us-mobile-network-operator--mno--codes-of-conduct-and-non-compliance-fines)
- [Text-Em-All — blocked URL domains](https://support.text-em-all.com/article/572-sending-urls-in-text-messages)
- [Bitly — why carriers block shortened links](https://support.bitly.com/hc/en-us/articles/20441769384589-Why-can-t-I-use-Bitly-links-in-some-SMS-campaigns)
- [Telgorithm — T-Mobile 2026 fees](https://www.telgorithm.com/news/t-mobile-announces-new-2026-a2p-sms-pass-through-fees) · [US Cellular 2026 fees](https://www.telgorithm.com/news/us-cellular-announces-new-a2p-pass-through-fees-for-short-code-and-toll-free-messaging)

### Secondary (law firm and industry commentary — labelled throughout)
Wiley · Goodwin · Hunton · Nixon Peabody · Cooley · Duane Morris · Manatt · Troutman · Potomac Law · Kaufman Dolowich · Holland & Knight · Privacy World · TCPAWorld · EPIC · SIPNEX · Apten · Dialpad

---

*Compiled 11 August 2026. Re-verify per §10.3 before launch. This is research, not legal advice.*
