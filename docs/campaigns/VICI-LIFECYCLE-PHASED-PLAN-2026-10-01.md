# Vici customer lifecycle: phased build and approval plan

**Prepared:** 1 October 2026. **Status:** Proposal for owner approval, not permission to send, change consent, or deploy. **Channel ownership:** Omnisend sends email; LUKO sends SMS and manages the inbox. WooCommerce is the paid-order source of truth. WordPress/Vici's own registration checkbox is the candidate source of SMS opt-in evidence.

## The two outcomes

1. **First-purchase conversion:** among real, OTP-completed accounts registered during a defined window, what fraction place a first paid order within 30 days? Report the denominator, channel eligibility, and exclusions, not just a headline percent.
2. **Second-purchase conversion:** among customers with exactly one paid order, what fraction place a second paid order within 30, 60, and 90 days? Report repeat purchase separately for all buyers and VIPs. Optimize **incremental contribution margin**, not merely message-attributed revenue.

The 1 October read-only audit found 706 recent consumer registrations without a paid WooCommerce order; 195 have a valid stored phone, 187 of those have never placed any Woo order, and eight have only cancelled/on-hold attempts. These are an **identified cohort**, not a confirmed eligible sending audience. The supplied CSV has no WordPress checkbox-evidence field. The prior LUKO audit found 92 latest evidenced promotional opt-ins among the 195, but send-time suppression/DND clearance was not established. These counts must be recomputed before a pilot.

## What exists today, versus the missing journey

| Customer stage | Existing LUKO capability | Missing for a complete lifecycle |
| --- | --- | --- |
| Registered, no purchase | WordPress phone and optional consent capture; Woo identity; manual segment/campaign tools; cart recovery **only if an actual cart was observed** | A dedicated registration-to-first-paid-order journey, its purchase/reply/cart exits, and current per-person consent/clearance reconciliation |
| First paid order | Order/payment communications and automatic 21-day check-in; one-time-buyer cohort analysis | A measured second-order journey that respects the existing check-in, differentiates support from promotion, and avoids duplicate touches |
| Repeat buyer | Reorder/win-back opportunity logic, segmentation, manual campaigns | A verified always-on cadence and coordinated cross-channel calendar; historical detectors are not proof of current live dispatch |
| VIP (3+ paid orders and $500+ spend) | VIP inbox/number, welcome automation, analytics ranking, review-only guide drafts | A service-level promise with staffed response, documented offer entitlement, preference capture, and incremental VIP measurement |
| Omnisend email | Woo-connected email contact and campaign system | Read-only email-touch visibility inside LUKO and collision suppression. No need to activate or sync Omnisend SMS. |

## Phase 0 — Foundation and truth (approval gate before any new outreach)

**Build/audit:** Read the current WordPress `_luko_consent_evidence` and `luko_sms_consent` values, registration time, disclosure/version, phone, and OTP completion for each of the 195; compare with LUKO's append-only promotional-consent events and current STOP/DND/suppression state. Resolve the four Omnisend split-email/phone identities and six missing phone matches as identity issues, not as SMS-consent vetoes. Import only **verified, matching, non-revoked** checkbox evidence into LUKO with source, timestamp and dedupe key. Never fabricate an opt-in for a blank/unchecked form, a pre-plugin account, or a changed phone number. Keep an exception list for ambiguous records.

**Email coordination:** First integrate Omnisend **read-only** for email identity, subscribed/unsubscribed state, campaign/automation metadata, and recipient-level send/click events only where the API or reviewed exports actually expose them. Do not write subscription status or launch Omnisend campaigns through this phase. Woo remains the purchase authority. Add one cross-channel touch timeline and a fresh-at-send check so LUKO can avoid SMS immediately after an Omnisend email.

**Dashboard:** Show registered/no-paid, valid phone, checkbox evidence verified, LUKO consent synced, currently suppressed, and potentially eligible as separate numbers. Never label all 195 “SMS ready” on account-creation evidence alone.

**Owner review:** Approve the consent-reconciliation report, source disclosure, exception handling, data-access scope, and provider/product messaging clearance before Phase 1. No send in Phase 0.

## Phase 1 — First-purchase journey

**Pilot population:** OTP-completed, genuine registered customers with no paid order, verified LUKO SMS permission, current clearance, and unambiguous identity. Split “no cart ever observed” from “active/abandoned cart” and “failed or on-hold checkout.” Existing cart recovery gets priority; do not add a second generic welcome text to that same moment.

**Proposed flow for owner review:** one timely, short, person-specific assistance message after registration or observed checkout friction; a second touch only if no order, reply, support issue or conflicting Omnisend email touch, and if provider/content approval and cadence permit it. Personalize with known first name and **verified** actions only. Ask a genuine question about checkout, availability, shipping or documentation. No fabricated browsing, medical benefits, dosing or product stacking. A discount is an optional measured test, not a default.

**Exit:** first paid order, opt-out, reply requiring a human, support/refund issue, identity conflict, or active cart-recovery journey. Drafts, previews, test phone, audience reasons and a kill switch must be visible in Growth → Automations before live enablement.

