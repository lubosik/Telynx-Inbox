# Opportunity-to-draft production wiring

Status: server-owned, Admin-triggered dry-run and draft generation are implemented and tested offline on 22 August 2026. No detector is scheduled, no production data was written by this repository work, no notification was dispatched, and this layer never approves, schedules, or sends a campaign.

## What is now wired

`lib/campaigns/opportunity-orchestrator.js` is the pure boundary between detector rules and the existing campaign foundation. `lib/campaigns/generation-service.js` now supplies its production input from server-owned, paginated sources and produces four reviewable outputs:

1. open opportunity records shaped for `sms_campaign_opportunities`;
2. campaign records capped at `draft` by default;
3. deterministic recipient inclusion evidence for the existing frozen-audience workflow;
4. native-push payload preparations for active Owners/Admins who hold the effective `campaigns.approve` permission.

The pure orchestrator does not import Supabase, Telnyx, APNs, the campaign route/service, or a queue. The production generation service reads Vici orders, contacts, exact inventory, signed product events, existing opportunity keys, commercial-contact history, authoritative suppressions, fresh support eligibility, active users and effective approval permissions. It is deliberately restricted to workspace `vici`: the legacy order/contact tables have no tenant column, so pretending they were safe for a second workspace would be a tenant-boundary bug.

`POST /api/campaigns/generate` accepts only `workflows` and a boolean `commit`; any client-supplied candidate, customer, product, order, recipient or evidence field is rejected. Omitted/false `commit` performs an aggregate-only authoritative dry-run. A commit requires `CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED=true` and every requested detector's exact flag. The service then calls one transaction-backed `persist_sms_opportunity_draft_bundle` RPC. It can persist only `draft`, and the exact `productID` and `variationID` are frozen into every recipient's inclusion evidence. Moving a draft to review still uses the normal audited submit-for-review lifecycle.

## Detector inputs

### Back in stock

A candidate is not evaluated until at least five minutes after the signed Woo event observation. At that point the caller must provide an authoritative refetch adapter:

```js
async function authoritativeProductRefetch({ workspaceID, productID, variationID }) {
  // Use the tenant's authenticated Woo client. Return the exact item only.
  return {
    snapshot: exactWooProductOrVariation,
    trusted: true,
    recheckedAt: new Date().toISOString()
  };
}
```

The candidate qualifies only if the trusted previous snapshot was definitely unavailable, the signed event snapshot was definitely available, the exact product/variation still is available after the debounce, and the Woo delivery/open-opportunity identities are not duplicates. A product edit while already in stock is suppressed. A missing callback, untrusted response, identity mismatch, unavailable product, or refetch error fails closed.

The orchestrator never treats the signed webhook payload as its own authoritative refetch.

### Reorder

The caller supplies authoritative paid purchase history for one normalized phone and exact product/variation, product availability, product-level cadence evidence where applicable, and whether that last-purchase cycle has already been contacted. The existing median/MAD policy decides whether the cadence is reliable and due.

The stable key includes workspace, opportunity type, phone, exact item, last purchase, and cadence. A newly detected cycle has a bounded 21-day review lifetime. The expected range remains evidence; it is not incorrectly reused as an expiry timestamp after the customer has become overdue.

### Win-back

The caller supplies reliable cadence, last purchase, lifetime purchase count, prior win-back contact/rejection, open opportunity state, current product availability, and current complaint/refund/support blockers. The existing 180-day cooldown and cadence-relative lapse policy applies. The stable key includes the customer, item, last purchase, and eligibility boundary.

## Deduplication and collision behavior

Each prepared opportunity has a SHA-256 stable key which includes the workspace and normalized customer identity without exposing the phone in the key. Duplicate candidates in one run are collapsed. Existing persisted keys must be loaded and passed as `existingDedupeKeys`; the database unique constraint remains the concurrency authority.

After detection, candidates are grouped by normalized phone and passed to `resolveOpportunityCollision`. At most one opportunity per customer survives:

- requested/repeat-buyer back-in-stock outranks reorder;
- reorder outranks win-back;
- lower priorities are retained in the result as `lower_priority_collision`;
- an active payment-recovery phone suppresses every promotional candidate.

This selection is deterministic. No model assigns priority.

## Draft creation boundary

Selected opportunities are grouped only when their workflow and exact product are compatible. Every proposed campaign remains:

