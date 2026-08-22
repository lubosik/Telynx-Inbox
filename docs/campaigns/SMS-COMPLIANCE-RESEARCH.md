# SMS campaign compliance research

Status: implementation guidance researched 22 August 2026

This document describes product safeguards. It does not certify legal
compliance and is not legal advice.

## Responsibility model

The merchant or client is responsible for obtaining lawful customer consent and
for the truth and legality of its products, offers, and claims. Vici Inbox is
responsible for not turning an unsupported assertion into an unsafe send.

That division means the platform must:

- store the consent evidence supplied by the client;
- distinguish promotional from transactional scope;
- exclude unknown or insufficient consent;
- enforce STOP, DND, quiet hours, provider eligibility, and frequency controls;
- preserve the reviewed audience and final copy;
- revalidate every recipient immediately before send;
- record who approved and launched the campaign;
- never claim that software controls replace legal review.

Client responsibility does not justify treating every customer phone number as
an eligible promotional subscriber.

## Default-off provider eligibility gate

Telnyx's current forbidden-use-case policy is directly relevant to peptide
campaigns. It lists controlled or prescription drugs without proper
authorization, substances not legally approved for sale, and unregulated or
prohibited supplements among unsupported US and Canada messaging categories.

Source: [Telnyx forbidden messaging use cases](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code).

The safe first release therefore requires all of the following before a live
campaign can launch:

1. tenant live-send flag enabled;
2. active provider eligibility record;
3. matching Telnyx brand, campaign, messaging profile, and sending number;
4. the requested campaign type covered by the registered use case;
5. copy inside the provider-approved product and content scope;
6. valid recipient consent for the brand and use case;
7. Admin approval of the exact audience, message, and schedule;
8. final send-time suppression checks.

The provider eligibility record should include reviewer, date, evidence
reference, permitted categories, restrictions, expiry or recheck date, and
status. It must not contain an API key or private credential.

Drafts, dry runs, segment explanations, and analytics can operate while live
sending is disabled. Send endpoints and queue workers must fail closed with a
clear code such as `PROVIDER_ELIGIBILITY_REQUIRED`.

For future client tenants, Telnyx describes messaging platforms serving
separate businesses as ISVs and says each end user needs its own brand. A Vici
registration must not be reused for another business.

