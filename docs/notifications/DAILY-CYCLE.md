# The daily segmentation cycle, and the digest

The clock that makes segmentation automatic, and the one notification it is
allowed to send.

Read `docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md` first. Its DECISIONS
block is the contract this implements; this document records how, and names the
three places the implementation departs from it and why.

---

## The gap this closes

Twelve segments were live and populated with about 1,600 memberships. The
opportunity detector refreshed every six hours. The campaign delivery worker
ticked every two minutes when enabled. **Segment recompute and proposal
generation were on demand only.** New orders arrived and nobody moved between
groups until a person opened the app and pressed a button.

---

## What one cycle does

1. Recompute every non-archived automatic segment from live data.
2. Record which movements are material.
3. Refresh the portfolio opportunity detector.
4. Decide which findings are significant, and draft proposals for them when the
   flag allows.
5. Write the whole pass to `sms_daily_cycle_runs`.

The digest is deliberately not step six. It runs per person, on that person's
own local morning, and reads the ledger row this pass wrote.

---

## Scheduling, and why it is not a daily `setInterval`

Every other background job here is `setInterval(fn, N)` started from
`app.listen`. At five minutes that is fine. At twenty-four hours it is not:
`setInterval(fn, 86_400_000)` fires 24 hours after **boot**, `main` auto-deploys
to Railway, and the fire time would wander around the clock at the pace of the
release cadence.

So the timer decides nothing. A **five-minute tick** asks
`lib/notifications/daily-schedule.js#dueAt()` a question of the wall clock in a
named zone and a persisted claim, and the answer is one of five verdicts:

| verdict | meaning |
|---|---|
| `run` | at or past the target today, and today is unclaimed |
| `waiting` | the target has not arrived yet |
| `done` | today is already claimed |
| `skip` | more than 180 minutes past the target, so the day is recorded as missed rather than fired stale |
| `off_day` | weekdays only, and today is not one |

`minutesLate >= 0` rather than `=== 0` is load-bearing: a tick eaten by a
redeploy, a slow pass or a paused container self-heals on the next tick.
Worst-case lateness is one tick, not one deploy cycle.

`test/daily-schedule.test.js` runs a simulated day of five-minute ticks, then
the same day with the process restarting every twenty minutes, and asserts the
fire minute is identical.

### Idempotency is a database constraint

`sms_daily_cycle_runs_claim` is `UNIQUE (workspace_id, scope, scope_key,
local_day)`. `claim()` INSERTs and reads the answer; a 23505 **is** the verdict
"already done". There is no check-then-act window, which matters because Railway
keeps the old instance alive while the new one boots and both are ticking.

A `running` claim older than the ten-minute lease may be taken over through a
conditional UPDATE matched on status **and** age, which is a compare-and-swap. A
completed run is never retried, however old.

`apns-collapse-id` is `digest-{userId}-{localDate}` as defence in depth: if a
bug ever double-sends, APNs merges rather than stacks.

### SIGTERM

Railway sends it on every deploy. The scheduler stops claiming immediately,
clears its timers, and lets an in-flight pass finish so its ledger row is
closed. A process killed between claim and completion would otherwise block the
day for the full lease.

---

## Time zones

Three zones exist in this system and they must not be crossed.

| zone | decides | source |
|---|---|---|
| `DAILY_CYCLE_TIMEZONE` | when our own recompute runs | env, default `Europe/London` |
| `sms_users.timezone` | when **one person's** digest is delivered | per account |
| `sms_campaign_settings.business_timezone` | when a **customer** may be texted | per business |

The first two are display and delivery-timing concerns. The third is
compliance, is enforced in SQL inside `claim_sms_campaign_batch`, and **nothing
in this feature reads or writes it**. `test/daily-cycle.test.js` asserts that
against the source of all five new modules, and every one of them lives outside
`lib/campaigns/` so the existing guard in `test/user-timezone.test.js` keeps
holding.

**The London-to-New-York gap is not five hours.** The UK and the US change
clocks on different dates, so it is four hours for two to three weeks in March
and about a week around the end of October. Nothing here ever computes an offset
and reuses it: every question is asked of `Intl` at the instant it is asked,
against the stored IANA identifier. `test/daily-schedule.test.js` pins real
instants inside both windows.

---

## What is worth interrupting somebody for

Four gates, all of which must pass. The full argument is in the header of
`lib/notifications/daily-digest.js`.

**ACTIONABLE.** Only segment movement, proposals waiting, and failures reach the
copy. "Segments recomputed" is a log line.

**MATERIAL.** `delta >= 3 AND delta >= 10% of the segment's prior size`,
conjoined. Absolute-only lets three out of five hundred through; relative-only
lets one out of three through. Revenue-critical segments drop to `delta >= 1`.

**NOVEL.** The headline claim is hashed as segment plus direction, never the
count, and suppressed if it matches a recent day. Reversal and crossing a round
threshold re-open it.

**ATTRIBUTABLE.** At most three segments may be named. Past that the digest is
suppressed as `too_diffuse` rather than papered over with "several segments
changed".

Plus two edge cases and a breaker: **cold start** (first run has no prior state,
so every member "joins"), **bulk import** (customer base moved more than 15%),
and the **circuit breaker** (more than half of six or more segments material in
one run).

**Silence is mandatory.** If nothing passes, nothing is sent. Never an "all
quiet" push.

### Measured on live data, 24 August 2026

`node scripts/dry-run-daily-cycle.js` against 10 saved segments and 781 buyers:

