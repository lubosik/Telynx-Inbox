# P2-06 — Safety and Testing Architecture for Bulk Campaigns

**Written:** 12 August 2026
**Scope:** everything that stands between "someone clicks send" and "847 people receive a text", plus everything that protects the five live order flows and the voice path while we build it.
**Status:** design document. No code. Pseudocode only.
**Governing requirement, verbatim from the client:** *"we don't want a campaign going out without testing it. That is definitely not going to happen."*

---

## 0. The one-paragraph version

Every outbound SMS in this repo already funnels through a single function — `telnyx.js:5 sendSMS()` — and there are exactly nine call sites. That is the entire safety story: one choke point, already built, currently doing nothing. The plan is to put a guard in front of it (`lib/outbound-guard.js`), give that guard a database-backed kill switch, and make campaign sending a claim-then-send state machine that cannot start without a fresh, hash-matched test send to two managed devices. Everything else in this document is detail on those four things. Before any of it, three live fail-open bugs must be fixed, because they already let us text people who said STOP.

**The three things that must be fixed this week, before a single line of campaign code:**

1. `flows/utils.js:39-41` — `isOptedOut()` returns `false` on any database error. **The opt-out check fails open.** A Supabase blip means we text people who opted out.
2. `flows/utils.js:62-71` — `alreadySent()` has the same shape. A database error means "not sent yet", so we re-send.
3. `scripts/backfill-missing.js:169`, `scripts/send-processing-sms.js:74`, `scripts/full-sync.js:74` — three ad-hoc scripts call `sendSMS()` directly, bypassing `isOptedOut()` entirely. Any of them, run against production with a wrong date filter, is a bulk send with no guard. These predate the campaign feature and are live today.

---

## 1. What we are defending — the current outbound surface

### 1.1 The single egress point

```
telnyx.js:5   async function sendSMS(to, message, mediaUrls = null)
              → POST https://api.telnyx.com/v2/messages
```

Nine callers, verified by grep:

| Call site | Kind | Opt-out checked? | Rate limited? |
|---|---|---|---|
| `flows/utils.js:96` (`sendAndLog`) | transactional flow | yes — `utils.js:84`, **fails open** | no |
| `routes/send.js:27` | manual inbox reply | yes — `send.js:23`, **fails open** | yes, 20/min (`server.js:68-72`) |
| `routes/react.js:58` | tapback echo | no | yes, 20/min (`server.js:91`) |
| `routes/catchup.js:95` | bulk backfill send | no | no |
| `routes/catchup.js:149` | bulk backfill send | no | no |
| `routes/intelligence.js:41` | AI-suggested send | no | no |
| `routes/webhook-send.js:59` | external trigger | no | no |
| `scripts/backfill-missing.js:169` | ad-hoc CLI | no | no |
| `scripts/send-processing-sms.js:74` | ad-hoc CLI | no | no |
| `scripts/full-sync.js:74` | ad-hoc CLI | no | no |

`routes/catchup.js` already loops over orders and sends in bulk. **We already have an unguarded bulk sender in production.** It is the closest thing to a campaign that exists, and it is the shape of the accident we are trying to prevent.

Voice is a separate egress: `lib/telnyx-api.js:5 telnyxPost()`, used only by `routes/voice.js` and `routes/voice-webhook.js`. It must stay independently controllable — an SMS incident should not take the phone line down.

### 1.2 The background jobs

`server.js:117-157` starts three `setInterval` timers inside the web process:

- `startScheduledQueue()` — `processScheduledQueue()` at boot+15s and every 5 min (`server.js:120-128`)
- `startShipmentPoll()` — every 30 min
- `startDeliveryCheck()` — every 6 hours

None has a reentrancy guard, a cross-instance lock, or a kill check. `processScheduledQueue()` (`flows/utils.js:218-271`) pulls up to 50 due rows and sends them in a bare `for` loop.

### 1.3 What exists for testing today

- `test/` — five files, `node --test test/*.test.js`. All pure unit tests of `lib/` helpers. Nothing covers `routes/send.js`, `flows/utils.js`, or any send path.
- `scripts/test-flows.js` (35 KB) — read-only, never sends, never writes. **But it copies flow logic out of `hold.js` rather than importing it** (see its own comment at line ~68). It tests a fork of the code, so it drifts silently. Useful as a data-shape sanity check; not a regression suite.
- `scripts/test-mms-flows.js` (15 KB) — **this is the asset.** It boots the real Express routes on port 3199 against real Supabase, and mocks the vendor seam by replacing `global.fetch` and intercepting `api.telnyx.com` (lines ~50-62), plus stubbing `ghl.js` and `push-notify.js` via `require.cache`. It uses a reserved fake number `+15005550123` (line 19) and cleans up its rows (lines 292-302).

**Everything in section 7 of this document is built on `test-mms-flows.js`'s harness.** It already proves the pattern works. It needs to become `test/helpers/harness.js` and be imported, not copy-pasted.

### 1.4 Two phone normalisers that disagree

`flows/utils.js:15-22 formatPhone()` and `lib/phone.js:14-28 normalisePhone()` are different functions with different behaviour. `formatPhone("447506440284")` returns `null`; `normalisePhone("447506440284")` returns `+447506440284`. The test-number registry and the campaign roster must use exactly one of these. Recommendation: `lib/phone.js:normalisePhone` (it handles international correctly), with `formatPhone` kept as a deprecated alias so the flows do not change behaviour.

---

## 2. The test-send gate

This is the central requirement. It is a **HARD BLOCK with no override.**

### 2.1 Managed test numbers

New table:

```sql
CREATE TABLE sms_test_numbers (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,      -- E.164, via lib/phone.js normalisePhone
  label         TEXT NOT NULL,             -- 'Dominic iPhone', 'Lubosi UK'
  owner         TEXT NOT NULL,             -- 'dominic' | 'lubosi'
  carrier       TEXT,                      -- 'verizon' | 'att' | 't-mobile' | 'uk-ee'
  country       TEXT NOT NULL DEFAULT 'US',
  platform      TEXT,                      -- 'ios' | 'android'
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,   -- must receive every test
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  added_by      TEXT NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Seed rows:

| phone | label | owner | country | is_primary |
|---|---|---|---|---|
| `+16317426316` | Dominic iPhone | dominic | US | **true** |
| `+447506440284` | Lubosi UK | lubosi | GB | false |

**The UK number cannot satisfy the gate on its own, and this matters.** `+44` traffic does not traverse US A2P 10DLC. It will not surface carrier filtering, will not produce US DLR codes, and will not reveal a T-Mobile block. It validates *rendering* — merge fields, encoding, link display, MMS attachment — and nothing about *deliverability*. Therefore:

> **Gate rule:** at least one **`is_primary = true`, `country = 'US'`** test number must have received and been acknowledged. `+447506440284` is a secondary confirmation, never the sole evidence.

Today that means Dominic's `+16317426316` is a single point of failure. Two additions are cheap and should happen before the first campaign:

- One prepaid US SIM on a carrier other than Dominic's (~$15/month, Mint/US Mobile). Gets us two of the big three.
- One Android device or a cheap Android on the same SIM, so the MMS/RCS rendering path is not iOS-only.

Enforcement: `sms_test_numbers` is the **only** source of recipients for the test-send path. See §9 failure mode F6.

### 2.2 What a test send actually does

The test send must be **the real thing**, not a preview. Same sender number, same messaging profile, same encoding, same rendered body, same links, same media.

```
POST /api/campaigns/:id/test

1. Load campaign. Refuse if status not in ('draft','ready').
2. Compute content_hash (§2.3).
3. Resolve test recipients:
     recipients = sms_test_numbers where active = true
     assert recipients.length >= 1 and <= 5           -- hard cap on this path
     assert recipients.every(isRegisteredTestNumber)  -- throws, never filters
     assert recipients.some(r => r.is_primary && r.country === 'US')
4. Pick a REAL sample contact from the resolved roster (not a fixture):
     sample = roster.orderBy(random).first()
   Render the body with sample's actual merge values.
   Also render a SECOND message using the roster's
   "worst case" contact — the one with the most null merge fields.
5. For each test recipient, for each of the two renders:
     sendSMS(to, renderedBody, media, { kind: 'campaign_test', campaign_id })
