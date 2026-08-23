# Campaign delivery

How an approved campaign becomes messages, and what stops it.

## The short version

Delivery is off. Two independent flags must both be `true` before a single
message can leave, and neither is set:

| Flag | Where | Meaning |
|---|---|---|
| `sms_campaign_settings.provider_approved` | database | the carrier/provider has approved this traffic |
| `sms_campaign_settings.live_send_enabled` | database | the business has switched sending on |
| `CAMPAIGNS_LIVE_SEND_ENABLED` | environment | the worker loop exists in the process at all |

The database checks the first two inside `claim_sms_campaign_recipients` and
again inside `begin_sms_campaign_provider_attempt`. The environment flag is
checked by `lib/campaigns/delivery-worker.js` before it opens a connection.
Turning off any one of the three stops delivery completely.

`provider_approved` additionally cannot be set without a written approval
reference, a timestamp, and the id of the person who set it — a CHECK
constraint enforces that, so there is no way to switch it on anonymously.

## The path a message takes

```
draft ──► review requested ──► approved ──► scheduled ──► [worker] ──► sent ──► delivered
                   │                                          │
              a person, with                          nothing here decides
            campaigns.approve                          who is eligible
```

Approval is human and revision-bound. Approving campaign revision 3 approves
revision 3 — edit the message afterwards and the approval no longer applies.

## What the worker is allowed to decide

Almost nothing, and that is the design.

Eligibility, quiet hours, promotional spacing, the 7- and 30-day frequency
caps, opt-out, DND freshness, positive-consent evidence, and the campaign being
approved and scheduled are all enforced in SQL under row locks. The worker asks
the database for work and is handed only work that is already lawful. It never
asks "may I send to this person" because it is not trusted to answer.

It decides three things:

1. how many recipients to claim at once (10);
2. how long a lease lasts (300s);
3. what to do when the provider does not answer clearly.

### Why 10 and 300, and not 25 and 120

`claim_sms_campaign_recipients` stamps **one** `claim_expires_at` across the
whole batch, and the worker then sends sequentially. With 25 recipients on a
120-second lease, anything past ~4.8 seconds of average provider latency pushed
the tail of every batch past its own lease, `begin_sms_campaign_provider_attempt`
fenced it out as `campaign_claim_fence_failed`, and the worker logged nothing —
because that is the same error a STOP produces, and a STOP is not worth
alarming on. Throughput collapsed silently.

The current numbers are a provable bound rather than a guess. Every provider
call has a 20-second abort (`PROVIDER_TIMEOUT_MS` in `telnyx.js`), so the
worst possible batch is 10 x 20s = 200s inside a 300-second lease, leaving 100
seconds for round trips. `maxBatchForLease()` enforces the relationship and
clamps anything larger, out loud.

`heartbeat_sms_campaign_provider_attempt` cannot help here, which is why it is
still uncalled. It requires `state = 'sending'`, and the rows that fence out are
still in `claimed` — they have not reached `begin_` yet, so there is nothing to
heartbeat.

At 10 per two minutes, an audience of 900 takes about three hours. That is the
intended trade. A campaign arriving over an afternoon is fine; a cap breach is
not.

A fence failure is now logged when — and only when — the claim lease had already
run out, with the recipient's position in the batch and the elapsed time. A
fence inside the lease stays silent, because that one really is a STOP, a
cancellation or stale consent.

## Never retry an uncertain send

Three outcomes follow a provider call, and only two are knowable:

- **accepted** — recorded, the recipient moves to `sent`
- **refused** — the provider rejected it before submission
- **unknown** — the request timed out, the process died, the network broke

For **unknown** the worker does nothing at all. No retry, no failure mark, no
guess. The lease expires and `release_expired_sms_campaign_claims` moves the row
to `reconciliation_required`, where a person decides.

**Refused** is a real third outcome, not a polite word for unknown. `telnyx.js`
marks a thrown error `providerRefused` only for an HTTP 400, 404 or 422 whose
JSON error body parsed — the provider rejecting the request itself, before
anything reached a carrier. The worker then calls
`record_sms_campaign_provider_refusal`, which marks the recipient `failed` with
the provider error code and hands the reserved cadence slot back, because a
refusal is not a contact.

The line is drawn deliberately tight. A 401 or 403 is about our credentials, not
this destination. A 429 is retryable. A 5xx says nothing about whether the
message was submitted. An abort or a timeout is the definition of not knowing.
All of them stay **unknown**. Without the refused path, one bad phone number in
an audience of 900 became a line in a human reconciliation queue; with it too
wide, a real recipient gets permanently marked failed over a transient blip.

The recovery function treats the two stuck states differently, and the
difference is the whole point of splitting the claim from the provider call:

