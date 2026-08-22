# The Activity Center

An append-only record of who did what, when, and what the affected row looked
like before and after.

Sources: `scripts/audit-migration.sql`, `lib/audit/event-types.js`,
`lib/audit/log.js`, `lib/audit/redact.js`, `routes/audit.js`, the 33
`logAudit()` / `logAuditSafely()` call sites, and `test/audit-log.test.js`,
`test/audit-redact.test.js`, `test/audit-api.test.js`,
`test/audit-team.test.js`, `test/audit-sync-latch.test.js`.

## The question this exists to answer

One Admin cancels a queued automation. Another Admin needs to see that it
happened, who did it, when, and what the message was going to be. Before this,
the only trace was a `console.log` line on Railway and a `status = 'cancelled'`
in `sms_scheduled` with no author and no timestamp.

That is why the automation events are the most detailed ones in the taxonomy and
why the `previous_state` / `new_state` columns exist at all.

There is now a second question of equal weight, and it is the same question about
a different object: **one Admin changes what another person is allowed to do, and
somebody needs to see it.** `sms_auth_events` records who signed in; it cannot
answer who granted whom Admin last Tuesday. The nine `team.*` types below are
that answer. Everything else in the taxonomy is secondary to those two.

## Read this first: the name collision

There are two things in this repository called "activity" and they are different
subsystems.

| | scheduled-SMS queue | audit trail |
|---|---|---|
| route file | `routes/activity.js` | `routes/audit.js` |
| API prefix | `/api/activity/*` | `/api/audit` |
| tables | `sms_scheduled`, `sms_sent_log` | `sms_audit_log` |
| iOS label | the **Automations** tab | the **Activity** screen |
| writes | yes — cancels a queued message | never; read-only by construction |

So the tab labelled "Automations" calls `/api/activity/*`, and the screen
labelled "Activity" calls `/api/audit`. The labels and the paths are crossed.

**The live route was not renamed.** The iOS binary already in the field calls
`/api/activity/stats`, `/api/activity/queue`, `/api/activity/recent` and
`DELETE /api/activity/queue/:id` by those exact paths. Renaming them would break
every installed copy for the sake of tidiness, and an iOS build cannot be
replaced without a multi-day TestFlight round trip. Both files carry a header
comment pointing at the other. If the paths are ever unified, it has to be done
additively — serve both prefixes, wait for the old build to age out, then remove
one.

## The event model

One row per event in `sms_audit_log`. The columns that carry meaning:

| column | notes |
|---|---|
| `id` | `bigint` identity. **This is the pagination cursor**, which is why it is not a uuid — a uuid would force offset pagination, and offsets duplicate and skip rows on a feed that grows at the head |
| `workspace_id` | `'vici'`, leading column of every index; a hedge against multi-tenancy, not a feature today |
| `occurred_at` | when the action happened, which is not always insert order |
| `actor_type` | `user` \| `system` \| `integration` \| `contact` \| `anonymous` |
| `actor_user_id` | **no foreign key**, deliberately — an audit row must survive deletion of the account that performed the action |
| `actor_display_name`, `actor_role` | denormalised at write time. The read path therefore performs no join, and the row preserves what the actor was called *at the time* |
| `event_type` | key of `lib/audit/event-types.js` |
| `category` | stored column with a CHECK constraint; what a UI tab filters on with `.eq()` |
| `visibility` | `feed` \| `detail` \| `audit` |
| `severity` | `info` \| `notice` \| `warning` |
| `entity_type`, `entity_id` | what was acted on. `entity_id` is text, always stringified |
| `contact_phone` | full E.164 — see the privacy section |
| `summary` | one rendered sentence, written once by the code that had the context |
| `previous_state`, `new_state` | jsonb snapshots with message content structurally stripped |
| `changed_fields` | `text[]`; explicit from the call site, or diffed from the two snapshots |
| `metadata` | jsonb, allowlisted per event type, capped at 8 KB |
| `ip`, `user_agent`, `request_id` | request provenance where there is a request |
| `fingerprint` | optional idempotency key, partial-unique on `(workspace_id, fingerprint)` |

`category` is a stored column rather than something derived at read time for one
specific reason. If a tab filtered by listing its event types, that list would
grow with every new type and end up inside a Supabase `.in()`, which serialises
into the request URL — the exact shape that took the inbox down on 20 August
2026 (`docs/` note in `test/no-unbounded-in.test.js`). Deciding category
centrally in `event-types.js` keeps the read path a single equality filter.

### Visibility tiers

- **`feed`** — belongs in the main Activity list.
- **`detail`** — correct and worth keeping, but too frequent for the main list.
  Shown on an entity or contact timeline. `automation.queue_item.scheduled`
  fires on every queued message; putting it in the feed would bury everything
  else.
- **`audit`** — compliance/forensic only. Hidden unless `includeAudit=true`.
  Currently: who played a recording, who was issued SIP credentials, what the
  retention job purged.

### Severity

- **`info`** — routine.
- **`notice`** — a deliberate human decision worth noticing.
- **`warning`** — silently destructive or hard to reverse.

`contact.phone_changed` is a warning rather than an info because changing the
number silently detaches every message and order in the history: those rows key
on the phone number, not on a contact id.

## The full event-type taxonomy

36 types. Six of them are reserved and cannot be emitted, leaving 30 live.

### automations

| event type | entity type | visibility | severity |
|---|---|---|---|
| `automation.queue_item.cancelled` | `scheduled_message` | feed | notice |
| `automation.queue_item.bulk_cancelled` | `scheduled_message_set` | feed | notice |
| `automation.queue_item.scheduled` | `scheduled_message` | detail | info |
| `automation.queue_item.failed` | `scheduled_message` | feed | warning |

### contacts

| event type | entity type | visibility | severity | |
|---|---|---|---|---|
| `contact.created` | `contact` | feed | info | |
| `contact.updated` | `contact` | detail | info | |
| `contact.phone_changed` | `contact` | feed | warning | |
| `contact.opted_out` | `contact` | feed | notice | **consent-bearing** |
| `contact.opt_in_restored` | `contact` | feed | notice | **consent-bearing** |
| `contact.bulk_imported` | `contact_set` | feed | warning | |

