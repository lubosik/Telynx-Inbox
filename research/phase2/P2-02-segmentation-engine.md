# P2-02 — Segmentation & Automation Engine

**Status:** Design document. Planning only. No application code has been written.
**Date:** 11 August 2026
**Inputs:** `research/ai-wizard/02-campaign-flows-and-segmentation.md` (primary), `00-current-state.md`, `03-compliance-and-high-risk.md`; code read: `flows/utils.js`, `flows/confirmed.js`, `flows/shipped.js`, `server.js`, `sync-woocommerce.js`, `routes/send.js`, `routes/webhook.js`.
**Scale this is designed for:** 847 contacts, 1,497 orders, 2,283 messages, 115 calls. ~26 consumable SKUs. One Railway web process.

This document answers a single question: **how does a person get chosen for a message, and how do we guarantee they never get three of them in a day?** Everything else — copy generation, projection UI, attribution — is out of scope and lives in sibling documents.

---

## 0. The five decisions, up front

If you read nothing else:

1. **Segmentation runs on a four-tier hybrid**, split by how fast the predicate goes stale — not by convenience. Nightly full recompute, event-driven single-contact invalidation, on-demand preview at build time, and a real-time gate at the moment of each send.
2. **`setInterval` survives.** It does not force a job queue at this scale. But it survives *only* with two additions that are non-negotiable: a **database lease** so overlapping deploys cannot double-run a job, and a **claim-then-send** transition on every outbound row. Without those two, the current architecture double-sends today and it is luck, not design, that it has not yet.
3. **The multi-segment hypothesis is validated**, with two amendments. Segment *membership* overlaps freely; conflicts resolve at send time by campaign priority plus a per-contact frequency cap. But `lifecycle_stage` must stay single-valued (it is a routing key, not an audience), and two campaigns of the *same flow type* must never both hold the same contact — enforced by a partial unique index.
4. **Membership freezes at approval, and can only ever shrink after that.** Nothing re-expands mid-send. Every individual send re-checks opt-out, suppression, quiet hours, frequency and recent-purchase synchronously, in that order, and drops or defers accordingly.
5. **The engine prefers a missing marketing message to a duplicate one**, everywhere, without exception. Every ambiguous state resolves toward not-sending. A duplicate marketing SMS is a compliance incident at $500–$1,500 statutory exposure per message; a missed one costs a fraction of one expected order.

---

## 1. When does segmentation run?

### 1.1 The wrong answers, and why

**Pure on-demand (compute at campaign build time).** Fails on replenishment. Replenishment is not "who matches this filter right now" — it is a scan over everyone, every day, looking for people whose predicted depletion date has entered the send window. There is no operator sitting there at 3am to trigger it. It also fails on any predicate defined by the *absence* of an event: "no order in 90 days" never fires a webhook.

**Pure event-driven (recompute on order / message / delivery).** Same failure, from the other side. Win-back, replenishment and sunset are all absence-of-event predicates. Nothing arrives to trigger them. Event-driven alone means those flows never fire.

**Pure scheduled (nightly, everything).** Fails the single most damaging error mode doc 02 identifies (§3.6): *"the only thing worse than not sending a replenishment message is sending one to somebody who reordered yesterday."* With a nightly-only model, a customer who orders at 09:00 can still receive a "time to restock" text at 16:00 the same day, because the metrics row that drove the send was computed at 03:00. That is the exact failure that makes an operator stop trusting the tool.

### 1.2 The recommendation — hybrid, split by predicate volatility

The correct split is not "cheap things often, expensive things rarely". It is **how fast does this predicate go stale, and what does it cost to be wrong?**

| Tier | Cadence | What it computes | Why here |
|---|---|---|---|
| **T1 — Send gate** | Synchronous, per individual send, never cached | opt-out, suppression list, consent validity, recent purchase (10d), frequency counts, cooldown, quiet hours, campaign still-active | These can invalidate between the campaign being approved and this specific message leaving. Being wrong is a legal or trust event. Never read from a cache, never from the metrics table. |
| **T2 — Event-driven** | Seconds, on webhook | On order: recompute that one contact's metrics row; cancel or re-plan their pending replenishment. On inbound message: update engagement fields. On opt-out: write suppression, cancel all their pending marketing rows. On delivery: set the replenishment anchor. | Single-contact, cheap, and closes the staleness window that matters most. |
| **T3 — Nightly** | 03:00 America/New_York | Full recompute of `sms_contact_metrics`: RFM, lifecycle stage, engagement tier, inter-purchase interval stats (log-median, MAD, CV, shrunk estimate), predicted reorder date + window + confidence, cohort medians, transit-time p90 | Everything derived and slow-moving. A day-old RFM score costs nothing, because a wrong *label* is harmless until a send happens, and a send is gated by T1. |
| **T4 — On demand** | Interactive, at campaign build | The operator's ad-hoc segment query, run live against `sms_contact_metrics` joined to `sms_orders` / `sms_messages`. Previewed, counted, exclusion-broken-down. Not persisted until approval. | The operator needs an accurate count *now*. 847 rows, sub-second. Persisting it before approval would create phantom campaigns. |

The governing principle: **a wrong label is free; a wrong send is not.** So labels can be stale and sends cannot. That is why T3 can be nightly and T1 must be synchronous, and it is why we do not need the elaborate incremental-materialisation machinery a larger system would.

### 1.3 Can we keep `setInterval`? Yes — with two mandatory additions

**The plain answer: this does not force a real job queue.** Not at 847 contacts, not at 8,470. Adding BullMQ/Redis or a hosted queue would be a significant, unnecessary scope increase for this workload. What it *does* force is fixing two specific defects in how the current timers work.

Today `server.js:117-157` runs three bare `setInterval` timers with no locking. `00-current-state.md` §2 already flags this: *"No queue, no locking, no idempotency guard beyond DB status columns. If two instances ever run, messages send twice."*

**Two instances already run.** Railway performs overlapping deploys — the new container boots and begins serving before the old one is torn down. `startScheduledQueue()` fires a catch-up run 15 seconds after boot (`server.js:120-123`). So every deploy creates a window in which two processes can both call `processScheduledQueue()` and both pull the same `pending` rows. The only thing preventing a duplicate today is the unique index behind `sms_sent_log` and the `alreadySent()` pre-check in `flows/utils.js:62-71` — which is a genuine guard for order-keyed transactional flows, and which **will not exist for marketing campaigns** unless we build it deliberately. Marketing sends have no natural `order_id` to key on.

**Addition 1 — a database lease around every timer body.**

Do *not* use `pg_advisory_lock`. Advisory locks are session-scoped, and every Supabase call goes over PostgREST against a pooled connection — a subsequent request may land on a different backend, and the lock's lifetime becomes unpredictable. This is a real trap and it will look like it works in testing.

Use an explicit lease table instead:

```sql
CREATE TABLE job_leases (
  job         text PRIMARY KEY,
  holder      text        NOT NULL,   -- process uuid, generated at boot
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
```

Acquired via an RPC so the whole thing is one atomic statement:

```sql
CREATE FUNCTION acquire_job_lease(p_job text, p_holder text, p_ttl interval)
RETURNS boolean LANGUAGE sql AS $$
  INSERT INTO job_leases (job, holder, expires_at)
  VALUES (p_job, p_holder, now() + p_ttl)
  ON CONFLICT (job) DO UPDATE
    SET holder = EXCLUDED.holder,
        acquired_at = now(),
        expires_at = EXCLUDED.expires_at
    WHERE job_leases.expires_at < now()
  RETURNING holder = p_holder;
$$;
```

Returns `true` only if this process now holds it. Returns no row (treat as `false`) if someone else holds a live lease. Restart-safe: a crashed holder's lease simply expires. Release on clean completion by setting `expires_at = now()`.

Wrap every timer body:

```js
const HOLDER = crypto.randomUUID();
async function withLease(job, ttlMinutes, fn) {
  const { data } = await supabase.rpc('acquire_job_lease',
    { p_job: job, p_holder: HOLDER, p_ttl: `${ttlMinutes} minutes` });
  if (data !== true) { console.log(`[LEASE] ${job} held elsewhere, skipping`); return; }
  try { await fn(); }
  finally { await supabase.rpc('release_job_lease', { p_job: job, p_holder: HOLDER }); }
}
```

TTL must exceed the job's worst-case runtime. Use 10 min for the 5-minute queue tick, 30 min for the ShipStation poll, 60 min for the nightly recompute.

**Addition 2 — re-entrancy guard on the tick itself.** A single process can also overlap with itself if a tick runs longer than 5 minutes. A module-level `let running = false` flag around each timer body handles this and costs one line. The lease covers cross-process; the flag covers intra-process.

**Where `setInterval` actually breaks — say the number.**

| Constraint | Breaks at | Symptom |
|---|---|---|
| Send-time precision | Any flow needing sub-5-minute accuracy | The tick is the granularity floor. Fine for replenishment (day-level), fine for abandoned checkout (30 min target), unusable for anything real-time. |
| Single-worker throughput | ~5,000 sends per tick | 25-row claim batches × sequential Telnyx calls at ~200ms each. 5,000 sends ≈ 17 min > tick interval. Mitigated by widening the batch and parallelising sends 5-wide before it becomes a real problem. |
| Volume | ~50,000 sends/day | Below this, one leased worker is fine. Above it you want parallel workers, which the lease design forbids by construction. That is the moment to buy a queue. |
| Retry semantics | When you need exponential backoff with jitter across hours | The `attempts` column plus a `next_attempt_at` gets you three tries. Beyond that, use a queue. |
| Multi-tenant | The second tenant on one deployment | Per-tenant fairness and isolation are what queues are for. This is the fork question from `00-current-state.md` §7, not a queue question. |