| Stuck in | Means | Becomes |
|---|---|---|
| `claimed` | never reached the provider | `pending` — safe to retry |
| `sending` | may or may not have sent | `reconciliation_required` — a person looks |

A duplicate marketing text is worse than a late one. A wrongly-failed row is
worse than an unresolved one.

## Idempotency

The key is `campaign-recipient:<recipient id>`, generated by the database, not
by the worker. A partial unique index on
`(workspace_id, provider_idempotency_key)` makes a second acceptance for one
recipient impossible to record.

## Recording a send is unconditional

Apply `scripts/campaign-delivery-fixes-migration.sql`. It is a follow-up to
`scripts/campaigns-migration.sql`, which is already applied in production and
must not be edited.

`record_sms_campaign_provider_acceptance` used to re-run the entire eligibility
check *after* the provider call and refuse to record if anything had changed.
That was backwards. Refusing to record cannot un-send a message; it can only
delete the evidence that one went out. And the check flipped routinely: a
contact sitting on the 24-hour `ghl_dnd_synced_at` freshness boundary crosses it
between `begin_` and `record_` as a matter of course, and so does a STOP that
arrives while the request is on the wire.

Two things followed from a lost acceptance, both bad:

1. `accepted_at` stayed NULL and the reservation stayed expired, so the sent
   message counted towards **none** of `minimum_promotional_spacing_hours`,
   `max_promotional_per_7_days` or `max_promotional_per_30_days`. A real message
   escaped every frequency cap, permanently.
2. `provider_message_id` is written only by that RPC, so every delivery receipt
   for the message returned `not_a_campaign_message`. No delivery evidence and
   no attribution, ever.

Now:

- The eligibility gate lives only in `begin_sms_campaign_provider_attempt`,
  which holds the same per-phone advisory lock, runs immediately before provider
  I/O, and can actually still prevent the send.
- After the send, recording is unconditional. Only the **identity** fence —
  state, claim token, idempotency key — can refuse, and it refuses a caller who
  does not own the attempt, never a send that happened.
- The eligibility signals are still evaluated and written down as a
  `provider.accepted_while_ineligible` event with the specific reasons.
  Compliance keeps the signal; the record survives.
- Timestamps are clamped rather than rejected. The worker's clock is a Node
  process on Railway and the comparison clock is Postgres.

This makes the caps stricter, never looser. Nothing about who may be claimed or
sent to has changed.

**A row in flight counts.** The three cadence predicates in
`claim_sms_campaign_recipients` now also count a ledger row whose recipient is
still `sending` or `reconciliation_required`. That closes the same hole for the
case where the worker simply dies between the provider call and the acceptance
RPC, and it needs no timer: a row counts from the instant it enters `sending`
and keeps counting until a person resolves the reconciliation.

`release_expired_sms_campaign_claims` must keep refusing to expire the
reservation of a row in those states. Removing that guard re-opens the hole.

## Delivery receipts

`lib/campaigns/delivery-receipts.js` runs inside the existing Telnyx webhook.
It is a no-op for every message that is not a campaign recipient, which is
almost all of them, and it is never awaited — campaign bookkeeping must not
delay or fail the status update the inbox is waiting on.

Only terminal outcomes are recorded. `sent` and `queued` are progress, and the
acceptance record already covers them.

Trust is separate from status. An unsigned webhook still updates what a person
sees, because a failed message should look failed. It is recorded without a
trust source, so it can never become a revenue claim — campaign attribution
counts only `telnyx_ed25519_v2` evidence.

## Turning it on

In order, and not before the one above is true:

1. **Consent exists.** There are currently zero `sms_consent_events` rows, so
   every recipient is correctly suppressed for missing consent. Nothing below
   matters until this is solved, and it is a business decision about what was
   actually collected, not a code change.
2. **Provider approval.** Set `provider_approved` with its reference, timestamp
   and approver. Owner only — `campaigns.configure`.
3. **`scripts/campaign-delivery-fixes-migration.sql` applied.** Without it the
   frequency caps do not hold for any send whose acceptance fails to record, and
   delivery receipts cannot be matched to campaign messages. Migration first,
   then the code that depends on it.
4. **`CAMPAIGNS_LIVE_SEND_ENABLED=true`** in Railway, then redeploy. The log
   line at boot says which mode it started in.
5. **`live_send_enabled`** in settings. This is the last switch, and the one to
   flip back first if anything looks wrong.

Claim recovery runs on its own 15-minute timer whether or not sending is
enabled, so rows abandoned by an earlier run are still resolved after the
feature is switched back off.

Both timers in `server.js` carry a re-entrancy guard. A batch can legitimately
outlast its own two-minute interval, and without the guard `setInterval` stacked
concurrent `deliverBatch` runs that fenced each other out of their own leases.