`contact.opt_in_restored` is declared and consent-bearing but has **no call
site**. Nothing in the codebase restores an opt-in today; the opt-out sentinel in
`sms_sent_log` is written and never removed. It is the one live event type with
no emitter, and it is where a future "resubscribe" action should log.

### calls

| event type | entity type | visibility | severity |
|---|---|---|---|
| `call.recording.started` | `call` | detail | notice |
| `call.recording.stopped` | `call` | detail | info |
| `recording.played` | `call_recording` | audit | notice |
| `recording.purged` | `call_recording` | audit | warning |

### security

| event type | entity type | visibility | severity |
|---|---|---|---|
| `security.voice_credentials.issued` | `sip_credential` | audit | notice |

Records that SIP credentials were issued and to whom. The password is never part
of the row; `redact.js` drops it by key name, by pattern, and by value.

### settings

| event type | entity type | visibility | severity |
|---|---|---|---|
| `settings.sync.triggered` | `sync_job` | feed | info |
| `settings.sync.completed` | `sync_job` | detail | info |
| `settings.sync.failed` | `sync_job` | feed | warning |

### messages

| event type | entity type | visibility | severity | fires from |
|---|---|---|---|---|
| `message.catchup.sent` | `catchup_run` | feed | warning | `routes/catchup.js`, `POST /api/catchup/send` |

Routine outbound sends are **not** audited — `sms_sent_log` and `sms_messages`
are already that ledger. This one is, because a person pressed a button that
messaged customers who were not expecting it. One summary row per run, never one
per recipient, for the same reason `automation.queue_item.bulk_cancelled` is a
single row: the metadata carries `sent`, `failed`, `skipped`,
`processing_candidates` and `shipped_candidates`.

It is `logAuditSafely` and awaited only **after** the sends. The customers have
already been messaged by that point, so a failed audit insert must not turn a
completed run into a 500 that invites somebody to run it again.

### campaigns — lifecycle auditing is live; launch remains reserved

| event type | entity type | visibility | severity | fires from |
|---|---|---|---|---|
| `campaign.suggestion.sent` | `campaign_suggestion` | feed | notice | `routes/intelligence.js`, `POST /api/intelligence/campaigns/:id/send` |
| `campaign.suggestion.dismissed` | `campaign_suggestion` | detail | info | `routes/intelligence.js`, the dismiss handler |
| `campaign.created` | `campaign` | feed | info | `routes/campaigns.js`, draft creation |
| `campaign.edited` | `campaign` | feed | info | `routes/campaigns.js`, draft replacement |
| `campaign.review_submitted` | `campaign` | feed | notice | `routes/campaigns.js`, review submission |
| `campaign.rejected` | `campaign` | feed | notice | `routes/campaigns.js`, Admin rejection |
| `campaign.approved` | `campaign` | feed | notice | `routes/campaigns.js`, two-phase approval |
| `campaign.scheduled` | `campaign` | feed | notice | `routes/campaigns.js`, approved scheduling |
| `campaign.cancelled` | `campaign` | feed | notice | `routes/campaigns.js`, cancellation |

A campaign *suggestion* is one AI-drafted message to one contact, approved and
released by a human. It sits in category `'campaigns'` because that is the tab it
belongs on, and it is separate from the frozen-audience campaign lifecycle. Both are
safe-logged after the effect: the SMS has already gone out, and an audit failure
must not produce a 500 that invites a second send. The drafted body is referenced
by `messageFingerprint()` — length and digest — never copied.

`campaign.approved` is consent-bearing: the database revision cannot become
`approved` unless the exact frozen revision/audience audit row exists. Message
content is never copied into the audit log; only allowlisted lengths/digests and
counts are stored. `campaign.launched` alone remains reserved because this
release deliberately has no live campaign delivery worker. Emitting it would be
a false operational claim.

### team

Nine types, all live and all instrumented. This section previously said the
`team` category had no emitters. That is no longer true and has not been true
since `routes/users.js` and `routes/invitations.js` were instrumented.

Team management is the other flagship, alongside
`automation.queue_item.cancelled`. "One Admin must be able to see what another
Admin did" is meaningless if the most sensitive class of admin action — granting
and revoking access — is invisible. `sms_auth_events` records who signed *in*,
not who changed what somebody is allowed to do.

| event type | entity type | visibility | severity | fires from |
|---|---|---|---|---|
| `team.member.invited` | `user_invitation` | feed | notice | `routes/invitations.js`, `POST /api/invitations`, after the row exists |
| `team.invitation.revoked` | `user_invitation` | feed | notice | `routes/invitations.js`, `POST /api/invitations/:id/revoke` |
| `team.member.activated` | `user` | feed | notice | two sites: `routes/users.js` `POST /api/users` (`via: 'direct_creation'`) and `routes/invitations.js` `auditRedemption()` after `POST /auth/invitation/accept` (`via: 'invitation'`) |
| `team.member.role_changed` | `user` | feed | **warning** | `routes/users.js`, `PATCH /api/users/:id`, only when `patch.role` is set |
| `team.member.deactivated` | `user` | feed | **warning** | `routes/users.js`, `POST /api/users/:id/deactivate` |
| `team.member.reactivated` | `user` | feed | notice | `routes/users.js`, `PATCH /api/users/:id` with `isActive: true` |
| `team.member.password_reset` | `user` | feed | **warning** | `routes/users.js`, `POST /api/users/:id/reset-password` |
| `team.permission_override.granted` | `user_permission_grant` | feed | **warning** | `routes/users.js`, `PATCH /api/users/:id`, one row per grant |
| `team.permission_override.revoked` | `user_permission_grant` | feed | notice | `routes/users.js`, `PATCH /api/users/:id`, one row per revoke |

Design rules that hold across all nine:

- **`activated`, not `created`.** The event that matters is a new identity
  becoming able to act, whichever endpoint it arrives through. `can_sign_in`
  distinguishes an account created with a password from one created without.
- **Every summary names the actor *and* the target explicitly**, and spells roles
  with their catalogue **display names** ("Support Agent", not "agent"), resolved
  through `createRoleNamer()`. The summary is rendered once and must still read
  correctly years after the roles table has been edited.