**Verdict: keep `setInterval`. Add the lease and the claim pattern. Revisit at ~50k sends/day or the moment multi-tenancy lands.** The lease is roughly 60 lines including the RPCs. A job queue is a new infrastructure dependency, a new failure surface, and a deployment change. The cost/benefit is not close.

---

## 2. The multi-segment question

The hypothesis under test:

> *Membership should overlap freely, and conflicts should be resolved at send time by campaign priority plus a per-contact frequency cap, rather than by forcing exclusivity.*

**Verdict: VALIDATED**, with two amendments and one condition. The condition is load-bearing and is where naive implementations of this hypothesis fail.

### 2.1 Working the realistic cases

**Case A — a VIP who is also due a reorder.**

Under forced exclusivity, you must pick an owner. Whichever you pick is wrong: assign them to VIP and they miss the reorder prompt tied to a real, dated need; assign them to replenishment and the VIP treatment never happens. There is no third option, because exclusivity is a partition.

Under overlap-plus-priority there is not even a conflict, because **VIP is not a sending campaign.** Doc 02 §1.10 is explicit: at 847 contacts the top decile is ~85 people, that is a concierge list not a campaign segment, and the correct build is *a VIP view in the inbox*, not an automated flow. So the VIP label is a display attribute and the replenishment message sends. The exclusivity model forces you to answer a question that overlap dissolves.

This generalises: **most "conflicts" are between a label and a campaign, and labels do not send messages.**

**Case B — a lapsed customer who places an order mid-campaign.**

This is the case that refutes exclusivity most cleanly, because **exclusivity does not help at all.** Exclusivity is evaluated when the audience is built. The order arrives afterwards. Whatever partition you computed at 14:00 is stale at 14:30 regardless of whether it was exclusive.

The only fix is a **real-time re-check at the moment of the individual send** — the `recent_purchaser` gate. That is a drift control (§3), not a membership control. Anyone who proposes exclusivity as the answer to this case has misdiagnosed it.

**Case C — someone in both "back in stock" and "win-back".**

Both plausibly fire on the same day. Under exclusivity the person carries one label, probably `lapsed` since that is the more durable attribute, and therefore **does not receive the restock alert they explicitly asked for** — a message that converts at 6.0–14.3% (doc 02 §1.11, the highest of any type) is suppressed in favour of one that converts at 0.4–1.6% and is the single most opt-out-generating flow in the taxonomy (§1.9). Exclusivity produces exactly the wrong outcome, and produces it silently.

Under overlap plus priority: back-in-stock has higher priority and is exempt from the frequency bucket (doc 02 §4.2, and I agree with that call), so it sends immediately. Win-back is deferred by the 48-hour cooldown. When it re-evaluates two days later, one of two things is true — either the person bought, in which case `recent_purchaser` suppresses the win-back automatically and correctly, or they did not, in which case the win-back sends on a contact who has just demonstrated engagement. **The system self-corrects in both branches without anyone specifying the interaction.** That is the strongest argument for the model: the correct behaviour is emergent rather than enumerated.

### 2.2 Amendment 1 — `lifecycle_stage` stays single-valued

Doc 02 §3.3 already writes lifecycle as a `CASE` expression, which is single-valued by construction, and that is right. Lifecycle is not an audience — it is a **routing key** that determines which flow a contact is *eligible* for. A contact cannot be simultaneously `first_purchase_active` and `repeat_lapsed`; those are states of one variable.

So the precise statement is: **descriptive labels overlap (RFM segment, engagement tier, product affinity, VIP); the lifecycle state does not.** Do not let "overlap freely" bleed into making lifecycle multi-valued, or the flow-routing logic loses its only clean discriminator.

### 2.3 Amendment 2 — exclusivity *within* a flow type

Overlap across flows, never within one. Two concurrently active replenishment campaigns must not both hold the same contact — that is not a priority conflict, it is a bug, and priority resolution would silently mask it as a deferral.

Enforce it in the schema, not in code:

```sql
CREATE UNIQUE INDEX ux_one_live_row_per_flow
  ON sms_campaign_recipients (phone, flow_type)
  WHERE state IN ('pending','claimed','sending');
```

The materialiser handles the resulting `23505` by skipping that contact with `skip_reason = 'already_queued_same_flow'`. This is the same defensive pattern `flows/utils.js:107-113` already uses for `sms_sent_log`, and it works for the same reason: the database is the only place a uniqueness claim can actually be made under concurrency.

### 2.4 The condition — overlap without deferral is worse than exclusivity

Here is where the hypothesis fails if implemented naively.

If contention losers are simply **dropped**, a contact who is persistently eligible for several flows will receive only the highest-priority one, forever. A tight-cycle replenishment customer would never get a review request, because replenishment outranks it every single time. Worse, the operator's campaign silently shrinks with no explanation, which reproduces the trust failure doc 02 §7.4 warns about from the other direction.

So the hypothesis is only correct in the form: **overlap freely + priority + frequency cap + a deferral queue with per-flow expiry + a visible exclusion breakdown.** Drop any of the last three and it degrades below exclusivity. Specified in §2.5–2.6.

### 2.5 The conflict-resolution algorithm

Runs inside the send worker, per contact, over all rows for that contact that are `pending` and due.

**Step 1 — gather.** Select all `sms_campaign_recipients` rows for this phone with `state='pending'` and `planned_send_at <= now()`.

**Step 2 — hard-filter.** Apply suppression gate checks 1–7 (§5). Rows failing a hard block are terminated now, not ranked. They never enter contention.

**Step 3 — partition by budget.** Split survivors into `exempt` (does not consume a frequency token) and `budgeted`.

```
EXEMPT   — transactional flows, back-in-stock, replies inside an open conversation
BUDGETED — replenishment, win-back, review request, cross-sell, broadcast/promo
```

All exempt rows send (still subject to quiet hours and the Florida statutory cap — §4.5).

**Step 4 — rank the budgeted rows.**

```
ORDER BY
  1. priority DESC                      -- static integer on the campaign
  2. expected_value DESC                -- p_flow × AOV_segment × (1 − haircut)
  3. planned_send_at ASC                -- the one that has waited longest
  4. campaign_id ASC                    -- deterministic final tie-break
```

Static priorities:

| Priority | Flow | Rationale |
|---:|---|---|
| 100 | Transactional (`confirmed`, `shipped`, `hold`, `failed`, delivery) | Expected, requested, exempt |
| 90 | Back-in-stock | Explicitly requested for a specific SKU; 6.0–14.3% CR; exempt |
| 70 | Replenishment, high confidence (CV < 0.35) | Dated need; late-error is unrecoverable (doc 02 §2.3) |
| 60 | Replenishment, medium confidence (0.35 ≤ CV < 0.75) | Same, wider window |
| 50 | Post-purchase education / cross-sell (delivery-triggered) | Recurring, whole base |
| 40 | Review request (21–30d post-delivery) | Revenue-indirect but compounding |
| 30 | Win-back | Lowest CR, highest opt-out risk |
| 20 | Broadcast / promo | Undifferentiated |
| 10 | Everything else | |

Priority is a column on `sms_campaigns`, defaulted from flow type and editable by the operator at approval. Doc 02 §4.2 proposes ranking purely by `p_flow × AOV_segment × (1 − haircut)`. **I am demoting that to the tie-break rather than the primary sort.** At 847 contacts, `p_flow` is an empirical-Bayes posterior over a handful of conversions (doc 02 §5.2); its ordering is noise-dominated and it would reshuffle priorities between weeks for no real reason. A static ladder is stable, explicable to the operator, and auditable. The EV term earns its place only when two rows sit on the same rung.

**Step 5 — spend.** Compute the remaining token count (§4). Award tokens down the ranked list until exhausted.

**Step 6 — dispose of the losers.** Deferred, not dropped, *if the flow is deferrable*:

| Flow | Loser disposition | Expiry after freeze | Reasoning |
|---|---|---|---|
| Replenishment | Defer | 5 days | The date carries meaning. Past 5 days the prediction is stale — expire and let the next nightly run re-derive it from current data rather than sending a wrong-dated message. |
| Win-back | Defer | 14 days | Nothing time-critical. |
| Review request | Defer | 14 days | Response rates fall 60–70% after two weeks (doc 02 §1.7), so expiry past that is correct anyway. |
| Post-purchase cross-sell | Defer | 7 days | Anchored on delivery; loses relevance slowly. |
| Broadcast / promo | **Drop** | n/a | A dated one-off. Deferring a Black Friday text to Tuesday is worse than not sending it. Reported to the operator as *"sent to 137 of 214 — 22 frequency-capped"*, per doc 02 §4.3's silent-suppression pattern. |
| Back-in-stock | Never deferred (exempt) | 72 h hard expiry | If it could not send in three days the stock situation has probably changed. |

Deferred rows go back to `state='pending'` with `planned_send_at` advanced to the earliest moment the blocking constraint clears (next token free / cooldown end / quiet-hours open — whichever is latest), `defer_count` incremented, and `expires_at` unchanged. A row hitting `expires_at` transitions to `expired` with its last blocking reason recorded. Expired and dropped rows are equally visible in the campaign report; the operator should never have to wonder where someone went.

