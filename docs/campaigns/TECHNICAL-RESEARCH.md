# Campaign technical research

Status: architecture inputs researched 22 August 2026

This document records technical findings that modify or constrain the master
prompt. It complements the repository's existing RBAC, Activity, Analytics, and
approval documentation.

## Existing system constraints

The current application is a native SwiftUI iPhone client backed by Express on
Railway and Supabase. It supports iOS 16 and uses Xcode 26 for current CI and
TestFlight submission.

Campaign work must preserve these enforced repository rules:

- route policy is default deny and every API route needs one permission entry;
- Support Agents can read campaign context but cannot manage, approve, launch,
  schedule, or cancel;
- reserved campaign audit events must be enabled only with their real call
  sites;
- approval and launch are separate consent-bearing audit acts;
- computed Supabase ID sets use `selectIn()` chunking rather than unbounded
  `.in()`;
- all source reads page beyond Supabase's 1,000-row default cap;
- Supabase query builders are awaited inside try/catch and never use builder
  `.catch()`;
- model calls use `lib/openrouter-private.js`;
- Analytics remains additive and fail-safe;
- the existing five-tab iPhone layout puts Campaigns inside Growth rather than
  adding a sixth tab.

## Feature and provider gates

Use separate controls so UI exposure is not confused with sending authority:

- `campaigns_ui_enabled`
- `campaign_detection_enabled`
- `campaign_dry_run_enabled`
- `campaign_live_send_enabled`
- provider eligibility status and evidence

All should be tenant-scoped when the data model supports tenants. The worker
must enforce live-send and provider eligibility independently of the API that
launches a campaign.