- **One row per kind of change.** A `PATCH` that both changes a role and adds two
  overrides writes three rows, not one. A role change and a permission override
  answer different questions and folding them together destroys both answers.
  Overrides are one row each — "who was given `automation.cancel`, and why" is
  the question they exist to answer, and a rolled-up row cannot answer it.
- **`logAuditSafely`, and after the write has landed.** By the time these run the
  role is granted, the session is revoked, the invitation is live. A throw there
  would turn a completed action into a 500 and invite a retry of something that
  already happened. `auditRedemption()` goes further and is wrapped entirely: an
  account has just been created inside a committed SQL transaction, so nothing in
  it may throw — a failure degrades to a warning and a missing row, never to an
  invitee who cannot finish signing up.
- **No credential is ever on one of these rows.** No password, no temporary
  password, no invitation token, no token hash. Three independent layers: the
  per-event allowlists in `lib/audit/redact.js` omit every such key,
  `SECRET_KEY_PATTERN` drops them a second time even if an allowlist is edited by
  mistake, and `test/audit-team.test.js` asserts their absence in the serialised
  row. The reset handler carries no `previousState`/`newState` at all, because
  every field that would describe the change is password-shaped.
- **The invitation token hash is a filter, never a value.** `auditRedemption()`
  looks the invitation up *by* `token_hash` and writes neither it nor
  `token_prefix`.

Who the actor is differs in one case. For an invitation redemption the **invitee**
is the actor — they redeemed the token — because the inviting Admin is already
recorded on the `team.member.invited` row.

#### Worked example: promoting a Support Agent

`PATCH /api/users/12 { "role": "admin" }`, by an Owner whose actor is
`{ id: 3, displayName: 'Lubosi', role: 'owner' }`, against Dana, a Support Agent.

`revokeSessions(12)` runs first — the epoch bump plus `authz.invalidate(12)` —
and only then is the row written:

```json
{
  "workspace_id": "vici",
  "occurred_at": "2026-08-21T14:32:10.004Z",

  "actor_type": "user",
  "actor_user_id": 3,
  "actor_display_name": "Lubosi",
  "actor_role": "owner",

  "event_type": "team.member.role_changed",
  "category": "team",
  "visibility": "feed",
  "severity": "warning",

  "entity_type": "user",
  "entity_id": "12",
  "contact_phone": null,

  "summary": "Lubosi changed Dana from Support Agent to Admin",

  "previous_state": { "role": "agent" },
  "new_state":      { "role": "admin" },
  "changed_fields": ["role"],

  "metadata": {
    "user_id": 12,
    "email": "dana@example.com",
    "previous_role": "agent",
    "new_role": "admin",
    "previous_role_display_name": "Support Agent",
    "new_role_display_name": "Admin",
    "logins_revoked": true
  },

  "ip": "203.0.113.9",
  "user_agent": "Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0",
  "request_id": null,
  "fingerprint": null
}
```

Points worth noticing:

- `severity` is `warning`, not `notice`. A role change is hard to reverse in
  effect: it ends every live session for that person mid-shift.
- Both the raw keys and the display names are in metadata. The raw keys survive a
  rename of the display name; the display names survive a rename of the keys.
  `summary` is rendered from the display names and is never recomputed.
- `logins_revoked: true` is a fact about what already happened, not an intention.
  The bump ran before the log.
- `campaign.launched` would throw here because it is still reserved; the other
  campaign lifecycle types and every `team.*` type are live.

#### `audit: true` in the route policy is still descriptive only

`lib/route-policy.js` marks audited mutation entries `audit: true` and `lib/enforce-policy.js`
copies that onto `req.policy.audit`. **Nothing reads it.** Every row in this table
is written by an explicit `logAudit()` / `logAuditSafely()` call inside a handler,
never by the policy layer. That is unchanged, and it is a gap rather than a
decision — but note that the flag would be the wrong mechanism on its own: a
middleware cannot know the before state, the after state, or the sentence.

### What is deliberately not audited

- **Successful automated sends.** `sms_sent_log` is already that ledger and its
  unique index makes a double-insert impossible. Failures are audited; successes
  are referenced.
- **Inbound messages.** They are already in `sms_messages`.
- **Read-state changes** — marking a thread read, opening a conversation.
  Recording who opened which conversation is the fastest way to make a
  two-person team feel surveilled, and it answers no question anybody has asked.

## Worked example: cancelling one queued automation

`DELETE /api/activity/queue/8421`, by an Admin whose actor is
`{ id: 7, displayName: 'Dominic', role: 'admin' }`.

The handler in `routes/activity.js` `SELECT`s the pending row first — so the
snapshot is the exact pre-change state, not a reconstruction — then updates the
status, then logs. The row in `sms_scheduled` was:

```json
{
  "id": 8421,
  "order_id": "4177",
  "phone": "+14155550143",
  "flow_type": "hold-msg2",
  "message_body": "Hi Dana, your order is still on hold. Reply HELP…",
  "send_at": "2026-08-22T14:00:00.000Z"
}
```

The audit row written:

```json
{
  "workspace_id": "vici",
  "occurred_at": "2026-08-21T09:14:02.118Z",

  "actor_type": "user",
  "actor_user_id": 7,
  "actor_display_name": "Dominic",
  "actor_role": "admin",

  "event_type": "automation.queue_item.cancelled",
  "category": "automations",
  "visibility": "feed",
  "severity": "notice",

  "entity_type": "scheduled_message",
  "entity_id": "8421",
  "contact_phone": "+14155550143",

  "summary": "Cancelled the queued hold-msg2 message for order 4177",

  "previous_state": {
    "id": 8421,
    "order_id": "4177",
    "phone": "+14155550143",
    "flow_type": "hold-msg2",
    "send_at": "2026-08-22T14:00:00.000Z",
    "status": "pending"
  },
  "new_state": {
    "id": 8421,
    "order_id": "4177",
    "phone": "+14155550143",
    "flow_type": "hold-msg2",
    "send_at": "2026-08-22T14:00:00.000Z",
    "status": "cancelled"
  },
  "changed_fields": ["status"],

  "metadata": {
    "scheduled_id": 8421,
    "order_id": "4177",
    "flow_type": "hold-msg2",
    "send_at": "2026-08-22T14:00:00.000Z",
    "reason": "manual",
    "message_length": 49,
    "message_digest": "9f2c…64 hex chars…"
  },

  "ip": "203.0.113.9",
  "user_agent": "Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0",
  "request_id": null,
  "fingerprint": null
}
```