---

## 3. Segment drift during a send

### 3.1 Freeze point: approval, and only approval

The lifecycle of an audience:

| Stage | Actor | What exists | Membership can |
|---|---|---|---|
| **Build** | Operator, interactive | A segment *definition* (SQL / filter set). Counts previewed live. Nothing persisted. | Change freely — it is a query, not a list |
| **Approve** | Named human | Definition executes once. Rows written to `sms_campaign_recipients` with `state='pending'`. `sms_campaigns.frozen_at = now()`. | **FROZEN. This is the boundary.** |
| **Send** | Worker | Rows claimed and sent individually | **Only shrink.** Never re-expand. |

**Membership is monotonically non-increasing after `frozen_at`.** A contact who becomes eligible at 15:00 for a campaign frozen at 14:00 does not join it. They are picked up by the next run of that flow.

The alternative — a live-evaluating audience that re-expands during the send — is what most platforms do and it is wrong for us. It makes the audience unbounded (an operator approves 214 and 260 get messaged), makes the approval meaningless as an authorisation artefact, makes the campaign report un-reconcilable, and at 847 contacts the upside is a handful of extra recipients who will be caught tomorrow anyway.

### 3.2 What is re-checked at each individual send

Non-negotiable, synchronous, per contact, immediately before the Telnyx call. Full ordering in §5; the minimum set:

1. **Opt-out / suppression** — a fresh read of `sms_suppressions`. Never cached beyond the request. Doc 03 §8.2 B21 states this as a hard block and doc 03 §5.4 sets the engineering target at *real-time, synchronous, before the next send*. A campaign that takes two hours to drain will have people opt out during it; every message after their STOP is separate statutory exposure.
2. **Consent validity** — a `consent_event_id` must resolve. Doc 03 §8.2 B27 makes this referential integrity, and §5.6 makes it one of the eight fields that wins a TCPA case.
3. **Campaign still active** — cancelled campaigns must stop mid-drain (§10.5).
4. **Recent purchaser** — an order in the last 10 days (§3.3).
5. **Frequency budget and cooldown** — recomputed live, because sibling campaigns may have spent tokens since the freeze.
6. **Quiet hours in the recipient's local time** — recomputed live, because a deferred row's original `planned_send_at` may have drifted across a boundary.
7. **Duplicate guard** — the claim itself (§6).

Checks 1, 2 and 7 are the irreducible minimum. The others are the difference between a system the operator trusts and one they do not.

### 3.3 The mid-campaign purchaser

The most common and most damaging drift case. Three mechanisms, layered:

**Mechanism 1 — event-driven cancellation (T2).** The WooCommerce order webhook already runs `syncOrder()` (`sync-woocommerce.js:8`). Extend the same handler: after the order is written, cancel that contact's pending marketing rows in the flows the purchase invalidates.

```
on order.created / order.updated → status in (processing, completed, shipped, delivered):
  UPDATE sms_campaign_recipients
     SET state = 'cancelled', skip_reason = 'purchased_after_freeze'
   WHERE phone = :phone
     AND state = 'pending'
     AND flow_type IN ('mkt:replenishment','mkt:winback','mkt:promo','mkt:crosssell');
  → recompute that contact's metrics row (new gap, new predicted reorder date)
```

Review requests are deliberately excluded — a new order does not invalidate a pending review request for an earlier delivered one. Back-in-stock is excluded because the customer may have bought a different SKU.

**Mechanism 2 — the send-time gate.** Webhooks can be missed, delayed, or arrive out of order. So the `recent_purchaser` check runs again at send time regardless: any order in `('processing','completed','shipped','delivered')` within 10 days terminates the row.

**Mechanism 3 — disposition is flow-specific.**

- **Replenishment:** terminate with `skip_reason='purchased_after_freeze'`, and immediately recompute the prediction. The purchase *is* the reorder. This is the flow working, not failing — record it as an attribution candidate (`converted_before_send`), because it is evidence the timing model was approximately right, and that is worth surfacing.
- **Win-back / promo / cross-sell:** terminate. Doc 02 §3.6 is unambiguous that selling to someone who just bought is the fastest route to losing the client's confidence.
- **Broadcast the operator has explicitly marked informational** (a product launch, a policy change): the campaign carries an `ignores_recent_purchaser` boolean, settable only at approval, recorded with the approving actor and a written reason. This is the single legitimate exception and it must be a deliberate, logged act.

---

## 4. The per-contact frequency budget

### 4.1 Implementation: a rolling-window count, not a stateful bucket

Doc 02 §4.2 specifies a token bucket with capacity `B = 4` and refill `R = 4/30 days`. **I am implementing the semantics and refuting the mechanism.**

A literal bucket needs persisted per-contact state (`tokens`, `last_refill_at`) that can drift from reality after a crash, a manual send, a partial rollback, or a backfill. It is also unanswerable after the fact: when the operator asks *"why was Sarah capped?"*, a bucket can only say `tokens = 0`.

A **rolling-window `COUNT` over the send ledger** has identical semantics for a bucket whose capacity equals its refill quantity (which is what doc 02 specifies), has no state to corrupt, is trivially restart-safe, and answers the operator's question directly by listing the messages that consumed the budget. At 847 contacts the query cost is irrelevant.

```sql
-- Marketing sends in the trailing 30 days, for one contact.
SELECT count(*)
  FROM sms_campaign_recipients
 WHERE phone = :phone
   AND state = 'sent'
   AND sent_at > now() - interval '30 days'
   AND consumes_budget IS TRUE;
```

`consumes_budget` is denormalised onto the recipient row at materialisation, from the campaign's flow type, so the cap query never needs a join and the historical record cannot be retroactively changed by an operator reclassifying a flow.

### 4.2 Window, budget, tiers

- **Window:** rolling 30 days. Not calendar month — a calendar month lets a contact receive the December allowance on the 30th and the January allowance on the 1st.
- **Budget:** tiered by engagement, per doc 02 §4.2, using the reply-based engagement tier from §3.4 (Telynx has inbound replies and tapback reactions, which are a stronger and unspoofable signal versus click tracking we do not have).

| Engagement tier | Marketing cap / 30d | Source |
|---|---:|---|
| `engaged` — inbound reply < 30d | 6 | doc 02 §4.2 |
| `less_engaged` — reply 30–90d | 4 | Klaviyo's explicit guidance for this tier |
| `unengaged` / `never_responded` | 2 | |
| `fatigue_risk` (doc 02 §3.6 rule 7) | 0 | Transactional only |

**Ship a flat 4 for everyone in Phase 2 and tier it in Phase 6.** The cap is the safety property; the tiering is a refinement. Do not block the safety property on the refinement.

Note the interaction with doc 02 §3.4's Vici adjustment: `never_responded` is not a meaningful negative signal for a transactional program, because nobody replies to a shipping notification. It gets 2 rather than 0 for exactly that reason.

- **Cooldown:** 48 hours minimum between two *marketing* messages. See §4.4 — this is a deliberate narrowing of doc 02's text.

### 4.3 Why transactional messages do not consume the budget

Four independent reasons, in descending order of how much they should convince you:

1. **The consent basis is different.** 47 CFR § 64.1200(f)(15) defines "telephone solicitation" as a message *"for the purpose of encouraging the purchase"*, and excludes messages sent with prior express invitation or permission and those inside an established business relationship (doc 03 §4.4). An order confirmation is not a solicitation. The fatigue budget is a marketing-pressure control; applying it to a legally distinct category is a category error.
2. **Suppressing them inverts the goal.** The cap exists to prevent the customer feeling harassed. Withholding "your order shipped" does not reduce annoyance — it generates a support ticket, which is more contact, initiated by a frustrated customer. Doc 02 §1.6 identifies shipping notifications as *the single most-wanted transactional text*.
3. **The evidence measures marketing.** Every figure in doc 02 §4.1 — the 56%-unsubscribe-at-4+, the 61%-cite-too-many-messages, Postscript's 1.91/month median — is about promotional volume. There is no basis for applying those thresholds to transactional traffic.
4. **It breaks the architectural boundary.** If transactional consumed the budget, `flows/` would need to read marketing state, and the marketing engine could no longer be switched off independently. §5.4 keeps that dependency strictly one-way.

**Two exceptions, and they matter.**

- **Florida's statutory cap counts everything** (§4.5). Fla. Stat. § 501.059 limits *contact attempts*, not marketing messages. Transactional texts and outbound calls count. This means a Florida customer with an active order can be starved of marketing capacity by their own shipping notifications — and that is the legally correct outcome.
- **A global 6-messages-per-24-hours ceiling across all categories**, as a bug guard rather than a policy. If a webhook loop or a retry storm tries to send a contact ten transactional messages in an hour, something is broken and the correct behaviour is to stop and page a human. This is not a fatigue control; it is a blast-radius limiter. Breaching it should alert, not silently suppress.

### 4.4 Two narrowings of doc 02's suppression rules

**Doc 02 §3.6 rule 5 — the cooldown — is too broad as written.** It suppresses on *any* outbound message in 48 hours. With 1,497 orders across 847 contacts and five active transactional flows, a large and continuously-refreshing fraction of the list has had an outbound message in the last two days. Applied literally, marketing would be near-permanently suppressed for the most active customers — which is to say, the best ones.