6. Insert sms_campaign_tests row (§2.4) with status='sent'.
7. Return the telnyx_message_ids and poll for DLR.
```

Two renders, deliberately: the "typical" recipient and the "worst" recipient. The worst-case render is where `Hi ,` shows up, and rendering only the first row of the roster is how that bug reaches production.

Test sends are marked `is_test = true`, never write `sms_campaign_recipients` rows, never count toward campaign metrics, and never count toward the frequency cap.

### 2.3 The content hash — exact definition

```
content_hash = sha256(canonical_json({
  schema_version:        2,                         // bump invalidates all prior tests
  body_template:         string,                    // EXACT bytes, pre-merge, incl. trailing whitespace
  media_urls:            string[],                  // sorted, final resolved URLs
  link_destinations:     string[],                  // sorted destination URLs, NOT per-recipient tokens
  from_number:           string,                    // E.164
  messaging_profile_id:  string,
  merge_fields_used:     string[],                  // sorted, parsed from the template
  merge_field_fallbacks: { [field]: string },       // sorted keys
  segment_definition:    canonical_json(segment),   // the definition, not the roster
  campaign_kind:         'campaign' | 'flow'
}))
```

`canonical_json` = keys sorted lexicographically, no insignificant whitespace, UTF-8, NFC-normalised. NFC matters: a curly apostrophe can be one codepoint or two, and the two forms must not produce different hashes for what is visibly the same message.

**In the hash (any change invalidates the test):**
- body text — including a single space, a case change, or `'` → `'`
- media URLs, added or removed or reordered (sorted, so reorder alone does not)
- link destinations
- sending number or messaging profile
- which merge fields are used, and their declared fallbacks
- the segment definition
- the schema version

**Deliberately NOT in the hash (change freely without re-testing):**
- campaign name, internal notes, tags
- `scheduled_at`
- tranche sizes and pacing
- holdout percentage
- the *resolved roster* — see below

**Why the roster is excluded, and what replaces it.** The roster legitimately changes between test and send: orders arrive, contacts opt out. Hashing it would force a re-test every few minutes. Instead the definition is hashed, and roster movement is caught by a separate **audience-drift check** at send time:

```
drift = |roster_now| / |roster_at_test| - 1
  |drift| <= 0.10   → PASS
  |drift| <= 0.30   → WARN, shown with the two counts and the delta list
  |drift|  > 0.30   → HARD BLOCK ("the audience changed by 34% since you tested;
                                  re-test to confirm")
```

Plus an absolute rule: any contact in `roster_now` who is opted out, suppressed, or duplicated is removed by pre-flight regardless of drift.

### 2.4 Recording the test

```sql
CREATE TABLE sms_campaign_tests (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       BIGINT NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  content_hash      TEXT NOT NULL,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by           TEXT NOT NULL,                  -- operator id
  recipients        JSONB NOT NULL,                 -- [{phone, label, telnyx_message_id, dlr_status}]
  sample_contact    TEXT,                           -- phone of the roster contact used for render 1
  worst_case_contact TEXT,
  rendered_bodies   JSONB NOT NULL,                 -- the exact two strings sent
  roster_count_at_test INT NOT NULL,
  encoding          TEXT NOT NULL,                  -- 'GSM-7' | 'UCS-2'
  segments          INT NOT NULL,
  delivered_at      TIMESTAMPTZ,                    -- first DLR 'delivered' on a primary US number
  acknowledged_at   TIMESTAMPTZ,                    -- human pressed "I received this and it's correct"
  acknowledged_by   TEXT,
  ack_note          TEXT,
  status            TEXT NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('sent','delivered','acknowledged','failed','expired'))
);
CREATE INDEX idx_sct_campaign_hash ON sms_campaign_tests(campaign_id, content_hash, acknowledged_at DESC);
```

### 2.5 The gate itself

```
function assertTestGate(campaign):
    hash = computeContentHash(campaign)
    test = SELECT * FROM sms_campaign_tests
           WHERE campaign_id = campaign.id
             AND content_hash = hash
             AND acknowledged_at IS NOT NULL
             AND acknowledged_at > NOW() - INTERVAL '24 hours'
           ORDER BY acknowledged_at DESC LIMIT 1

    if test is null:
        BLOCK "No acknowledged test send exists for this exact message.
               Send a test and confirm you received it."

    if not test.recipients.some(r => r.is_primary && r.country == 'US'
                                     && r.dlr_status in ('sent','delivered')):
        BLOCK "The US test number did not accept the message. UK delivery alone
               is not sufficient — it does not exercise A2P 10DLC."

    return test
```

The gate runs at **two** points: `POST /api/campaigns/:id/schedule` and again inside the runner at the moment it transitions `scheduled → sending`. Checking only at schedule time is how a campaign gets edited after approval.

**Why acknowledgement and not just DLR.** Some carriers return no delivery receipt. Gating purely on `delivered` would lock the operator out through no fault of theirs. Gating on a human pressing a button is both stronger (a person actually looked at the message on a real handset — which is the point) and cannot deadlock. The DLR is recorded as corroborating evidence and the primary-US check accepts `sent` as well as `delivered`.

The 24-hour freshness window exists because links rot, media URLs expire, and the store changes. It is short because re-testing costs two messages, about 1.5 cents, and thirty seconds.

### 2.6 Can the gate be overridden?

**No. Not by an operator, not by an admin, not by an env var, not by a feature flag.**

The justification is simple and should be stated in the UI: complying with the gate costs roughly thirty seconds and 1.5 cents. There is no emergency in which that is too expensive. Every override mechanism that has ever existed has eventually been used routinely, and the first time it is used is always at 11pm under pressure — which is exactly when the message has a typo in it.

The mechanisms that make "no override" survivable:
- Acknowledgement, not DLR, is the gating signal (§2.5) — so a dead phone cannot deadlock you.
- The test path is one API call and one button press.
- Any of the registered test numbers can acknowledge, so long as a US primary accepted the send. If Dominic is asleep, Lubosi can acknowledge Dominic's device's copy only if he can see it — otherwise, add a second US primary. That is a hardware problem with a $15/month solution, not a software override.

The only thing anywhere near an override is `schema_version` in the hash. Bumping it invalidates every prior test — it makes the gate *stricter*, never looser. It must never be used to make an old test match a new message.

---

## 3. Progressive rollout

A passing test proves the message renders. It does not prove the audience is right, the links work at scale, or that the copy will not draw twenty opt-outs. Staged sending is the second net.

### 3.1 Tranche plan for 847

| # | Size | Cumulative | Pause after | Purpose |
|---|---:|---:|---:|---|
| 1 | **25** | 25 | **15 min** | Canary. Catches a broken link, a carrier block, an obviously wrong audience. |
| 2 | **75** | 100 | **20 min** | First statistically meaningful delivery rate. |
| 3 | **250** | 350 | **20 min** | First meaningful opt-out and reply signal. |
| 4 | remainder (~497) | 847 | — | Completion. |

Total wall-clock at a 1 msg/sec ceiling: ~14 min of sending plus 55 min of pauses ≈ **70 minutes**. That is the right order of magnitude for a 2-person team — long enough that a human can intervene, short enough that nobody abandons the process.

Tranche membership is assigned by shuffling the roster with the campaign's stored `randomisation_seed` and slicing. It must not be ordered by `created_at`, because the first 25 rows of `sms_contacts` are the oldest, least representative contacts.

The pauses are **automatic and mandatory**. Between tranches the campaign sits in `paused_gate` and only advances when the health check passes. The operator can advance early only if the check has already passed; they cannot advance past a failed check.

### 3.2 Health checks between tranches

Evaluated at the end of each pause, over the cumulative send:

**a. Delivery failure rate**

```sql
select count(*) filter (where send_status in ('failed','rejected')) as hard_fail,
       count(*) filter (where send_status in ('delivered','sent'))  as ok,
       count(*) filter (where send_status = 'pending')              as unresolved
  from sms_campaign_recipients
 where campaign_id = $1 and arm = 'treatment' and dispatched_at is not null;
