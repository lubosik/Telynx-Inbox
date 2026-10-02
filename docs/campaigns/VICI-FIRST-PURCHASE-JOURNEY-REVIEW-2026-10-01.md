# Vici first-purchase journey: review draft

Status: **design and local segment code only**. No campaign, automation, coupon or SMS has been scheduled or sent. Copy requires Dominic's review and a provider/compliance check before activation.

## Audience and trigger

An OTP-completed Vici website account with a normalized phone becomes one inbox contact. This is independent of SMS permission. The dynamic **Registered, no paid order** segment requires one unambiguous WordPress-to-contact identity and zero paid orders on the LUKO order record. The 2026-10-01 verified cohort had 92 accounts but 91 distinct phone numbers; after the guarded repair, 90 verified account identities are linked and two conflicting records remain quarantined. A shared phone is never two recipients.

Segment membership answers *who registered without buying*, not *who may receive SMS*. Before each send, independently require a checked and recorded Vici SMS opt-in for that exact phone, no later STOP or suppression, fresh contactability, approved provider use case, quiet-hour compliance, and a live WooCommerce first-paid-order check. Do not text a person who only supplied a required phone. Pause this journey during an active cart-recovery journey, an open support conversation, or a recent marketing text. Any reply hands the conversation to the team and cancels later automated touches. A paid order exits immediately; a refund is measured separately and does not restart onboarding automatically.

## Recommended cadence for review

| Step | Earliest timing | Purpose | Exit/check before sending |
| --- | --- | --- | --- |
| 1. Human-feeling welcome | 24 hours after verified registration, at the next permitted 6 p.m. New York window | Invite a question; make the inbox useful | All send gates, no paid order, no active cart journey or recent reply |
| 2. Helpful follow-up | 4 days after step 1, only without reply or purchase | Discover friction: product information, checkout or shipping | Same fresh gates; do not repeat if an Omnisend email covers the same topic that day |
| 3. Optional offer | 7 days after step 2, **off by default** | A measured incentive only if Dominic approves terms and a live coupon exists | Recheck coupon, products, carrier policy and all send gates |

Cap this journey at two messages in its first 7 days unless the third step is expressly approved. Also apply the existing cross-workflow cadence cap so payment, cart, VIP and first-purchase messages do not stack. Use `America/New_York`, not a fixed EST offset, so daylight saving time is handled correctly. Hold 10% of otherwise eligible people out of these sends to measure incremental first purchases; keep them in the segment and analytics denominator.

## Message options for Dominic

These are **drafts, not send-ready templates**. They intentionally avoid peptide names, health benefits, stacking, urgency and unverified offers. The app should render a first-name fallback before review, and the initial automated marketing text should include the provider-approved opt-out wording.

**Recommended step 1:**

> Hi {{first_name}}, it's Vin from Vici. Thanks for joining us. If you have a question before your first order, just reply here and I'll help. Reply STOP to opt out.

**Alternative A, more specific:**

> Hi {{first_name}}, Vin from Vici here. Need help with product details, shipping, or checkout before your first order? Reply and I'll point you in the right direction. Reply STOP to opt out.

**Alternative B, more personal:**

> Hi {{first_name}}, it's Vin. Welcome to Vici. What would make your first order easier? You can reach our team right here. Reply STOP to opt out.

**Step 2, only if quiet:**

> Hi {{first_name}}, Vin checking in. Was there anything unclear while you looked around Vici? Product info, shipping, or checkout, I'm happy to help. Reply STOP to opt out.

No coupon code or claimed discount appears here. If Dominic chooses an offer, create and verify its exact WooCommerce terms first, then preview the rendered code and link in the app and in a controlled test. Do not send a product-specific recommendation from inferred health needs.

## Tracking contract

- Persist one canonical registration/journey ID tied to WordPress user ID and LUKO contact, but never use consent as a membership shortcut.
- Store enrolment, suppression/holdout reason, each eligibility decision, queued/sent/delivered/replied/clicked timestamp, campaign/message ID, and first paid order ID/time. Keep Omnisend email events separate and use them for cadence coordination when available.
- The first-purchase KPI uses a real paid WooCommerce order, not a cart or unpaid order. Track gross, discounts, refunds and net revenue. Do not call all post-message orders *recovered*; deterministic link/click evidence is DIRECT, and qualified but non-click evidence should be labelled separately. Compare conversion against holdout before claiming incremental lift.
- Reconcile by WordPress user ID first, then a validated existing mapping; quarantine shared phones or disputed customer IDs. Each paid order counts once.

## Activation checklist

1. Deploy and verify the registration-contact bridge and dynamic segment. Check a controlled new account with the checkbox **unchecked** and another with it checked; both appear as one contact, only the latter has SMS opt-in evidence.
2. Inspect the two conflicting historical customer IDs; do not merge or message them by assumption.
3. Establish a safe contactability route for the GHL-absent opt-ins without fabricating DND status or triggering GHL automations unexpectedly.
4. Confirm Telnyx approves the proposed use case and copy, and confirm the Omnisend email calendar to avoid same-day duplication.
5. Have Dominic approve copy, cadence, holdout and any offer. Then implement a dry-run queue, test with controlled numbers, review rendered messages, and separately authorize live sending.