**Narrowing:** the 48h cooldown counts **marketing sends only**. Transactional traffic is handled by a separate, shorter anti-collision guard (§5.4) — no marketing message within 24 hours of a transactional one to the same contact. This preserves the intent (do not stack a restock pitch on top of a shipping text) without the pathology.

**Doc 02 §3.6 rule 6 — `in_active_flow` — is also too broad.** It suppresses anyone with a pending row in `sms_scheduled`. The `hold` and `failed` sequences (`flows/hold.js`, `flows/failed.js`) schedule messages days out, so a contact with one payment hiccup is excluded from marketing for the better part of a week.

**Narrowing:** defer only if a transactional message is scheduled within ±6 hours of the proposed marketing send. Time-boxed, not blanket.

### 4.5 Quiet hours and per-timezone handling

Quiet hours are a **deferral**, never a drop. A message blocked by quiet hours is rescheduled to the next open local window.

**Windows** (doc 03 §4.4, §4.8; doc 02 §6.2):

| Recipient state | Window (recipient local) |
|---|---|
| Default / federal | 08:00 – 21:00 |
| FL, OK, OR, WA | 08:00 – 20:00 |
| Timezone unknown | **14:00 – 20:00 America/New_York** — the bulletproof all-50-state window (doc 02 §6.3) |

**Apply a 15-minute buffer at both ends** → effectively 08:15–20:45, or 08:15–19:45 in the stricter states. Doc 02 §6.2: carrier queuing means a 19:58 submission can land at 20:03, and TCPA damages are $500–$1,500 per message. Fifteen minutes of foregone send window is not a cost worth arguing about.

Doc 03 §4.4 notes the law here is genuinely unsettled — *King v. Bon Charge* (D. Del., Apr 2026) dismissed a quiet-hours claim on the prior-express-invitation carve-out, there is no appellate authority, and post-*McLaughlin* a favourable FCC ruling would not bind district courts anyway. Its engineering recommendation, which I adopt: **hard-block outside the window regardless.** There is no commercial upside to litigating it with a client's money.

**Enforce quiet hours on transactional messages too.** Legally they are probably exempt. Operationally, a 05:30 shipping text is a bad experience, and doc 03 §4.6's design consequence — *build to the strictest plausible reading of the statutory text* — applies. The cost of deferring a shipping notification from 05:30 to 08:15 is nil. This is a change to the existing `flows/` behaviour and should ship in Phase 0.

**Timezone resolution ladder** (doc 02 §6.3 — area code is explicitly *last*, because local number portability makes NPA-NXX unreliable and people keep numbers when they move):

1. `sms_contacts.state` — populated from the WooCommerce billing address by `sync-woocommerce.js:36-45`. Already in the schema, already populated, and it is the shipping destination, i.e. where the person actually is. **Primary.**
2. `city` + `state` for the twelve states split across zones (FL, TX, KS, NE, ND, SD, MI, IN, KY, TN, OR, ID). Ship a city→timezone lookup table. Do not guess.
3. Observed inbound reply timestamps — a cheap, self-correcting behavioural signal.
4. Area code — last resort.
5. Unknown → the 14:00–20:00 ET window.

Persist `sms_contacts.timezone` and `sms_contacts.timezone_source`. Write `recipient_local_time` and `timezone_source` onto every send row: doc 03 §5.6 lists `recipient_local_time` as one of the eight fields that wins a TCPA case, and *"our records provably say"* beats *"our records say"*.

**Florida's statutory cap, enforced in code:** max **3 contact attempts per rolling 24 hours** per contact, counting outbound `sms_messages` **and** outbound `call_logs`, across all sending numbers. Applies to FL, OK and OR contacts (all three states have the same 3/day rule per doc 03 §4.8). This is statute, not best practice. It is a **deferral** for marketing (push to the next 24h boundary) and a **hard block with an alert** for transactional — if a Florida contact is about to receive a fourth attempt in a day, stop and tell a human.

### 4.6 The override path

Exactly one override exists: `sms_campaigns.bypass_frequency_cap`.

**Requirements to set it:** the campaign must be human-approved; the flag must be set at approval time (never afterwards, never programmatically); and the approving actor plus a free-text reason are recorded. It is a per-campaign flag — never a per-contact or global one.

**It bypasses exactly two things:** the rolling-30-day frequency cap and the 48-hour marketing cooldown. Nothing else.