```

Note: a large `unresolved` count is itself a signal. If >40% of a tranche has no terminal status after the pause, extend the pause once by 15 minutes, then WARN. Silence from a carrier is often filtering.

**b. Opt-out rate** — inbound STOP matches (`routes/webhook.js:73`) from campaign recipients since `sent_at`, over messages delivered.

**c. Inbound reply sentiment** — count of inbound replies from recipients since send, classified. Do **not** put an LLM in the abort path: `OPENROUTER_MODEL` 404s in production today (research doc 00 §8), and a classifier that fails returns `null`, which would fail open. Use a keyword-first classifier with the LLM as a non-blocking enrichment:

```
negative_markers = /\b(stop|unsubscribe|scam|spam|fraud|report(ing)? you|
                       harass|lawyer|attorney|who is this|wrong number|
                       leave me alone|never signed up|didn'?t sign up)\b/i
```

**d. Carrier error codes** — distribution of `failure_code` on failed rows. Any occurrence of a block-class code is treated as categorical, not rate-based.

### 3.3 Auto-abort thresholds

Sized for the tranche, using absolute counts at small n because a rate on 25 messages is meaningless.

| Signal | Tranche 1 (n=25) | Tranche 2 (n=100 cum.) | Tranche 3+ (n≥350 cum.) |
|---|---|---|---|
| Hard delivery failures | **≥3** → abort | >8% → abort; >5% → pause+notify | >6% → abort; >4% → pause+notify |
| Consecutive hard failures | **≥3 in a row** → abort at any point | same | same |
| Opt-outs | **≥1** → pause + notify; ≥2 → abort | ≥3 (3%) → abort; ≥2 → pause | >2.0% → abort; >1.5% → pause |
| Negative replies (keyword) | **≥1** → pause + notify | ≥3 → abort | >1.0% → abort |
| Carrier block code (see below) | **any 1** → abort | any 1 → abort | any 1 → abort |
| Telnyx 4xx on the POST itself | **any 1** → abort | any 1 → abort | any 1 → abort |

**Block-class codes.** Telnyx error `40315` (unhealthy from-address) and `40002` are documented in research doc 03 §6.5 as reputation signals. Treat these as categorical aborts. *(The precise code list must be read out of the Telnyx portal before launch — 03 §6.5 flags this table as needing verification. Until verified, abort on **any** `failure_code` seen ≥2 times in a tranche, which is conservative and correct.)*

Abort semantics: campaign → `aborted` (terminal), all undispatched recipients → `cancelled`, alert fired to both phones, nothing auto-resumes. A human must clone the campaign to try again — there is no "un-abort".

### 3.4 What a tranche pause does not do

It does not recall messages already sent. At 25 recipients the exposure of a bad tranche 1 is 25 people, roughly 3% of the list. That is the whole design goal: make the worst realistic outcome recoverable by two people making twenty-five apology phone calls.

---

## 4. The kill switch

### 4.1 Scopes

| Scope | Stops | Leaves running |
|---|---|---|
| `campaigns` | campaign runner, campaign tranches | flows, manual replies, tapbacks, voice |
| `automated` | campaigns **+** `processScheduledQueue` **+** all five flows **+** `catchup` **+** `intelligence` sends | manual inbox replies, voice |
| `all` | every SMS/MMS including manual replies | voice only |

**`automated` is the default for the big red button.** During an incident you want the machine silent but you still want to be able to text an angry customer back. Voice is never stopped by the SMS kill switch; it has its own toggle.

### 4.2 Mechanism through the stack

**Layer 1 — database flag (authoritative, ~0-10s to take effect).**

```sql
CREATE TABLE outbound_control (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton row
  kill_scope    TEXT NOT NULL DEFAULT 'none'
                  CHECK (kill_scope IN ('none','campaigns','automated','all')),
  engaged_at    TIMESTAMPTZ,
  engaged_by    TEXT,
  reason        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`lib/outbound-guard.js` caches this row in-process with a **10-second TTL**. Every `sendSMS()` call consults the cache. On engage, the API handler also sets the in-process flag immediately for the instance that served the request and broadcasts over SSE (`server.js:16-21`) so a second instance's next tick sees it.

Ten seconds, not zero, because a synchronous Supabase round-trip per message at 1 msg/sec is fine but at burst it is not, and a stale-by-10s cache bounds the damage at ~10 messages. Trading 10 extra messages for not coupling every send to database latency is the right trade at this scale.

**Layer 2 — the campaign runner's own check.** Before *every individual message*, not every tranche. The check is a cached read, so it costs nothing.

**Layer 3 — Railway env var `OUTBOUND_DISABLED=true`.** Requires a redeploy (~60-90s) and survives a database outage. This is the layer that works when Supabase is the thing that is broken.

**Layer 4 — Telnyx portal: disable the messaging profile.** ~30 seconds, kills everything including flows, no code involved. This is the "we have lost control of the application" option and it must be written on the runbook.

### 4.3 What happens to in-flight messages

`telnyx.js:5-27` posts **one message per HTTP call**. There is no bulk endpoint in use and no batch handed to Telnyx. Therefore "already handed to Telnyx" means: the messages currently in an open HTTP request, which at a serialised 1 msg/sec is **at most one**.

> **Hard design rule: never use Telnyx's `send_at` scheduling parameter.** It is tempting for tranche pacing and it would be a catastrophic mistake — a message scheduled inside Telnyx is outside our kill switch. All scheduling stays in `sms_campaign_recipients` with our runner doing the pacing, exactly as `sms_scheduled` already works for the flows (`flows/utils.js:141-178`).

Messages already accepted by Telnyx cannot be recalled. There is no unsend. The kill switch's honest promise is: **no new message is handed to Telnyx more than ~10 seconds after you press it.** At the 1 msg/sec ceiling that is a bounded worst case of about 10 additional recipients.

### 4.4 Where the check lives

Inside `telnyx.js:sendSMS`, before the `fetch` at line 16 — not in the campaign runner, not in the routes. Putting it at the egress means the three ad-hoc scripts in `scripts/` are covered too, which is the point (§1.1).

```
// telnyx.js — pseudocode
async function sendSMS(to, message, mediaUrls = null, opts = {}) {
  await require('./lib/outbound-guard').assertSendAllowed({
    to, kind: opts.kind, campaignId: opts.campaignId ?? null
  });                                  // throws OutboundBlockedError
  ...existing body...
}
```

### 4.5 Re-enabling

Disengaging the kill switch requires typing the reason it was engaged (shown on screen) — a friction device that stops someone clearing it reflexively without reading why it was set. Every engage/disengage is appended to an `outbound_control_log` table with actor and timestamp.

---

## 5. Pre-flight checks

Run in this order. Order is deliberate: free local checks first, database checks next, network calls last, the test gate and human sign-off last of all. Every check returns `PASS` / `WARN` / `BLOCK` / `SIGN-OFF`. A single `BLOCK` prevents scheduling and prevents sending.

Levels follow research doc 03 §8: **HARD BLOCK** has no override, ever. **WARN** requires explicit logged acknowledgement. **SIGN-OFF** requires a second named person.

| # | Check | Level | Query / computation | Failure message |
|---:|---|---|---|---|
| 1 | Campaign integrity | BLOCK | body non-empty; status in (`draft`,`ready`); `from_number` set; not already sent | "Campaign is not in a sendable state." |
| 2 | Kill switch clear | BLOCK | `outbound_control.kill_scope` ∈ (`none`) for campaigns | "Outbound sending is disabled (engaged by X at Y: reason)." |
| 3 | Sender config | BLOCK | `TELNYX_PHONE_NUMBER` and `TELNYX_MESSAGING_PROFILE_ID` present and matching the campaign's `from_number` | "Sending number mismatch — campaign says A, environment says B." |
| 4 | Environment assertion | BLOCK | `OUTBOUND_ENV === 'production'` for a real send | "This is not the production environment. Real sends are blocked." |
| 5 | Segment resolves | BLOCK | segment definition executes; returns ≥1 row; declares ≥1 filter clause | "Segment returned 0 recipients." / "Segment has no filters — it would match everyone." |
| 6 | Blast-radius cap | BLOCK | `roster.length <= MAX_RECIPIENTS_PER_CAMPAIGN` (§6) | "Segment resolved to 1,240 recipients, above the 1,000 cap. This usually means the segment query is wrong." |
| 7 | Recipient-count sanity | WARN / BLOCK | vs. last send of the same segment: >30% delta = WARN, >100% = BLOCK | "This segment matched 412 last time and 903 now (+119%)." |
| 8 | Audience drift vs. test | WARN / BLOCK | §2.3 | "Audience changed 34% since your test. Re-test." |
| 9 | Duplicate recipients | BLOCK | `select phone, count(*) from roster group by phone having count(*)>1` — after `normalisePhone` | "3 contacts normalise to the same number (+1305…1234). Deduplicate before sending." |
| 10 | Opt-out / suppression | BLOCK | every roster phone against `sms_contacts.opted_out = true` **and** the `sms_sent_log` sentinel (`flows/utils.js:29-42`) **and** free-text revocations | "14 recipients have opted out. They have been removed. (Removal is automatic; this blocks only if removal fails.)" |
| 11 | Consent record | SIGN-OFF *(→ BLOCK once the ledger exists)* | recipients with a stored consent timestamp + source | "No consent ledger exists yet. A named person must attest that this audience consented, and that attestation is recorded." |
| 12 | Merge-field coverage | BLOCK | see §5.1 | "`{{first_name}}` is empty for 68 of 847 recipients and no fallback is declared. They would receive `Hi ,`." |
| 13 | Merge-field junk | WARN | see §5.1 | "12 recipients have a `first_name` that looks like junk (`N/A`, `+13055551234`, `test`). Sample shown." |
| 14 | Encoding + segments | WARN / BLOCK | see §5.2 | "UCS-2 forced by ' at position 34. 3 segments instead of 1. Cost $19.06 instead of $6.35." |
| 15 | Link presence & format | BLOCK | no public shortener (03 §8.5 deny-list); no raw-IP URL; no credentialed URL | "bit.ly links are blocked. Use go.vicipeptides.com." |
| 16 | Link reachability | WARN / BLOCK | HEAD+GET, ≤3 hops, final 200, TLS >14d, query params preserved | "Destination returns 404 for a logged-out visitor." |
| 17 | Compliance lint | BLOCK / WARN / SIGN-OFF | 03 §8.5 regexes | per-rule; see 03 §8.2-8.4 |
| 18 | Quiet hours | BLOCK | see §5.3 | "97 recipients would receive this before 09:00 or after 20:00 local. Shift the send window or enable per-recipient deferral." |
| 19 | Frequency cap | BLOCK | see §5.4 | "312 recipients received a campaign message 6 days ago; 41 received one 18 hours ago (cap: 1 per 72h)." |
| 20 | Cost ceiling | BLOCK / SIGN-OFF | exact computation (§5.5) | "Projected cost $27.40 exceeds the $25 per-campaign cap." |
| 21 | Daily volume cap | BLOCK | campaign size + today's sends vs. daily cap (§6) | "This would put today's outbound at 1,340 messages, above the 1,200/day cap." |
| 22 | Deliverability posture | WARN | 30-day delivery rate on the number; opt-out trend; 10DLC campaign status | "Delivery rate has fallen from 97% to 91% over 30 days." |
| 23 | **Test-send gate** | **BLOCK** | §2.5 | "No acknowledged test send exists for this exact message." |
| 24 | Two-person authorisation | SIGN-OFF | see §5.6 | "The person who acknowledged the test cannot also authorise the send (first 5 campaigns)." |

### 5.1 Merge-field coverage — the one that will definitely bite

847 rows with a nullable `first_name` guarantees empties. `sms_contacts` has both `name` and `first_name` (research doc 00 §4), and nothing enforces either.

```sql
-- coverage
select count(*) filter (where first_name is null or btrim(first_name) = '') as missing,
       count(*) as total
  from sms_contacts
 where phone = any($roster);
```

Rule:
- Template uses `{{first_name}}` with **no** declared fallback and `missing > 0` → **HARD BLOCK**.
- Template uses `{{first_name|there}}` → fallback substituted, downgrade to **WARN** showing the count and the rendered fallback line.
- Fallback must be a literal, must not itself contain a merge field, and must be ≤20 chars.

Junk detection is the sibling problem and is worse, because it renders something rather than nothing:

```sql
select phone, first_name from sms_contacts
 where phone = any($roster)
   and (first_name ~ '[0-9@]'                      -- digits or an email
     or lower(btrim(first_name)) in ('null','n/a','na','none','test','customer','guest','-','.')
     or length(btrim(first_name)) > 20
     or first_name = phone
     or first_name ~ '^[A-Z ]{4,}$');              -- SHOUTING
```

`WARN` with a sample of 10 and a one-click "use fallback for these" action. `Hi 3055551234,` is a worse look than `Hi,`.

### 5.2 Encoding and segments — the UCS-2 trap

Per research doc 05 §7.3 and 01 §4:

```
1. Normalise the rendered body to NFC.
2. Classify every character against GSM 03.38 basic.
   Extension-table chars { } [ ] ~ ^ | \ € count as TWO septets.
3. Any character outside GSM-7 → encoding = UCS-2.
4. GSM-7: len ≤ 160 → 1 segment, else ceil(len / 153)
   UCS-2: len ≤  70 → 1 segment, else ceil(len /  67)
5. Compute per recipient — merge fields change the length.
   Report the DISTRIBUTION, not one number.
```

**Compute per recipient, not once on the template.** A template that is 158 GSM-7 characters with `{{first_name}}` is one segment for "Jo" and two for "Christopher". Report:

```
Segment distribution across 847 recipients:
  1 segment  → 780
  2 segments →  67   (longest first_name: "Konstantinos")
  Total billable segments: 914     Cost: $6.86
```

Levels: `WARN` on UCS-2 (with the offending characters and their positions). `WARN` if any recipient exceeds 2 segments. `HARD BLOCK` if any recipient exceeds 4.

The auto-fix (`'`→`'`, `—`→` - `, `…`→`...`, `"`→`"`) must show a character-level diff and require confirmation. It must never run silently. Note it also enforces the house no-em-dash rule.

### 5.3 Quiet hours across timezones

`sms_contacts` has `state`, `city`, `country` but no timezone. Resolution cascade, recording `tz_source` per recipient:

1. `sms_contacts.timezone` (new nullable column) — source `explicit`
2. NANP area code → timezone map, from `phone` — source `area_code`
3. `state` → representative timezone — source `state`
4. `America/New_York` — source `default`

Then, for each recipient, compute local time at their projected tranche time.

**House rule, tighter than the law:** every recipient must land inside **09:00–20:00 local**. Federal TCPA is 08:00–21:00 and FL/OK/OR are stricter (03 §4.4, flagged unresolved). A one-hour buffer on each side absorbs area-code inference error, which is the real risk — an area code is a birth certificate, not an address.

`HARD BLOCK` if any recipient falls outside. Two remedies offered: shift the window, or enable per-recipient deferral (recipients outside the window are queued for the next 09:00 local, which stretches the campaign across a day — acceptable but must be a conscious choice, not a default).

**Practical guidance to put in the UI:** a send window of **12:00–17:00 America/New_York** is 09:00–14:00 Pacific and satisfies every US mainland timezone with no deferral. Recommend it as the default.

Additional `WARN` if >10% of the roster resolves via `tz_source = 'default'` — that means we are guessing about a lot of people.

### 5.4 Frequency caps

Applies to `kind = 'campaign'` only. Transactional flows are exempt — an order confirmation must go out regardless.

| Cap | Value | Level |
|---|---|---|
| Campaign messages per contact per 72h | 1 | BLOCK |
| Campaign messages per contact per rolling 30 days | 4 | BLOCK |
| Campaign messages per contact per rolling 7 days | 2 | WARN |
| Contact has an unanswered inbound message | — | WARN ("41 recipients are waiting on a reply from you") |

```sql
select r.contact_phone, max(c.sent_at) as last_campaign
  from sms_campaign_recipients r
  join sms_campaigns c on c.id = r.campaign_id
 where r.contact_phone = any($roster)
   and r.send_status in ('sent','delivered')
   and c.sent_at > now() - interval '72 hours'
 group by 1;
```

The last row of that table matters more than it looks. Texting a promotional blast to someone whose question you have not answered is the fastest way to earn a spam report.

### 5.5 Cost ceiling

Cost is deterministic. Compute it exactly; no interval.

```
cost = Σ_recipients (segments_for_that_recipient × rate)
rate = $0.0075/segment   (Telnyx, per research doc 04 §2 — verify against the
                          current Telnyx price list before each quarter)
```

Reference points for 847: 1 segment = **$6.35**; 2 segments = **$12.71**; 3 segments (the UCS-2 accident) = **$19.06**.

- `> $10` → **WARN** with the segment distribution
- `> $25` → **HARD BLOCK**
- `> 2×` the median of the last 5 campaigns → **WARN**

$25 is set deliberately just above the worst realistic full-list 3-segment blast. It is a tripwire for "the encoding check was ignored" or "the segment is wrong", not a budget.

### 5.6 Two-person authorisation, without an auth system

Sign-off needs a named person and `routes/auth.js` is a shared password with no user identity. The full auth project (research doc 06) is 6-8 weeks and must not block campaigns.

**Recommended 15-line stopgap:** add an operator selector to the login screen — a dropdown of `['dominic','lubosi']`, no additional password — that sets `req.session.operator`. This is *attribution, not authentication*. It is honest about what it is, it costs almost nothing, and it unblocks: test acknowledgement attribution, send authorisation, the kill-switch log, and the audit trail. It should be replaced by real auth later, and the column it writes (`operator TEXT`) migrates cleanly to a user id.

Rule: for the **first 5 campaigns**, the operator who acknowledged the test and the operator who authorises the send must differ. After 5, same-operator is permitted but both events remain recorded.

---

## 6. Blast-radius limits

Hard caps enforced in code, stored in `outbound_control`, changeable only by a database update — not by the UI, not by an env var. If someone needs to exceed one, that is a deliberate act with a commit attached.

| Cap | Recommended value | Justification |
|---|---:|---|
| **Max recipients per campaign** | **1,000** | The list is 847. 1,000 allows a year of organic growth while making any segment bug that returns "everyone plus the orders table joined wrong" fail loudly. A cap of 900 would trip on legitimate growth within months; 5,000 would not catch anything. |
| **Max campaign messages per day** | **1,200** | Campaign traffic only. Two full-list sends in a day is already more than this list should ever see; the cap makes a duplicate-cron double-send (F2, F3) visible rather than silent. |
| **Max total outbound per day (all kinds)** | **1,500** | Flows currently run around 15/day (1,151 sends in `sms_sent_log` across several months). 1,500 leaves enormous headroom for flows while capping total exposure. |
| **Max spend per campaign** | **$25** | §5.5. Above the worst realistic legitimate send, below anything that constitutes real money. |
| **Max spend per day** | **$40** | Two campaigns' worth. |
| **Rate ceiling** | **1 msg/sec (60/min)** | 847 recipients in ~14 minutes. Well under any 10DLC TPS allocation, so we never discover our throughput limit during a live campaign. It also means the 10-second kill-switch cache costs at most ~10 messages. Configurable up to 3/sec once the number's 10DLC trust score is known; do not raise it before the first three campaigns. |
| **Max test-send recipients** | **5** | §2.1. A structural guard against the test path being handed the real roster. |
| **Max tranche 1 size** | **25** | §3.1. |

Escalation to exceed any of these: a database update to `outbound_control`, made by the person who is not running the campaign, with the reason recorded in `outbound_control_log`. Deliberately clumsy.

---

## 7. Protecting what already works

This is at least as important as the new features. The five flows send real transactional messages to paying customers and they work.

### 7.1 Adding the suppression choke point without breaking the flows

New module `lib/outbound-guard.js`, called from `telnyx.js:sendSMS` before the fetch (§4.4).

```
// lib/outbound-guard.js — pseudocode

const KINDS = ['transactional_flow','manual_reply','tapback',
               'campaign','campaign_test','maintenance_script'];

async function assertSendAllowed({ to, kind, campaignId }) {
  if (!KINDS.includes(kind)) throw new Error(`sendSMS: unknown kind "${kind}"`);

  // 1. Non-production allowlist — §8. Fail closed, throw loudly.
  if (process.env.OUTBOUND_ENV !== 'production' && !isAllowlisted(to))
    throw new OutboundBlockedError('non_production_allowlist', to);

  // 2. Kill switch — cached 10s
  const scope = await killScope();
  if (scope === 'all') throw new OutboundBlockedError('kill_all');
  if (scope === 'automated' && kind !== 'manual_reply')
    throw new OutboundBlockedError('kill_automated');
  if (scope === 'campaigns' && kind.startsWith('campaign'))
    throw new OutboundBlockedError('kill_campaigns');

  // 3. Opt-out — FAIL CLOSED on database error
  if (kind !== 'campaign_test' && await isSuppressed(to))
    throw new OutboundBlockedError('suppressed', to);

  // 4. Campaign-only checks
  if (kind === 'campaign') {
    if (await exceedsFrequencyCap(to)) throw new OutboundBlockedError('frequency_cap');
    if (!withinQuietHours(to))         throw new OutboundBlockedError('quiet_hours');
    if (await exceedsDailyCap())       throw new OutboundBlockedError('daily_cap');
  }
}
```

**How this ships without changing flow behaviour:**

1. `kind` is a **required** parameter. All nine call sites are updated in one commit. A `test/call-sites.test.js` greps the tree and fails if any `sendSMS(` invocation lacks a `kind` — crude, effective, and it stays correct as new call sites appear.
2. For `transactional_flow`, the guard performs exactly the checks `flows/utils.js:84` already performs, plus the kill switch and the allowlist. **In normal operation the behaviour is byte-identical.** No quiet hours, no frequency caps on flows.
3. The one intentional behaviour change: `isSuppressed()` **fails closed**. If Supabase errors, the send is refused and logged. Today `flows/utils.js:39-41` swallows the error and sends. Refusing an order confirmation during a database outage is strictly better than texting someone who said STOP, and the message stays in `sms_scheduled` to retry.
4. `flows/utils.js:84` keeps its own `isOptedOut` call. Redundant with the guard, and that is fine — it produces the friendly `[SMS] SKIP opted out` log line and avoids a wasted round trip. Belt and braces at the one place that matters.
5. Apply `scripts/add-optout-column.sql` (it has been sitting unapplied since 29 May) so `isSuppressed()` can read a real column instead of the `sms_sent_log` sentinel hack at `flows/utils.js:44-53`. Keep reading the sentinel too, as a union, forever — those rows are the existing opt-out record and must not be orphaned.

### 7.2 Regression tests required before touching `routes/send.js` or `flows/utils.js`

Non-negotiable. Written first, passing against the current code, then the refactor. Built on the `scripts/test-mms-flows.js` harness promoted to `test/helpers/harness.js`.

| File | Covers | Why |
|---|---|---|
| `test/flows-utils.test.js` | `formatPhone` table (US 10/11-digit, `+44`, garbage); `isOptedOut` **fails closed** on DB error; `alreadySent` fails closed; `sendAndLog` skips opted-out, skips already-sent, handles the 23505 race at `utils.js:109-112`; `scheduleSMS` dedupes against pending | This file is the heart of the flows. Nothing currently tests it. |
| `test/send-route.test.js` | `POST /api/send`: 400 on missing `to`, 400 on invalid phone, 400 on empty body+media, 400 over 1600 chars, 403 on opted-out, MMS filter (https only, ≤10, `send.js:13-15`), `replyToMessageId` coercion (`send.js:30-32`), DB insert happens **before** GHL (`send.js:34-51` — there is a comment explaining why; a test should defend it), SSE payload shape | This route is being modified; every one of these is a real behaviour someone could break. |
| `test/scheduled-queue.test.js` | `processScheduledQueue` due selection, `checkOrderRecovered` cancellation path (`utils.js:240-250`), status transition to sent/failed, attempts increment, **reentrancy guard**, **kill-switch bail** | The queue is the closest existing thing to a campaign runner. |
| `test/outbound-guard.test.js` | Every kind × every kill scope; allowlist behaviour; fail-closed on DB error | New code, pure, trivially testable. |
| `test/segment-count.test.js` | GSM-7 basic, extension chars (`{}[]~^\|\€` = 2 septets), curly apostrophe → UCS-2, em dash, emoji, 160/153 and 70/67 boundaries exactly | Pure function, high value, catches the cost bug. |
| `test/flow-goldens.test.js` | **Snapshot the exact rendered body of all five flows** against fixed order fixtures | The single highest-value cheap test in this list. Any accidental change to customer-facing copy — including the AI personalisation path in `confirmed.js` — fails the build. |
| `test/call-sites.test.js` | grep assertion that every `sendSMS(` passes `kind` | Stays correct without maintenance. |

Note on `scripts/test-flows.js`: it should be **rewritten to import the flow modules** rather than copying their logic (its own header admits the copy at the `hold.js` section). Until then it is a data-shape check, not a regression test, and it must not be relied on as one.

### 7.3 Verifying voice/CallKit still works after auth changes

`server.js:103` mounts `/webhooks/voice` **outside** `requireAuth`, and `server.js:100` mounts `/api/voice` inside it. An auth change that accidentally moves the boundary silently kills inbound calling — silently, because Telnyx retries and no user sees an error page.

Checklist after any change to `server.js` auth wiring, `routes/auth.js`, or the `cookieSession` config at `server.js:54-61`:

1. `POST /webhooks/voice` returns 200 **unauthenticated**. Automated, in `test/`.
2. `GET /api/voice/credentials` returns 401 without a session, 200 with one. Automated.
3. `node --test test/voice-credentials.test.js` and `test/call-status.test.js` pass.
4. **Manual, on a device that is already logged in** — not a fresh install. Changing the cookie `name`, `secret`, or `sameSite` at `server.js:54-61` invalidates every existing session. A fresh install re-authenticates and hides the bug; an existing install is the actual user experience. Confirm the app does not silently lose its session.
5. Manual: place an inbound call to the Telnyx number → CallKit rings the iPhone → answer → two-way audio.
6. Manual: place an outbound call from the app → connects.
7. Confirm a `call_logs` row appears with `duration_seconds` and a recording URL.

Steps 4-7 take about four minutes and cannot be automated on this Mac (macOS 13 cannot build the iOS app — see the project memory). They must be on the deploy checklist as manual items.

### 7.4 Pre-deploy checklist

```
[ ] npm test                      passes
[ ] npm run build                 passes (babel; a JSX syntax error breaks the Railway build)
[ ] node scripts/preflight-deploy.js
      - all required env vars present
      - OUTBOUND_ENV asserted
      - every sendSMS() call site passes `kind`
      - no pending .sql in scripts/ unapplied (checked against a migrations table)
[ ] git diff --stat reviewed; no .env committed
[ ] If routes/send.js, flows/*, telnyx.js, or lib/outbound-guard.js changed:
      - flow golden snapshots reviewed, not just accepted
[ ] If server.js auth wiring or cookieSession changed:
      - voice checklist §7.3 steps 4-7, manually
[ ] Kill switch reachable: GET /api/outbound-control returns current scope
[ ] After deploy: GET /health returns 200
[ ] After deploy: send one manual inbox message to a test number, confirm delivery
[ ] After deploy: confirm [QUEUE] Startup run logged exactly once
```

### 7.5 Minimum CI genuinely worth adding

There is no CI today and two `.github/workflows/` files, both for iOS builds. Be realistic about what a 2-person team will maintain.

**Add exactly one workflow.** ~20 lines, on push to `main` and on PRs:

```yaml
- node 20
- npm ci
- npm test            # node --test test/*.test.js
- npm run build       # babel — catches a JSX syntax error before Railway does
- node scripts/preflight-deploy.js --check-only
```

That is it. It catches the two failure modes that actually occur here: a broken unit test and a build-breaking syntax error in the 3,269-line `public/app.jsx`. Railway already runs the build (`railway.json` buildCommand), so today you learn about a JSX error *after* pushing; this moves it to before.

**Do not add:** coverage gates (they become a number people game), Playwright e2e in CI (`scripts/test-ui-visual.js` exists and is fine to run by hand), a staging deploy pipeline, Dependabot (noise at this dependency count), or a linter with an existing-code exemption list. Each of those costs more in maintenance friction than it returns at two people.

One further piece of automation that *is* worth it: a **migrations table**. Two migrations have already been forgotten (`ios_push_devices`, `add-optout-column`). A `schema_migrations(filename, applied_at)` table plus a startup check that logs a loud warning for any `scripts/*.sql` not recorded costs about thirty lines and permanently ends that class of bug.

---

## 8. Environment separation

### 8.1 How dangerous is the current setup

One Supabase project, one Telnyx number, development against production. For an inbox app this was tolerable. For bulk sending it is not, and the risk is asymmetric:

| Accident | Recoverable? |
|---|---|
| Dev script deletes rows from `sms_contacts` | Yes — Supabase PITR / backup |
| Dev run corrupts campaign state | Yes — it is our own data |
| Untested migration breaks production reads | Yes — roll back the SQL |
| **Dev code sends an SMS to a real customer** | **No. There is no unsend.** |
| **Dev code sends 847 SMS to real customers** | **No, and it is also a TCPA event, a carrier reputation event, and possibly the end of the client relationship.** |

Everything database-shaped is recoverable. The only irreversible outcome is a message leaving the building. That asymmetry decides the recommendation.

The current code makes the bad outcome easy: `routes/catchup.js` loops and sends; `scripts/full-sync.js:74` sends; the campaign runner we are about to write will be the most send-happy code in the repo. Running any of them locally with production credentials — which is how development happens today — reaches real phones.

### 8.2 The options

| Option | Cost | Blocks the irreversible thing? | Objection |
|---|---|---|---|
| Staging Supabase project | $0 (free tier allows 2) | **No** — dev still holds prod Telnyx credentials | Also needs data seeding and doubles migration work |
| Second Telnyx number for dev | ~$1/mo **+ a separate 10DLC registration** (fees, weeks of vetting) | Partly — still real messages to whoever `to` says | 10DLC registration is the real cost, and it is not small |
| Global dry-run env flag | ~free | **No** — fails open. Forget to set it and you send. Also never exercises the real send path, so the dry run drifts from reality | Fail-open is disqualifying |
| **Hard allowlist in non-production** | ~20 lines | **Yes, completely** | Does not protect the production database |

### 8.3 Recommendation

> **Implement a hard, fail-closed allowlist inside `telnyx.js:sendSMS` (via `lib/outbound-guard.js`), gated on a positive-assertion environment variable.** Do this first, before any campaign code.

```
// lib/outbound-guard.js
const ALLOWLIST = new Set([
  '+16317426316',   // Dominic
  '+447506440284',  // Lubosi
  '+15005550123'    // the reserved test number already used by scripts/test-mms-flows.js:19
]);

function isAllowlisted(to) { return ALLOWLIST.has(normalisePhone(to)); }

// In assertSendAllowed:
if (process.env.OUTBOUND_ENV !== 'production' && !isAllowlisted(to))
  throw new OutboundBlockedError('non_production_allowlist', to);
```

Four properties that make this the right pick:

1. **It gates the only irreversible failure.** Nothing else on the list does.
2. **`OUTBOUND_ENV` is a positive assertion, not `NODE_ENV`.** It must equal the literal string `production`. Unset, misspelled, or empty all mean "not production" and all block. This is the opposite of the dry-run flag's failure mode: forgetting to set it makes you safe, not sorry.
3. **It throws rather than silently no-oping.** A blocked send is a visible error in the test output. A silent no-op teaches you that sending works when it does not.
4. **Zero infrastructure.** No second credential set, no data seeding, no schema drift between environments, nothing to keep in sync — which matters enormously for a team that has already forgotten two migrations.

The allowlist is a constant in source, not an env var, so changing it is a commit and a code review rather than a dashboard click.

**Fast-follows, in order:**
- A **staging Supabase project** (free, second project on the same account) once campaign tables exist and the runner starts mutating state. It closes the database half of the problem. Defer until then because today's dev work is mostly reads.
- A **second Telnyx number** only when a second 10DLC campaign is registered anyway — the number is $1 but the registration is the cost, and the allowlist already covers the risk.

**Explicitly rejected:** the global dry-run env flag. It fails open, and it means the real send path is never exercised until it is exercised on 847 people.

---

## 9. Accidental-send failure modes

Each with the specific guard. These are the ways a campaign goes out when nobody pressed send.

**F1 — Process restart re-queues and re-sends.**
`server.js:120-123` already runs `processScheduledQueue()` 15 seconds after every boot, and `railway.json` restarts on failure up to 3 times. A campaign runner built on the same pattern would resume and re-send on every crash.
*Guard:* **claim-then-send.** Write `dispatched_at` to the recipient row *before* the Telnyx call, never after. On boot, any campaign with `status = 'sending'` and a heartbeat older than 120 seconds is set to `interrupted` — **never auto-resumed**. Resuming requires a human clicking resume, which re-runs the test gate and pre-flight. A recipient row with `dispatched_at` set and no terminal status is reconciled against Telnyx (list messages to that number in the window), never blindly retried.

**F2 — Duplicate cron tick / overlapping run.**
`setInterval` at 5 minutes (`server.js:125-128`). If a run takes longer than 5 minutes, the next one starts on top of it. `processScheduledQueue` has no reentrancy guard today.
*Guard:* module-level `let running = false` with `try/finally`. Three lines. **Add this to `flows/utils.js:218` now, independently of campaigns** — it is a live latent bug. Plus a Postgres advisory lock for the cross-process case.

**F3 — Two Railway instances.**
Replica count raised, or the overlap window during a rolling deploy where old and new both serve.
*Guard:* a `singleton_lease(job_name, instance_id, heartbeat_at)` row. On boot, a background job takes the lease only if no live lease exists (heartbeat within 60s); the loser logs and does not start its timers. Belt and braces: `pg_try_advisory_lock(hashtext('campaign_runner'))` held for the campaign's duration via an RPC. Also: set Railway replicas explicitly to 1 and assert it at boot.

**F4 — Retry loop after a Telnyx timeout.**
`telnyx.js:16` uses bare `fetch` with **no timeout and no idempotency key**. If Telnyx accepts the message and the response is lost, we see a failure. A naive retry duplicates.
*Guard:* (a) `AbortSignal.timeout(15000)` on the fetch; (b) **never auto-retry a messaging POST that timed out or returned 5xx** — mark the recipient `unknown` and enqueue a reconciliation that queries Telnyx for messages to that number in the last 5 minutes; (c) claim-then-send means the row is already claimed, so the retry path is reconciliation-only by construction; (d) a per-recipient unique constraint on `(campaign_id, contact_phone)` so a duplicate insert cannot manufacture a second send.

**F5 — Mis-scoped segment query returns everyone.**
The classic: a PostgREST `.eq('status', undefined)` that silently returns all rows, or a JS `.filter()` whose predicate always returns true.
*Guard:* five layers, because this one is the most likely.
(a) A segment definition with zero filter clauses is rejected at save time.
(b) Every segment declares `expected_max`; the resolver blocks if `actual > expected_max`.
(c) The 1,000-recipient blast cap (§6).
(d) Recipient-count sanity vs. the last send of the same segment: >30% WARN, >100% BLOCK (pre-flight #7).
(e) Audience-drift vs. the tested roster: >30% BLOCK (§2.3).
Additionally, the resolver must build queries so that an `undefined` parameter throws rather than being dropped — validate the segment definition against a schema before executing it.

**F6 — A test send hits the real audience.**
The scariest and the most plausible: `sendTest(campaign)` gets handed `campaign.roster` instead of the test list, by a one-line refactor.
*Guard:* structural, not procedural. The test path has **no parameter that accepts a recipient list.** It calls `getTestRecipients()`, which reads only `sms_test_numbers`. Before dispatch it asserts:

```
assert(recipients.length <= 5,                        'test path recipient cap')
assert(recipients.every(r => testNumberSet.has(r)),   'test path allowlist')  // throws, never filters
```

`.every(...)` that **throws** rather than a `.filter(...)` that silently drops — a filter would quietly send to the two test numbers and hide the bug until someone changed the filter. Plus `test/` coverage asserting the test path refuses a roster it was handed.

**F7 — A cancelled campaign resumes after redeploy.**
*Guard:* `cancelled`, `aborted`, and `sent` are **terminal**. A Postgres trigger rejects any transition out of them. The runner's resume query selects only `status = 'sending'`, and boot never auto-resumes anyway (F1).

**F8 — A scheduled campaign fires twice because two ticks both see it as due.**
*Guard:* the fundamental idempotency primitive — conditional claim:

```sql
update sms_campaigns
   set status = 'sending', claimed_by = $instance, claimed_at = now()
 where id = $1 and status = 'scheduled' and scheduled_at <= now();
-- proceed if and only if rowcount = 1
```

The same pattern at the recipient level: `update ... set dispatched_at = now() where id = $1 and dispatched_at is null` — proceed only on rowcount 1.

**F9 — The message is edited while the campaign is sending.**
*Guard:* the campaign row is immutable once `status` leaves `draft` (trigger-enforced on `body_template`, `media_urls`, `from_number`, `segment_definition`). Each recipient's rendered body is snapshotted at claim time, so even an impossible edit cannot change what tranche 3 receives.

**F10 — Webhook replay re-triggers a flow.**
*Guard:* already handled and should be preserved — `alreadySent()` at `flows/utils.js:62-71` plus the unique index whose 23505 violation is caught at `utils.js:107-113`. The unique index is the real guard; the pre-check is an optimisation. **Fix the fail-open** (§0) so a DB error does not defeat it.

**F11 — An ad-hoc script in `scripts/` sends in bulk.**
`scripts/full-sync.js:74`, `scripts/backfill-missing.js:169`, `scripts/send-processing-sms.js:74` call `sendSMS()` with no opt-out check and no rate limit. Live today.
*Guard:* the guard lives in `telnyx.js:sendSMS`, so they inherit it automatically once §7.1 ships. Additionally they must pass `kind: 'maintenance_script'`, which the guard treats as `campaign`-strict (suppression + daily cap + kill switch). Each should also require an explicit `--i-understand-this-sends-real-sms` flag and print the recipient count with a 10-second countdown before starting.

**F12 — Supabase outage defeats the opt-out check.**
`flows/utils.js:39-41` catches and returns `false`.
*Guard:* fail closed. Throw, refuse the send, leave the row in `sms_scheduled` to retry. Covered by `test/flows-utils.test.js`.

**F13 — A campaign is scheduled for a time that has already passed.**
Setting `scheduled_at` to 09:00 when it is 14:00 makes it immediately due, and it goes out with no pause.
*Guard:* reject `scheduled_at` in the past at save time; require it to be at least 5 minutes ahead; the runner refuses to claim a campaign whose `scheduled_at` is more than 2 hours stale (it fires an alert instead — that means the runner was down).

---

## 10. Observability

### 10.1 What must be logged

Keep the existing prefix convention (`[SMS]`, `[SCHEDULE]`, `[QUEUE]`) and add `[CAMPAIGN]`. Railway log search is the only log tool here, so prefixes and consistent field order matter more than structure.

Per campaign message:
```
[CAMPAIGN] SENT | c=42 t=2 r=317 phone=...6316 seg=1 enc=GSM-7 tid=abc123 ms=180
[CAMPAIGN] BLOCKED | c=42 r=318 reason=frequency_cap phone=...4412
[CAMPAIGN] FAILED | c=42 r=319 code=40315 phone=...8890
```

Per campaign lifecycle: created, tested, test acknowledged, scheduled, claimed (with instance id), tranche start/end, gate pass/fail with the numbers, paused, resumed, aborted, completed — each with actor and timestamp, written to a `sms_campaign_events` append-only table, not just stdout. Railway logs are ephemeral; the audit trail must be in Postgres.

Always logged, never to stdout in full: phone numbers appear as last-4 only (the existing code already does this — `flows/utils.js:85`, `129`). Message bodies go to the database, never to the log.

Per guard rejection: every `OutboundBlockedError` is logged and counted, including in production. A rejection is information, not noise.

### 10.2 Real-time view during a send

Reuse SSE (`server.js:15-22`) — it already reaches both the web app and iOS. New event type `campaign_progress`, emitted every 5 seconds while sending:

```json
{ "type":"campaign_progress", "campaign_id":42, "tranche":2,
  "dispatched":100, "total":847, "delivered":91, "failed":2, "pending":7,
  "opt_outs":1, "replies":3, "spend_cents":75, "eta_seconds":740,
  "state":"sending" }
```

The campaign screen shows: a progress bar with tranche boundaries marked, the four health metrics with their abort thresholds drawn as lines, a live feed of failures and opt-outs, and a persistent **STOP** button. The stop button must be present on the screen at all times during a send, not behind a menu.

SSE is in-process and drops on redeploy (research doc 00 §2). That is acceptable for a progress view — but the runner must never depend on SSE for anything. All state is in Postgres; SSE is a view.

### 10.3 Alert conditions that should page a human

Use the push infrastructure that already exists — `push-notify.js` (VAPID) and `lib/apns-notify.js` (APNs). Both already deliver to Dominic's and Lubosi's phones. No new vendor, no PagerDuty.

**Page immediately (push to both phones):**
1. A campaign auto-aborted — with the reason and the counts.
2. Kill switch engaged — who, what scope, why.
3. Cumulative opt-out rate in an active campaign crosses 1.5%.
4. Three consecutive hard delivery failures in an active campaign.
5. Any block-class carrier code (§3.3).
6. A Telnyx 4xx/5xx on the messaging POST itself (as distinct from a per-recipient failure) — this means our credentials, profile, or number are wrong.
7. Campaign runner heartbeat missing for >120 seconds while `status = 'sending'`.
8. An outbound send attempted to a **non-allowlisted number in non-production** — this means someone came within one env var of a real accident, and it should wake somebody up.
9. Two consecutive `processScheduledQueue` exceptions — the flows are down.

**Daily digest (not a page):**
10. Daily outbound count above 80% of the cap.
11. Any `sms_campaign_tests` row older than 24h with `acknowledged_at IS NULL` — a test was sent and nobody looked at it.
12. Rolling 7-day delivery rate down more than 5 points.
13. Unapplied `scripts/*.sql` migrations.

Alert fatigue is the real risk at two people. Nine paging conditions is already near the limit; resist adding a tenth without removing one.

---

## 11. Phased safety plan

### Phase 0 — before writing any campaign code

Fix what is already broken. None of this depends on the campaign feature and all of it makes the existing system safer today.

- [ ] `isOptedOut()` fails **closed** (`flows/utils.js:29-42`)
- [ ] `alreadySent()` fails **closed** (`flows/utils.js:62-71`)
- [ ] Apply `scripts/add-optout-column.sql`; add a `schema_migrations` table and a boot-time warning for unapplied SQL
- [ ] `lib/outbound-guard.js` + `kind` parameter threaded through all nine `sendSMS()` call sites
- [ ] Non-production allowlist, fail-closed, on `OUTBOUND_ENV` (§8.3)
- [ ] `outbound_control` table + kill switch at the `sendSMS` egress + a reachable UI button
- [ ] Reentrancy guard on `processScheduledQueue` (`flows/utils.js:218`)
- [ ] `singleton_lease` so background jobs run on one instance only
- [ ] Regression suite §7.2, including the five flow golden snapshots, passing against current behaviour
- [ ] The single CI workflow (§7.5)
- [ ] Guard the three `scripts/` senders behind an explicit confirmation flag
- [ ] Operator selector at login (§5.6) so events have an actor

**Gate to Phase 1:** the golden snapshots pass, the kill switch has been engaged and disengaged on production once as a drill, and a non-production send to a non-allowlisted number has been demonstrated to throw.

### Phase 1 — before the FIRST real campaign

Every item is mandatory. This is the strict list.

- [ ] `sms_test_numbers` seeded, including **a second US primary** on a different carrier from Dominic's
- [ ] Test-send path with the structural recipient guard (§2.2, F6)
- [ ] Content hash exactly as specified in §2.3
- [ ] `sms_campaign_tests` + acknowledgement UI
- [ ] **The gate** enforced at both schedule time and send time (§2.5), with no override anywhere in the code
- [ ] Campaign state machine: conditional claim (F8), claim-then-send (F1/F4), terminal statuses (F7), immutability after draft (F9)
- [ ] Pre-flight checks 1-24 (§5) — every one; checks 11 and 16 may run at their reduced level (SIGN-OFF / WARN) but must be present and must produce their output
- [ ] Dry run (§12) producing the full artifact
- [ ] Tranche runner with the 25/75/250/rest plan and automatic gates (§3)
- [ ] Auto-abort thresholds wired to real signals (§3.3)
- [ ] Blast-radius caps enforced in code (§6)
- [ ] Quiet-hours resolution with `tz_source` recorded; house window 12:00-17:00 ET
- [ ] Frequency caps (§5.4)
- [ ] Encoding/segment calculator, per-recipient, in the pre-flight
- [ ] `sms_campaign_events` audit trail
- [ ] The nine paging alerts (§10.3)
- [ ] SSE `campaign_progress` and the always-visible STOP button
- [ ] Two-person authorisation for the first five campaigns (§5.6)
- [ ] A written runbook, one page, covering: how to stop a campaign, the four kill-switch layers in order, who to call, and what to say to a customer who received something wrong
- [ ] **A full rehearsal**: a real campaign to a roster consisting only of the test numbers, run through the entire pipeline including tranches, with a deliberate mid-flight kill-switch press. Verify from the Telnyx logs that no message was dispatched more than ~10 seconds after the press.

### Phase 2 — after three successful campaigns

- Per-recipient quiet-hours deferral (rather than blocking the campaign)
- Link reachability checks upgraded from WARN to BLOCK
- Cost-ceiling auto-comparison against campaign history
- Free-text opt-out detection per research doc 03 §8.5 Tier 2 (the FCC-required layer Telnyx does not implement)
- Consent ledger, upgrading pre-flight #11 from SIGN-OFF to BLOCK
- Holdout assignment and the measurability pre-flight (research doc 05 §7.8)
- Click attribution
- Staging Supabase project

### Phase 3 — later

- Real multi-user auth (research doc 06), replacing the operator selector
- Activity Center
- Second Telnyx number and a second 10DLC registration
- Cross-client pooling

---

## 12. Dry run

### 12.1 Preview vs. dry run

| | **Preview** | **Dry run** |
|---|---|---|
| Scope | one message, one contact | the entire resolved audience |
| Speed | instant, on every keystroke | seconds; explicitly triggered |
| Resolves the segment | no | yes, fully |
| Runs pre-flight | no | yes, all 24 checks |
| Computes cost | rough, from the template | exact, per recipient |
| Writes | nothing | one `sms_campaign_dry_runs` artifact row |
| Sends | nothing | nothing |
| Answers | "what does this look like?" | "what will actually happen?" |

### 12.2 The critical property

The dry run must execute **the same code path as the real send**, with a recording transport substituted at the vendor seam:

```
runCampaign(campaign, { transport })

transport.send(to, body, media) →
   production:  telnyx.js sendSMS(...)
   dry run:     record({ to, body, media, segments, encoding, cost }); return fakeId
```

This is exactly the trick `scripts/test-mms-flows.js` already uses at lines ~50-62, promoted from a test hack to a first-class parameter. If the dry run had its own renderer, the dry run would be testing the dry run. Every render, every merge, every suppression decision, every tranche assignment must be produced by the real runner.

The transport is injected by the caller and defaults to the real one, so no code path can accidentally get a dry-run transport in production or vice versa. The dry-run transport additionally asserts it is never constructed when `campaign.status === 'sending'`.

### 12.3 Output

```
DRY RUN — "August Restock"  ·  content_hash 7f3a91c4  ·  2026-08-12 14:03

AUDIENCE
  Segment matched                     892
    − opted out                       -14
    − no valid phone                   -3
    − duplicate after normalisation    -2
    − frequency cap (72h)              -8
    − quiet hours (would defer)         0
  = Eligible                          865
    → treatment                       865   (holdout 0%)

  Drift vs. tested roster: 861 → 865  (+0.5%)   PASS
  Overlap with last campaign (6 days ago): 812 of 865 (94%)   ⚠ fatigue

RENDERING
  Merge fields: {{first_name}}
    resolved                          797
    empty → fallback "there"           56   ⚠
    junk (digits / N/A / SHOUTING)     12   ⚠  [view]

  Encoding: GSM-7 for all 865          PASS
  Segments: 1 → 802 recipients
            2 →  63 recipients  (longest render 171 chars, "Konstantinos")
  Total billable segments: 928

  Sample renders:
    typical  → "Hi Sarah, your BPC-157 is back in stock: go.vicipeptides.com/r/xxxx"
    worst    → "Hi there, your BPC-157 is back in stock: go.vicipeptides.com/r/xxxx"
    longest  → "Hi Konstantinos, ..."  (171 chars, 2 segments)

TIMING
  Window: 12:00–17:00 America/New_York
  Timezone sources: explicit 0 · area_code 781 · state 71 · default 13  ⚠ 1.5% guessed
  Earliest local delivery 09:04 (PT) · latest 17:12 (ET)     PASS

COST
  928 segments × $0.0075                          = $6.96
  Cap $25.00                                        PASS

PLAN
  T1  25 → pause 15m   T2  75 → pause 20m
  T3 250 → pause 20m   T4 515
  Rate 1/sec · sending ~14m · total ~70m · completes ~15:13 ET

PRE-FLIGHT           20 PASS · 4 WARN · 0 BLOCK
  ⚠ #7  audience 94% overlap with the 6-Aug send
  ⚠ #13 12 junk first_names
  ⚠ #18 1.5% of timezones inferred from the store default
  ⚠ #22 delivery rate 96.1%, down 1.2pts over 30 days

GATE                 ✗ BLOCKED — no acknowledged test for hash 7f3a91c4

NOTHING WAS SENT. NOTHING WAS WRITTEN except this dry-run record.
```

The artifact row stores the full per-recipient table so two dry runs can be diffed. "What changed since yesterday's dry run" is the question an operator actually asks, and answering it is nearly free once the artifact exists.

---

## 13. Open items this document depends on

1. **The Telnyx block-class error code list** — research doc 03 §6.5 flags its table as needing verification. Until read from the portal, §3.3 uses the conservative fallback (any code seen twice in a tranche aborts).
2. **Telnyx's written position on Vici's traffic** — research doc 03 §2.5 and the INDEX call this blocking. A safety architecture cannot make prohibited traffic permitted. Everything here is conditional on the account being allowed to send.
3. **Quiet-hour boundaries** — 03 §4.4 is explicitly unresolved. The 09:00-20:00 house rule is a self-imposed buffer, not a legal determination.
4. **The SHAFT-C contradiction** between docs 03 and 04 — must be resolved before the compliance linter (pre-flight #17) is written, not after.
5. **`OPENROUTER_MODEL` 404s in production** — this is why no LLM sits in the abort path (§3.2c). Fix it before relying on AI classification anywhere in the send path.
6. **Second US test number** — a hardware purchase, ~$15/month, blocking Phase 1.