Points worth noticing:

- `category`, `visibility`, `severity` and `entity_type` are **not** supplied by
  the call site. They come from `eventDefinition('automation.queue_item.cancelled')`.
  A row written with the wrong category is wrong permanently, so one table of
  definitions is reviewed instead of forty call sites.
- `entity_id` is `"8421"`, a string. `buildRow()` stringifies whatever it is
  given.
- `changed_fields` is explicit here. When a call site omits it and supplies both
  snapshots, `diffFields()` computes it by `JSON.stringify` comparison per key
  and sorts the result.
- `message_body` appears in neither snapshot and neither does anything derived
  from it beyond length and digest. See the privacy section.
- The same shape, with `actorType: 'system'` and no `req`, is written by the
  queue processor in `flows/utils.js` when an order recovers and its hold
  messages are cancelled automatically — `reason: 'order_recovered'` instead of
  `'manual'`.

## Bulk cancels collapse to one row

A single WooCommerce webhook can cancel a dozen queued messages at once.
`cancelScheduled(orderId)` and `cancelScheduledForCustomer(phone, flowTypes)`
both write **one** `automation.queue_item.bulk_cancelled` row, never one per
message. Twelve near-identical rows would bury everything a human actually needs
to read, and `test/audit-log.test.js` asserts the count is exactly one.

```json
{
  "event_type": "automation.queue_item.bulk_cancelled",
  "entity_type": "scheduled_message_set",
  "entity_id": "4177",
  "contact_phone": "+14155550143",
  "actor_type": "system",
  "actor_display_name": "Automation",
  "summary": "Cancelled 4 queued message(s) for order 4177",
  "previous_state": { "status": "pending", "pending_count": 4 },
  "new_state":      { "status": "cancelled", "pending_count": 0 },
  "changed_fields": ["status"],
  "metadata": {
    "scope": "order",
    "order_id": "4177",
    "reason": "order_state_changed",
    "cancelled_count": 4,
    "flow_types": ["hold-msg1", "hold-msg2", "hold-msg3"],
    "scheduled_ids": [8419, 8420, 8421, 8422],
    "scheduled_ids_truncated": false
  }
}
```

The individual ids are not lost — `cappedScheduledIDs()` puts them in metadata,
capped at 200 with `scheduled_ids_truncated: true` beyond that, which the tests
also assert. `entity_id` is the order id for an order-scoped cancel and
`"phone:+1…"` for a customer-scoped one.

`contact_phone` is set only when every cancelled row shares the same number
(`singleContactPhone()`); a bulk cancel spanning several customers records
`null` rather than picking one arbitrarily. `scope` distinguishes the two
entry points, and `reason` distinguishes `order_state_changed`,
`customer_replied` and `customer_opted_out`.

If nothing was actually cancelled, nothing is logged. An empty result writes no
row.

## Write path

`lib/audit/log.js` is the only writer. `logAudit(input, options)`.

**Fail-open by default.** An audit write must never break a send, a call, or a
cancel. A missing table, a stale PostgREST schema cache, or any insert failure
returns `{ recorded: false, reason }` and the originating request continues. A
missing table is warned about exactly once per process, mirroring
`lib/analytics/events.js`, so an un-migrated deploy does not emit one warning per
queued message.

**Three exceptions, all deliberate:**

1. **Consent-bearing types throw — but only when the table exists and refused
   the write.** `contact.opted_out` and `contact.opt_in_restored` are flagged
   `consentBearing` in `event-types.js`. A consent record that cannot be written
   must stop the action rather than let it proceed unrecorded. In `flows/utils.js`
   the opt-out sentinel row is written to `sms_sent_log` first, and if *that*
   fails the function returns early — there is nothing truthful to audit if the
   customer is not actually opted out. See the ordering section below.
2. **Unknown event types throw.** `automation.queue_item.canceled` (one `l`)
   fails loudly in a unit test rather than quietly writing nothing.
3. **Reserved types throw.** A `campaign.*` event cannot be emitted before the
   campaigns feature exists.

A `23505` unique-violation on `fingerprint` is treated as success, including for
a consent-bearing event. That is the point of a fingerprint: the event is already
recorded. `contact.opted_out` uses `contact.opted_out:${phone}`, so a retried
Telnyx webhook produces one row.

### The catch-block ordering, which is the opposite of what it looks like

Inside `logAudit()`'s catch, the order is fixed and load-bearing:

```
1. 23505 fingerprint collision  -> success ('duplicate')
2. isMissingAuditSchema(error)  -> FAIL OPEN ('schema_missing'), warn once
3. definition.consentBearing    -> throw AuditWriteError
4. everything else              -> fail open ('write_failed')
```

Step 2 comes **before** step 3, and that is the correction. It reads backwards —
surely a consent record is the thing you never let slide — so here is the failure
it prevents, which shipped twice already.

In the window between deploying the code and applying
`scripts/audit-migration.sql`, `contact.opted_out` throws. Its only caller is
`markOptedOut()`, whose only caller is the Telnyx **STOP** branch in
`routes/webhook.js`. The throw propagates into that handler's outer catch, and
every statement after `markOptedOut` is skipped: queued sequences are never
cancelled, the STOP message is never recorded, the `opt_out` broadcast never
fires. **A customer who texted STOP keeps receiving automation SMS.**

The principle, stated once so it is not re-litigated:

> An unrecorded suppression is a bookkeeping problem. An unhonoured STOP is a
> regulatory one.

A migration that has not been applied yet is an operator sequencing problem, not
evidence that consent went unrecorded. So fail open on it, and reserve the hard
failure for **a table that exists and refused the write** — which is a real
signal that something is wrong with the record, not with the deploy.

`routes/webhook.js` belts this a second time. The STOP branch wraps the call:

```js
try {
  await markOptedOut(fromPhone);
} catch (optOutErr) {
  console.error(`[OPT-OUT] Proceeding with suppression despite an unrecorded consent event …`);
}
await cancelScheduledForCustomer(fromPhone).catch(() => {});
```