**Measure:** 30-day first-paid-order rate and contribution margin, compared with a stable holdout. Record actual paid orders and refunds. Email and SMS get distinct touch records; never sum their platform-attributed revenue as if incremental.

**Owner approval:** message wording, exact timing, maximum touches, offer/no-offer choice, exclusion list, recipient preview, test send, and small initial batch.

## Phase 2 — Second purchase and broader retention

The August Vici purchase analysis found that many returning buyers bought **different** products; an exact-SKU reorder model alone misses the larger second-purchase opportunity. Recompute the cohort before launch. Reuse the 21-day check-in and one-time-buyer segmentation; do not layer a new SMS on top of a queued check-in, payment reminder, cart recovery, or recent Omnisend email.

**Proposed flow:** after the first paid order, deliver useful order/fulfillment support through existing transactional rails; keep the 21-day check-in as the personal conversation opener; for one-time buyers still without order two, test one reviewed service/quality-documentation or shipping-focused follow-up. Established repeat buyers get preference-based service, not an automatic discount calendar. Any cross-sell copy must be separately reviewed for product and health-claim risk.

**Measure:** second paid order by day 30/60/90, incremental margin versus holdout, refunds, complaints, reply quality, and suppression rate. Keep a customer-level order denominator, not customer-product pairs.

**Owner approval:** second-order message, trigger and suppression rules, any incentive, and whether the existing 21-day copy changes.

## Phase 3 — VIP service and SMS relationship

Keep the current VIP definition: **3+ distinct paid orders and $500+ paid lifetime spend**. Preserve one shared customer history and route VIP SMS/calls through the VIP number. Existing welcome automation is the entry point; the proposed guide follow-up remains **review-only** until the template, content and product claims are approved. Its current internal draft waits at least 48 hours after a sent welcome and checks recent conversation activity.

Build a coherent VIP workspace around **service**, not more volume: VIP preferences and contact history, priority response queue, verified offer/code entitlement, early stock information only when genuinely early, and a clear human handoff. Confirm staffing before promising “24/7” coaching. Avoid individualized human-use or stacking advice in automated messages. Later referral/affiliate mechanics require a separate disclosure, product, fraud and unit-economics review; they are not a prerequisite to the first two journeys.

**Measure:** VIP retained paid orders and contribution margin, human response time, reply resolution, satisfaction/complaints and incremental value relative to a comparable/holdout group. A VIP welcome attribution tag is not causal lift.

**Owner approval:** exact VIP promise, staffing, template, offer rules, reply routing, and pilot group. No new VIP campaign automatically follows from this plan.

## Phase 4 — Cross-channel optimization

Once the three journeys work, show a single customer timeline: Omnisend email touch, LUKO SMS, reply, support interaction, cart, paid order and refund. Add collision rules and customer preferences. Test **one variable at a time** (timing, assistance angle, or offer) with a fixed holdout and a predeclared outcome. Keep Omnisend email-only and LUKO SMS-only unless the owner deliberately changes channel ownership later.

## Non-negotiable release checks

- Every live SMS recipient has documented, current Vici/LUKO marketing permission **for that number and use**, no later STOP, and current provider/DND clearance. The optional, unchecked WordPress checkbox proves consent only when that individual checked it and the evidence survived OTP completion.
- The brand, products, sender number and **actual message copy** are allowed by the messaging provider and reviewed for FDA/FTC claims. Consent alone cannot authorize a prohibited product/use case.
- A paid-order event cancels pending first/second-purchase messages; a reply or support issue routes to a human and pauses promotional automation. Cadence and recipient-local quiet hours span all LUKO SMS; Omnisend email touches are considered for spacing.
- Draft, individual cancellation, test message, send-time eligibility, audit trail, kill switch and refund-aware measurement are verified before a small live batch. No one is sent a campaign merely by approving this plan.

## Research anchors

- [Vici research library, entry 08](/Users/ghost/telynx-inbox/research/ai-wizard/08-vici-omnisend-lifecycle-research.md), [Vici repeat-purchase analysis](/Users/ghost/telynx-inbox/docs/campaigns/REPEAT-PURCHASE-RESEARCH.md), [VIP definition](/Users/ghost/telynx-inbox/docs/campaigns/VIP-CUSTOMERS.md).
- [Omnisend WooCommerce integration](https://support.omnisend.com/en/articles/1636174-connect-your-woocommerce-wordpress-store-to-omnisend), [Omnisend contacts API](https://api-docs.omnisend.com/reference/contacts), [Omnisend campaign list API](https://api-docs.omnisend.com/reference/get_campaigns), [Omnisend recipient segment guidance](https://support.omnisend.com/en/articles/4216311-understand-how-segments-update-in-omnisend).
- [Klaviyo SMS-flow guidance](https://academy.klaviyo.com/en-us/best-practices/best-practices-for-sms-flows) is a hypothesis source, not a Vici result. [Telnyx forbidden-use policy](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code), [FDA research-peptide warning](https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/summit-research-peptides-695607-12102024), and [FTC health-products guidance](https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance) are release constraints.
