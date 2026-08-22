# Campaign backend completion audit

Date: 22 August 2026  
Scope: master-prompt Phases 2–7 and 9, backend/campaign requirements only.  
Status vocabulary: **Repository ready** means implemented and tested offline; it does not mean migrated, deployed, provider-approved, or live.

No migration was run, no external service was called, no campaign was scheduled, and no SMS or notification was dispatched during this audit. All live gates remain off.

## Requirement matrix

| Phase / requirement | Status | Evidence | Remaining boundary |
| --- | --- | --- | --- |
| 2 — additive tenant-scoped campaign schema and lifecycle | Repository ready | `scripts/campaigns-migration.sql`; `test/campaign-migration.test.js` | Migration has not been applied to staging or production. |
| 2 — draft, review, reject, two-phase audited approval, schedule and cancel API | Repository ready | `routes/campaigns.js`; `lib/campaigns/service.js`; `test/campaign-api.test.js` | Scheduling correctly returns disabled until every live gate is deliberately enabled. There is no launch/send endpoint. |
| 2 — Admin/Owner authority and Support Agent restrictions | Repository ready | `scripts/rbac-migration.sql`; `lib/route-policy.js`; `test/route-policy.test.js`; `test/audit-log.test.js` | Runtime permission grants depend on applying the RBAC migration and reconciliation. |
| 2 — frozen reviewed audience and mandatory re-review after edits | Repository ready | `prepare_sms_campaign_approval`, `finalize_sms_campaign_approval`, and `replace_sms_campaign_draft` in `scripts/campaigns-migration.sql`; approval retry tests in `test/campaign-api.test.js` | Frozen rows remain visible when later suppressed; they are not silently removed. |
| 2 — live suppression and cadence | Repository ready for current authoritative sources | `lib/campaigns/eligibility.js`; `claim_sms_campaign_recipients` in `scripts/campaigns-migration.sql`; `test/campaign-eligibility.test.js`; `test/campaign-migration.test.js` | Claim rechecks positive consent, STOP, contact opt-out, current GHL SMS DND, authoritative suppression, quiet hours and cadence. Production commerce/support adapters must add a suppression or close an opportunity when a customer converts, stock changes, or a support problem opens. |
| 2 — durable recipient jobs, concurrency, retries and callback reconciliation contract | Repository ready, worker intentionally absent | queue/ledger/event tables and claim/begin/heartbeat/accept/result/release RPCs in `scripts/campaigns-migration.sql`; `test/campaign-migration.test.js`; `lib/campaigns/analytics.js` | No sender, scheduler runner, Telnyx call, provider lookup reconciler, or automatic resolution of `reconciliation_required` exists. This is intentional until provider/carrier approval and a separate worker review. |
| 2 — feature flags / kill switches | Repository ready and off | `.env.example`; `lib/campaigns/eligibility.js`; `lib/campaigns/opportunity-orchestrator.js`; `test/campaign-eligibility.test.js`; `test/campaign-opportunity-orchestrator.test.js` | Live requires exact lowercase environment opt-in plus DB provider evidence and DB live opt-in. Detector persistence now requires an overall flag plus its exact workflow flag. |
| 2 — legacy intelligence suggestion cannot bypass gates | Repository ready | `routes/intelligence.js`; `test/campaign-api.test.js` | Still no permission to send while the gates are off or consent/DND evidence is insufficient. |
| 3 — manual campaign with explicit safe recipients | Repository ready | `POST /api/campaigns`, edit/review/recipient/dry-run/approve/reject/schedule/cancel routes; `lib/campaigns/service.js`; `test/campaign-api.test.js` | “Send now” is represented by a current schedule time, but remains disabled with the live gates. |
| 3 — review inclusion/exclusion reasons before approval | Repository ready | `POST /api/campaigns/:id/dry-run`; `GET /api/campaigns/:id/recipients`; `lib/campaigns/service.js` | Preview is capped to 500 detailed rows while aggregate counts cover the frozen audience. |
| 3 — **All Eligible SMS Subscribers** selector | Not shipped; safety-blocked | Absence is explicit in `docs/campaigns/CAMPAIGNS-ARCHITECTURE.md`; last authorised consent analysis in `docs/campaigns/CADENCE-DRY-RUN.md` | Do not implement a broad-audience shortcut until a paginated workspace-scoped selector, verified positive promotional-consent coverage, complete DND/suppression inputs, and private sample review exist. Explicit-recipient manual drafts remain available. |
| 4 — signed, deduplicated Woo inventory evidence | Repository ready | `routes/webhook-woocommerce.js`; `lib/woocommerce-webhook.js`; `scripts/campaigns-migration.sql`; `test/woocommerce-product-webhook.test.js` | Product webhook only records trusted evidence; it never drafts or sends. |
| 4 — exact unavailable→available restock detector, debounce, authoritative refetch and dedupe | Repository ready, default off | `lib/campaigns/back-in-stock.js`; `lib/campaigns/opportunity-orchestrator.js`; `lib/campaigns/generation-service.js`; `test/campaign-back-in-stock.test.js`; `test/campaign-generation.test.js` | Admin-triggered server-owned dry-run/draft generation and exact Woo refetch are ready. No scheduler or live dispatch exists; detector/persistence flags default off. |
| 5 — reorder cadence based on real intervals, conservative fallback, dedupe and expiry | Repository ready, default off | `lib/campaigns/reorder-cadence.js`; `lib/campaigns/opportunity-orchestrator.js`; `lib/campaigns/generation-service.js`; `test/campaign-reorder-winback.test.js`; `test/campaign-generation.test.js` | Paginated Vici production inputs and atomic drafts are ready. No daily scheduler exists. Fresh authoritative commercial-support state is required and not yet populated. |
| 6 — cadence-relative win-back, value/history blockers and cooldown | Repository ready, default off | `lib/campaigns/winback.js`; `lib/campaigns/opportunity-policy.js`; `lib/campaigns/opportunity-orchestrator.js`; `lib/campaigns/generation-service.js`; `test/campaign-reorder-winback.test.js` | Admin-triggered production cohort assembly and atomic drafts are ready. No weekly scheduler/live dispatch exists; unknown support state suppresses candidates. |
| 7 — unconverted-enquiry detector | Intentionally not shipped | `docs/campaigns/SEGMENTATION-METHODOLOGY.md`; only future priority/expiry taxonomy in `lib/campaigns/opportunity-policy.js` | The master prompt requires acceptable sample accuracy first. No labelled private evaluation demonstrates that buying intent can be separated reliably from delivery, refund, or support complaints, so no classifier or draft generator was enabled. |
| Cross-phase — deterministic collision and opportunity expiry | Repository ready | `lib/campaigns/opportunity-policy.js`; `lib/campaigns/opportunity-orchestrator.js`; `test/campaign-opportunity-policy.test.js`; `test/campaign-opportunity-orchestrator.test.js` | Lower-priority items are recorded as suppressed/deferred; active payment recovery wins over promotion. Production closure inputs still require the adapters above. |
| Cross-phase — Admin-ready notification preparation, coalescing, review count and owned-device APNs delivery | Repository ready; default off | `lib/campaigns/campaign-ready-notifications.js`; `sendCampaignReadyNotifications` in `lib/apns-notify.js`; `POST /api/campaigns/generate`; `test/campaign-apns-notify.test.js`; `test/campaign-api.test.js` | Successful committed generation invokes the permission-scoped dispatcher and writes one aggregate PII-free audit event. Real APNs delivery still requires its separate default-off flag; push failure never rolls back a draft. |
| 9 — 2/4/6 cadence dry-run and centrally controlled V1 policy | Repository ready; external rerun not performed | `scripts/dry-run-campaign-cadence.js`; `lib/campaigns/cadence-policy.js`; `test/campaign-dry-run.test.js`; `test/campaign-cadence-policy.test.js`; `docs/campaigns/CADENCE-DRY-RUN.md` | The stored 22 August snapshot is historical, not a current launch audience. The analyser now fails closed on unavailable consent, DND, authoritative suppression, or commercial-contact ledger sources. No fatigue/revenue claim is made. |