Telnyx's current product-category policy makes the provider gate mandatory for
Vici. See
[forbidden messaging use cases](https://support.telnyx.com/en/articles/14286763-forbidden-messaging-use-cases-in-the-us-and-canada-10dlc-toll-free-and-short-code).

## Webhook intake

### WooCommerce

WooCommerce documents these headers:

- `X-WC-Webhook-Signature`
- `X-WC-Webhook-Delivery-ID`
- `X-WC-Webhook-Topic`
- `X-WC-Webhook-Resource`
- `X-WC-Webhook-Event`

The signature is a base64 HMAC-SHA256 of the raw request body using the webhook
secret. The delivery ID is appropriate for deduplication.

Source: [WooCommerce REST API v3 webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/).

The current order route reads `x-wc-delivery-id`. The new implementation should
read the official lowercased Express header
`x-wc-webhook-delivery-id`, preserve a temporary compatibility fallback, and
test both. Existing operational compatibility may process an invalid signature,
but campaign intelligence and revenue evidence must not trust it.

Recommended intake flow:

1. preserve raw bytes;
2. validate required secret and timing-safe signature;
3. parse only after signature validation for trusted processing;
4. store or claim delivery ID idempotently;
5. acknowledge quickly;
6. enqueue narrow internal work;
7. perform authenticated current-resource re-fetch for consequential actions;
8. retain safe status and timestamps, not secrets or full personal payloads in
   campaign logs.

WooCommerce can disable a webhook after repeated delivery failures. Diagnostics
should show last trusted event, last failure, and stale-event warning. A
scheduled reconciliation should discover missed state rather than assume
webhooks are perfect.

### Telnyx

Telnyx messaging events include a unique `data.id`, occurred time, payload,
delivery attempt, and event type. Telnyx signs current webhooks with Ed25519 and
expects prompt acknowledgement. Failed delivery is retried.

Source: [Receiving Telnyx messaging webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks).

Persist and deduplicate the provider event before applying campaign statistics.
Provider status meanings must remain distinct:

- queued: accepted into a provider queue;
- sent: handed to the upstream carrier;
- delivered: carrier-confirmed delivery where available;
- delivery unconfirmed: no carrier confirmation;
- sending or delivery failed: terminal failure class.

Do not present queued or sent as delivered.

## Back-in-stock intelligence

A `product.updated` event is not a restock signal. Price, title, description,
metadata, images, and stock can all trigger the same topic.

For each parent product or variation, store a trusted normalized inventory
snapshot:

- product ID;
- variation ID if any;
- SKU;
- stock status;
- stock quantity when managed;
- backorder settings;
- purchasable and publication state where relevant;
- source modified time;
- trusted webhook delivery and observation time.

A restock candidate requires:

1. previously unavailable state;
2. newly observed available state;
3. signature-valid event;
4. deduplicated delivery;
5. authenticated current Woo re-fetch after a short debounce;
6. exact parent or variation still available;
7. no existing open opportunity for the same restock event.

Variation-level stock fields are documented at
[WooCommerce product variations](https://developer.woocommerce.com/docs/apis/rest-api/v3/product-variations/).

The Woo Store API is public and excludes variations by default. Use
authenticated REST v3 rather than the public Store API as the authoritative
campaign source.

## Order and customer matching

Woo orders expose `date_paid_gmt`, `status`, `currency`, `total`, `customer_id`,
`transaction_id`, `line_items`, and refunds. Guest orders can have
`customer_id = 0`.

Source: [WooCommerce orders API](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/).

Campaign detectors and attribution should use, in descending strength:

1. exact Woo customer and order identifiers where valid;
2. exact line-item product and variation identifiers;
3. normalized phone identity;
4. normalized email only as a controlled secondary identity signal;
5. timestamp and workflow evidence.

Never join all guest orders on customer ID zero. Ambiguous identity remains
ineligible or Unattributed.

REST historical reads are paged. Woo exposes total page counts in response
headers: [Woo REST API pagination](https://developer.woocommerce.com/docs/apis/rest-api/).

## Durable recipient queue

Campaign launch should create durable per-recipient jobs in one transaction or
controlled sequence tied to the frozen approved audience version. It must not
loop over hundreds of Telnyx calls inside the launch request.

Each job needs:

- campaign, audience snapshot, and recipient IDs;
- normalized destination reference;
- approved message version and digest;
- scheduled and next-attempt time;
- status and attempt count;
- idempotency key;
- provider message ID;
- last safe error code;
- cancellation and suppression reason;
- accepted, sent, delivered, failed, and completed times;
- rule and eligibility versions used at the final check.

The idempotency key should be stable for one campaign recipient and message
version. A retry after timeout must reconcile an existing provider message ID or
claimed job before creating a new send.

Telnyx documents account, sender, and registered 10DLC campaign throughput,
provider queue behavior, queue-full error `40318`, and separate HTTP API rate
limits. Source:
[Telnyx messaging rate limits](https://developers.telnyx.com/docs/messaging/messages/rate-limiting).

The worker should:

1. claim a small bounded batch with a lease;
2. re-run every send-time gate;
3. pace to the configured actual campaign throughput;
4. submit one recipient request;
5. persist provider acceptance and ID;
6. release or renew its lease;
7. retry transient 429 and 5xx responses using `retry-after` where supplied,
   exponential backoff, jitter, and a maximum attempt policy;
8. never retry permanent opt-out, content, invalid-number, or eligibility
   failures;
9. reconcile final delivery through verified webhooks;
10. resume safely after worker restart.

Campaign cancellation prevents unclaimed jobs from sending and marks claimed
jobs for cancellation where the provider has not accepted them. It cannot
recall an already accepted SMS.

## Frozen approval and mutable eligibility

Approval freezes:

- audience snapshot;
- inclusion explanations;
- copy;
- campaign type and source;
- attribution rule;
- schedule or timing mode;
- approval actor and time;
- version and digest.

Send-time checks do not mutate that frozen evidence. They produce `sent` or
`skipped` outcomes against each approved member.

Any material edit to audience, text, campaign type, offer, link, product, or
schedule after approval creates a new version and returns the campaign to
`review_required`. A cosmetic local UI preference does not.

## Analytics extension

Use the existing revenue-attribution contract. Campaign recipients should
provide the explicit action evidence that historical ordinary conversations do
not have.

At minimum attach:

- campaign and recipient ID;
- campaign category;
- exact message/provider ID;
- delivered time where verified;
- customer, order, product, and variation match;
- attribution window and rule version;
- deterministic winner evidence;
- Direct, Strong, Influenced, or Unattributed classification;
- refund and invalidation state.

One order can have only one current winning attribution. A payment-recovery
action and campaign action cannot both claim it. Campaign-level metrics may show
delivery and conversion while global Analytics rolls up only real, classified
revenue.

## Apple implementation research

### iOS 16 and TipKit

The repository supports iOS 16. TipKit belongs to the iOS 17 generation. A
TipKit-only full tour would not satisfy the requirement for all supported
devices.

Use a small custom SwiftUI onboarding coordinator for the full cross-tab
spotlight experience, or supply an equivalent iOS 16 fallback if TipKit is used
on newer systems. TipKit remains appropriate for later contextual feature tips.

Apple recommends brief, optional, contextual onboarding after launch and says
not to automatically present a skipped tutorial on later launches:
[Onboarding HIG](https://developer.apple.com/design/human-interface-guidelines/onboarding).

Backend account state is the source of truth for automatic-tour completion,
skip, and version. Local state should prevent repetition during temporary
network failure but must not become the only source.

### Liquid Glass and appearance

Current App Store Connect uploads require Xcode 26 with the iOS 26 SDK. The
existing workflows already select the correct generation.

Source: [Apple upcoming requirements](https://developer.apple.com/news/upcoming-requirements/).

Standard navigation and control components receive current platform styling
automatically. Apple says Liquid Glass should define a functional layer for
navigation and controls and should not be used throughout content surfaces.

Sources:

- [Apple Materials HIG](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)

Use semantic color and material tokens for System, Light, and Dark. Custom
glass APIs require an availability check and a standard material fallback on
older supported iOS. Do not raise the deployment target for this visual change.

### Accessibility

Apple guidance supports Dynamic Type, VoiceOver, sufficient control size,
Reduce Motion, and testing transparency and contrast settings:
[Accessibility HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility).

Campaign review and onboarding targets need meaningful VoiceOver labels, a
logical focus order, and controls that remain usable at accessibility text
sizes. The welcome glow becomes a static or soft fade under Reduce Motion.

For charts, keep the main takeaway and values available as text. Swift Charts
provides accessible marks, and chart descriptors can improve the VoiceOver
experience. Touch or drag inspection is supplementary, never the only way to
obtain a critical value.

Sources:

- [Charts HIG](https://developer.apple.com/design/human-interface-guidelines/charts)
- [Swift Charts: Raise the bar](https://developer.apple.com/videos/play/wwdc2022/10137/)

## Research-driven regression tests

Backend and data:

- official and compatibility Woo delivery header names;
- valid, invalid, missing, and duplicate Woo signatures and deliveries;
- product edit without stock transition;
- parent and variation restock transitions;
- restock reversed during debounce;
- webhook inactivity reconciliation;
- guest customer ID zero never cross-matches customers;
- more than 1,000 contacts and orders page correctly;
- large ID sets use bounded chunking;
- provider gate off at API and worker layers;
- job retry after timeout never duplicates a send;
- worker restart and lease expiry;
- cancellation during queue processing;
- verified Telnyx event deduplication;
- queued, sent, delivered, unconfirmed, and failed remain distinct;
- approval invalidated by material edit;
- send-time STOP, DND, consent, conversion, stock, quiet-hour, and frequency
  changes;
- Support Agent direct API denial;
- tenant isolation for every campaign resource;
- attribution winner and refund reconciliation.

iOS:

- iOS 16 fallback and iOS 26 current design;
- new Admin, new Support Agent, complete, skip, second login, reinstall, second
  device, offline fetch, and manual replay;
- System, Light, and Dark appearance persistence;
- Dynamic Type and smallest supported screen;
- VoiceOver focus through campaign wizard and charts;
- Reduce Motion, Reduce Transparency, and Increase Contrast;
- five-tab navigation remains stable and Growth badge routes correctly;
- empty, loading, partial, and API failure states.

## Implementation decisions that must not be assumed complete

- Telnyx eligibility for Vici promotional product messaging;
- historical promotional consent coverage;
- current 10DLC use case and number assignment;
- Advanced Opt-Out configuration and response ownership;
- final state-law matrix;
- queue scheduler mechanism and production worker ownership;
- link tracking domain and redirect security;
- exact reorder cadence model from real data;
- acceptable unconverted-enquiry classification quality.

These items should remain explicit gates or documented open decisions rather
than optimistic defaults.
