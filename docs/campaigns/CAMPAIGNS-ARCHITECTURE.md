# Campaigns backend foundation

Status: repository foundation only. No campaign delivery worker is installed,
no SMS is sent by this feature, and production migrations have not been run by
this change.

## Safety boundary

Campaigns may be drafted and dry-run while live sending is disabled. Scheduling
requires all of the following:

1. `CAMPAIGNS_LIVE_SEND_ENABLED=true` in the backend environment;
2. `sms_campaign_settings.provider_approved = true`;
3. `sms_campaign_settings.live_send_enabled = true`.

The database defaults both flags to `false` and enforces that live sending
cannot be enabled without provider approval. This matters for Vici because
provider/carrier approval for promotional peptide traffic must be explicit;
having a working transactional number or 10DLC registration is not treated as
approval for this new use.

There is deliberately no JavaScript campaign sender, timer, cron, or launch API
in this release. `campaign.launched` remains a reserved audit type.

## State and approval flow

```text
draft -> review_required -> approval_pending -> approved -> scheduled
   ^          |                    |               |            |
   |          +------ rejected ----+               +-- cancel --+
   +---------------- edit -------------------------+
```

Approval is two-phase:

1. `prepare_sms_campaign_approval` locks the campaign, freezes the selected
   recipient set and rendered message, stores hashes, and moves it to
   `approval_pending`.
2. The API writes the consent-bearing `campaign.approved` audit event.
3. Only after that succeeds does `finalize_sms_campaign_approval` verify the
   immutable audit row by workspace, campaign, event type, fingerprint and
   optional ID, attach that proof to the approval, and mark it `approved`.

If the audit write fails, scheduling remains impossible. Retrying approval for
the exact same frozen revision resumes phase two; changed audience/message
hashes are rejected. Editing increments `revision` and requires a fresh review.

## Schema

The repeatable migration is `scripts/campaigns-migration.sql`.

- `sms_campaign_settings`: tenant timezone, drafting setting, positive-consent
  requirement, provider approval and the default-off live switch.
- `sms_consent_events`: append-only positive/negative consent evidence. The
  migration does not invent consent for existing contacts.
- `sms_campaign_suppressions`: authoritative, tenant-scoped internal/test,
  manual and compliance blocks. No phone number is seeded by the migration.
- `sms_customer_commercial_eligibility`: fresh, evidenced support/refund and
  customer-experience state for promotional opportunity detection. Missing or
  stale state is unknown and suppresses generation; it is never inferred clear.
- `sms_campaigns`: draft text, revision and review/approval/schedule state.
- `sms_campaign_recipients`: frozen audience plus the durable recipient job.
- `sms_campaign_approvals`: immutable decision, revision, message/audience
  digests, recipient count and verified approval-audit proof.
- `sms_campaign_recipient_events`: append-only structured recipient lifecycle
  ledger. Terminal provider events require a Telnyx provider-event ID and the
  `telnyx_ed25519_v2` trust source; Analytics recognises only canonical
  `provider.delivered` evidence.
- `sms_commercial_contact_ledger`: cross-workflow promotional/transactional
  contact ledger, deduplicated by idempotency/provider identity and indexed by
  normalized phone for 24-hour, 7-day and 30-day cadence checks. It carries
  campaign/recipient, product/topic, reply/order/opt-out and suppression links.
- `sms_product_inventory` and `sms_commerce_product_events`: verified
  WooCommerce inventory snapshots and deduplicated transitions.
- `sms_campaign_opportunities`: additive future opportunity records; a trusted
  out-of-stock to in-stock transition may create a back-in-stock opportunity,
  never a campaign or send.

The migration also provides `persist_sms_opportunity_draft_bundle`. This
service-role-only RPC persists server-detected opportunities, draft campaigns
and exact recipients in one transaction. It verifies the workspace, active
actor permission, stable preparation key, one-to-one opportunity/audience set,
E.164 identity, and frozen product/variation evidence. Any mismatch rolls back
the entire bundle.

Every new table has RLS enabled with no anon/authenticated policies. Internal
RPCs are revoked from public roles and granted only to `service_role`.
Workspace-aware composite foreign keys prevent a recipient, event, ledger row,
approval or opportunity from being attached to another tenant's campaign.

