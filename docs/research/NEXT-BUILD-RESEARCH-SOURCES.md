# Next-build research source register

Status: researched 22 August 2026

This register records the external evidence used to design the next Vici Inbox
build. It distinguishes law and regulation from provider rules, voluntary
industry guidance, platform documentation, and product-practice guidance.

It is not legal advice. State and federal rules can change, and the business
should obtain qualified counsel before representing the campaign engine as a
complete legal compliance system.

## Highest-priority conclusion

Live promotional campaign sending must remain disabled by default for Vici.
Telnyx currently lists controlled or prescription drugs without proper
authorization, substances not legally approved for sale, and unregulated or
prohibited supplements among forbidden US and Canada messaging categories.
Because Vici distributes peptides, an Admin approval inside the app is not
enough to establish carrier or provider eligibility.

The app may safely provide detection, segmentation, drafts, review, dry runs,
and analytics while live sending is disabled. Live sending may be enabled for a
tenant only after the exact products, message content, registered 10DLC use
case, sending number, brand, campaign, and messaging profile have been confirmed
eligible. Record that decision as operational evidence rather than a comment or
an assumed environment state.

## Source register

All sources were accessed on 22 August 2026.

| Topic | Authority and type | Source | Current date shown by source | What it supports | Implementation decision |
|---|---|---|---|---|---|
| Onboarding | Apple, platform design guidance | [Human Interface Guidelines: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | Current Apple documentation | Onboarding should be brief, optional, contextual, after launch, skippable, and not automatically shown again after skip | Use a short role-aware tour after authentication. Persist completed or skipped state by account and make replay manual |
| Launch | Apple, platform design guidance | [Human Interface Guidelines: Launching](https://developer.apple.com/design/human-interface-guidelines/launching) | Current Apple documentation | Launch should be fast and the launch screen is not a splash or onboarding surface | Keep the edge glow out of the launch-critical path |
| TipKit | Apple, platform API documentation | [TipGroup](https://developer.apple.com/documentation/tipkit/tipgroup), [MaxDisplayCount](https://developer.apple.com/documentation/tipkit/tips/maxdisplaycount), [WWDC23 TipKit](https://developer.apple.com/videos/play/wwdc2023/10229/) | Current Apple documentation | TipKit supports eligibility, order, dismissal, and display limits | TipKit can support later contextual tips. The full required tour still needs an iOS 16-compatible custom coordinator or equivalent fallback |
| Materials | Apple, platform design guidance | [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) | Materials change log updated 9 September 2025 | Liquid Glass belongs primarily in navigation and controls, not the content layer, and custom use should be restrained | Prefer standard TabView, NavigationStack, toolbar, sheet, and control behavior. Availability-gate custom glass and use standard materials on older iOS |
| App submission SDK | Apple, platform requirement | [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/) | Xcode 26 requirement effective 28 April 2026 | App Store Connect uploads require Xcode 26 or later with the iOS 26 SDK or later | Keep the existing macOS 26 and Xcode 26 release workflow |
| Accessibility | Apple, platform design guidance | [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Current Apple documentation | Dynamic Type, VoiceOver, Reduce Motion, contrast, and comfortable controls must be supported | Test themes, onboarding, glow, campaign review, and charts under relevant accessibility settings |
| Charts | Apple, platform design and API guidance | [Charts HIG](https://developer.apple.com/design/human-interface-guidelines/charts), [Swift Charts: Raise the bar](https://developer.apple.com/videos/play/wwdc2022/10137/) | Current Apple documentation | Charts need a plain-language takeaway, accessible marks, and non-touch access to critical values | Keep critical values outside tooltips and supply VoiceOver labels and chart descriptions |
| Woo webhooks | WooCommerce, platform technical documentation | [REST API v3 webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/), [Webhook operations](https://woocommerce.com/document/webhooks/) | Current Woo documentation | Webhooks include a base64 HMAC-SHA256 signature and `X-WC-Webhook-Delivery-ID`; repeated failures can disable a webhook | Verify the raw body, deduplicate the official delivery ID, acknowledge quickly, and monitor webhook freshness |
| Woo REST version and paging | WooCommerce, platform technical documentation | [REST API v3](https://developer.woocommerce.com/docs/apis/rest-api/v3/), [REST API pagination](https://developer.woocommerce.com/docs/apis/rest-api/) | REST v3 described as current and recommended | Collections are paged and totals are exposed in response headers | Page historical product and order reads. Never assume one response is complete |
| Woo product variations | WooCommerce, platform technical documentation | [Product variations](https://developer.woocommerce.com/docs/apis/rest-api/v3/product-variations/) | Current Woo documentation | Variations can have independent stock management, quantity, status, and backorder behavior | Detect restocks at the exact product or variation level and re-fetch authoritative current state |
| Woo orders | WooCommerce, platform technical documentation | [Orders](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/) | Current Woo documentation | Orders expose paid timestamps, status, currency, totals, line items, customer IDs, transactions, and refunds; guest customer ID can be zero | Match exact order and line item identifiers plus normalized identity. Exclude refunds and cancellations according to attribution rules |
| HighLevel contact DND | HighLevel, platform technical documentation | [Create Contact schema](https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact/) and [Get Contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/) | Current v3 documentation accessed 22 August 2026 | Contacts expose global `dnd` and channel-specific `dndSettings.sms.status`, with active, inactive, or permanent states | Preserve an authoritative SMS DND state and check time. Missing or stale state must suppress promotional delivery rather than default to eligible |
| Telnyx prohibited content | Telnyx, provider rule | [Forbidden messaging use cases](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code) | Updated during the week of 22 August 2026 | Certain drugs, unapproved substances, and unregulated or prohibited supplements are not supported | Add a default-off provider eligibility gate before any live campaign job is created or sent |
| Telnyx ISV model | Telnyx, provider rule and setup guidance | [ISVs and 10DLC](https://support.telnyx.com/en/articles/5593977-isvs-10dlc) | Updated during the week of 22 August 2026 | An ISV serving separate end businesses needs separate brand registration for each end customer | Bind provider brand, campaign, profile, and number to the tenant. Never reuse Vici registration for another client |
| Telnyx opt-in | Telnyx, provider rule | [10DLC opt-in form](https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form), [Messaging acceptable use](https://support.telnyx.com/en/articles/1310359-acceptable-use-policy-for-messaging) | Opt-in page updated during the week of 22 August 2026 | Promotional consent must be explicit and verifiable. A phone collected for another purpose or transactional program does not establish recurring promotional consent | Unknown historical consent is ineligible. Store consent scope, source, time, brand, and evidence reference |
| Telnyx opt-out | Telnyx, provider technical and compliance documentation | [Advanced opt-in/out](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out) | Current Telnyx documentation | Standard keywords create profile-level blocks and webhook payloads expose `autoresponse_type` | Synchronize provider and local suppression. Avoid duplicate confirmation messages |
| Telnyx delivery webhooks | Telnyx, provider technical documentation | [Receiving messaging webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks) | Current Telnyx documentation | Webhooks use Ed25519 signatures, unique event IDs, short acknowledgement expectations, retries, and terminal delivery events | Verify, deduplicate, acknowledge, enqueue, and reconcile per recipient asynchronously |
| Telnyx throughput | Telnyx, provider technical documentation | [Messaging rate limits](https://developers.telnyx.com/docs/messaging/messages/rate-limiting), [Send a message](https://developers.telnyx.com/docs/messaging/messages/send-message) | Current Telnyx documentation | Throughput depends on sender and registered campaign; excess traffic queues; queue full and HTTP rate-limit states exist | Pace application jobs to the actual registered throughput and honor `retry-after` with bounded retry |
| Federal consent and revocation | FCC rule, authoritative unofficial eCFR | [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | eCFR up to date 20 August 2026 | Covered telemarketing calls and robotexts have consent requirements; revocation can use reasonable means and must be honored within at most ten business days | Recognize required keywords and unambiguous natural-language revocations, suppress sender-wide, and retain auditable evidence |
| Cross-category revocation timing | FCC order, regulator source | [DA 25-312](https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf) | Released 7 April 2025 | The limited waiver delayed one cross-category revocation requirement only until 11 April 2026 | Treat the delay as expired. Do not scope a general revocation only to one campaign unless valid clarification supports that result |
| Industry messaging practice | CTIA, voluntary industry guidance | [Messaging channel](https://www.ctia.org/messaging-channel) | Current CTIA guidance | Non-consumer senders should obtain consent and provide an opt-out path | Treat CTIA as industry guidance, not a statute, while still honoring provider and carrier expectations |
| Advertising claims | FTC, regulator business guidance | [Health Products Compliance Guidance](https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance) | Current FTC guidance issued December 2022 | Express and implied health or safety claims must be truthful, non-misleading, and supported by competent and reliable scientific evidence | Apply an approved-copy and prohibited-claims gate to generated and manually edited campaign copy |
| Federal telemarketing calls | FTC, regulator business guidance | [Complying with the Telemarketing Sales Rule](https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule) | Current FTC guidance | Live and prerecorded telemarketing calls carry Do Not Call, time, disclosure, and record obligations | Keep voice-campaign compliance separate from SMS campaign rules. This build does not add automated outbound voice campaigns |
| Product cadence | Klaviyo, product-practice guidance | [SMS Smart Sending](https://help.klaviyo.com/hc/en-us/articles/115002779311), [Engagement-based schedule](https://help.klaviyo.com/hc/en-us/articles/360044556071) | Updated 6 August 2025 and 10 February 2026 | A 24-hour SMS spacing window and a conservative 2 to 4 sends per month are useful starting practices, not law | Model 2, 4, and 6 monthly contacts in dry run, then choose Vici policy from real outcomes |
| Vendor state-law implementation | Klaviyo, vendor summary rather than legal authority | [State-law frequency limits](https://help.klaviyo.com/hc/en-us/articles/44447515845019) | Updated 15 January 2026 | Klaviyo applies a conservative three promotional messages per rolling 24 hours control for selected area codes | Use as a comparison only. Implement centrally configurable rules and obtain legal review |
| Oregon state example | Oregon Legislature, statute | [ORS 646.561 and 646.563](https://www.oregonlegislature.gov/bills_laws/ors/ors646.html) | Includes 2025 chapter 580 changes | Oregon includes texts in telephone solicitation and specifies time and frequency rules with stated exclusions | Keep jurisdiction rules versioned and preserve the basis for each suppression |
| Maryland state example | Maryland General Assembly, statute | [Commercial Law section 14-4502](https://mgaleg.maryland.gov/2026RS/Statute_Web/gcl/14-4502.pdf) | 2026 statute edition | Maryland specifies quiet hours, frequency, and exemptions for telephone solicitation | Do not represent one national cadence rule as a complete state-law implementation |
| Florida state examples | Florida Legislature, statutes | [Florida 501.059](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.059.html), [Florida 501.616](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.616.html) | 2026 and 2025 statute editions | Florida definitions, consent, opt-out, time, and frequency provisions are split across sections with different scopes | Keep legal controls configurable and counsel-reviewed instead of copying a vendor label |

## Conclusions that are not legal rules

The following are useful product defaults, not universal legal limits:

- a 24-hour promotional Smart Sending window;
- two to four promotional contacts per month as an initial cohort;
- one to two promotional contacts per week for engaged recipients;
- weekly win-back cohort assembly;
- daily opportunity detection;
- a seven-step onboarding tour;
- a particular attribution window.

Each must remain centrally configurable and measurable.

## Required rechecks before live launch

1. Obtain written Telnyx confirmation for the exact Vici product categories,
   registered use case, and representative campaign copy.
2. Verify the number is assigned to the matching active 10DLC campaign and
   messaging profile.
3. Verify current checkout or other opt-in language and import only real consent
   evidence. Do not manufacture historical consent.
4. Review state-law configuration with qualified counsel for the states in
   which recipients are located.
5. Confirm Advanced Opt-Out behavior and whether Telnyx sends the one-time
   confirmation, so the app does not send a second response.
6. Recheck all provider and legal sources immediately before enabling live
   campaign sending, then record the review date.
