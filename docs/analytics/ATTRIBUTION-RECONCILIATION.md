# Attribution reconciliation

Revenue has one published winner per workspace and WooCommerce order. The
winner is not whichever workflow writes last.

## Runtime path

1. A trusted workflow evaluates evidence and creates a Direct, Strong,
   Influenced, or Unattributed candidate.
2. `lib/analytics/reconciliation.js` validates the fixed confidence/score
   mapping and calls `stage_revenue_attribution_candidate` once.
3. Postgres locks that exact workspace/order, retains the candidate, accepts
   financial state only when its authoritative observation is not stale, and
   recomputes all candidates with deterministic rules.
4. One candidate is marked winner and the existing `revenue_attributions` row
   is updated. Its revision trigger retains the prior published result.

The order-state table is deliberately separate from candidate evidence. A Woo
refund or cancellation therefore reduces or invalidates the global winner,
whether the winning touch was payment recovery, a future campaign, a call, or
a conversation.

## Safety properties

- Workspace and order are part of every key, lookup, lock, and write.
- A partial unique index permits only one staged winner per workspace/order.
- The existing unique key permits only one published winner.
- Candidate and financial observation timestamps reject stale retries.
- Direct/Strong/Influenced/Unattributed use the fixed 1.00/0.90/0.60/0.00 map.
- The RPC is `SECURITY DEFINER` with an empty search path and is executable only
  by the service role; client roles have no table access.
- Existing winners are seeded before reconciliation is enabled.
- Provider acceptance is not delivery. Campaign analytics counts only a final
  delivery event carrying explicit trusted verification metadata.

## Campaign candidate generation

`lib/campaigns/attribution-generator.js` now supplies campaign candidates only
from a complete active `campaign_attribution_policies` version set, an approved
frozen recipient, a canonical signed Telnyx delivery, exact customer identity,
authoritative Woo payment and, where required, exact frozen product/variation.
It runs from the existing trusted Woo paid/refund/cancel reconciliation and
stages through the same RPC as payment recovery.

Missing schema, incomplete policy, missing identifiers, legacy SKU/name data,
untrusted acceptance/delivery, and mismatched products either make generation
unavailable or produce Unattributed. They never become revenue by proximity.

## Deliberately not enabled

This foundation does not infer historical campaign revenue, enable a campaign
worker, or send messages. Direct campaign attribution also remains unavailable
until a real signed link, recipient-bound coupon, or deterministic intent
ledger is implemented. The versioned default Direct allowlist is empty.