`sms_messages` and `sms_sent_log` receive nullable campaign/recipient links.
`revenue_attributions` receives the same links. The Analytics and Campaign
migrations each converge the nullable columns and attach workspace-aware
foreign keys when the other schema exists, so either migration may run first
after their shared RBAC/audit prerequisites. Existing rows are never guessed or
rewritten; future provider and commerce events populate the links so order →
attribution → campaign → recipient → message remains drillable.

## Recipient eligibility

Draft membership is not permission to send. Dry-run and the SQL claim function
both evaluate current state. A recipient is suppressed for:

- invalid phone number;
- an active row in `sms_campaign_suppressions`, including verified staff/test
  identities;
- `sms_contacts.opted_out`;
- the existing `sms_sent_log` STOP sentinel;
- HighLevel global DND or SMS-channel DND;
- missing, partial or stale HighLevel DND evidence (`dnd_unknown`);
- a latest `sms_consent_events` opt-out;
- missing current `promotional_sms` opt-in evidence (including a nonblank
  source and evidence reference) for this workspace/brand
  when positive evidence is required. Transactional or another brand's consent
  is not interchangeable.

The dry-run returns reason counts and at most 500 recipient decisions. A
campaign may schedule when at least one frozen recipient is currently eligible;
ineligible frozen rows remain visible and become skipped/suppressed with their
reason instead of blocking every eligible recipient. The claim RPC repeats
suppression immediately before claiming due rows, then uses
`FOR UPDATE SKIP LOCKED` and a lease token to prevent two future workers from
owning the same job. Expired `claimed` rows can be released; `sending` rows are
never reset automatically because delivery may already have begun.

HighLevel currently exposes both contact-level `dnd` and
`dndSettings.sms.status` (`active`, `inactive`, or `permanent`). `sync-ghl.js`
stores both with an observation time. Only explicit global `false` plus SMS
`inactive` observed inside the configured freshness window counts as known-not-
DND. A missing field is written as unknown rather than inferred false. A DND
observation timestamp in the future is also unknown; it cannot extend the
freshness window.

The claim RPC also refuses work during business quiet hours or while the shared
commercial-contact ledger shows the 24-hour spacing, 2-per-7-day, or
4-per-30-day product guardrail is exhausted. It serializes each workspace/phone
with a transaction advisory lock and writes an expiring ledger reservation
before returning a claimed recipient, so concurrent campaigns cannot both pass
the same frequency window.

The migration also defines, but does not call, fenced provider RPCs:

1. `begin_sms_campaign_provider_attempt` repeats live, consent, suppression and
   DND checks, changes `claimed` to `sending`, and returns the immutable
   provider idempotency key.
2. `heartbeat_sms_campaign_provider_attempt` may extend an unexpired in-flight
   lease using the exact claim token.
3. Provider acceptance requires the exact claim token, idempotency key,
   provider message ID, current gates and durable reservation.
4. Signed terminal callbacks are stored as immutable canonical provider events.
   Recipient state is recomputed by provider occurrence time, with delivery
   winning an exact timestamp tie, so callback arrival order cannot flap state.

An expired pre-provider `claimed` row may return to pending. An expired
`sending` row becomes `reconciliation_required`, retains its reservation and is
never automatically retried: an external provider lookup must establish that
the original idempotency key was not accepted before any future resolution can
release it. There remains no JavaScript worker, provider lookup or provider
call.

## HTTP API and RBAC