```
one_time_buyers                   delta    5 of   51 required  below_threshold
one_time_first_month              delta    4 of   14 required  below_threshold
one_time_multi_product            delta    3 of   33 required  below_threshold
one_time_above_typical_spend      delta    2 of   26 required  net_zero_churn
one_time_slipping                 delta    2 of   13 required  below_threshold
one_time_lapsed                   delta    1 of   25 required  below_threshold
reorder_approaching               delta    0 of    3 required  no_movement
reorder_due                       delta    0 of    1 required  no_movement
reorder_due_high_confidence       delta    0 of    1 required  no_movement
winback_qualified                 delta    0 of    3 required  no_movement

At a flat threshold of 1, 6 of 10 segments would be material, 17 movements,
and a push would fire. At the conjoined gates, 0 do.
```

Six of the twelve segments are tenure cohorts with frozen cuts at 30, 90 and
365 days, so people cross a boundary every single day with no order placed. A
threshold of 1 reports the passage of time, daily, forever.

---

## Flags

| flag | default | what it gates |
|---|---|---|
| `DAILY_DIGEST_NOTIFICATIONS_ENABLED` | off | the digest push only |
| `SEGMENT_CHANGE_NOTIFICATIONS_ENABLED` | off | the per-segment push only |
| `CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED` | off | drafting and saving proposals only |

The scheduler itself has **no flag**. With all three off it recomputes, decides
materiality, runs the detector, composes the digest and records the whole pass
in the ledger. Nothing reaches a phone and nothing reaches a review queue. That
is what makes it verifiable before it is turned on.

---

## Notification preferences

`sms_user_notification_preferences`, one row per account, five boolean
categories, all defaulting to true. An absent row means "no preference
expressed" and resolves to the same defaults, so nobody has to be seeded.

Consulted at **delivery**, in `splitByPreference()` in `lib/apns-notify.js`,
immediately before the device list goes to Apple. Not at the five call sites
that decide to notify: there will be more of them and a future one must not be
able to forget.

A stored `false` is honoured always. An **unreadable** preference is a different
question, and the failure mode splits on whether the alert already existed:

- `new_customer_messages`, `missed_calls`, `campaign_proposals`, `new_releases`
  fail **open**. Deploying the code before the migration must not silently
  switch four working features off, and a customer is waiting at the other end
  of the first one.
- `daily_digest` fails **closed**. It ships with the migration and has never
  sent anything, so there is nothing to regress.

`missed_calls` controls the missed-call half of the app badge, and the label
says exactly that. There is no server-sent missed-call alert to suppress: a call
arrives as a VoIP push and CallKit presents it. A switch that appeared to
silence a ringing phone and did not would be worse than no switch.

---

## Deploy order

1. `scripts/notification-preferences-migration.sql`
2. `scripts/daily-cycle-runs-migration.sql`
3. Deploy the backend.
4. Ship the iOS build.

Both migrations are additive, transaction-wrapped, re-runnable, add no
permission key and cannot cause the startup permission check to crash-loop the
deploy. Running the code first is safe: the scheduler reports `not_ready` and
does nothing, and the settings endpoint reports `available: false` so the screen
shows defaults and says they cannot be saved yet.

---

## Files

| file | what it is |
|---|---|
| `lib/notifications/daily-schedule.js` | pure scheduling arithmetic. No database, no clock of its own |
| `lib/notifications/daily-digest.js` | pure. The four gates and the copy |
| `lib/notifications/preferences.js` | the veto, and what an unreadable answer means |
| `lib/notifications/run-ledger.js` | the only writer of `sms_daily_cycle_runs` |
| `lib/daily-cycle.js` | the orchestration |
| `lib/daily-scheduler.js` | the tick, the re-entrancy guard, SIGTERM |
| `scripts/dry-run-daily-cycle.js` | read-only rehearsal against live data |
| `ios/ViciInbox/Core/NotificationSettingsModels.swift` | Foundation-only, so it can be type-checked |

---

## Departures from the research, and why

**No badge on the digest.** D7 asks for `badge = pending proposals`. iOS gives
the app one badge number and it already means "unread messages plus unseen
missed calls", reconciled on every message push and persisted on the client. A
digest carrying a proposal count would overwrite a live operational count with
an unrelated one. Making the badge mean proposals as well is a decision about
what the badge **is**, and it is bigger than this change.

**No lifetime-value floor on the revenue-critical exception.** D4 pairs
`delta >= 1` with an LTV threshold. A recompute summary carries counts, not
people, and reaching for per-member value would mean a pure module reading
customer records. It is also the wrong place: `opportunity-sizing.js` is the
honesty boundary for any claim about customer value and it refuses several by
construction. The exception is limited to a named list of segments that are
small and high-intent by definition, which is a structural proxy needing no
per-person read.

**Sentence case, not title case.** D7 asks for title case on the title. Every
other push in this application is sentence case. One in a different case reads
as a mistake rather than as a style.

Two further research points are noted rather than implemented:

- **D1 folds the campaign-proposal push into the digest.** The digest does
  report waiting proposals. `sendCampaignReadyNotifications` was left in place
  rather than removed: it is an existing, separately flagged sender with its own
  tests, and deleting it is its own change.
- **D6 asks for croner and an external dead-man's switch.** The tick is a plain
  five-minute `setInterval` with a re-entrancy guard written out, because the
  objection to `setInterval` is about a 24-hour timer's phase and a five-minute
  tick that decides nothing has no phase to get wrong. An in-process watchdog
  cannot detect its own process being dead; an external one was not added
  because that is a new third-party dependency and needs its own approval. The
  "Last digest" line on the Settings screen is the in-band substitute: a date
  that stopped moving, in front of the person who would notice.