Source: [Telnyx ISVs and 10DLC](https://support.telnyx.com/en/articles/5593977-isvs-10dlc).

## Consent evidence

Telnyx states that collecting a number for another purpose, or receiving
transactional consent, does not by itself establish recurring promotional
consent. Telnyx may request proof of opt-in.

Sources:

- [Telnyx acceptable use policy for messaging](https://support.telnyx.com/en/articles/1310359-acceptable-use-policy-for-messaging)
- [Telnyx 10DLC opt-in form](https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form)
- [Telnyx 10DLC campaign compliance](https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements)

A consent record should contain at least:

- tenant and contact ID;
- normalized phone number reference;
- brand;
- program or use case;
- promotional or transactional scope;
- collection method;
- collection timestamp;
- disclosure or form version;
- source-system identifier or immutable evidence reference;
- status and revocation timestamp;
- latest verification date.

Do not copy screenshots, raw checkout payloads, or unnecessary customer data
into campaign audit logs. Store a safe evidence reference and a disclosure
version.

Historical contacts with no verifiable evidence remain `unknown` and are
excluded. An Admin may import or reconcile real evidence, but cannot convert
unknown contacts to consented through a bulk UI assertion that leaves no source
or timestamp.

## Revocation and DND

HighLevel's current contact schema exposes both a global `dnd` flag and a
channel-specific `dndSettings.sms.status` value. The campaign system must
preserve the authoritative SMS state and the time it was checked. An absent or
stale DND result is unknown, not permission to send.

Sources: [HighLevel Create Contact schema](https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact/)
and [HighLevel Get Contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/).

Current [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200)
recognizes the following reply words as reasonable means of revocation:

- STOP
- QUIT
- END
- REVOKE
- OPT OUT
- CANCEL
- UNSUBSCRIBE

The rule also requires treatment of other wording as revocation when a
reasonable person would understand it that way. Covered requests must be
honored within a reasonable time, not more than ten business days. Vici should
suppress immediately because it can.

The FCC's [DA 25-312](https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf)
delayed one cross-category revocation requirement only until 11 April 2026.
That date has passed. A general revocation must not be confined to one campaign
merely because it arrived as a reply to that campaign.

Recommended implementation:

- exact recognized keywords suppress immediately;
- clear natural-language requests suppress immediately;
- plausible but ambiguous revocations enter `suppressed_pending_review`, which
  also blocks sending until resolved;
- only documented customer clarification can narrow or restore consent;
- local suppression is checked even when the provider also blocks;
- all queued promotional jobs for the contact are cancelled;
- one consent-bearing audit summary is written;
- a confirmation, if sent, contains no marketing content.

Telnyx Advanced Opt-Out creates block rules at messaging-profile level and
provides `autoresponse_type` in the inbound webhook. Confirm whether it is
enabled and whether Telnyx already sends the response before adding an app-level
confirmation.

Source: [Telnyx Advanced Opt-In/Out](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out).

## Promotional and transactional classification

Store message classification explicitly. A message that includes an offer,
upsell, reorder suggestion, back-in-stock purchase invitation, win-back offer,
or general promotion should be treated as promotional even if it also contains
order information.

Payment reminders and order status messages may have a different consent and
regulatory basis, but promotional content must not be inserted into those flows
to evade campaign controls.

The recipient commercial-contact ledger should count promotional campaign and
promotional flow sends together. Transactional traffic should be visible but
should not consume the same product frequency allowance unless the configured
policy deliberately says it does.

## Quiet hours and jurisdiction

Federal, state, provider, and product rules do not collapse into one universal
window. Current examples include:

- federal telephone-solicitation rules in 47 CFR 64.1200;
- Oregon's text-inclusive solicitation provisions in
  [ORS 646.561 and 646.563](https://www.oregonlegislature.gov/bills_laws/ors/ors646.html);
- Maryland's quiet-hour and frequency provisions in
  [section 14-4502](https://mgaleg.maryland.gov/2026RS/Statute_Web/gcl/14-4502.pdf);
- Florida provisions spread across
  [501.059](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.059.html)
  and
  [501.616](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.616.html).

State definitions and exemptions differ. Area code can be a conservative
fallback but is not reliable proof of present location. Store the basis used to
resolve recipient timezone and jurisdiction.

The campaign engine should use centrally versioned rules with:

- effective dates;
- jurisdiction;
- message classification;
- local-time window;
- rolling frequency limit;
- exemptions approved by counsel;
- source and review date;
- fail-closed fallback.

Do not label a vendor implementation as the law. Klaviyo's state-frequency
control is useful comparison material, not primary authority:
[Klaviyo state-law frequency limits](https://help.klaviyo.com/hc/en-us/articles/44447515845019).

## Copy and health-product claims

The copy engine must not bypass product eligibility or advertising review.
Both model-generated and hand-edited copy should pass the same server-side
validation before approval and again before launch.

The FTC's [Health Products Compliance Guidance](https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance)
states that express and implied health or safety claims must be truthful,
non-misleading, and supported by competent and reliable scientific evidence.

For this product:

- do not generate therapeutic, disease, dosing, human-use, safety, or efficacy
  claims without an approved, substantiated source;
- do not use customer testimonials to imply unsupported outcomes;
- do not use fake scarcity or misleading inventory claims;
- do not assume a disclaimer cures a misleading overall impression;
- use a reviewed copy bank with version and approval metadata;
- retain a digest of the final approved text and the rule version;
- block public URL shorteners and use only allowlisted HTTPS brand domains.

Copy validation does not make a provider-forbidden product eligible.

## Send-time eligibility order

Recommended fail-closed order for every recipient job:

1. tenant and campaign active;
2. live provider eligibility active;
3. campaign approval version still current;
4. contact identity and normalized phone valid;
5. promotional consent active for this brand and use case;
6. no local or provider opt-out and no DND;
7. no pending revocation review;
8. recipient not internal, staff, or test unless the campaign is an explicit
   test campaign;
9. product or variation still available where relevant;
10. customer has not already converted or reordered;
11. no unresolved support or configured sentiment suppression;
12. jurisdiction and quiet hours permit sending;
13. legal and product frequency caps permit sending;
14. opportunity has not expired;
15. final copy remains identical to the approved copy and passes content rules;
16. idempotency key has not already been accepted by the provider.

Record one skip reason per failed gate plus any secondary reasons useful for
review. Do not silently remove a person from the frozen approved snapshot.

## Minimum compliance tests

- unknown consent is excluded;
- transactional-only consent is excluded from promotion;
- wrong brand or use case is excluded;
- standard STOP keywords suppress and cancel queued sends;
- unambiguous natural-language revocation suppresses;
- ambiguous revocation blocks pending review;
- opt-out after approval is skipped at send time;
- Telnyx autoresponse does not cause a second confirmation;
- provider eligibility off blocks launch and worker execution;
- expired provider review blocks sending;
- state and product caps work on a rolling window;
- DST and recipient-local quiet-hour boundaries are correct;
- manual message edits invalidate approval;
- support agents cannot change any compliance state or launch;
- internal and test recipients are excluded from production campaigns;
- audit failure prevents consent-bearing approval or launch as designed;
- no failure can fall back to sending.

## Sources and classification

Provider rules and current technical behavior:

- [Telnyx forbidden messaging use cases](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code)
- [Telnyx acceptable use policy](https://support.telnyx.com/en/articles/1310359-acceptable-use-policy-for-messaging)
- [Telnyx opt-in form](https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form)
- [Telnyx Advanced Opt-In/Out](https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out)
- [Telnyx and 10DLC compliance](https://support.telnyx.com/en/articles/5664840-telnyx-10dlc-compliance)

Law and regulator guidance:

- [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200)
- [FCC DA 25-312](https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf)
- [FTC Health Products Compliance Guidance](https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance)

Voluntary industry guidance:

- [CTIA messaging channel](https://www.ctia.org/messaging-channel)

CTIA guidance is not a statute. Provider rules may still be contractually
binding and carriers may filter traffic that does not meet their expectations.