so no future audit failure of any kind — not only a missing table — can skip the
suppression. Two independent guards, because this exact branch has broken twice
through two different mechanisms, and the second time was caused by fixing the
first one in only one place.

(`cancelScheduledForCustomer` is an ordinary async function, so `.catch()` on it
is real. `.catch()` on a Supabase query builder is not — see the next section.)

### The third way the STOP branch broke: `.catch()` on a query builder

Not an audit bug, but it lived in the same three lines and it is now guarded, so
it belongs here.

A Supabase query builder is a **thenable, not a Promise**. It implements `then`
and nothing else; `catch` and `finally` are `undefined`. So this shape:

```js
await supabase.from('t').insert({ … }).catch(() => {});
```

does not "ignore errors". It throws `TypeError: …insert(…).catch is not a
function` **before the request is ever dispatched**, and every statement after it
in the same block is skipped.

That sat in `markOptedOut` (`flows/utils.js`) and in the Telnyx STOP branch of
`routes/webhook.js`. The one in `markOptedOut` killed the STOP branch at its
first statement: no opt-out sentinel, no sequence cancellation, no record of the
message, no broadcast. Both looked like deliberate best-effort error handling,
and the webhook's outer try/catch hid the crash. The same bug was present in the
Shore fork of this application.

PostgREST reports failures in `error`, never as a rejection, so the correct shape
is a try/catch around the `await` **and** a check of `error`.

`test/no-builder-catch.test.js` scans `routes/`, `flows/`, `lib/`, `sync/`,
`scripts/`, `server.js` and `db.js` recursively for the shape and fails on it.
Two tests: the scan itself, and a self-check that the detector still recognises
the exact source line that broke production — without which the guard could
quietly become vacuous.

### `logAuditSafely()` — for call sites where the audit follows the effect

`logAudit()` fails open on a failed insert, but it throws **before** the insert
on an unknown or reserved event type, and `buildRow()` can throw on malformed
input. At a call site that has already changed the world — a role granted, a bulk
SMS sent, a background sync latch taken — that throw propagates into the handler
and turns a completed action into a 500, or worse.

`routes/sync.js` is the "or worse". The previous shape awaited the
`settings.sync.triggered` row **before** responding and **outside** any try, so a
single failed audit insert threw past the `finally` that clears `syncRunning`:
the caller got a 500 instead of the acknowledgement, and `syncRunning` stayed
`true` **for the entire life of the process**. No sync of any kind could be
triggered again until Railway restarted the service.

The rule that came out of it:

> An audit write must never be able to wedge the feature it describes.

Every sync route now answers the client **first**, then audits, and audits with
`logAuditSafely` from inside the try whose `finally` owns the latch.
`test/audit-sync-latch.test.js` asserts all of it, including by reading
`routes/sync.js` as text to check that each route's `res.json()` precedes its
audit call.

`logAuditSafely` catches everything `logAudit` can throw and returns
`{ recorded: false, reason: 'threw' }` — **except** for a consent-bearing event
type, which it re-raises unchanged. Nothing about it weakens the consent path.

Current `logAuditSafely` call sites: `routes/sync.js` (all five),
`routes/catchup.js`, `routes/intelligence.js` (both), `routes/users.js` (all
seven) and `routes/invitations.js` (all three). Use it at any call site where the
audit follows the effect.

After a successful insert the writer emits an SSE `audit_changed` event carrying
the new row id, category, visibility and timestamp — a **dedicated** event, not
the analytics `analytics_changed` one. A client sitting on the Analytics tab
would otherwise refetch the entire revenue overview every time somebody cancelled
a queued SMS.

### The `LEGACY_ACTOR` fallback

When neither `input.actor` nor `req.actor` is present, the row is written as
`{ actor_type: 'user', actor_user_id: null, actor_display_name: 'Team',
actor_role: 'legacy' }`. Its stated purpose is that the audit table accumulates
correct before/after history even before real identities exist, with `'legacy'`
marking exactly which rows predate them.

With RBAC deployed, `req.actor` is populated on every `/api` request, so
request-scoped call sites resolve a real actor. The fallback now only catches
non-request call sites that forgot `actorType: 'system'`. It is worth keeping for
that reason — `'Team' / 'legacy'` in the feed is a visible signal that a call
site is missing its actor — but it no longer means what its comment says it
means.

## Privacy

### Message bodies are never stored. Ever.

`sms_audit_log` has no body column and never will. What is stored instead is
`metadata.message_length`, a sha256 `metadata.message_digest`, and the id of the
source row.

Four reasons, in order of how much they matter:

1. **A customer erasure request can be honoured against the source tables and
   cannot be honoured here.** `sms_scheduled`, `sms_sent_log` and `sms_messages`
   are ordinary tables. `sms_audit_log` has `REVOKE DELETE` and an immutability
   trigger. Copying customer content into it would convert a routine deletion
   request into an incident.
2. **Nothing is lost.** The body already lives durably in the source table, and
   the audit row references it by id.
3. **A truncated body would be the worst of both** — still personal data, no
   longer usable as evidence.
4. **A digest answers the question that actually gets asked later**, which is
   whether the text sitting in `sms_scheduled` today is byte-identical to the
   text that was there when the action was taken. A stored copy proves nothing
   of the sort, because it is a copy.

The guarantee is structural rather than a habit. Three independent layers:

- `sanitiseState()` strips every key in `MESSAGE_BODY_KEYS` from both snapshots
  before they are stored.
- `redactMetadata()` drops the same keys from metadata **before** consulting the
  allowlist, so adding `body` to an allowlist by mistake still does not write it.
- No allowlist names any of them.

`MESSAGE_BODY_KEYS` covers `body`, `message_body`, `message`, `text`, `content`,
`sms_body`, `transcript`, `preview`. `test/audit-log.test.js` asserts on the
serialised JSON of the built row — not on a field-by-field check — that the body
text does not appear anywhere in it.

### State snapshots get the secret and signed-URL screens too

`sanitiseState()` used to filter message-body keys and nothing else. It now
applies the same unconditional screens the metadata path applies, through
`stateEntryIsUnsafe()` in `lib/audit/redact.js`:

1. the key is dropped if its **name** matches `SECRET_KEY_PATTERN`
   (secret / password / passwd / api_key / private_key / access_key / credential
   / authorization / bearer / session / cookie / signature / p8), with
   `device_token_last8` the single reviewed exemption;
2. the entry is dropped if its **value** holds a live configured secret read from
   the environment at call time, or looks like a signed or provider-temporary
   media URL (`SIGNED_URL_PATTERN`);
3. nested objects and arrays are walked to a depth of 6, and anything deeper than
   that is treated as unsafe rather than trusted — the offending string is as
   likely to be one level down as at the top.

What survives is then run through `capMetadata()`, so a snapshot is subject to
the same 8 KB ceiling as metadata.

What state **cannot** get is the allowlist. A snapshot's keys are the source
row's column names, and those are not enumerable in advance — which is precisely
why the unconditional screens have to apply instead.

**No current call site trips any of this.** The point is that the next one
cannot. `previous_state` and `new_state` are returned verbatim by
`GET /api/audit` and land in a table with `REVOKE DELETE` and an immutability
trigger, so a signed recording URL or a SIP password written into a snapshot is
burned in permanently.

### `ip` is validated with `net.isIP`, not a character class

The `ip` column is Postgres `inet`. It rejects anything malformed with `22P02`,
which fails the whole insert and loses the audit row.

A character-class test is not a validator: it admits `aaaa`, `1.2.3.4.5.6`,
`::::` and `....`, all of which Postgres refuses. `clientIP()` uses
`net.isIP()` from `node:net` — the actual parser — and stores `null` for anything
that is neither a valid IPv4 nor a valid IPv6 address. A row with a null `ip` is
worth far more than no row at all.

### Metadata is an allowlist, keyed by event type

Not a denylist. A denylist fails open the first time somebody adds a new
provider field or a debug key to a call site. An allowlist fails closed: an
unrecognised key is dropped and the row is still written. Since the table cannot
be UPDATEd, "drop it unless it was explicitly approved" is the only defensible
default.

On top of the allowlist, `redact.js` enforces rules the allowlist cannot express:

- **No secret, ever.** Screened by key name (`SECRET_KEY_PATTERN` matches
  secret/password/api_key/private_key/credential/authorization/bearer/session/
  cookie/signature/p8) **and** by comparing values against the live configured
  secrets read from the environment at call time. So a secret smuggled in under
  an allowlisted key name is still dropped. `device_token_last8` is the single
  reviewed exemption from the name pattern.
- **No signed recording URL.** `/api/voice/recordings/:id` mints a short-lived
  signed URL; writing one into a permanent table would outlive its own expiry
  policy. Matched by `SIGNED_URL_PATTERN`, including inside arrays.
- **No raw APNs device token.** Last 8 characters only, matching the convention
  already used in `routes/mobile-push.js`.
- **8 KB cap** on the serialised object, keeping keys in declaration order and
  setting `truncated: true`.

The `security.voice_credentials.issued` allowlist is the sharpest case: `login`
is permitted because it identifies *which* credential was handed out, and the
SIP password is not on the list and must never be added to it.
`test/audit-redact.test.js` asserts it is dropped even when a caller hands it
straight over under the key `password`, and separately that every name in
`SECRET_ENV_NAMES` is screened out by value.

### Phone numbers are stored in full, deliberately

`contact_phone` holds the complete E.164 number. This breaks the codebase's
`...${phone.slice(-4)}` logging habit on purpose, and it is a considered choice
rather than an oversight.

- `GET /api/audit/contact/:phone` — the per-contact audit export — is
  unbuildable from the last four digits. That endpoint is the reason the column
  exists in this shape.
- The same number already sits in `sms_contacts`, `sms_messages`,
  `sms_scheduled` and `sms_sent_log`. Storing it here adds no new *class* of
  personal data to the database.
- The masking convention exists for **logs**, which leave the database and land
  in Railway's log stream. `sms_audit_log` is inside the same database, under the
  same RLS posture as every other table, reachable only through the service role.

The trade this accepts: a phone number cannot be erased from the audit trail,
because the trail cannot be deleted from. That is the same trade as the body
decision, resolved the other way, and the difference is that a number is an
identifier the row is about while a body is content the row merely references.

## Immutability: tamper-resistance, not tamper-evidence

Be precise about this, because the distinction is the whole point.

What the migration actually does:

- A `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger that raises
  `restrict_violation`.
- A **second**, statement-level `BEFORE TRUNCATE` trigger. A row-level trigger
  does not fire on `TRUNCATE`; without this the table is one
  `TRUNCATE sms_audit_log;` away from empty and the row trigger would never have
  been consulted.
- `REVOKE UPDATE, DELETE, TRUNCATE … FROM service_role`, and
  `GRANT INSERT, SELECT` only.
- RLS enabled with no policies, so anon and authenticated see zero rows.
- `routes/audit.js` exposes no POST, PATCH or DELETE, and
  `test/audit-api.test.js` asserts the router's stack contains no write method.

**The load-bearing control is the trigger, not the grants.** The backend holds
the service-role key, so any grant given to `service_role` is a grant given to
anything that can read the Railway environment. The trigger refuses the statement
regardless of who issued it, which is why it exists as well as the revoke.

**Neither control stops a Postgres superuser with Supabase SQL-editor access —
which is us.** A superuser can `ALTER TABLE … DISABLE TRIGGER`, drop the trigger,
or drop the table. Nothing in this design proves to a third party that a row was
never removed.

So: tamper-**resistance**. Not tamper-**evidence**. Genuine tamper-evidence needs
periodic export, or hash-chain anchoring, to a location this application and this
database cannot write to. That is a conscious deferral, recorded here and in the
migration header so the next reader does not mistake "append-only" for "provably
complete".

There is also no write API, and there will not be one. An audit row is a
by-product of doing something, never a thing a client asks for. A write API would
also be an API for writing rows describing events that never happened.

## Retention: there is none, on purpose

No TTL, no purge job, no archive step. Nothing deletes from `sms_audit_log`, and
nothing can.

The reasoning is not "we forgot":

- **A delete job with a filter is a delete job somebody eventually gets wrong.**
  The failure mode is concrete and predictable: somebody adds a consent-bearing
  event type, forgets to add it to the retention exclusion list, and ninety days
  later the record that mattered most is the one that got swept. The exclusion
  list is the part that rots, and it rots silently.
- **Storage is not the constraint.** At roughly 500 events a month this table
  grows a few MB a year.
- **A retention job would need `DELETE`**, which means either dropping the
  trigger or granting back the privilege the design just revoked. The
  immutability guarantee and a retention job are mutually exclusive, and
  immutability is the more valuable of the two here.

If a legal retention limit is ever imposed, the honest implementation is export
then drop the whole table, as a reviewed one-off, not a cron job with a `WHERE`
clause.

The one exception in the neighbourhood is call *recordings*, whose retention
deletion lives in `lib/private-recordings.js` and writes a `recording.purged`
audit row when it runs. That job deletes audio, never audit rows, and per
`AGENTS.md` it stays disabled until its dry run and target rows are approved.

## Read API

`routes/audit.js`, mounted at `/api/audit`, all five endpoints requiring
`audit.read` — Owner, Admin and the legacy shared identity, not Support Agent.
The feed names who did what, which is management information.

| endpoint | purpose |
|---|---|
| `GET /api/audit` | main feed |
| `GET /api/audit/entity/:entityType/:entityId` | everything that happened to one scheduled message, contact, call or sync job |
| `GET /api/audit/contact/:phone` | per-contact export; the reason `contact_phone` is a full number |
| `GET /api/audit/actors` | the actor filter's option list |
| `GET /api/audit/summary` | per-category counts for tab badges |

Feed parameters: `category`, `actor`, `from`, `to`, `cursor`, `limit`
(default 50, max 100), `includeAudit` (default false). All validated before any
query runs; an invalid value is a 400 with a message, never a silently different
query.

Three query-shape constraints, all traceable to the 20 August 2026 outage:

- **`category` is filtered with `.eq()`** on the stored column. Never an `in`
  filter over a list of event types.
- **`actor` is a single id, `.eq()`.** Multi-actor selection is not offered
  because it is the same unbounded list in a nicer shirt.
  `parsePositiveInteger()` rejects `"7,9"` outright rather than letting
  `Number.parseInt` silently return `7` and answer a different question than the
  one asked — which is worse in an audit tool than anywhere else.
- **Pagination is keyset:** `.lt('id', cursor)` + `.order('id', desc)` +
  `.limit(n + 1)`. Never `.range()` with a page number. The extra row makes
  "is there another page" a fact rather than a guess, so the client is never
  handed a cursor that leads to an empty page. `test/audit-api.test.js` asserts
  every row appears exactly once across pages, and that a row appended
  mid-pagination cannot duplicate or displace an existing page.

Actor display name and role come off the row, so the read path performs no
lookup at all — the denormalisation is what makes that true.

`GET /api/audit/actors` scans the most recent 1000 rows and deduplicates in
memory. That is a deliberate trade, stated in the response: an actor who has done
nothing in the last thousand events will not appear in the option list. The
alternatives are `SELECT DISTINCT` over the whole table on every page load, or a
second table to keep in sync. Filtering by an absent actor still works — any id
can be passed to `?actor=`.

A missing migration returns 503 with "The activity audit trail is unavailable
until `scripts/audit-migration.sql` is applied", not an empty and believable
feed. Database detail is logged, never returned.

## The Activity UI

Native SwiftUI, in `ios/ViciInbox/UI/ActivityLogView.swift` and
`ios/ViciInbox/App/TeamActivityModels.swift`. There is no browser UI for the
audit trail; `public/app.jsx` does not reference `/api/audit`.

**`ActivityLogView`** — reached from Settings and from the Automations toolbar.
Deliberately not a sixth tab: the `TabView` already carries five and a sixth
collapses into the "More" overflow on smaller iPhones.

- Category picker over `AuditCategory` (`all`, `messages`, `calls`,
  `automations`, `team`, `settings`, `contacts`, `security`). `campaigns` is
  omitted — which matched the reservation when it was written, but no longer
  matches the data; see gap 3 below.
- Person picker, defaulting to Everyone, populated from `/api/audit/actors` and
  disabled while that list is empty.
- Rows grouped under Today / Yesterday / a date by `AuditGrouping`, which buckets
  in the order the server returned them and **never re-sorts** — re-sorting on
  the client would fight cursor paging and make an appended page jump around.
- Infinite scroll by cursor, pull to refresh, explicit loading and empty states.
- `includeAudit` is not exposed in the UI, so the compliance tier stays hidden
  from the app entirely.

**`EntityHistoryView`** — the change history of one record: "scheduled by the
hold flow at 09:12, cancelled by Dominic at 14:32". Opened from a queue item in
the Automations tab with `entityType: "scheduled_message"`. `AuditItem`
renders only the fields the server listed in `changedFields`, so a large state
blob never becomes an unreadable wall of JSON.

### Known client/server contract gaps

Re-verified against `ios/ViciInbox/Core/AccountModels.swift`,
`ios/ViciInbox/Core/APIClient.swift` and `routes/audit.js` during the full next
build. The previously recorded client/server contract gaps are now fixed:

- **Row decoding.** `AuditItem` now declares explicit `CodingKeys` mapping every
  snake_case column (`occurred_at`, `actor_display_name`, `event_type`,
  `entity_type`, `entity_id`, `contact_phone`, `changed_fields`,
  `previous_state`, `new_state`) onto its Swift property. Rows render with real
  content instead of the "System" / "Activity" fallbacks. The paging envelope
  (`items`, `hasMore`, `nextCursor`) is camelCase because `routes/audit.js`
  builds it in JavaScript, and `AuditPage` matches it — so the two conventions
  coexist in one response and both are now decoded correctly.
- **`AuditActor` row shape and envelope.**
  It now has a custom `init(from:)` reading
  `actor_user_id`, `actor_display_name` and `actor_role`, accepting the id as
  either `Int` or `String`, and synthesising `id = "name:<displayName>"` when
  there is no user id — so the automation, a webhook and the shared identity stay
  filterable; `fetchAuditActors()` also accepts the server's `{ actors: [...] }`
  envelope.
- **Unfiltered Activity.** `.all` is omitted from the query rather than sent as
  an invalid server category.
- **Campaign filtering.** `AuditCategory` includes `campaigns`, so suggestion
  and campaign lifecycle rows are reachable.
- **Team/invitation envelopes.** The client decodes `{ users, roles }` and
  `{ invitations }`, while retaining bounded compatibility fallbacks.

## Why this did not reuse the analytics event model

`docs/analytics/ANALYTICS-ARCHITECTURE.md` describes a mature event ledger —
`analytics_order_events`, `analytics_message_events`, `revenue_attributions`
with a history table and an update trigger. Reusing it was considered and
rejected. The two subsystems have opposite semantics on four axes:

| | analytics events | audit events |
|---|---|---|
| **actor** | a provider. WooCommerce, Telnyx, GHL | a person, usually. `actor_user_id`, `actor_display_name`, `actor_role` are the primary columns |
| **trust** | cryptographic. Only a verified Woo HMAC or a Telnyx v2 Ed25519 signature enters the trusted ledger | the request is already authenticated by `resolveActor`; there is no second signature and no concept of an untrusted audit event |
| **dedup** | mandatory and keyed on a provider event id. **A replayed webhook must not double-count revenue** | mostly absent by design. **A repeated human action is a second real event and must appear twice.** Cancelling, re-queueing, and cancelling again is three rows, and collapsing them would destroy the record. `fingerprint` is opt-in, used by exactly one call site, for the specific case of a retried webhook representing one real-world consent change |
| **mutability** | required. A refund reclassifies an order; `revenue_attributions` is updated in place and a trigger copies the prior revision into `revenue_attribution_history` | forbidden. `REVOKE UPDATE` plus a trigger. A correction is a new row, never an edit |

They also disagree about content. Analytics deliberately stores no duplicate of
raw message text and computes aggregates; the audit trail deliberately stores
before/after state snapshots of individual rows. One is a measurement system, the
other is a record of decisions.

Where they touch:

- Both are additive subsystems that must never break a send, a call, a webhook,
  or a fulfilment. Both fail open on a missing migration and both warn exactly
  once per process about it (`lib/audit/log.js` mirrors
  `lib/analytics/events.js`).
- Both use RLS-with-no-policies and the service role as the only application
  path.
- Both signal clients over the existing SSE broadcaster, with **separate** event
  names: `analytics_changed` and `audit_changed`. Sharing one would make a
  cancelled SMS trigger a full revenue-overview refetch on any client sitting on
  the Analytics tab.
- Both are gated by permissions that Support Agent does not hold —
  `analytics.read` and `audit.read` respectively. See `docs/team/RBAC.md` for why
  Analytics is Admin-only.

## Deployment

`scripts/audit-migration.sql` is additive: one table, its indexes, two guard
triggers, the grants and RLS. No existing row, column, policy or grant elsewhere
is modified.

Apply it **once, before** deploying the matching backend code. Getting the order
wrong is safe rather than fatal — `logAudit()` fails open, so an out-of-order
deploy degrades to "no audit rows" and a single warning line, not to a broken
send, call or cancel — but the read API returns 503 until it lands.

That safety now explicitly includes the consent-bearing types: the missing-schema
check runs before the consent throw, so an unapplied migration cannot break the
inbound STOP path. See "The catch-block ordering" above; that ordering is the
reason this paragraph is true, and reversing it makes an out-of-order deploy
fatal to opt-outs.

This is the opposite posture from `scripts/rbac-migration.sql`, which the server
refuses to boot without. Authorisation must not fail open; an audit trail must
not take the product down. Both orderings are still migration-first.

`main` auto-deploys to Railway. Treat a push as a deployment.

## Files

| path | role |
|---|---|
| `scripts/audit-migration.sql` | table, indexes, immutability triggers, grants, RLS |
| `lib/audit/event-types.js` | the event registry: category, entity type, visibility, severity, reserved, consent-bearing |
| `lib/audit/log.js` | the only writer; fail-open, consent exception, SSE emit |
| `lib/audit/redact.js` | metadata allowlist, secret/URL/token/body rules, 8 KB cap, `messageFingerprint()` |
| `routes/audit.js` | five read endpoints; keyset pagination, validated parameters |
| `routes/activity.js` | **not this subsystem** — the scheduled-SMS queue; one `logAudit()` call site |
| `flows/utils.js` | six: opt-out, scheduled, two bulk cancels, recovery cancel, send failure |
| `routes/users.js` | seven: activated, role changed, reactivated, deactivated, password reset, override granted, override revoked |
| `routes/invitations.js` | three: invited, invitation revoked, activated via redemption |
| `routes/contacts.js` | three: `contact.created`, `contact.updated` on a create that hit an existing row, and one ternary site that emits `contact.phone_changed` or `contact.updated` |
| `routes/sync.js` | five: triggered, completed, failed, and two bulk imports (`/import`, `/seed-from-bridge`) |
| `routes/voice.js` | four: credentials issued, recording played, recording started/stopped |
| `routes/catchup.js` | one: `message.catchup.sent` |
| `routes/intelligence.js` | two: `campaign.suggestion.sent`, `campaign.suggestion.dismissed` |
| `lib/private-recordings.js` | one: recording purged by the retention job |
| `routes/webhook.js` | not a call site — wraps `markOptedOut` so an audit failure cannot skip a STOP suppression |
| `test/audit-log.test.js` | write path: one row per cancel, no body, fail-open, reserved/unknown throw, consent, fingerprint, bulk collapse |
| `test/audit-redact.test.js` | allowlist fails closed, secrets by name and by value, signed URLs, token masking, cap |
| `test/audit-api.test.js` | no write methods, `.eq()` filters, keyset correctness under concurrent appends, 503 on missing migration |
| `test/audit-team.test.js` | the nine `team.*` rows: summaries read as sentences, before/after, no hash or token in the serialised row |
| `test/audit-sync-latch.test.js` | a failed audit cannot wedge `syncRunning`; `logAuditSafely` absorbs a programming error but not a consent failure; every sync route responds before it audits |
| `test/no-builder-catch.test.js` | no `.catch()`/`.finally()` on a Supabase query builder, plus a self-check of the detector |

## Related

- `docs/team/RBAC.md` — the actors this table records, and `audit.read`.
- `docs/analytics/ANALYTICS-ARCHITECTURE.md` — the subsystem this one
  deliberately does not share a model with.