All endpoints are under the normal session, actor and default-deny route policy.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/campaigns` | `campaigns.read` | paged campaigns |
| `GET /api/campaigns/review-count` | `campaigns.read` | approval badge count |
| `POST /api/campaigns/generate` | `campaigns.manage` | authoritative aggregate dry-run, or default-off atomic draft generation |
| `POST /api/campaigns` | `campaigns.manage` | manual draft with explicit recipients |
| `GET /api/campaigns/:id` | `campaigns.read` | campaign and latest approval |
| `PATCH /api/campaigns/:id` | `campaigns.manage` | edit mutable draft copy |
| `GET /api/campaigns/:id/recipients` | `campaigns.read` | paged audience/results |
| `POST /api/campaigns/:id/submit-review` | `campaigns.manage` | queue review |
| `POST /api/campaigns/:id/reject` | `campaigns.approve` | reject with reason |
| `POST /api/campaigns/:id/approve` | `campaigns.approve` | frozen two-phase approval |
| `POST /api/campaigns/:id/schedule` | `campaigns.launch` | schedule, only when all gates pass |
| `POST /api/campaigns/:id/cancel` | `campaigns.cancel` | cancel every not-started recipient |
| `POST /api/campaigns/:id/dry-run` | `campaigns.manage` | read-only current eligibility preview |

Owner and Admin can manage the lifecycle. The legacy shared role remains Admin
equivalent during migration. Support Agent has read-only Campaign access.
Provider/live configuration is Owner-only and intentionally has no HTTP route.

The generation endpoint accepts only a workflow allowlist and explicit boolean
`commit`; source evidence cannot be supplied by the client. The server reads
paginated Vici order/contact, inventory, signed restock, support, suppression,
commercial-contact and effective-permission sources. Restock always performs a
second authenticated Woo refetch of the exact parent/variation after debounce.
The legacy order/contact tables are not tenant-scoped, so this adapter refuses
any workspace other than `vici` until those sources are migrated.

Committed generation creates drafts only. It then invokes the independently
default-off, permission-scoped campaign-review APNs path and records one
aggregate audit event without customer/product/copy data. Push failure does not
roll back the draft. There is no automatic scheduler and no SMS provider call.

The older intelligence suggestion send endpoint is also behind the new live
eligibility gate and positive-consent check, so it cannot bypass Campaign
safety.

## WooCommerce product events

`/webhook/woocommerce-product` receives raw JSON. It refuses to write if
`WC_WEBHOOK_SECRET` is absent or `X-WC-Webhook-Signature` is invalid. Verified
events are deduplicated using the official
`X-WC-Webhook-Delivery-ID` (Node header key
`x-wc-webhook-delivery-id`), with the old `x-wc-delivery-id` alias retained only
for compatibility. First-seen in-stock inventory is not called a restock. This
endpoint records evidence only: an opportunity still requires the separate
debounce and authoritative-refetch detector, and a product webhook never
creates a draft by itself.

The existing order webhook now forwards the official delivery ID into
Analytics. Its older operational signature behavior is otherwise unchanged to
avoid disrupting payment/order SMS flows in this additive phase.

## Rollout

1. Back up production and review the migration in staging.
2. Apply `scripts/campaigns-migration.sql` after RBAC and audit migrations.
3. `scripts/analytics-migration.sql` may be applied before or after Campaigns;
   rerun the later migration once and confirm the workspace-aware attribution
   foreign keys.
4. Insert verified staff/test phones into `sms_campaign_suppressions` through a
   separately approved service-role administration process. Do not hardcode
   them in source or depend on environment exclusions for delivery safety.
5. Confirm permission boot validation, RLS and RPC grants.
6. Deploy the backend with `CAMPAIGNS_LIVE_SEND_ENABLED` absent/false.
7. Exercise create, edit, review, approve, reject, cancel and dry-run using only
   staff/test recipients. Scheduling must return
   `CAMPAIGN_LIVE_SEND_DISABLED`.
8. Populate fresh, evidenced `sms_customer_commercial_eligibility` state and
   configure signed Woo product webhooks. Exercise `POST /api/campaigns/generate`
   as an aggregate dry-run first; keep every detector/persistence flag off.
9. In staging only, enable the overall draft flag plus one detector flag and
   verify atomic draft/retry behavior. APNs remains separately off.
10. Obtain written provider/carrier approval for the exact live campaign use.
11. In a later controlled release, add a separately reviewed delivery worker
    that uses begin/heartbeat, the exact idempotency key, signed callback
    verification and provider-side reconciliation before any retry.
12. Only then may the Owner enable the database flags and environment gate.

## Remaining limitations

- The SQL has not been executed against staging PostgreSQL/PostgREST yet.
- There is no delivery worker, signed campaign callback adapter, provider query
  reconciler, or automatic resolution path for `reconciliation_required`.
- There is intentionally no HTTP/UI administration endpoint for authoritative
  suppressions; population and later lifecycle management require a separately
  reviewed operational path with audit logging.
- There is no authoritative producer for
  `sms_customer_commercial_eligibility` yet. Until one exists and produces
  current evidenced `clear` rows, opportunity generation fails closed.
- Generation is Admin-triggered only. There is no distributed scheduler/lease
  or persisted detector-run monitoring yet.
- `sms_contacts` is a legacy phone-keyed table without a workspace column. The
  campaign-owned consent, suppression, queue, events and ledgers are tenant-
  scoped, but a future multi-tenant conversion must migrate contact DND storage
  before tenants can share one database safely.

Rollback is to deploy code without the route mount and leave the additive
tables dormant. Do not drop the tables until their audit/recipient history has
been retained according to policy.
