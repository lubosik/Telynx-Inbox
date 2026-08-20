# Analytics architecture

## Existing system and safe insertion points

Vici Inbox is an existing Node/Express backend on Railway with Supabase
Postgres, a React web inbox and a native SwiftUI iPhone app. Analytics is an
additive subsystem; messaging, calling, order sync and automations remain the
operational source paths.

| Domain | Existing source | Analytics use |
|---|---|---|
| SMS/MMS | `sms_messages`, `sms_sent_log`, Telnyx webhooks | activity, delivery, replies, response time, payment-reminder evidence |
| CRM | GHL webhooks mirrored into `sms_messages` | activity and inbound sentiment; never carrier-delivery proof |
| Commerce | signed WooCommerce order webhooks and REST orders | authoritative payment, status, gross value and refunds |
| Voice | `call_logs` from the Telnyx voice path | inbound/outbound, answered/missed, talk time |
| Contacts/orders | `sms_contacts`, `sms_orders` | operational context; Woo remains financial authority |
| Realtime | existing process-wide SSE broadcaster | `analytics_changed` invalidation signal after trusted event changes |
| iOS | SwiftUI + shared authenticated `APIClient` | native Analytics tab, date filtering, cards and drill-down |

The safest backend insertion points are after an existing source event has been
authenticated and its operational handling has begun. Analytics calls are
best-effort: a missing migration or analytics write failure must never block an
SMS, Woo order flow, fulfilment action, or call.

## Event flow

```text
Telnyx delivery webhook ─┐
Telnyx/GHL inbound SMS ──┼── existing operational tables
Telnyx call completion ──┤             │
                         │             ├── analytics state/version bump
signed Woo order webhook ┴── analytics_order_events (deduplicated)
                                       │
                                       ├── rule-based order reconciliation
                                       │
                                       └── revenue_attributions (one/order)

message_sentiment ───────────────────────── aggregate-only sentiment

authenticated GET /api/analytics/overview ── bounded range aggregation ── iOS
authenticated GET /api/analytics/attributions ─ paged audit rows ──────── iOS
```

Only cryptographically verified WooCommerce webhooks enter the trusted
`analytics_order_events` ledger. Woo documents `X-WC-Webhook-Signature` as an
HMAC-SHA256 signature and exposes a delivery ID suitable for deduplication:
[official WooCommerce webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/).

## Additive database objects

`scripts/analytics-migration.sql` creates only new tables, functions, triggers
and narrow source indexes:

- `analytics_attribution_rules`: business timezone, currency, methodology
  version and central attribution windows.
- `analytics_order_events`: trusted, deduplicated commerce event ledger.
- `revenue_attributions`: one current classification per order, including
  Direct/Strong/Influenced/Unattributed, evidence, gross/refund/net values and
  invalidation state.
- `revenue_attribution_history`: immutable prior revisions from an update
  trigger.
- `message_sentiment`: one cached classification per message and classifier
  version.
- `analytics_backfill_runs` / `analytics_backfill_candidates`: controlled
  historical review and persistence audit.
- `analytics_message_events`: minimal Telnyx event ledger keyed by provider
  event ID. Only current Ed25519-verified events are trusted for live delivery,
  reply and sentiment evidence; raw message text is not duplicated here.
- `analytics_daily_rollups`: future scale path; not required by the initial
  volume.
- `analytics_state`: monotonically increasing invalidation version.

All new tables enable RLS and deliberately have no direct anon/authenticated
policies. The authenticated Express backend uses the service role and returns a
minimised DTO. Supabase advises enabling RLS on exposed-schema tables and never
exposing service keys in clients: [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).
The state-changing `bump_analytics_state` RPC explicitly revokes execution from
PUBLIC, anon and authenticated roles and grants it only to the service role.

The migration is reversible at the subsystem level because existing source
rows/columns are untouched. It must be applied before deploying code that
expects Analytics to be available. Until then, source hooks fail open only for
analytics and the API returns `ANALYTICS_NOT_READY`.

## Calculation, API and caching strategy

Initial aggregates run server-side. The iPhone never scans raw messages,
orders, or calls and never receives phone numbers or raw conversation text from
the Analytics API.

`GET /api/analytics/overview` accepts `today`, `week`, `month`, `year`, `all`,
or `custom` and calculates every metric against the same half-open time range
`[start, end)` in the configured business timezone. Comparable fixed periods
receive an equal previous range. Custom and All Time avoid misleading forced
comparisons.

`GET /api/analytics/attributions` is paged and can filter by confidence/category.
Its DTO exposes the order ID, amounts, timestamps, confidence, explanation and
safe evidence codes—not customer message content.

Current volume is suitable for bounded range queries. Each source is paged with
a safety ceiling and emits a warning if truncated. Narrow timestamp/status
indexes support the initial read patterns. At higher volume:

1. build/update `analytics_daily_rollups` from trusted events;
2. serve completed days from rollups and only the current day dynamically;
3. reconcile rollups after late/refund events;
4. retain raw drill-down in paged attribution rows;
5. inspect actual `EXPLAIN ANALYZE` plans before adding indexes.

Do not cache owner-specific analytics publicly. Responses are `private,
no-store` in version 1. `analytics_state.version` is the invalidation primitive;
an `analytics_changed` SSE event lets a visible client refresh without polling
the full dashboard continuously. Supabase also documents private Broadcast as
the recommended scalable database-change approach if the product later moves
realtime fan-out into Postgres: [Supabase database-change subscriptions](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes).

## iOS rendering

The iOS client remains native SwiftUI:

- `MainTabView` adds `Analytics` with `chart.bar.xaxis` as the fifth primary tab.
- `AnalyticsViewModel` owns period/custom range state and ignores stale async
  responses.
- `AnalyticsModels.swift` decodes decimal money without binary floating-point
  assumptions.
- the overview prioritises Revenue Impact, then recovery, sentiment, response,
  messaging and calls;
- the attribution list is paged and gives every headline revenue amount a path
  to its order-level explanation;
- loading, empty, partial-availability and API-error states are explicit;
- production APIs never inject preview/sample revenue.

The existing tab order and working inbox/contacts/automations/calls behavior are
otherwise unchanged.

## Sentiment

Version 1 uses a deterministic local classifier over inbound customer text
only. It excludes empty/media-only messages, tapbacks, replies/reactions,
explicit internal/test numbers and mixed emotional cues. It stores the score,
label, classifier/version and confidence, not a duplicate of the raw body.

This avoids sending additional customer content to an external model. Any
future AI classifier must still pass through `lib/openrouter-private.js`, use
the minimum necessary text, be separately versioned/validated, and never
silently overwrite old classifications.

`scripts/backfill-sentiment.js` is aggregate-only and read-only by default.
Like revenue backfill, persistence requires both `--persist` and
`ANALYTICS_BACKFILL_APPROVED=YES`.

## Data quality and reconciliation

- Telnyx provider IDs, GHL IDs and call-control IDs deduplicate activity.
- Woo delivery IDs/dedup keys deduplicate commerce webhooks.
- phone identity is normalised before matching; missing/mismatched identity
  makes revenue Unattributed.
- one unique `(workspace_id, order_id)` prevents double revenue credit.
- refunds and cancellations trigger reconciliation; previous classifications
  remain in revision history.
- internal/test phones and order IDs are centrally supplied through environment
  exclusions.
- timestamps use UTC in storage and the configured account timezone only at
  range boundaries/presentation.
- source safety ceilings surface warnings rather than silently returning a
  complete-looking partial result.

Woo's order API explicitly supplies `date_paid_gmt`, status and refunds used for
these decisions: [WooCommerce order schema](https://woocommerce.github.io/woocommerce-rest-api-docs/#orders).

## Future workflow compatibility

Future campaign/reorder/back-in-stock/win-back/payment-opportunity records can
attach workflow/category and originating action IDs to the same attribution
contract. They must also record cohort/eligibility, consent checks, quiet hours,
send limits, human-control mode and their own configurable attribution rule.

Suggested, Approval Required and Autonomous execution modes belong to the
future automation system—not this analytics release. Autonomous must never be
the default. Adding a future category must not automatically enable historical
Influenced revenue.

## Current account boundary limitation

The live Vici deployment is one hard-coded workspace behind the application's
existing shared authenticated session. It therefore does **not** yet support
defensible per-staff usage metrics or safe multi-client tenancy. The new tables
carry `workspace_id` to avoid a dead-end, but onboarding another business into
the same backend requires tenant-aware identities, memberships and server-side
workspace authorization first. Until that exists, deploy separate isolated
backend/database environments per client and never present team-member
performance as available analytics.

## Deployment sequence

1. Review and back up the current Supabase project according to the project's
   existing backup plan.
2. Apply the additive analytics migration once.
3. Deploy backend hooks/API with analytics failures isolated from source flows.
4. Run authenticated API smoke checks with empty analytics tables.
5. Run candidate-only revenue and aggregate-only sentiment dry runs.
6. Manually review attribution samples and confirm exclusion/settings inputs.
7. Stage and atomically promote the approved historical cohort; existing live
   rows win and a failed promotion rolls back completely.
8. Reconcile API totals against the approved aggregate report.
9. Run the non-signing iOS build workflow from that exact commit.
10. Only then ship the same commit through the existing TestFlight workflow.
11. Observe source webhook errors, truncation warnings and event/version changes.