## Current safety posture

- `CAMPAIGNS_LIVE_SEND_ENABLED=false` is documented and exact lowercase `true` is required.
- `sms_campaign_settings.provider_approved` and `live_send_enabled` both default to `false`; provider approval additionally requires a reference, timestamp, and approving user.
- Draft detector persistence defaults off through `CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED=false` and separate default-off restock, reorder, and win-back flags.
- Permission-sensitive campaign-review APNs delivery separately defaults off through `CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED=false`; draft creation never implies notification authority.
- Missing or stale consent/DND/suppression/cadence evidence fails closed.
- The migration seeds no customer, staff, test phone, credential, provider ID, consent, or live approval.
- No JavaScript delivery worker exists, so repository code cannot turn a scheduled campaign into provider traffic.

## Exact next controlled sequence

1. Review and apply prerequisites, then the additive migrations in a backed-up staging environment; perform the documented read-only schema/RLS/RPC checks.
2. Populate authoritative staff/test suppressions and verified promotional consent evidence through an audited service-role path; do not infer consent from orders or transactional messages.
3. Populate the new authoritative commercial-support projection. Missing, stale or future-dated state intentionally suppresses generation.
4. Use the server-owned Admin generation endpoint in aggregate dry-run mode and manually validate private samples of every inclusion and suppression reason. Keep all persistence/live gates off.
5. In staging, enable only the overall draft flag plus one detector flag and validate the atomic bundle, exact product/variation evidence, idempotent retry and aggregate audit. Keep APNs separately off until its target dry-run is approved.
6. Obtain written carrier/provider approval for the exact brand, products, message types, numbers, and representative promotional copy.
7. If desired, separately enable the already-connected owned-device campaign-review APNs dispatcher after verifying target ownership; a push failure cannot change campaign state.
8. Separately design and approve the SMS delivery worker and provider reconciliation adapter; only after staging fault tests may an Owner enable the DB gates and environment switch in a controlled release.

## Offline verification

- Campaign/APNs/detector/cadence/RBAC/Woo focused checks: passed.
- Complete Node test suite: **690 passed, 0 failed**.
- JavaScript syntax checks: passed.
- `git diff --check`: passed.
- Scoped credential/private-key scan of the changed campaign files: no matches.

The complete suite's HTTP routing tests require permission to bind a temporary localhost listener. A sandbox-only attempt produced `listen EPERM`; the identical approved offline command passed all 690 tests. This was an execution-environment restriction, not a product failure.
