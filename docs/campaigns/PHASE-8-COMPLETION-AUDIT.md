# Phase 8 campaign analytics completion audit

Audit date: 22 August 2026

Scope: the campaign attribution policy, campaign-specific analytics, global
Analytics rollup, realtime behavior, data quality, privacy, historical claims,
and cadence claims requested by `VICI_Full_Next_Build_Master_Prompt.md`.

## Executive conclusion

The repository contains the conservative campaign classification policy,
atomic global-winner persistence foundation, bounded campaign analytics read
APIs, drill-down DTOs, global revenue-driver rollup, and a future-order
candidate generator wired to trusted Woo reconciliation. Live campaign sending
remains disabled. Campaign revenue attribution reports unavailable until the
additive versioned policy migration is present, rather than showing a
believable zero during an out-of-order deploy.

This is the correct fail-closed state. Implemented infrastructure must not be
described as measured campaign revenue.

## Requirement audit

| Requirement | Status | Current evidence / boundary |
|---|---|---|
| Direct / Strong / Influenced / Unattributed | Satisfied as deterministic policy | `lib/campaigns/attribution-policy.js`; unknown, contradictory, missing-identity, missing-product, untrusted-delivery, pre-delivery, out-of-window, cancelled and refunded cases fail to Unattributed. |
| Exact campaign/order/customer/product/timestamp evidence | Satisfied as policy | Exact workspace, recipient, provider message, trusted delivery, customer/phone identity, Woo order, paid time and exact product/variation checks are required. Guest customer ID zero is not an identity. |
| Provider acceptance is not delivery | Satisfied | `lib/campaigns/analytics.js` recognizes only canonical `provider.delivered` carrying the Telnyx provider event ID and `telnyx_ed25519_v2` trust source. The SQL event contract enforces the same boundary. |
| Configurable attribution windows | Satisfied | `campaign_attribution_policies` stores one active version per tenant/workflow; the production generator loads the complete set and fails closed on missing, malformed or policy-weakening rows. |
| One workspace/order winner | Satisfied as persistence foundation | `scripts/attribution-reconciliation-migration.sql` stages all workflow candidates, serializes one workspace/order, rejects stale observations and publishes one deterministic winner. Existing winners are seeded before use. |
| Refund, cancellation, downgrade and audit | Satisfied as persistence foundation | Authoritative order state adjusts the global winner; the existing revision trigger preserves published history. Losing candidates remain in the candidate ledger. |
| Production campaign candidate generation | Satisfied for future paid/refund/cancel events | The trusted Woo path pages exact campaign touches, verifies frozen approval and canonical signed delivery, classifies and stages through the global RPC. It does not generate historical candidates. |
| Campaign operational metrics | Satisfied as read path | `GET /api/campaigns/:id/performance` reports accepted, delivered, replies, opt-outs, queued, failed, skipped and cancelled without financial access. |
| Campaign financial metrics and drill-down | Satisfied | Analytics-only endpoints split Direct, Strong and Influenced revenue, refunds, conversion and safe order evidence. They show only persisted global winners. |
| Honest availability state | Satisfied | Availability is derived from the complete active versioned policy set. Missing policy schema/rows returns unavailable and stages nothing. |
| Global Revenue Drivers | Satisfied | `lib/analytics/aggregate.js` derives payment recovery, campaigns, reorder, back-in-stock and win-back only from real globally winning rows; absent categories are omitted. |
| No double counting | Satisfied | The SQL winner and aggregate order deduplication prevent one order being credited to payment recovery and a campaign simultaneously. |
| Realtime global Analytics | Satisfied for currently wired SMS/Woo/call activity | Trusted event paths bump analytics state, broadcast `analytics_changed`, and the iOS Analytics model refreshes through the existing SSE stream with debounce. |
| Realtime campaign metrics | Partially blocked with campaign execution | Woo conversion/refund changes use the existing Analytics state/SSE refresh. There is still no live campaign sender/callback adapter to emit campaign delivery activity because delivery remains disabled. |
| Paging and bounded `.in()` | Satisfied | Campaign recipient/event/attribution reads page to a documented ceiling and legacy action IDs are chunked before `.in()`. Truncation is surfaced as warnings. |
| Duplicate and retry handling | Satisfied at schema/policy layer | Provider event IDs, Woo delivery/event identities, candidate keys, order keys, advisory locks and stale-observation guards are deterministic and idempotent. |
| Tenant isolation and RBAC | Satisfied for current single-workspace architecture | Every campaign query/RPC includes workspace; route policy is default-deny. Operational performance uses `campaigns.read`; financial routes require `analytics.read`. |
| Analytics privacy | Satisfied | Campaign analytics reads omit phone/name/message body. Public drill-down removes customer/recipient identifiers and emits only allowlisted evidence codes and safe explanations. |
| Historical campaign attribution | **Unavailable, correctly not claimed** | Historical records lack a reliable complete combination of frozen campaign recipient, exact product/variation, trusted delivery and order-bound evidence. No historical campaign revenue is persisted. |
| Historical payment recovery | Satisfied separately from campaigns | `docs/analytics/HISTORICAL-REVENUE-ANALYSIS.md` records the reviewed 20 August snapshot and explicitly leaves unsupported orders Unattributed. |
| Cadence dry-run | Satisfied as dated aggregate analysis | `docs/campaigns/CADENCE-DRY-RUN.md` records 1,281 paid orders, 44 selected opportunities and zero eligible promotional sends because positive promotional consent evidence is absent. It reports no campaign revenue and does not authorize sends. |
| Historical fatigue/conversion comparison | **Unavailable, correctly not claimed** | Historical promotional messages are not reliably classified, so the 2/4/6 monthly scenarios cannot support truthful revenue, opt-out, fatigue or conversion comparisons. |

## What remains before live campaign operation

Live campaign operation still requires a delivery worker and callback adapter
that, without weakening the current safety gates:

1. consumes a canonical signed Telnyx final-delivery event;
2. records it through the existing canonical campaign event RPC;
3. bumps/broadcasts operational campaign activity after commit;
4. passes provider throttling, restart, partial-campaign and cancellation tests.

The later authoritative Woo event already performs the exact tenant, approved
recipient, customer identity, product/variation, time-window classification,
global-winner staging, refund reconciliation and Analytics broadcast.

It must not be activated merely because the schema and UI already exist.