**It can never bypass** — and this list is a hard block in code with no flag, no admin path, no environment variable (doc 03 §8's HARD BLOCK level: *"Not by the user, not by an admin, not by a flag"*):

- opt-out / suppression list
- missing or invalid consent record
- quiet hours
- the Florida/Oklahoma/Oregon statutory 3-per-24h cap
- the undeliverable-number block
- the duplicate guard
- the dosing/efficacy content block (§5.3, doc 02 §2.6)

Realistic legitimate uses: a product recall, a shipping outage notice, a compliance notification. If a marketing campaign wants this flag, that is a signal to question the campaign.

---

## 5. Suppression — the always-on gate

### 5.1 One function, ordered, returning a disposition

Doc 02 §3.6 expresses suppression as a `UNION ALL` view. **I am refuting that shape**, though not its content, for three reasons: a `UNION ALL` yields multiple rows per phone so there is no single authoritative reason; a view cannot distinguish a hard block from a deferral or compute *when* a deferral clears; and it re-scans `sms_messages` on every read.

Replace it with a SQL function returning **one row per phone**: the first blocking reason in priority order, a disposition, and a deferral target.

```sql
CREATE FUNCTION evaluate_send_gate(p_phone text, p_flow text, p_campaign uuid, p_now timestamptz)
RETURNS TABLE (
  disposition   text,        -- 'allow' | 'block' | 'defer'
  reason        text,
  defer_until   timestamptz,
  local_time    timestamptz,
  timezone_src  text
);
```

Keep doc 02's view as a debugging and preview aid — it is genuinely useful for the build-time exclusion breakdown, where multiple reasons per contact are informative rather than ambiguous.

### 5.2 The order, and why this order

Ordering is not arbitrary. **Terminal, cheap and legally absolute first; time-based deferrals last.** A deferral requires computing a future timestamp, which is wasted work on a row that is already dead — and more importantly, an audit trail should record the *most serious* reason a message was withheld, not an incidental one. A contact who is opted out *and* frequency-capped must be logged as opted out.

| # | Check | Disposition | Notes |
|---:|---|---|---|
| 1 | **Consent record exists and is valid** | HARD BLOCK, terminal | doc 03 §8.2 B27. A grandfather consent event is backfilled for existing contacts in Phase 0, with `consent_type='implied'` and an honest provenance note. |
| 2 | **Not on the suppression list** (opt-out, any scope covering this flow) | HARD BLOCK, terminal | Fresh read, never cached. doc 03 §8.2 B21. |
| 3 | **Phone is valid E.164** | HARD BLOCK, terminal | `formatPhone()` already exists at `flows/utils.js:15-22`. |
| 4 | **Not undeliverable** — ≥3 failures and >50% failure rate over 90 days | HARD BLOCK, terminal for marketing | doc 02 §3.6 rule 2. Transactional may still attempt. |
| 5 | **Campaign is still `active`** | HARD BLOCK, terminal | Catches mid-drain cancellation (§10.5). |
| 6 | **Duplicate guard** — no prior `sent` row for this (campaign, phone); no live row for this (phone, flow_type) | HARD BLOCK, terminal | Enforced by unique index; this check is the friendly path. |
| 7 | **Content gate on the rendered body** — no dosing/efficacy language; STOP language present; ≤10 segments; no public URL shortener; sender identified | HARD BLOCK, terminal | Primarily enforced at template approval; re-run after variable substitution because interpolation can break it. doc 02 §2.6, doc 03 §8.2 B23–B26, B29–B30. |
| 8 | **Recent purchaser** — no qualifying order in 10 days | Marketing: BLOCK (terminal, `purchased_after_freeze`) unless `ignores_recent_purchaser` | doc 02 §3.6 rule 3. |
| 9 | **FL/OK/OR statutory 3-per-24h** (all outbound messages + calls) | Marketing: DEFER to the 24h boundary. Transactional: BLOCK + alert. | Statute. doc 02 §4.2, doc 03 §4.8. |
| 10 | **Frequency cap** — rolling 30d tiered count | DEFER if the flow is deferrable, else DROP | §4.1–4.2. |
| 11 | **Marketing cooldown** — 48h since the last marketing send | DEFER | §4.4. |
| 12 | **Transactional anti-collision** — no transactional send in the last 24h; none scheduled within ±6h | DEFER | §4.4, replaces doc 02's blanket `in_active_flow`. |
| 13 | **Quiet hours** in recipient local time, with 15-min buffer | DEFER to the next open window | Last, because it determines the actual `defer_until`. |

**Deferral arithmetic:** when several deferrals apply, `defer_until = max(all deferral targets)`, then snapped forward into the next open quiet-hours window. Doc 02 §6.3 makes the point precisely: the send *date* is chosen by the model and the send *time* is snapped by the scheduler, and *"conflating them is how quiet-hours violations happen."*

`fatigue_risk` (doc 02 §3.6 rule 7 — ≥6 outbound in 60 days, zero inbound, zero orders) is not a separate gate; it is an engagement tier with a marketing cap of 0, which check 10 enforces.

### 5.3 The dosing-language block

Doc 02 §2.6 asks for a deterministic blocklist rather than a model instruction, and it is right. This is one of the few places where a regex beats a classifier, because the failure mode is existential rather than statistical: a replenishment SMS reading *"time for your next dose"* is a written admission by the seller that the buyer is injecting the product on a schedule. That is evidence against the research-use framing, it is a human-use claim, and it puts the 10DLC registration at risk.

Block on the **rendered** body, after substitution, for every marketing flow. Terms include dose/dosing/dosage, protocol, cycle, inject/injection, mg per day, "running low on your <SKU>", "time for your next", "due for a refill", "your results". Apply doc 03 §8.5's evasion normalisation (homoglyphs, zero-width characters, leetspeak) before matching — a classifier that skips normalisation is trivially defeated, and evasion is itself a documented violation.

The approved framing references **the order, never the use**: *"Hi Alex — it's been 24 days since your last order (5mg BPC-157). Restock here: [link]. Reply STOP to opt out."*

Doc 03 §8.4 S10 additionally requires named human sign-off on any Vici campaign. That stands.

### 5.4 The boundary with the existing transactional flows

This is the part most likely to be got wrong, so it is specified as rules rather than principles.

| | Transactional (`flows/`) | Marketing (new engine) |
|---|---|---|
| Trigger | WooCommerce / ShipStation webhook on a specific order | Metrics, schedule, or inventory event |
| Queue table | `sms_scheduled` (keyed on `order_id`) | `sms_campaign_recipients` (keyed on `campaign_id`) |
| Worker | `processScheduledQueue()` — **unchanged** | New `processCampaignSends()` |
| Approval | Pre-approved hard-coded templates | Template *and* audience approved by a named human |
| Frequency budget | Exempt (counts only toward FL statutory + the 6/24h bug guard) | Consumes |
| Quiet hours | Enforced (new in Phase 0), deferral | Enforced, deferral |
| Opt-out | Enforced (already, `flows/utils.js:84-87`) | Enforced |
| `flow_type` namespace | Existing literals (`confirmed-new`, `shipped-msg1`, `hold-msg2`, …) | Prefixed `mkt:` |

**Rule 1 — namespace separation, enforced by the database.** Marketing `flow_type` values are prefixed `mkt:`. A `CHECK` constraint on `sms_campaign_recipients.flow_type` requires the prefix; a `CHECK` on `sms_scheduled.flow_type` forbids it. This makes collision a write error rather than a runtime surprise, and it makes every historical query unambiguous about which system sent what.

**Rule 2 — the marketing engine never writes to `sms_scheduled`, and never writes `sms_sent_log` rows under a transactional `flow_type`.** Both are read-only to it.

**Rule 3 — one shared send primitive, two callers.** Both workers funnel through a single `sendGuarded()` that runs the §5.2 gate and performs the Telnyx call. Today that role is played by `sendAndLog()` (`flows/utils.js:77-135`), which already does opt-out and dedup. Extend it with the gate rather than writing a second send path — a second send path is how a compliance check ends up applied in one place and not the other.

**Rule 4 — anti-collision is one-directional.** Marketing defers around transactional (gate check 12). Transactional never checks marketing state. This keeps the dependency acyclic and means the entire marketing engine can be disabled with a feature flag without touching a line of `flows/`.

**Rule 5 — one exception where transactional yields.** A hard breach of the FL/OK/OR statutory cap blocks transactional too, with an alert. Statute outranks convenience.

---

## 6. Idempotency and double-send prevention

The current queue has no locking and, as established in §1.3, two processes genuinely do overlap during deploys. For transactional flows the `alreadySent()` check plus the unique index on `sms_sent_log` has been carrying this — `flows/utils.js:107-113` explicitly catches `23505` and treats it as *already sent by another process*, which is the correct instinct. Marketing sends have no `order_id`, so they need the equivalent built deliberately.

Five layers. Each is independently sufficient for a subset of the failure space; together they close it.

### Layer 1 — unique constraints

```sql
-- At most one row per contact per campaign, ever.
CREATE UNIQUE INDEX ux_campaign_recipient
  ON sms_campaign_recipients (campaign_id, phone);

-- At most one live row per contact per flow type, across all campaigns.
CREATE UNIQUE INDEX ux_one_live_row_per_flow
  ON sms_campaign_recipients (phone, flow_type)
  WHERE state IN ('pending','claimed','sending');
```

The database is the only place a uniqueness claim can be made under concurrency. Application-level checks are advisory.

### Layer 2 — claim-then-send

**This is the core of the design.** A worker never reads rows and then sends them. It performs a conditional `UPDATE` that *is* the claim, and sends only what the `UPDATE` returned.

```sql
CREATE FUNCTION claim_campaign_sends(p_holder text, p_limit int DEFAULT 25)
RETURNS SETOF sms_campaign_recipients
LANGUAGE sql AS $$
  UPDATE sms_campaign_recipients r
     SET state            = 'claimed',
         claimed_by       = p_holder,
         claimed_at       = now(),
         claim_expires_at = now() + interval '5 minutes',
         attempts         = r.attempts + 1
   WHERE r.id IN (
     SELECT id FROM sms_campaign_recipients
      WHERE state = 'pending'
        AND planned_send_at <= now()
      ORDER BY priority DESC, planned_send_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING r.*;
$$;
```

**Implementation note that will otherwise be discovered painfully:** `supabase-js` speaks PostgREST and cannot express `FOR UPDATE SKIP LOCKED` or a `RETURNING` on a subquery-scoped `UPDATE`. This **must** be a Postgres function invoked via `supabase.rpc('claim_campaign_sends', …)`. Attempting it as a `select` followed by an `update` reintroduces exactly the race this exists to close. This is the single most important technical instruction in the document.

`FOR UPDATE SKIP LOCKED` also means additional workers are safe by construction if we ever add them — they take disjoint row sets without coordination.

### Layer 3 — the state machine, and the at-most-once policy

```
pending ──claim──▶ claimed ──gate passes──▶ sending ──Telnyx ok──▶ sent
   ▲                  │                        │
   │                  │ gate says defer        │ Telnyx permanent error
   └──────────────────┘                        ▼
                      │ gate says block   failed (terminal)
                      ▼
                 skipped (terminal)            │ transient error
                                               ▼
                                          pending (attempts+1, backoff)

  crash while claimed → lease expires → reaped back to pending
  crash while sending → NEVER auto-reaped → 'unknown' after 15 min → human
```

`claimed → sending` is written **immediately before** the Telnyx call and `sending → sent` immediately after. The window in which a crash loses information is the duration of one HTTP request.

**The policy, stated so it is never accidentally reversed: rows stuck in `sending` are never automatically retried.** The reaper only touches `claimed` rows past `claim_expires_at`. A `sending` row older than 15 minutes transitions to `unknown` and raises an operator alert. We do not know whether Telnyx accepted it; retrying risks a duplicate, and a duplicate marketing SMS is a compliance incident while a missing one is a fraction of one expected order. **At-most-once, deliberately.**

### Layer 4 — reconciliation for `unknown`

Resolve `unknown` rows by querying Telnyx for messages to that number in the claim window and matching against `sms_messages.telnyx_message_id`. If found, mark `sent` and backfill the id. If not found after two checks 10 minutes apart, mark `failed` and allow one manual requeue by an operator.

Telnyx's v2 Messages API has no documented idempotency key, so do not design around one. Reconciliation is the substitute.

### Layer 5 — the job lease

Per §1.3. Prevents two processes running the same job body at all, which is the cheapest layer and the one that would have prevented the historical risk on its own.

### Why all five

| Failure | Caught by |
|---|---|
| Two processes tick simultaneously | Layer 5, then Layer 2 |
| One process, overlapping ticks | Re-entrancy flag, then Layer 2 |
| Materialiser runs twice for one campaign | Layer 1 |
| Two campaigns of the same flow target one contact | Layer 1 (partial index) |
| Crash between claim and send | Layer 3 reaper |
| Crash between Telnyx call and state write | Layer 3 `unknown` + Layer 4 |
| Operator clicks Send twice | Layer 1 + campaign state transition |
| Webhook delivered twice | Existing upsert with `ignoreDuplicates` (`sync-woocommerce.js:107-121`) |

---

## 7. Replenishment, made implementable

Doc 02 §2 is the maths. This is the job.

### 7.1 Schema additions

```sql
-- Client-authored. The wizard READS this and never writes it (doc 02 §2.2).
CREATE TABLE sms_sku_supply_days (
  sku            text PRIMARY KEY,
  product_name   text,
  mg_per_unit    numeric,
  mg_per_day     numeric,
  supply_days    numeric NOT NULL,
  updated_by     text    NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int     NOT NULL DEFAULT 1
);

-- Client-authored product families, for the cohort ladder and cross-sell adjacency.
CREATE TABLE sms_product_families (
  sku text PRIMARY KEY,
  family text NOT NULL      -- healing_recovery | glp1 | cosmetic | sexual_health | gh_secretagogue
);
```

Doc 02 §2.2 is emphatic that `supply_days` must never be model-populated: it documents a search result that was wrong by a factor of seven (10–20 *days* rendered as 10–20 *weeks*). Enforce it as a permission, not a convention — the AI has no write path to these tables.

### 7.2 Nightly predictor — 03:00 ET, under lease

**Step 1 — gaps.** For each contact, order qualifying orders (`status IN ('processing','completed','shipped','delivered') AND total > 0`) by `created_at`; compute `g_i = t_{i+1} − t_i` in days; `k = n − 1`.

**Step 2 — log-space fit.** `μ = mean(ln g)`, `m = exp(μ)`, `MAD = median(|g − m|)`, `σ̂ = 1.4826 × MAD`, `CV = σ̂ / m`. Median not mean — with k ≤ 5, one bulk stock-up order is 20% of the data.

**Step 3 — cohort ladder**, walking up until the cohort has ≥30 observed gaps: same SKU → same family → same AOV tercile → whole store. Persist `cohort_tier_used`.

> **Expect the ladder to bottom out at family or store level, and say so in the UI.** Doc 02 §2.2's arithmetic: ~1,497 orders across 847 contacts gives on the order of 150–250 observed gaps spread over 26 SKUs — roughly 6–10 per SKU. **SKU-level cohorts are not viable.** Any UI offering per-product replenishment timing is offering precision the data cannot support.

**Step 4 — shrinkage.** `w = k / (k + κ)` with `κ = 2`; `m̂ = exp(w·ln m + (1−w)·ln m_cohort)`. Record κ as a guess; revisit at 2,000+ orders per doc 02.

**Step 5 — dose-based estimator.** From the most recent delivered order's line items: `supply_days = Σ(qty × supply_days(sku))`, anchored on `sms_orders.delivered_at` (the column exists — `00-current-state.md` §4). Fall back to `shipped_at + transit_p90`, then to `created_at + 5 days`, recording which anchor was used.

**Step 6 — combine**, per doc 02 §2.2:

```
if k ≥ 2 and CV < 0.5            → Estimator A
elif SKU has a supply_days entry → Estimator B
elif k ≥ 1                       → A with heavy shrinkage
else                             → cohort median, flag low confidence

if both available and they disagree by >2× → flag 'estimator_conflict', do not send
```

The conflict flag matters: a 2× disagreement means the customer is not using the product on the assumed schedule (stockpiling, sharing, reselling). Flag rather than guess.

**Step 7 — the transit floor, measured not assumed.**

```sql
SELECT percentile_cont(0.9) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM (delivered_at - shipped_at))/86400)
  FROM sms_orders
 WHERE shipped_at IS NOT NULL AND delivered_at IS NOT NULL
   AND delivered_at > shipped_at
   AND created_at > now() - interval '365 days';
```

Doc 02 §2.3 offers "≈7 days for US ground" as a placeholder and explicitly says to derive it empirically from shipping data. Use the measured p90; fall back to 7 only if fewer than 30 orders have both timestamps.

**Step 8 — lead time and window.**

```
L_min  = transit_p90 + 2
L_max  = 14
α      = 0.80  if CV < 0.35
       = 0.75  if 0.35 ≤ CV < 0.75      (bias early — doc 02 §2.3)
L      = clamp((1 − α) · m̂, L_min, L_max)

depletion_date = anchor_delivered_at + m̂   (or + supply_days for Estimator B)
send_at        = depletion_date − L
window_lo/hi   = exp(μ ± t₀.₉₇₅,k₋₁ · s · √(1 + 1/k))   applied to the anchor
```

The `√(1 + 1/k)` term is what makes this a prediction interval rather than a confidence interval; doc 02 §2.5 notes it is the term everyone drops and that dropping it makes the interval look 20–40% tighter than it is.

**Step 9 — confidence gate.** Doc 02 §2.4, and this is the branch every implementation skips:

```
CV < 0.35                          → high    → single send at depletion − L
0.35 ≤ CV < 0.75                   → medium  → send at the early edge (depletion − L_max)
CV ≥ 0.75, or k = 0 with no supply_days entry
                                   → DO NOT CALL THIS REPLENISHMENT
```

*"A replenishment message sent at a randomly-chosen time is just a promo with extra steps, and it will convert like a promo (0.1–0.6%) while consuming the fatigue budget of a replenishment message."* Low-confidence contacts fall through to win-back eligibility or nothing. They do not get a replenishment message with a confident-sounding date.

**Step 10 — write.** Upsert into `sms_contact_metrics`: `predicted_reorder_at`, `reorder_window_lo`, `reorder_window_hi`, `reorder_confidence`, `reorder_estimator` (`A`/`B`/`cohort`), `cohort_tier_used`, `gaps_k`, `ipi_median_days`, `ipi_cv`, `computed_at`.

The nightly job **writes predictions only. It never queues a send.** That separation is what makes the predictor safe to re-run, backfill, and debug.

### 7.3 Daily materialiser — 09:00 ET

1. Select contacts where `predicted_reorder_at − L` falls in the next 24 hours, `reorder_confidence != 'low'`, no `estimator_conflict`.
2. Run the §5.2 gate in **preview mode** (all checks, no side effects) and attach a reason to every exclusion.
3. Upsert a rolling `sms_campaigns` row (`flow_type='mkt:replenishment'`, one per day) and insert `sms_campaign_recipients` at `state='draft'`.
4. Render copy from the **already-approved template**, run the §5.3 content block, and present the batch to the operator with the exclusion breakdown: *"Audience 41 → 27 after exclusions: 8 recent purchasers, 4 frequency-capped, 2 low confidence."*
5. Operator approves → `frozen_at` set, rows move `draft → pending`, `planned_send_at` snapped into each contact's local 16:00–19:00 window (doc 02 §6.1 — revenue per send peaks 4–7pm local; not a lever worth testing at this N, just a sane default).
6. The worker picks them up on the next tick.

This is autonomy Stage 0 from doc 02 §7.3 — the template was approved once, the batch is approved daily. Stage 1 (auto-send with a weekly digest) unlocks after five consecutive unmodified approvals with zero compliance flags.

**One thing the UI must not do:** show a single predicted date. Doc 02 §2.5: *"A replenishment preview that says 'predicted reorder: 14 Sept' is a lie. One that says 'predicted reorder window: 2–24 Sept, low confidence (2 prior orders)' is the truth."*

---

## 8. Automated campaign triggers

| Flow | Trigger | Evaluation cadence | Double-send guards | Composition with `flows/` |
|---|---|---|---|---|
| **Replenishment** `mkt:replenishment` | `predicted_reorder_at − L` inside the next 24h, confidence ≥ medium | Nightly predict 03:00, materialise 09:00 daily | Partial unique index on (phone, `mkt:replenishment`); order webhook cancels pending rows; `recent_purchaser` gate; per-contact 30-day re-send floor | Zero overlap. Transactional owns the order event; this owns the *absence* of the next one. Anti-collision defers around any transactional send in 24h. |
| **Win-back** `mkt:winback` | `days_since_last_order` between 2× and 3× the contact's `m̂` (or cohort median if k=0). Not a calendar threshold — doc 02 §1.9 | Weekly, Monday 09:00 | Max one win-back per contact per 90 days (`last_winback_at` on metrics); `recent_purchaser`; unique index | No overlap. Restrict to contacts with a prior **inbound** SMS reply (doc 02 §1.9: win-back is the flow most likely to generate opt-outs). |
| **Post-purchase education / cross-sell** `mkt:crosssell` | `delivered_at + 3 days`, delivery-triggered not order-triggered | Daily 09:00 | Once per order (`order_id` on the recipient row + unique index); requires the delivery SMS to have already sent | **Adjacent to `flows/shipped.js` — the boundary is the receipt.** The transactional leg carries confirmation and tracking; the marketing leg carries education and cross-sell, gated on delivery. Doc 02 §1.5: *"a sales text 3 days after someone bought reads as greedy"* — so this needs the delivered anchor and a soft touch. |
| **Review request** `mkt:review` | `delivered_at + 21 to 30 days` | Daily 09:00 | Once per order; skip if a review already exists | No overlap. **21–30 days, not the 14-day default** — peptide protocols run 4–8 weeks and a day-14 ask requests a review of a product that has not done anything yet (doc 02 §1.7). Copy must ask about shipping, packaging and product quality, never efficacy. |
| **Back-in-stock** `mkt:restock` | Explicit per-SKU subscription **and** WooCommerce `stock_status` transitions 0 → positive | Event-driven on the existing `product.updated` webhook | One send per (phone, sku, restock event); 72h expiry | No overlap. Exempt from the frequency budget (§4.2) but still subject to quiet hours and the FL statutory cap. Requires a product-page capture form — Phase 5. |
| **VIP** | — | — | — | **Not automated. Deliberately.** Doc 02 §1.10: the top decile is a concierge list, not a campaign segment. Build a VIP *view* in the existing two-way inbox. `is_vip` is a display attribute on `sms_contact_metrics`. |
| **Sunset** | — | — | — | **Deferred.** Doc 02 §1.13: standard thresholds mis-classify a peptide customer mid-protocol as dead, and at this list size the cost of suppressing a false positive exceeds the cost of one extra send. |
| **Abandoned checkout** | Woo order stuck in `pending`/`failed` | — | — | **Out of scope for this document** — `flows/failed.js` and `flows/hold.js` are already ~80% of it (doc 02 §1.2). It belongs in the transactional system, not the marketing engine, and should be finished there. |
| **Abandoned cart / browse / price drop** | — | — | — | **Blocked on instrumentation we do not have**, and browse abandonment is separately inadvisable for a health-adjacent catalogue. Do not put them in the flow catalogue or the wizard will offer a campaign it cannot populate. |

**The one-line summary of the boundary:** `flows/` owns everything triggered by a specific order's state changing. The marketing engine owns everything triggered by time passing, a prediction maturing, or inventory moving. Neither reads the other's queue; marketing defers around transactional; transactional never yields except to statute.

---

## 9. Recomputation cost, honestly

At 847 contacts and 1,497 orders, **almost nothing here is expensive, and the temptation to optimise should be resisted.** The one genuine cost driver is not the one people expect.

### 9.1 What is cheap

| Operation | Cost | Breaks at |
|---|---|---|
| Full `sms_contact_metrics` recompute, one SQL statement | Well under one second. 1,497 rows grouped into 847. Window functions over a 1,497-row table are free. | ~500k contacts / ~5M orders before it needs incrementalisation |
| Segment preview at build time | Sub-second against a pre-computed 847-row metrics table | ~1M contacts |
| Per-contact metrics recompute on order webhook | One indexed query over ~2 orders | Never — it is O(orders per contact) |
| Frequency-cap count | Indexed count over a table that grows by ~200/month | ~10M rows |
| Transit p90 | One percentile over ≤1,497 rows | Cache nightly beyond ~1M orders |

### 9.2 The one thing that is genuinely expensive

**Round trips through `supabase-js`, not SQL.**

Every `supabase.from(...)` call is an HTTP request to PostgREST at roughly 20–50ms. The existing code is full of per-item queries — `flows/confirmed.js:27-91` alone can issue three separate lookups per order, and `processScheduledQueue()` (`flows/utils.js:238-270`) does two writes plus a gate per job, sequentially.

Do the arithmetic. A batch suppression evaluation implemented as JavaScript — 847 contacts × 6 checks × 30ms — is **~150 seconds**. The same logic as one SQL function is **~50 milliseconds**. That is a 3,000× difference, and it is entirely about where the loop lives.

**Rules that follow:**

1. **Batch gate evaluation (preview, materialisation) is one SQL function returning one row per contact.** Never a JS loop.
2. **The per-send gate is one RPC per contact** — and that is correct, because it must be synchronous and fresh. At 200 sends × 30ms it is 6 seconds per campaign, which is nothing next to the Telnyx calls.
3. **The nightly recompute is one `INSERT … SELECT … ON CONFLICT DO UPDATE`.** Not 847 upserts.
4. **The claim is one RPC returning 25 rows.** Not 25 selects.

### 9.3 Indexes required before anything else

Without these, the engagement and fatigue queries table-scan `sms_messages` on every evaluation.

```sql
CREATE INDEX ON sms_messages (contact_phone, created_at DESC);
CREATE INDEX ON sms_messages (contact_phone, direction, created_at DESC);
CREATE INDEX ON sms_orders   (contact_phone, created_at DESC);
CREATE INDEX ON sms_orders   (contact_phone, status, created_at DESC);
CREATE INDEX ON sms_campaign_recipients (phone, state, sent_at DESC);
CREATE INDEX ON sms_campaign_recipients (state, planned_send_at) WHERE state = 'pending';
```

At 2,283 messages a scan is imperceptible. At 1M it is the first thing that breaks. These cost nothing now and are annoying to add under load.

### 9.4 Where each approach breaks — the honest table

| Approach | Fine until | Then what |
|---|---|---|
| Nightly full recompute in one statement | ~500k contacts | Incremental recompute of contacts touched since the last run |
| Per-send synchronous gate | ~10k sends per campaign | Batch pre-gate + a narrower per-send re-check (opt-out and suppression only) |
| Single leased `setInterval` worker | ~50k sends/day | Parallel workers — the claim already supports it; retire the lease |
| 5-minute tick granularity | Any flow needing sub-5-minute precision | Shorten the tick, or move that one flow to event-driven |
| Rolling-window frequency count | ~10M ledger rows | Materialise a per-contact 30-day counter |
| PostgREST round trips | Already the binding constraint | Push logic into SQL functions — do this now, not later |

**Do not build for any of these.** The point of stating them is that when one is reached, the fix is known and local. Building the incremental recompute now would be optimising a 50ms query.

---

## 10. Failure modes

### 10.1 The segment query times out

- **At build time (T4):** show the error, do not materialise, do not partially insert. The operator retries or narrows.
- **In the nightly recompute (T3):** `sms_contact_metrics` retains yesterday's values with an unchanged `computed_at`. This is the dangerous case, because the data looks fine.
- **The control — a staleness guard.** The daily materialiser refuses to build any audience from metrics where `computed_at < now() − 36 hours`, logs a hard error, and alerts. **Silently sending from stale predictions is worse than sending nothing**: a two-day-old replenishment date is a message to someone who may already have reordered, which is doc 02's worst-case trust failure.
- Recovery: the nightly job is idempotent and safe to re-run manually at any time.

### 10.2 The AI is unavailable

`OPENROUTER_MODEL` currently 404s in production (`00-current-state.md` §8) — this is not hypothetical, it is the live state, and it is the likely reason `sms_customer_profiles` has one row.

**Architectural rule: there is no LLM call in the send path. Ever.** The model drafts copy; a human approves the template; the approved template is stored on the campaign; rendering is pure string substitution. An AI outage delays *authoring* and can never affect *sending*.

`flows/confirmed.js:446-454` already gets this right — it wraps the OpenRouter call in a try/catch with a 5-second abort and falls back to the base template. Generalise that posture: any AI call gets a timeout, a deterministic fallback, and no ability to block.

Corollary: an AI outage must never *silently* degrade copy quality. If personalisation fails at render time, either use the approved base template or skip the contact — never send a message with an unfilled placeholder.

### 10.3 Telnyx rejects a message mid-campaign

Classify the error; do not treat all failures alike.

| Error | Class | Action |
|---|---|---|
| `40300` — recipient opted out at the platform level | **Permanent, and informative** | Write to `sms_suppressions` immediately (Telnyx knows something we did not), mark the row `skipped`, cancel that contact's other pending rows |
| `4xx` invalid / unroutable number | Permanent | `failed`; increment the undeliverable counter; three strikes → suppression list |
| `429` rate limited | Transient | Back to `pending`, `planned_send_at = now() + 60s`, `attempts+1` |
| `5xx` / network / timeout | Transient | Back to `pending`, exponential backoff (1m, 5m, 25m), max 3 attempts, then `failed` |
| `40002`, `40315` — unhealthy from-address | **Reputation signal** | Pause the campaign, alert. Doc 03 §8.3 W12 flags these as leading indicators of reputation damage. |

**The circuit breaker is the important part.** If ≥10 consecutive sends fail, or the failure rate exceeds 25% over the last 20 sends, **pause the entire campaign** (`state='paused'`), stop claiming, and alert. A campaign that burns through 200 numbers while being carrier-filtered is a reputation event, not a delivery problem, and by the time a human notices the damage is done. Resume requires a human.

### 10.4 The process restarts mid-send

Three distinct concerns.

**Claimed rows.** The reaper (running on the same tick, before the claim) returns rows where `state='claimed' AND claim_expires_at < now()` to `pending`. Safe: the gate had not yet passed and no Telnyx call was made.

**Rows in `sending`.** Never auto-reaped. → `unknown` after 15 minutes → reconciliation (§6, Layer 4) → human. At-most-once, deliberately.

**The catch-up burst — the one that produces an incident.** `server.js:120-123` fires `processScheduledQueue()` 15 seconds after boot. If the process has been down for a day, that run finds every overdue row at once. Combined with a marketing queue, the failure mode is: *server down overnight, comes back at 03:00, blasts 200 people while they are asleep.*

Two controls, both required:

1. **Per-flow maximum lateness.** A row whose `planned_send_at` is more than its flow's `max_lateness` in the past transitions to `expired`, not `sent`.

   | Flow | max_lateness | Why |
   |---|---:|---|
   | Replenishment | 24 h | The date carries meaning; recompute instead |
   | Promo / broadcast | 2 h | Dated content |
   | Back-in-stock | 6 h | Stock may be gone |
   | Win-back / review | 72 h | Not time-critical |
   | Transactional | 24 h | A two-day-late shipping text is confusing |

2. **Quiet hours are re-evaluated at send, not at schedule.** Even inside `max_lateness`, a 03:00 catch-up defers everything to 08:15 local. This is the second reason quiet hours must be a live check rather than baked into `planned_send_at`.

**Boot rate-limit:** cap the first post-boot tick at 25 sends and let subsequent ticks drain the rest. It costs 5 minutes and removes the thundering-herd shape entirely.

### 10.5 A campaign is cancelled halfway

```sql
UPDATE sms_campaigns SET state = 'cancelled', cancelled_by = :actor, cancelled_at = now()
 WHERE id = :id;

UPDATE sms_campaign_recipients
   SET state = 'cancelled', skip_reason = 'campaign_cancelled'
 WHERE campaign_id = :id AND state = 'pending';
```

`claimed` and `sending` rows are **not** force-transitioned — a `sending` row may already be at Telnyx, and rewriting its state would lose the record. Instead, gate check 5 (campaign still active) catches any claimed row that has not yet called Telnyx and terminates it. The window in which a message escapes after cancellation is bounded by one claim batch, roughly 5 seconds.

The report must be honest and immediate: *"Cancelled. 20 sent, 3 in flight, 191 cancelled."* An operator who hits cancel needs to know exactly what got out, not a spinner.

### 10.6 Two more worth naming

**Duplicate WooCommerce webhooks.** Already handled — `sync-woocommerce.js:107-121` upserts with `ignoreDuplicates: true` against the unique constraint on `woo_order_id`. Keep that pattern for every new webhook consumer.

**An operator approves the same campaign twice.** The approval transition is `draft → approved` conditioned on the current state; the second click updates zero rows and returns "already approved". Never make approval a bare insert.

---

## 11. Phased build order

Ordered so each phase is independently useful and nothing is built on an unvalidated assumption.

### Phase 0 — Make the current system safe (~2 days). Prerequisite for everything.

No new features. Pure risk removal, and it delivers real value on its own because Vici today has no defensible opt-out record at all (`00-current-state.md` §8, and the high-risk client having *less* compliance machinery than the low-risk one is backwards).

- `sms_suppressions` and `sms_consent_events` tables per doc 03 §5.6; migrate the sentinel-row opt-out hack (`flows/utils.js:44-53`, `flow_type='opted-out'` in `sms_sent_log`) into a real table; `isOptedOut()` reads both during transition.
- Tier-2 free-text revocation detection on inbound (`routes/webhook.js:73` currently anchors the whole message with `^…$`, so *"please stop texting me about this"* does not match). Doc 03 §5.1: the FCC standard is "any reasonable means"; Telnyx only matches whole-message stop words. Default posture: auto-suppress, then human review.
- `sms_contacts.timezone`, `timezone_source`, `consent_at`. Backfill timezone from `state`, which `sync-woocommerce.js:36-45` already populates.
- `job_leases` table + `acquire_job_lease` / `release_job_lease` RPCs; wrap all three existing timers; add the re-entrancy flag.
- Quiet-hours enforcement inside `sendAndLog()`, as a deferral.
- The indexes from §9.3.
- Grandfather consent events for existing contacts, with honest provenance.

**Exit criterion:** two concurrent processes cannot double-send, and every send has a suppression check and a consent record behind it.

### Phase 1 — Metrics, read-only (~3 days). No sending.

- `sms_contact_metrics` + the nightly recompute (one SQL statement, under lease).
- RFM with **absolute thresholds, not `NTILE`** — doc 02 §3.1 shows `NTILE(5)` on frequency produces `[1,1,1,1,2]` on this distribution, four identical quintiles carrying no information. Recency measured in multiples of the cohort inter-purchase interval, not raw days.
- **Collapse RFM to four operational buckets** (champion / active / at-risk / lapsed) and hide the 11-way view. Doc 02 §3.1: an 11-way split on 847 contacts produces segments of 10–80 people, and segments under ~50 support no measurement at all.
- Lifecycle stage, engagement tier, product affinity, IPI statistics.
- `naive_annual_run_rate` — labelled "run rate", **never** "predicted LTV". Doc 02 §3.2: Vici does not clear the 500-customer bar Klaviyo sets for its own predictive analytics.
- A read-only segment preview endpoint.

**This phase answers doc 02's open question #4 with real numbers before anything is built on top of it.** Publish: customers with ≥2 orders, total gaps, median gap, the CV distribution, gaps per SKU. **Gate: if the CV distribution is mostly ≥0.75, replenishment is not viable and Phase 3 must be rescoped.** Do not skip this check to save two days.

### Phase 2 — The engine, proved end to end (~4 days).

- `sms_campaigns`, `sms_campaign_recipients`, all unique constraints and indexes.
- `evaluate_send_gate()` with all 13 checks; `claim_campaign_sends()`; the send worker; the reaper.
- Flat frequency cap (4/30d for everyone), 48h cooldown, quiet hours, FL/OK/OR statutory cap.
- Approval screen showing the **exclusion breakdown**, not just a count. Doc 02 §7.4: *"'214 → 137' with reasons is the artefact that builds operator trust."*
- Campaign report: sent / skipped / deferred / expired / failed, with reasons.
- **First campaign type: a manually-built one-off broadcast to a hand-picked segment.** The smallest thing that exercises the whole machine, and the thing the operator will use immediately.

### Phase 3 — Replenishment (~4 days).

- `sms_sku_supply_days` + `sms_product_families`, **authored by the client**, with no AI write path.
- The nightly predictor (§7.2) and daily materialiser (§7.3).
- The dosing-language content block (§5.3) — deterministic, applied to the rendered body.
- UI shows the predicted *window* and its confidence, never a bare date.

Highest-value flow available and the data already exists. It is third, not first, because it needs Phase 2's send machinery and Phase 1's viability check.

### Phase 4 — Win-back and review request (~2 days).

Both are different `WHERE` clauses over the same metrics table plus the same send machinery. Nearly free once Phase 3 exists. Win-back restricted to contacts with a prior inbound reply.

### Phase 5 — Back-in-stock (~3 days).

Needs a product-page subscription capture form (front-end) and WooCommerce `stock_status` transition handling off the existing `product.updated` webhook. Highest CR of any flow, zero fatigue cost, and it doubles as a purchasing demand signal.

### Phase 6 — Refinements (~2 days).

Engagement-tiered caps replacing the flat 4; contention priority tuning; deferral-expiry tuning from observed data; the VIP view in the inbox.

### Explicitly not built, and why

| Not building | Reason |
|---|---|
| Automated VIP flow | 85 people. Doc 02 §1.10 — concierge, not campaign. Build the inbox view. |
| Sunset / suppression policy | Doc 02 §1.13 — standard thresholds mis-classify mid-protocol customers; the list is too small to suppress into. |
| Abandoned cart, browse abandonment, price drop | Blocked on instrumentation; browse is separately inadvisable for a health-adjacent catalogue. |
| Per-customer predicted LTV | Below Klaviyo's own 500-customer threshold. Ship "run rate". |
| Per-campaign A/B testing | MDE at this N is +245% relative lift. Doc 02 §5.4: *you cannot A/B test at this list size.* Pool across campaigns by flow type instead. |
| A real job queue | §1.3. Not needed below ~50k sends/day. |

---

## 12. Where doc 02 and this architecture disagree

Stated plainly, with a side picked in each case.

| # | Doc 02 says | This document says | Why |
|---:|---|---|---|
| 1 | Suppression as a `UNION ALL` view (§3.6) | A SQL function returning one row per phone with a disposition and a defer target | A view yields multiple rows per phone (no authoritative reason), cannot distinguish block from defer, and cannot compute when a deferral clears. Keep the view for debugging and preview. |
| 2 | 48h cooldown on *any* outbound message (§3.6 rule 5) | 48h on **marketing** sends only; a separate 24h transactional anti-collision guard | Applied literally, five active transactional flows over 1,497 orders would near-permanently suppress marketing to the most active customers. |
| 3 | `in_active_flow` — exclude anyone with a pending `sms_scheduled` row (§3.6 rule 6) | Defer only within ±6h of a scheduled transactional send | `hold`/`failed` sequences run for days; one payment hiccup should not cost a week of eligibility. |
| 4 | Token bucket with capacity and refill rate (§4.2) | Rolling-window `COUNT` over the send ledger | Identical semantics when capacity equals refill. No state to corrupt, restart-safe, and it answers *"why was this contact capped?"* with the actual messages. |
| 5 | Contention ranked by `p_flow × AOV × (1 − haircut)` (§4.2) | Static priority ladder first; EV only as tie-break | At this N, `p_flow` is a posterior over a handful of conversions. Sorting by noise reshuffles priorities week to week for no reason. |
| 6 | `L_min ≈ 7 days for US ground` (§2.3) | Measured p90 of `shipped_at → delivered_at`, falling back to 7 below 30 samples | Doc 02 itself says to derive it empirically. We have the timestamps. |
| 7 | Assumes `sms_contacts.opted_out` exists (§3) | It does not. Opt-out is a sentinel row in `sms_sent_log` with `flow_type='opted-out'` | Verified in `flows/utils.js:29-53`. Phase 0 migrates it. |
| 8 | Nightly segmentation implied | Nightly **plus** event-driven invalidation on order | A nightly-only model sends replenishment to someone who ordered four hours ago — the exact failure doc 02 §3.6 calls the fastest route to losing the client. |
| 9 | Back-in-stock exempt from the bucket (§4.2) | Agreed — but still bound by quiet hours and the FL statutory 3/24h | Statute is not a fatigue control and does not have exemptions. |

---

## 13. Open questions this design cannot resolve

1. **Is `sms_orders.delivered_at` actually populated?** The column exists. Replenishment, review requests and post-purchase cross-sell all anchor on it. Doc 02 §8 lists this as blocking, and it still is. Verify before Phase 3.
2. **What does the real gap distribution look like?** Phase 1's exit gate. If most contacts land at CV ≥ 0.75, the confidence gate suppresses nearly everyone and replenishment collapses into generic lifecycle messaging.
3. **Will the client author `sku → supply_days`?** Phase 3 is blocked without it and it cannot be model-populated (doc 02 §2.2 documents a factor-of-seven error in the public sources).
4. **Fork vs. shared core vs. multi-tenant** (`00-current-state.md` §7). This design assumes a single deployment. Multi-tenancy changes the lease model, the priority ladder scoping, and the frequency cap's tenancy boundary. Every week of delay doubles the port cost.
5. **Does Telnyx accept Vici's traffic in writing?** Doc 03 §2.2 — Telnyx's forbidden-use list is *stricter* than Twilio's on this vertical. If the answer is no, this engine has no channel to send on.
6. **The SHAFT-C contradiction between docs 03 and 04** must be resolved before the content linter in §5.3 is finalised. It does not block the rest of the engine.