- `status: draft`;
- `copyStatus: human_review_required`;
- `audienceDefinition.frozen: false`;
- marked for current eligibility checks at approval and send time.

Consent is intentionally not inferred during detection. Before submission, the existing campaign review must show which suggested recipients have positive, evidenced consent. Approval freezes the reviewed audience; the SQL claim rechecks STOP/DND, positive evidence, authoritative suppression rows, quiet hours, and frequency at send time. Detection itself additionally requires a fresh `sms_customer_commercial_eligibility` row whose status is explicitly `clear`, with a nonblank source and evidence reference. Missing, stale, future-dated, expired, negative, complaint or refund state suppresses generation. No current sync populates that projection yet, so production generation correctly yields no commercially eligible candidates until an authoritative support/CRM projection is installed.

## Notification boundary

`lib/campaigns/campaign-ready-notifications.js` prepares payloads only. A target must be:

- active;
- role `owner` or `admin`; and
- explicitly marked `canApproveCampaigns: true` by an effective RBAC lookup.

Role alone is insufficient, so a per-user permission deny remains effective. Payloads contain a review count and workflow names, never a phone, customer name, message body, order, product, or APNs token. A single persisted draft may carry its campaign ID and a review destination; coalesced multi-campaign payloads deliberately open the Campaigns review queue instead of deep-linking to an arbitrary campaign.

`sendCampaignReadyNotifications` in `lib/apns-notify.js` is the tested dispatch boundary. After a successful atomic commit, the generation route invokes it only with internally prepared targets. Real delivery requires `CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED=true`; while off it returns before device lookup or APNs transport. It selects only devices with an owned `user_id` matching an authorised preparation, never legacy unowned devices or every team device, strips the payload to approved fields, and reuses existing APNs invalid-token handling. Notification failure never rolls back a persisted draft. The route records one aggregate, PII-free `campaign.drafts.generated` audit event.

## Atomic persistence and retry behavior

`persist_sms_opportunity_draft_bundle` validates the active actor's effective `campaigns.manage` permission, workspace, rule version, statuses, exact E.164 identity, product/variation evidence and exact one-to-one audience/opportunity set. A per-workspace preparation advisory lock plus unique stable keys makes retries return the same draft instead of duplicating it. Opportunity insertion, recipient inclusion and opportunity-to-draft linkage occur in one PostgreSQL transaction: any mismatch rolls back the whole bundle.

The endpoint is a human-triggered preparation path, not a scheduler and not a shortcut around evidence. The browser cannot manufacture its inputs. It also cannot submit, approve, schedule, or launch the result through this endpoint.

## Offline dry run

Use a local fixture only:

```text
node scripts/dry-run-campaign-opportunities.js --input /absolute/path/to/non-production-fixture.json
```

Back-in-stock fixture entries reference authoritative results through `authoritativeProducts["productID:variationID"]`. Output is aggregate-only: opportunity/draft counts, workflow counts, suppression reasons, notification preparation count, and the explicit no-write/no-dispatch safety state. It omits recipient and product identity.

## Safe rollout sequence

1. Apply the additive migration in staging and populate authoritative staff/test suppressions and support eligibility; keep every generation and live flag off.
2. Call the Admin endpoint in dry-run mode and manually inspect private source samples for every inclusion and suppression reason.
3. Enable only the overall draft flag and one detector flag in staging, commit drafts, and verify exact recipient/product evidence plus retry idempotency.
4. Dry-run APNs targeting, then separately approve `CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED=true` if desired. Notification enablement does not enable SMS.
5. If automatic generation is later required, add a scheduler with a distributed lease and persisted run audit; retries must reuse stable keys.
6. Keep both provider/live-send gates off. Validate consent coverage and obtain written provider/carrier approval for the exact use case and copy.
7. Separately approve any future launch worker. This orchestrator must never gain provider credentials or send capability.

## Remaining production prerequisites

- application of `scripts/campaigns-migration.sql` in a backed-up staging database;
- a trusted synchronizer that populates fresh `sms_customer_commercial_eligibility` rows; absence intentionally suppresses all candidates;
- private validation of the Vici-only legacy order/contact reader before any multi-tenant expansion;
- persisted detector-run metrics and alerting;
- private sample review and calibrated cadence dry run;
- verified promotional consent evidence coverage;
- explicit provider/carrier approval and a later, separately reviewed sender.
