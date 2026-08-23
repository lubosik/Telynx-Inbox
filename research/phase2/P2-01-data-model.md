# P2-01 — Data Model for Campaigns, Segments, Consent, Attribution and Identity

**Written:** 12 August 2026
**Repo:** `~/telynx-inbox` (Vici). Node 20, CommonJS, Express 5, Supabase Postgres via `@supabase/supabase-js` service key. No ORM, no migration tool.
**Status:** Design only. No code was written. No migration files were created. Every SQL block here is a design artefact.
**Scope:** the complete data model for automated campaigns, dynamic segments, a campaign builder, message variants, test sends, click and conversion attribution, consent and opt-out, multi-user identity, and activity/audit.

---

## 0. Executive summary

**17 new tables, 7 migration files, 4 ALTERed existing tables.** Nothing is dropped. Nothing existing is rewritten.

Five decisions carry the design:

1. **Segments overlap freely.** The hypothesis in the brief is **validated**. Exclusivity is refuted on the data: 166 of 477 buyers are repeat buyers and would legitimately sit in two or three segments at once. Conflicts resolve at *send* time via campaign priority plus a per-contact frequency cap.
2. **No materialised segment-membership table.** At 847 contacts, membership is computed on read from a derived facts table (`sms_contact_metrics`, 847 rows) and the rule tree is evaluated **in Node, not in SQL**. Zero injection surface, instant preview, ~50 lines of evaluator. The only membership that is ever materialised is the frozen per-campaign roster, because that is an audit record.
3. **Consent is a three-table ledger and it is authoritative on every send** — including the existing `flows/`. `scripts/add-optout-column.sql` is **superseded, not applied**: a boolean on `sms_contacts` would be a second source of truth for the one fact that carries $500–$1,500 statutory damages per message.
4. **Attribution ships Grade B (phone identity) first, Grade A second.** Grade A requires a WooCommerce-side snippet we do not control. Grade B needs zero store changes and works today. Doc 05's `sms_sessions`, `sms_campaign_costs` and `sms_experiment_snapshots` are rejected as premature.
5. **No `organisations` table.** This is a single-tenant deployment. Adding `org_id` later is one ALTER and a one-value backfill at these row counts. Adding it now is plumbing in every query for a decision (fork vs. shared core vs. multi-tenant) that Phase 2 has not made.

The single highest-risk change in the whole plan is rewriting `flows/utils.js:isOptedOut()`. It sits on the live send path for five order-triggered flows serving a real store. §10 ranks it first.

---

## 1. Ground truth — verified against the live database, 11–12 Aug 2026

Everything below was read out of the live Supabase instance via the service key, not recalled from a document.

| Fact | Value | Why it matters here |
|---|---|---|
| `sms_contacts` | 847 rows | The addressable universe. Small enough that in-memory rule evaluation is correct. |
| Contacts with an email | 827 / 847 | Email-identity matching (attribution Grade B) has near-full coverage. |
| Contacts failing `^\+[1-9][0-9]{7,14}$` | **0** | A CHECK constraint on E.164 can be added without cleaning data first. |
| `sms_orders` | 1,497 rows, `id` is **uuid**, `woo_order_id` is **integer**, 0 nulls, 0 duplicates | Doc 05's DDL assumed `woo_order_id` was the referencable key. The real PK is a uuid. Reconciled in §7. |
| Valid orders (`processing/completed/shipped/delivered`) | **738** | The real denominator for RFM, not 1,497. Cancelled=194, failed=66 are a third of the table. |
| Distinct buyers with ≥1 valid order | **477** | So 370 of 847 contacts have never successfully bought. |
| Repeat buyers ≥2 / ≥3 / ≥5 valid orders | **166 / 62 / 8** | This is the segment-overlap argument, quantified. Also: an 11-way RFM split produces buckets of 8. |
| AOV mean / median / cv | **$186.66 / $157.99 / 0.63** | Doc 05 assumed cv=0.6 and flagged it `[UNVERIFIED]`. **It is now verified at 0.63.** Its power maths stands. |
| Order history span | 2026-01-18 → 2026-07-15 | ~6 months, not the 15 assumed in doc 06 §6.7. Inter-order intervals are computable but thin. |
| Orders / messages whose `contact_phone` is missing from `sms_contacts` | **0 / 0** | A foreign key on `contact_phone → sms_contacts(phone)` will not fail on existing data. |
| `sms_sent_log` rows with `flow_type='opted-out'` | **0** | The existing opt-out mechanism (§2) has **never fired**. The consent migration has no legacy rows to carry across. |
| `sms_contacts.opted_out` | **does not exist** | Confirmed. `scripts/add-optout-column.sql` was never applied. |
| `ios_push_devices` | **does not exist** | Confirmed. `routes/mobile-push.js` falls back to `push_subscriptions`. |
| Outbound messages in the last 30 days | **1** | The programme is effectively dormant right now. Migrations can run against a quiet system. |

### 1.1 One correction to the brief

The brief states: *"there is no opt-out column and no consent record anywhere."* The first half is true. The second half is nearly true but there **is** an opt-out mechanism, and it must be reconciled rather than ignored:

`flows/utils.js:29-53` stores opt-outs as **sentinel rows in `sms_sent_log`** — `order_id = 'OPTOUT_<digits>'`, `flow_type = 'opted-out'`. `isOptedOut()` reads it; `markOptedOut()` writes it; `routes/webhook.js:73` calls `markOptedOut()` on a STOP match; `routes/send.js:22` and `flows/utils.js:84` both gate on it.

So there **is** a functioning suppression path. It is:
- **Undiscoverable** — an opt-out is stored in a table called "sent log" with a fake order ID.
- **Unprovable** — no timestamp of the consumer's act, no raw text, no channel, no actor. It records that we blocked someone, not why or when they asked.
- **Coupled to the wrong table** — any cleanup of `sms_sent_log` silently un-suppresses people.
- **Never exercised** — 0 rows. It has never been tested against a real STOP in production.

Good news: with 0 rows, the migration to a real ledger carries no legacy data and no risk of losing a suppression. The bad news is that we have also never verified the STOP path end to end.

---

## 2. Conventions this design follows

Matched from `scripts/*.sql`, `db.js`, and the live schema:

| Convention | Rule |
|---|---|
| Table prefix | `sms_` for anything domain-specific. Exceptions: `schema_migrations` (infrastructure). |
| Primary keys | `bigint generated always as identity primary key`. **uuid only** where the id is exposed in a URL or cookie and must be unguessable (`sms_link_clicks.id`) or where it already is one (`sms_orders.id`). |
| Timestamps | `timestamptz not null default now()`. Never `timestamp`. |
| Join key for a person | `contact_phone text` in E.164, **not** a contact FK id. Every existing table does this; changing it now would touch every query in the repo. |
| Order key | `woo_order_id integer` for external correlation; `sms_orders.id uuid` for referential integrity. Carry **both**. |
| RLS | `alter table … disable row level security;` explicitly, matching `voice-migration.sql`, `push-table.sql`, `ios-push-devices-migration.sql`. Access is service-key only. |
| Idempotency | `create table if not exists`, `add column if not exists`, `create index if not exists` everywhere. Files must be re-runnable. |
| PostgREST | Every migration file ends with `notify pgrst, 'reload schema';`. Without it new tables are invisible to `supabase-js` until the cache expires. This has already bitten a sibling project (an `engine_config` table that existed in Postgres but was never visible through PostgREST). |
| Server-side helpers | Prefer a SQL function called via `supabase.rpc()` over multi-round-trip JS. Precedent: `increment_unread`, `increment_contact_messages`. |

**Naming collision, resolved now:** `routes/activity.js` is the *automation queue*, not a team feed. The new team feed table is `sms_activity_events` and its route must be `/api/feed`. The existing route should be renamed `/api/automation` in the same change, or the two will be confused permanently. Doc 00 §8 flags this; this document is where it gets decided.

---

## 3. The new tables, in dependency order

Seventeen tables. Each entry states why it exists and what breaks without it.

### Dependency graph

```
schema_migrations          (no deps)
sms_settings               (no deps)
sms_users                  (no deps)
  └─ sms_user_devices
sms_consent_events         (→ sms_contacts, sms_users)
  ├─ sms_consent_state     (derived, trigger-maintained)
  └─ sms_suppressions      (→ sms_contacts, sms_users)
sms_contact_metrics        (→ sms_contacts;  derived, job-maintained)
sms_segments               (→ sms_users)
  └─ sms_segment_members   (→ sms_segments, sms_contacts;  static segments only)
sms_campaigns              (→ sms_segments, sms_users)
  ├─ sms_campaign_variants (→ sms_campaigns)
  ├─ sms_campaign_recipients (→ sms_campaigns, sms_campaign_variants, sms_contacts, sms_messages, sms_consent_events)
  │    └─ sms_link_clicks  (→ sms_campaign_recipients)
  │         └─ sms_attributions (→ sms_orders, sms_campaigns, sms_campaign_recipients, sms_link_clicks, call_logs)
  └─ sms_campaign_test_sends (→ sms_campaigns, sms_campaign_variants, sms_users)
sms_activity_events        (→ sms_users;  mutable, 90-day retention)
sms_audit_log              (no FKs by design;  append-only, 5-year retention)
```

---

### 3.1 `schema_migrations`

**Why it exists.** Two migrations have already been forgotten (`ios_push_devices`, `add-optout-column`). A migration you cannot query is a migration you will forget. This is the cheapest table in the design and the one with the highest expected value.

**What breaks without it.** The next forgotten migration. Given the base rate is two out of nineteen scripts, and Phase 2 adds seven more, the expected number of forgotten migrations without a ledger is roughly one.

```sql
create table if not exists schema_migrations (
  filename     text primary key,
  applied_at   timestamptz not null default now(),
  applied_by   text        not null default current_user,
  note         text
);

alter table schema_migrations disable row level security;
```

Every Phase-2 script's **last statement before the `notify`** is:

```sql
insert into schema_migrations (filename)
values ('P2-03-identity.sql')
on conflict (filename) do nothing;
```

The insert lives inside the migration file so that pasting the file into the Supabase SQL editor records itself. There is no separate "mark as applied" step to forget. See §9.3 for the startup check that reads this table.

---

### 3.2 `sms_settings`

**Why it exists.** Quiet hours, frequency caps, attribution windows and brand identifiers are configuration **with legal force**. Doc 05 §4.6 is explicit: *"log every change to an audit table and annotate the charts at the change point. If a number can be tuned, the tuning must be visible."* Env vars cannot be audited, cannot be changed without a deploy, and cannot be shown in a UI.

**What breaks without it.** Attribution windows get hardcoded, and the moment someone changes one the historical numbers silently change with no record — which is the exact behaviour doc 05 §1.3(f) identifies as the tell that a vendor's attribution is a preference rather than a measurement.

```sql
create table if not exists sms_settings (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_by  bigint      references sms_users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table sms_settings disable row level security;
```

Seed rows (values are proposals, all argued elsewhere in the research):

| key | value | source |
|---|---|---|
| `quiet_hours` | `{"start":"08:00","end":"21:00","strict_states":["FL","OK","OR"],"strict_end":"20:00"}` | doc 03 §8.2 B22 |
| `frequency_caps` | `{"engaged":6,"less_engaged":4,"unengaged":2,"fatigue_risk":0,"cooldown_hours":48,"fl_rolling_24h":3}` | doc 02 §4.2, §4.3 |
| `attribution` | `{"click_window_hours":72,"coupon_window_hours":72,"exposure_window_hours":12,"exposure_enabled":false,"call_window_hours":48,"reply_window_hours":168}` | doc 05 §4.6 |
| `brand` | `{"name":"Vici","short_domain":"go.vicipeptides.com","help_contact":"support@vicipeptides.com"}` | doc 03 §5.3 |
| `recent_purchaser_days` | `10` | doc 02 §3.6 |
| `holdout` | `{"default_pct":0.0,"enabled":false}` | doc 05 §2.2 — see §11 note |

Every write to this table must also write `sms_audit_log` with `before`/`after`. That is an application obligation, not a DB constraint; the reason it is not a trigger is that the trigger cannot know the actor.

---

### 3.3 `sms_users`

**Why it exists.** Sixteen action sites in the codebase have no attributable actor (doc 06 §1.6). Campaign approval ("approved by X at Y"), the activity feed, and the audit log are all unbuildable without an X. Selling to a team of five is unbuildable without it.

**What breaks without it.** Everything in §3.16 and §3.17, plus the approval workflow in §3.10.

```sql
create table if not exists sms_users (
  id              bigint generated always as identity primary key,
  auth_user_id    uuid unique,                    -- supabase auth.users(id); NULL for the legacy placeholder
  email           text        not null unique,
  display_name    text        not null,           -- 'Dominic' — what the feed renders
  phone           text,                           -- E.164; a test send may only target a phone in this column
  role            text        not null default 'agent'
                    check (role in ('owner','admin','agent')),
  avatar_url      text,
  is_active       boolean     not null default true,
  is_legacy_shared boolean    not null default false,  -- the INBOX_PASSWORD placeholder ("Team")
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists sms_users_active_idx on sms_users (is_active) where is_active;

alter table sms_users disable row level security;
```

**Reconciliation with doc 06 §2.5.** Doc 06 proposes `users.id uuid primary key references auth.users(id)` plus `organisations` and `memberships`. Three deliberate departures:

- **`bigint identity` PK, `auth_user_id` as a nullable unique side-column.** This decouples the user record from a decision about Supabase Auth that has not been made and does not have to be made to ship the audit log. It also permits exactly one row that has no `auth_user_id` at all: the legacy shared-password placeholder from doc 06's Stage 2, which cannot exist in `auth.users` because nobody logs into it.
- **`role` is a column, not a `memberships` row.** With no organisations there is nothing for a membership to be a membership *of*. One role per user is correct until there is more than one tenant.
- **No `organisations` / `memberships` / `invitations`.** See §11.6.

`phone` is load-bearing and easy to miss: it is what makes a test send legal. A test send goes to a number with no consent record, which every other path in this design correctly blocks. Restricting test sends to `sms_users.phone` makes them our own phones by construction.

---

### 3.4 `sms_user_devices`

**Why it exists.** Push is currently addressed to "everyone" (`sendPushToAll`), and APNs tokens are being written into `push_subscriptions` as a compatibility hack because `ios_push_devices` was never created. Once actions have actors, the correct notification rule is *"notify everyone except the person who did it"*, which needs a device→user mapping.

**What breaks without it.** Dominic gets a push notification for his own reply. The `ios_push_devices` dead reference in four files stays dead.

```sql
create table if not exists sms_user_devices (
  id              bigint generated always as identity primary key,
  user_id         bigint      references sms_users(id) on delete cascade,   -- NULL = unclaimed legacy device
  platform        text        not null check (platform in ('ios','web')),
  apns_token      text unique,
  push_endpoint   text unique,
  subscription    jsonb,                                   -- web VAPID payload, as push_subscriptions.subscription
  installation_id text,
  bundle_id       text,
  environment     text        not null default 'production'
                    check (environment in ('sandbox','production')),
  enabled         boolean     not null default true,
  last_error      text,
  user_agent      text,
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint one_address check (num_nonnulls(apns_token, push_endpoint) = 1)
);

create index if not exists sms_user_devices_user_idx
  on sms_user_devices (user_id) where revoked_at is null and enabled;

alter table sms_user_devices disable row level security;
```

This supersedes **both** `push_subscriptions` and the never-created `ios_push_devices`. `user_id` is nullable so the six existing `push_subscriptions` rows can be copied in before anyone has logged in as themselves. Migration strategy: dual-write for one release, then retire (§9.2, file P2-03).

---

### 3.5 `sms_consent_events` — the ledger

**Why it exists.** This is the table you produce when a plaintiff's counsel sends a demand letter. Doc 03 §5.6 names eight fields that win a TCPA case; all eight are here. Append-only, hash-chained, never updated, never deleted — *including when a contact is deleted*, because destroying the record destroys the defence.

**What breaks without it.** Every marketing send is undefended. At $500–$1,500 per message and 847 contacts, a single list-wide send with no consent record is a $423k–$1.27M theoretical exposure.

```sql
create table if not exists sms_consent_events (
  id                  uuid primary key default gen_random_uuid(),
  contact_phone       text        not null,           -- E.164. NO foreign key: see note below.
  event_type          text        not null check (event_type in ('opt_in','opt_out','reconfirm')),
  consent_type        text                 check (consent_type in
                        ('express_written','express','implied','client_attested','unverified_legacy')),
  consent_scope       text        not null check (consent_scope in ('marketing','transactional','all')),
  occurred_at         timestamptz not null,           -- when the consumer acted
  recorded_at         timestamptz not null default now(),

  -- PROOF OF THE ACT  (audit fields 1-4)
  channel             text        not null check (channel in
                        ('web_form','checkout','sms_keyword','inbound_sms','verbal','paper',
                         'api','pos','import','operator','backfill')),
  source_url          text,
  form_id             text,
  disclosure_text     text,                           -- VERBATIM copy shown at the moment of consent
  disclosure_version  text,
  affirmative_action  text,                           -- 'checkbox_checked' | 'replied_START' | 'order_placed'
  ip_address          inet,
  user_agent          text,
  session_id          text,
  identity_asserted   text,
  evidence_uri        text,                           -- immutable object-store ref (screenshot / PDF)

  -- REVOCATION SPECIFICS
  revocation_method   text                 check (revocation_method in
                        ('sms_keyword','sms_freetext','email','voice','web_form','operator','carrier')),
  revocation_raw_text text,                           -- the consumer's EXACT words
  revocation_matched_by text               check (revocation_matched_by in
                        ('per_se_keyword','free_text_pattern','human_review','provider')),
  honored_at          timestamptz,
  confirmation_sent_at timestamptz,

  -- INTEGRITY  (audit field 8)
  actor_user_id       bigint      references sms_users(id) on delete set null,
  actor_label         text        not null,           -- 'system:webhook' | 'Dominic' | 'backfill'
  prev_hash           text,
  row_hash            text        not null,

  source_note         text
);

create index if not exists sms_consent_events_phone_idx
  on sms_consent_events (contact_phone, occurred_at desc);
create index if not exists sms_consent_events_type_idx
  on sms_consent_events (event_type, occurred_at desc);

alter table sms_consent_events disable row level security;
```

**Design notes.**

- **No foreign key to `sms_contacts`.** Deliberate, and the opposite of every other table here. A consent record must survive the deletion of the contact. Doc 06 §6.4 makes the same call for `audit_log`, for the same reason.
- **`disclosure_text` is nullable** even though doc 03 marks it `not null`. It has to be, because the 847-row backfill (§5.3) has no disclosure text to record. Forcing a value would mean inventing one, which is manufacturing evidence. Instead the backfill sets `consent_type = 'unverified_legacy'` and leaves `disclosure_text` NULL, and NULL is the honest answer to *"what did they see?"*
- **`consent_type = 'client_attested'`** is a real, deliberate category. It records that a named human at the client asserted the basis, with `actor_user_id`, `evidence_uri` and `occurred_at`. It is a weaker basis than `express_written` and the schema says so out loud rather than laundering it.
- **Hash chain.** `row_hash = sha256(prev_hash || contact_phone || event_type || occurred_at || coalesce(disclosure_text,'') || actor_label)`, `prev_hash` = the `row_hash` of the previous event for the same `contact_phone`. Computed in Node at insert. It is tamper *evidence*, not tamper *prevention* — a Postgres superuser with SQL-editor access can rewrite the whole chain. Doc 06 §6.5 is right that real tamper-proofing means shipping off-box. That is a Phase 3 deferral, consciously taken.

**Append-only enforcement** (same pattern as doc 06 §6.5):

```sql
create or replace function sms_consent_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'sms_consent_events is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists sms_consent_events_no_mutate on sms_consent_events;
create trigger sms_consent_events_no_mutate
  before update or delete on sms_consent_events
  for each row execute function sms_consent_events_immutable();
```

**The eight fields that defend a TCPA claim** (doc 03 §5.6), mapped:

| # | Doc 03 requirement | Column here |
|---|---|---|
| 1 | Verbatim words the consumer saw | `disclosure_text` (+ `disclosure_version`) |
| 2 | Attribution of the act to a person at a time | `occurred_at`, `ip_address`, `user_agent` |
| 3 | Proof it was an act, not a default | `affirmative_action` |
| 4 | What the page looked like | `source_url`, `evidence_uri` |
| 5 | The chain from consent to send | **`sms_messages.consent_event_id`** (§4.2) |
| 6 | Proof the suppression check ran before each send | **`sms_messages.suppression_checked_at`** (§4.2) |
| 7 | Quiet-hours defence | **`sms_messages.recipient_local_time`** (§4.2) |
| 8 | Tamper evidence | `prev_hash`, `row_hash` |

Note that fields 5, 6 and 7 are **not** in this table. Doc 03 proposes a new `message_events` table for them. We already have that table: it is `sms_messages`, 2,283 rows, the universal outbound record. Adding three columns to it (§4.2) is strictly better than a parallel send log that would immediately diverge from it. This is the single most important reconciliation in the document.

---

### 3.6 `sms_consent_state` — the fast current status

**Why it exists.** The ledger answers "what happened". The send path needs "what is true now", in one indexed lookup, on every send, synchronously (doc 03 §8.2 B21: *"Never cached beyond the request"*). Deriving current state by scanning the ledger on every send is both slower and easy to get subtly wrong (latest-event-wins across two scopes).

**What breaks without it.** Either the send-time check becomes a window function over the ledger, or somebody caches it and a revocation goes unhonoured. The second one is the $1,500-per-message failure.

```sql
create table if not exists sms_consent_state (
  contact_phone    text        not null,
  scope            text        not null check (scope in ('marketing','transactional')),
  status           text        not null check (status in ('granted','revoked')),
  current_event_id uuid        not null references sms_consent_events(id),
  granted_at       timestamptz,
  revoked_at       timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (contact_phone, scope)
);

alter table sms_consent_state disable row level security;
```

Maintained by an `after insert` trigger on `sms_consent_events`:

```sql
create or replace function sms_apply_consent_event()
returns trigger language plpgsql as $$
declare
  scopes text[] := case when new.consent_scope = 'all'
                        then array['marketing','transactional']
                        else array[new.consent_scope] end;
  s text;
begin
  if new.event_type = 'opt_out' then
    foreach s in array scopes loop
      insert into sms_consent_state (contact_phone, scope, status, current_event_id, revoked_at)
      values (new.contact_phone, s, 'revoked', new.id, coalesce(new.honored_at, new.occurred_at))
      on conflict (contact_phone, scope) do update
        set status = 'revoked',
            current_event_id = excluded.current_event_id,
            revoked_at = excluded.revoked_at,
            updated_at = now();
    end loop;
  else
    foreach s in array scopes loop
      insert into sms_consent_state (contact_phone, scope, status, current_event_id, granted_at)
      values (new.contact_phone, s, 'granted', new.id, new.occurred_at)
      on conflict (contact_phone, scope) do update
        set status = 'granted',
            current_event_id = excluded.current_event_id,
            granted_at = excluded.granted_at,
            revoked_at = null,
            updated_at = now();
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_consent_event_applied on sms_consent_events;
create trigger sms_consent_event_applied
  after insert on sms_consent_events
  for each row execute function sms_apply_consent_event();
```

**The absence of a row means "no consent".** That is the fail-closed default and it is the correct one: a contact created by an inbound webhook is not sendable marketing until somebody records why they are.

---

### 3.7 `sms_suppressions` — operational blocks

**Why it exists.** Not every reason to never text someone is a consent revocation. Hard delivery failures, a manual do-not-contact from the operator, a litigation hold, and a carrier-reported opt-out that never reached our webhook are all suppressions with no consent event behind them. Putting them in the consent ledger would pollute a legal record with operational noise.

**What breaks without it.** Either operational blocks get written as fake consent events (corrupting the ledger) or they live nowhere and we keep texting a disconnected number.

```sql
create table if not exists sms_suppressions (
  id              bigint generated always as identity primary key,
  contact_phone   text        not null,
  scope           text        not null default 'all' check (scope in ('marketing','all')),
  reason          text        not null check (reason in
                    ('hard_bounce','manual_dnc','carrier_optout','litigation_hold',
                     'invalid_number','deactivated_number','fraud')),
  detail          text,
  suppressed_at   timestamptz not null default now(),
  suppressed_by   bigint      references sms_users(id) on delete set null,
  actor_label     text        not null default 'system',
  released_at     timestamptz,
  released_by     bigint      references sms_users(id) on delete set null,
  release_reason  text
);

create unique index if not exists sms_suppressions_active_idx
  on sms_suppressions (contact_phone, scope, reason) where released_at is null;
create index if not exists sms_suppressions_lookup_idx
  on sms_suppressions (contact_phone) where released_at is null;

alter table sms_suppressions disable row level security;
```

Releasable — unlike consent revocation, a hard bounce on a number the customer has since fixed is legitimately reversible. Every release is audit-logged with `released_by`.

---

### 3.8 `sms_contact_metrics` — the derived facts table

**Why it exists.** Segment rules need a stable, flat, named vocabulary to filter on. Recomputing RFM, lifecycle, engagement and replenishment timing inside every segment preview means unnesting `sms_orders.items` JSONB and scanning `sms_messages` on every keystroke in the builder. It also means the rule language has to be able to express aggregations, which is what turns a safe rule tree into an unsafe query builder.

**What breaks without it.** The rule tree grows joins and aggregates, and at that point you have reinvented SQL with a worse type system.

```sql
create table if not exists sms_contact_metrics (
  contact_phone            text primary key references sms_contacts(phone) on delete cascade,
  computed_at              timestamptz not null default now(),

  -- orders
  orders_valid             integer not null default 0,
  orders_all               integer not null default 0,
  first_order_at           timestamptz,
  last_order_at            timestamptz,
  days_since_last_order    integer,
  revenue_total_cents      bigint  not null default 0,
  aov_cents                integer,
  max_order_cents          integer,

  -- replenishment  (doc 02 §2)
  median_interorder_days   numeric(8,2),
  interorder_mad_days      numeric(8,2),
  ipi_confidence           text check (ipi_confidence in ('none','low','medium','high')),
  predicted_reorder_at     timestamptz,
  reorder_overdue_days     integer,

  -- rfm  (doc 02 §3.1 — absolute thresholds, NOT ntile)
  r_score                  smallint,
  f_score                  smallint,
  m_score                  smallint,
  rfm_bucket               text check (rfm_bucket in ('champion','active','at_risk','lapsed','never_bought')),
  lifecycle_stage          text,

  -- engagement  (doc 02 §3.4)
  last_inbound_at          timestamptz,
  inbound_90d              integer not null default 0,
  outbound_30d             integer not null default 0,
  outbound_marketing_30d   integer not null default 0,
  last_marketing_sent_at   timestamptz,
  reactions_90d            integer not null default 0,
  engagement_tier          text check (engagement_tier in
                             ('engaged','less_engaged','never_responded','unengaged')),

  -- deliverability
  outbound_fail_90d        integer not null default 0,
  outbound_total_90d       integer not null default 0,

  -- product affinity  (doc 02 §3.5)
  distinct_skus            integer not null default 0,
  last_sku                 text,
  top_sku                  text,
  skus                     jsonb   not null default '[]'::jsonb,

  -- copied for filtering convenience
  state                    text,
  country                  text,
  timezone                 text,
  has_email                boolean not null default false,

  -- derived cache of consent/suppression, for PREVIEW ONLY (never for the send gate)
  marketing_consent        boolean not null default false,
  is_suppressed            boolean not null default false,
  suppression_reason       text
);

create index if not exists sms_contact_metrics_bucket_idx  on sms_contact_metrics (rfm_bucket);
create index if not exists sms_contact_metrics_reorder_idx on sms_contact_metrics (predicted_reorder_at);

alter table sms_contact_metrics disable row level security;
```

**On the three consent columns at the bottom.** They are a *cache in a derived table*, refreshed with everything else, used only so a segment preview can show "42 of these are opted out" without a join. **The send-time gate never reads them** — it reads `sms_consent_state` and `sms_suppressions` directly, synchronously, per §5.4. Stating this explicitly here because a stale cache on the send path is exactly the failure mode this whole section exists to prevent.

**Refresh.** One SQL function, called via `supabase.rpc('refresh_sms_contact_metrics')`:

- nightly, from the existing `setInterval` scaffolding in `server.js`;
- on demand, when the campaign builder opens;
- after `syncOrder()` completes on a WooCommerce webhook (scoped to one phone via an optional `p_phone` argument).

Implementation is a single `insert … select … on conflict do update` over a CTE chain — the RFM, engagement and affinity SQL in doc 02 §3.1/§3.4/§3.5 is written against the real schema and transfers almost verbatim, with `NTILE` correctly replaced by absolute thresholds. At 847 contacts × 1,497 orders this is a sub-100ms full rebuild; there is no case for incremental refresh.

**One correction to doc 02 §3.1's segment labels.** Doc 02 defines an 11-way RFM split then says on the next page to collapse it to four for Vici. The live data settles it: with 8 contacts at ≥5 valid orders and 62 at ≥3, an 11-way split produces buckets of single digits. `rfm_bucket` is therefore constrained to **five** values (four operational plus `never_bought`, which is 370 of 847 contacts and needs a name). The 11-way view is not built.

---

### 3.9 `sms_segments` and `sms_segment_members`

**Why they exist.** A segment must be a saved object that can be re-evaluated tomorrow and shown in a UI. See §6 for the full argument on how the definition is stored.

**What breaks without them.** Every campaign carries a one-off ad-hoc audience, nothing is reusable, and "who is in this right now" cannot be answered because there is no "this".

```sql
create table if not exists sms_segments (
  id            bigint generated always as identity primary key,
  key           text        not null unique,     -- 'due-for-reorder'; stable, used in code and utm
  name          text        not null,            -- 'Due for reorder'
  description   text,
  kind          text        not null default 'dynamic'
                  check (kind in ('dynamic','static','predicate')),

  rules         jsonb,        -- kind='dynamic': the rule tree (§6.2)
  predicate_key text,         -- kind='predicate': a named, code-registered predicate
  params        jsonb not null default '{}'::jsonb,

  is_system     boolean     not null default false,   -- shipped with the product; not user-deletable
  created_by    bigint      references sms_users(id) on delete set null,
  updated_by    bigint      references sms_users(id) on delete set null,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint segment_definition_present check (
    (kind = 'dynamic'   and rules is not null and predicate_key is null) or
    (kind = 'static'    and rules is null     and predicate_key is null) or
    (kind = 'predicate' and rules is null     and predicate_key is not null)
  )
);

create index if not exists sms_segments_live_idx on sms_segments (key) where archived_at is null;

alter table sms_segments disable row level security;

-- Static segments ONLY. A dynamic segment never writes rows here.
create table if not exists sms_segment_members (
  segment_id    bigint not null references sms_segments(id) on delete cascade,
  contact_phone text   not null references sms_contacts(phone) on delete cascade,
  added_at      timestamptz not null default now(),
  added_by      bigint references sms_users(id) on delete set null,
  primary key (segment_id, contact_phone)
);

alter table sms_segment_members disable row level security;
```

Segments are **archived, never deleted** — a campaign that ran against a segment must still be able to name it a year later.

---

### 3.10 `sms_campaigns`

**Why it exists.** There is no campaign object in the system today. This is it: name, audience, schedule, status, approval state, priority, and the builder's working state.

**What breaks without it.** Everything downstream. Variants, rosters, clicks and attributions all hang off a campaign id.

```sql
create table if not exists sms_campaigns (
  id                bigint generated always as identity primary key,
  slug              text        not null unique,          -- stable; goes in utm_campaign
  name              text        not null,
  kind              text        not null default 'campaign' check (kind in ('campaign','flow')),
  message_class     text        not null default 'marketing'
                      check (message_class in ('marketing','transactional')),
  archetype         text        check (archetype in
                      ('discount_offer','restock_alert','education','scarcity','social_proof',
                       'replenishment_reminder','winback','new_product','shipping_update',
                       'review_request','welcome','other')),

  status            text        not null default 'draft'
                      check (status in ('draft','pending_approval','scheduled','sending',
                                        'sent','paused','cancelled')),

  -- audience
  segment_id        bigint      references sms_segments(id) on delete restrict,
  segment_snapshot  jsonb,                                 -- the definition, frozen at roster build
  exclusion_overrides jsonb not null default '[]'::jsonb,  -- which soft exclusions a human waived

  -- scheduling & contention
  priority          integer     not null default 100,      -- higher wins at send time (§5.5)
  scheduled_at      timestamptz,
  send_window       jsonb,                                 -- {"start":"10:00","end":"18:00"}
  sent_at           timestamptz,

  -- experiment
  holdout_pct       numeric(5,4) not null default 0
                      check (holdout_pct >= 0 and holdout_pct < 1),
  randomisation_seed text,
  attribution_window_hours integer not null default 72,

  -- approval  (doc 02 §7.2 — a human approves copy + audience, every time)
  approved_by       bigint      references sms_users(id) on delete set null,
  approved_at       timestamptz,
  approval_note     text,

  -- flow-only
  autonomy_stage    smallint    not null default 0 check (autonomy_stage between 0 and 3),
  trigger_spec      jsonb,                                 -- for kind='flow'

  -- cost, denormalised (see §11.2 — no separate costs table)
  segments_sent     integer     not null default 0,
  mms_sent          integer     not null default 0,
  provider_cost_cents integer   not null default 0,
  fixed_cost_cents  integer     not null default 0,

  builder_state     jsonb,                                 -- wizard's working draft + AI rationale
  created_by        bigint      references sms_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint approved_before_scheduled check (
    status in ('draft','pending_approval','cancelled') or approved_by is not null
  )
);

create index if not exists sms_campaigns_status_idx on sms_campaigns (status, scheduled_at);
create index if not exists sms_campaigns_sent_idx   on sms_campaigns (sent_at desc) where sent_at is not null;

alter table sms_campaigns disable row level security;
```

**`approved_before_scheduled` is the most important line in this table.** It makes doc 02 §7.2's rule — a human approves copy and audience, every time, no exceptions at this scale — a database constraint rather than an application convention. An AI agent with a service key cannot route around it.

**No separate approvals table.** A campaign is approved once. `approved_by`/`approved_at`/`approval_note` plus the full before/after in `sms_audit_log` covers it. A multi-step approval chain is a feature for a client with a compliance department; Vici has two people.

**Idempotent send claim, no lock table.** Background work runs in the web process with no locking (doc 00 §2), so two Railway instances would double-send. The claim is a conditional update, which is atomic and free:

```sql
update sms_campaigns
   set status = 'sending', sent_at = now()
 where id = $1 and status = 'scheduled'
returning id;
```

Zero rows returned means another worker got it. This same pattern should eventually be retrofitted to `processScheduledQueue()` in `flows/utils.js:218`, which has the identical race today.

---

### 3.11 `sms_campaign_variants`

**Why it exists.** A/B test arms, and the place where encoding and segment count are computed *before* a send. Doc 01 §1.8: one curly apostrophe silently converts a 1-segment message into 3 — a 3× cost multiplier invisible to the author.

**What breaks without it.** Variants live as a JSONB array on the campaign, which means a click cannot reference the arm it came from and per-arm click rates cannot be computed.

```sql
create table if not exists sms_campaign_variants (
  id            bigint generated always as identity primary key,
  campaign_id   bigint      not null references sms_campaigns(id) on delete cascade,
  slug          text        not null,                    -- 'a','b' — goes in utm_content
  body          text        not null,
  media_urls    jsonb,
  weight        numeric(5,4) not null default 1.0 check (weight > 0),
  encoding      text        check (encoding in ('GSM-7','UCS-2')),
  segment_count integer,
  est_cost_cents integer,
  created_at    timestamptz not null default now(),
  unique (campaign_id, slug)
);

alter table sms_campaign_variants disable row level security;
```

A single-variant campaign still gets one row (`slug='a'`). No special case in the join.

---

### 3.12 `sms_campaign_recipients` — the roster

**Why it exists.** This is the experiment log and the audit record of who was assigned what. Without it there is no defensible denominator, no defensible randomisation, and no way to answer "who did this campaign go to" after the fact.

**What breaks without it.** All attribution (clicks reference recipients), all metrics (delivery rate needs the assigned set), all holdout maths, and the exclusion transparency in doc 02 §3.6 (*"214 → 137 after exclusions: 41 recent purchasers, 22 frequency-capped…"*) which requires storing the suppressed rows, not filtering them out.

```sql
create table if not exists sms_campaign_recipients (
  id                bigint generated always as identity primary key,
  campaign_id       bigint      not null references sms_campaigns(id) on delete cascade,
  contact_phone     text        not null references sms_contacts(phone) on delete restrict,
  arm               text        not null check (arm in ('treatment','holdout')),
  variant_id        bigint      references sms_campaign_variants(id) on delete restrict,
  assigned_at       timestamptz not null default now(),

  -- send outcome
  send_status       text        not null default 'pending' check (send_status in
                      ('pending','sent','delivered','failed','rejected','suppressed','not_sent_holdout')),
  suppression_reason text,       -- 'no_marketing_consent' | 'opted_out' | 'quiet_hours'
                                 -- | 'frequency_cap' | 'cooldown' | 'recent_purchaser'
                                 -- | 'in_active_flow' | 'hard_bounce' | 'lost_priority'
  suppression_overridden_by bigint references sms_users(id) on delete set null,
  telnyx_message_id text,
  sms_message_id    bigint      references sms_messages(id) on delete set null,
  consent_event_id  uuid        references sms_consent_events(id),
  sent_at           timestamptz,
  delivered_at      timestamptz,
  failure_code      text,

  -- personalised assets
  link_token        text unique,
  coupon_code       text,
  rendered_body     text,        -- the EXACT bytes sent, after substitution

  -- CUPED covariate, frozen at assignment  (doc 05 §2.3(2))
  pre_period_revenue_cents integer not null default 0,
  pre_period_orders        integer not null default 0,

  constraint holdout_has_no_variant check ((arm = 'holdout') = (variant_id is null)),
  unique (campaign_id, contact_phone)
);

create index if not exists scr_campaign_arm_idx  on sms_campaign_recipients (campaign_id, arm);
create index if not exists scr_phone_idx         on sms_campaign_recipients (contact_phone, delivered_at desc);
create index if not exists scr_token_idx         on sms_campaign_recipients (link_token) where link_token is not null;
create index if not exists scr_coupon_idx        on sms_campaign_recipients (coupon_code) where coupon_code is not null;
create index if not exists scr_pending_idx       on sms_campaign_recipients (campaign_id) where send_status = 'pending';

alter table sms_campaign_recipients disable row level security;
```

**Three departures from doc 05's version, all deliberate:**

1. **`on delete restrict` on `contact_phone`, not `cascade`.** Doc 05 uses `cascade`. A campaign roster is an audit record; deleting a contact must not silently delete the evidence that we texted them. Combined with `sms_contacts.archived_at` (§4.1), the contact-deletion path becomes an archive.
2. **No `arm = 'test'`.** Test sends go in their own table (§3.13) so they cannot contaminate a denominator by accident.
3. **`rendered_body` added.** Doc 03 §5.6's `message_events.body_rendered` — the exact bytes sent. `sms_campaign_variants.body` is the template; this is the artefact.

---

### 3.13 `sms_campaign_test_sends`

**Why it exists.** You must be able to send a campaign to your own phone before sending it to 847 people, and that send must be legal (no consent record exists for a test) and must never appear in a rate calculation.

**What breaks without it.** Either test sends are blocked by the consent gate (so nobody tests), or they are recorded as recipients and quietly inflate the delivered denominator.

```sql
create table if not exists sms_campaign_test_sends (
  id                bigint generated always as identity primary key,
  campaign_id       bigint      not null references sms_campaigns(id) on delete cascade,
  variant_id        bigint      references sms_campaign_variants(id) on delete set null,
  to_phone          text        not null,
  rendered_body     text        not null,
  telnyx_message_id text,
  sent_by           bigint      not null references sms_users(id) on delete restrict,
  sent_at           timestamptz not null default now()
);

create index if not exists sms_campaign_test_sends_campaign_idx
  on sms_campaign_test_sends (campaign_id, sent_at desc);

alter table sms_campaign_test_sends disable row level security;
```

Application rule, enforced in the send handler: `to_phone` must match a `sms_users.phone` of an active user. That is what makes bypassing the consent gate defensible — the recipient is us.

---

### 3.14 `sms_link_clicks`

**Why it exists.** There is no click tracking of any kind today. Without a click there is no Grade A or Grade B attribution, and "see how much money it makes" has no evidence behind it.

**What breaks without it.** Attribution collapses to exposure-only (Grade D), which doc 05 §1.3(a) shows manufactures roughly 2 orders per blast out of nothing.

```sql
create table if not exists sms_link_clicks (
  id              uuid primary key default gen_random_uuid(),   -- the click_id in the URL and cookie
  recipient_id    bigint      not null references sms_campaign_recipients(id) on delete cascade,
  campaign_id     bigint      not null references sms_campaigns(id) on delete cascade,
  variant_id      bigint      references sms_campaign_variants(id) on delete set null,
  contact_phone   text        not null,                          -- denormalised for rollups
  clicked_at      timestamptz not null default now(),
  dest_url        text        not null,
  ip              inet,
  user_agent      text,
  device_class    text        check (device_class in ('mobile','tablet','desktop','bot','unknown')),
  is_bot          boolean     not null default false,
  bot_reason      text,
  latency_seconds integer                                        -- clicked_at − delivered_at; <3 is a bot tell
);

create index if not exists clicks_recipient_idx on sms_link_clicks (recipient_id);
create index if not exists clicks_campaign_idx  on sms_link_clicks (campaign_id, clicked_at desc) where not is_bot;
create index if not exists clicks_phone_idx     on sms_link_clicks (contact_phone, clicked_at desc) where not is_bot;

alter table sms_link_clicks disable row level security;
```

`ip_asn` from doc 05's version is **dropped** — it requires an IP-to-ASN lookup service we do not have and would not use. The other five bot signals in doc 05 §4.4 (sub-3-second latency, scanner user agents, HEAD requests, missing `Accept: text/html`, multiple tokens from one IP) need no external dependency and cover the realistic cases.

---

### 3.15 `sms_attributions`

**Why it exists.** One row per (order, campaign, channel, method) attribution claim, each carrying its evidence grade. An order may legitimately produce several rows. Nothing is ever silently merged.

**What breaks without it.** Revenue attribution has nowhere to live, and every number in the dashboard becomes a recomputation with no record of how it was derived — which means it changes retroactively when a setting changes, which is exactly the behaviour doc 05 §1.3(f) calls the tell.

```sql
create table if not exists sms_attributions (
  id                 bigint generated always as identity primary key,

  -- the order, both ways
  order_id           uuid        not null references sms_orders(id) on delete cascade,
  woo_order_id       integer     not null,
  contact_phone      text        not null,

  -- the touch
  campaign_id        bigint      references sms_campaigns(id) on delete set null,
  recipient_id       bigint      references sms_campaign_recipients(id) on delete set null,
  click_id           uuid        references sms_link_clicks(id) on delete set null,
  call_log_id        bigint      references call_logs(id) on delete set null,
  flow_type          text,                                  -- for channel='sms_flow'

  channel            text        not null check (channel in
                       ('sms_campaign','sms_flow','sms_conversation','voice')),
  grade              char(1)     not null check (grade in ('A','B','C','D','E')),
  match_method       text        not null check (match_method in
                       ('checkout_click_id','coupon','phone_identity','email_identity',
                        'woo_customer_id','exposure_only','operator_declared','call_assisted')),

  order_total_cents  integer     not null,
  order_margin_cents integer,
  ordered_at         timestamptz not null,
  touch_at           timestamptz not null,
  window_hours       integer     not null,
  hours_to_convert   numeric(8,2) generated always as
                       (extract(epoch from (ordered_at - touch_at)) / 3600) stored,

  -- honesty flags  (doc 05 §5)
  is_repeat_buyer    boolean     not null default false,
  baseline_p         numeric(6,5),
  had_other_channel_touch boolean not null default false,

  -- refund reconciliation  (doc 05 §4.5)
  voided_at          timestamptz,
  void_reason        text,

  declared_by        bigint      references sms_users(id) on delete set null,
  declared_note      text,
  attributed_at      timestamptz not null default now(),

  unique (order_id, campaign_id, channel, match_method)
);

create index if not exists attr_order_idx    on sms_attributions (order_id);
create index if not exists attr_campaign_idx on sms_attributions (campaign_id, grade) where voided_at is null;
create index if not exists attr_phone_idx    on sms_attributions (contact_phone, ordered_at desc);
create index if not exists attr_grade_idx    on sms_attributions (grade, ordered_at desc) where voided_at is null;

alter table sms_attributions disable row level security;
```

**Reconciliation with doc 05 §4.5.** Doc 05 writes `woo_order_id BIGINT NOT NULL REFERENCES sms_orders(woo_order_id)`. That is wrong against the live schema in two ways: `sms_orders`'s primary key is a **uuid**, and `woo_order_id` is an **integer** whose UNIQUE constraint (`scripts/add-woo-order-unique.sql`) must be verified as applied before it can be an FK target. This design references the real PK and carries `woo_order_id` alongside for correlation and reporting. Verify before running P2-06:

```sql
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'sms_orders'::regclass and contype = 'u';
```

Also removed from doc 05's version: `email_external` from the channel enum (see §11.4), and the `CHAR(1)` grade check gains no 'E' problem — grade E is `operator_declared` and `call_assisted`, both retained.

---

### 3.16 `sms_activity_events` — the team feed

**Why it exists.** The user-facing "who did what" surface. Mutable, curated, short-retention.

**What breaks without it.** No feed. Note that this table is *not* the audit log and cannot be, because `batch_count` makes it mutable (doc 06 §6.1).

```sql
create table if not exists sms_activity_events (
  id             bigint generated always as identity primary key,

  actor_type     text        not null check (actor_type in ('user','system','contact','integration')),
  actor_user_id  bigint      references sms_users(id) on delete set null,
  actor_label    text        not null,                    -- 'Dominic' | 'Automation' | 'WooCommerce'

  verb           text        not null,                    -- 'message.sent', 'campaign.approved'
  tier           text        not null default 'aware' check (tier in ('act','aware','audit')),

  target_type    text        not null,                    -- 'conversation'|'call'|'campaign'|'contact'
  target_id      text,
  contact_phone  text,                                    -- promoted out of payload: the hot path

  description    text        not null,                    -- pre-rendered sentence
  payload        jsonb       not null default '{}'::jsonb,

  fingerprint    text,                                    -- idempotency
  batch_key      text,
  batch_count    integer     not null default 1,
  batch_until    timestamptz,

  created_at     timestamptz not null default now()
);

create unique index if not exists activity_fingerprint_idx
  on sms_activity_events (fingerprint) where fingerprint is not null;
create index if not exists activity_recent_idx  on sms_activity_events (id desc);
create index if not exists activity_visible_idx on sms_activity_events (id desc) where tier <> 'audit';
create index if not exists activity_contact_idx on sms_activity_events (contact_phone, id desc)
  where contact_phone is not null;
create index if not exists activity_actor_idx   on sms_activity_events (actor_user_id, id desc)
  where actor_user_id is not null;
create index if not exists activity_batch_idx   on sms_activity_events (batch_key, batch_until desc)
  where batch_key is not null;

alter table sms_activity_events disable row level security;
```

Doc 06 §6.3 proposes `create unique index … where batch_until > now()`. **That index will not build** — `now()` is not immutable and Postgres rejects non-immutable expressions in index predicates. Doc 06 flags this itself; the plain `(batch_key, batch_until desc)` index above is the fix, with the time test in the query's `WHERE`.

`org_id` is dropped from doc 06's version (§11.6). Retention: 90 days, one nightly `DELETE`. No partitioning (doc 06 §6.7 computes ~500 events/month, ~3 MB/year).

---

### 3.17 `sms_audit_log` — the compliance record

**Why it exists.** Different audience, different retention (5+ years), different mutability (none), different fields (`ip`, `user_agent`, `before`/`after`) from the feed. Doc 06 §6.1 makes the case; the published retention numbers across Zendesk/Front/Linear/Missive settle it.

**What breaks without it.** Consent-bearing changes, setting changes and suppression overrides have no permanent record, which is the thing that turns a defensible programme into an indefensible one.

```sql
create table if not exists sms_audit_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),

  actor_type    text        not null,
  actor_user_id bigint,                                   -- NO foreign key, by design
  actor_label   text        not null,

  action        text        not null,                     -- same vocabulary as activity_events.verb
  entity_type   text        not null,
  entity_id     text,

  before        jsonb,
  after         jsonb,

  ip            inet,
  user_agent    text,
  session_id    text,
  request_id    text
);

create index if not exists audit_time_idx   on sms_audit_log (occurred_at desc);
create index if not exists audit_actor_idx  on sms_audit_log (actor_user_id, occurred_at desc);
create index if not exists audit_entity_idx on sms_audit_log (entity_type, entity_id, occurred_at desc);

alter table sms_audit_log disable row level security;

create or replace function sms_audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'sms_audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists sms_audit_log_no_mutate on sms_audit_log;
create trigger sms_audit_log_no_mutate
  before update or delete on sms_audit_log
  for each row execute function sms_audit_log_immutable();
```

**Deliberately no foreign keys.** An audit record must survive the deletion of everything it references. This is the opposite of the choice in `sms_activity_events` and it is intentional.

**Minimum actions that must be audited** (application obligation): any `sms_settings` write; any `sms_consent_events` insert; any `sms_suppressions` insert or release; campaign approve / schedule / cancel; any exclusion override; any user role change; any segment definition change; any attribution-window change; any bulk send from `routes/admin.js`.

---

## 4. Alterations to existing tables

**Live-safety summary.** Every statement below is `ADD COLUMN … NULL` or `ADD COLUMN … DEFAULT <constant>`, `CREATE INDEX IF NOT EXISTS`, or an `ADD CONSTRAINT … NOT VALID`. On Postgres 11+ none of these rewrite the table. All take a brief `ACCESS EXCLUSIVE` lock for the catalogue update — at 847/1,497/2,283 rows that is single-digit milliseconds. Index creation is the only statement that holds a lock for a meaningful duration; `CREATE INDEX CONCURRENTLY` is available but at these row counts it is not worth the complication (it cannot run inside a transaction block, which makes the migration files harder to paste safely).

**The one genuinely unsafe thing** in this whole section is not a DDL statement. It is `db.js`. See §4.2.

### 4.1 `sms_contacts` (847 rows)

```sql
alter table sms_contacts add column if not exists timezone   text;
alter table sms_contacts add column if not exists tz_source  text
  check (tz_source in ('area_code','profile','zip','state','manual'));
alter table sms_contacts add column if not exists archived_at timestamptz;

-- Required as the FK target for sms_contact_metrics / sms_segment_members /
-- sms_campaign_recipients. Verify it already exists before adding.
--   select conname from pg_constraint
--    where conrelid='sms_contacts'::regclass and contype in ('u','p');
-- (The code's supabase.upsert(..., {onConflict:'phone'}) implies it does.)
-- alter table sms_contacts add constraint sms_contacts_phone_unique unique (phone);

-- 0 of 847 rows fail this today (verified). NOT VALID keeps it cheap and
-- non-blocking; VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock.
alter table sms_contacts add constraint sms_contacts_phone_e164
  check (phone ~ '^\+[1-9][0-9]{7,14}$') not valid;
alter table sms_contacts validate constraint sms_contacts_phone_e164;
```

| Column | Safe on live data? | Backfill needed? |
|---|---|---|
| `timezone`, `tz_source` | Yes — nullable ADD COLUMN, no rewrite | Yes, but **not** from area code alone. Doc 02 §6.3 is explicit that area code is a poor proxy. Backfill from `sms_contacts.state` where present, fall back to area code with `tz_source='area_code'` so the weakness is visible in the data. Until backfilled, quiet-hours enforcement must default to the strictest window (08:00–20:00 Pacific-equivalent), not to "unknown means send". |
| `archived_at` | Yes | No |
| E.164 CHECK | Yes, `NOT VALID` then `VALIDATE` | No — 0 violations verified |

**Explicitly NOT added: `opted_out boolean`.** `scripts/add-optout-column.sql` is superseded, not applied. A denormalised opt-out boolean on a table that is `upsert`ed from six different code paths (`routes/send.js:70`, `routes/webhook.js:91`, `sync-woocommerce.js:37`, and three more) is one careless upsert away from silently resurrecting a suppressed contact. At 847 contacts there is no performance argument for the denormalisation. The authority is `sms_consent_state` + `sms_suppressions`, read directly, on every send.

**`sms_contacts` deletion becomes archival.** With `sms_campaign_recipients.contact_phone` on `ON DELETE RESTRICT`, an attempted delete of a contact who has ever been on a roster will now error. That is the intended behaviour, but any code path that deletes a contact must be changed to set `archived_at` instead. Grep confirms no such path exists in `routes/` today — the only `.delete()` calls are against `push_subscriptions` and `ios_push_devices`. So this is a forward constraint, not a break.

### 4.2 `sms_messages` (2,283 rows) — and the `db.js` trap

```sql
alter table sms_messages add column if not exists campaign_id     bigint references sms_campaigns(id) on delete set null;
alter table sms_messages add column if not exists variant_id      bigint references sms_campaign_variants(id) on delete set null;
alter table sms_messages add column if not exists recipient_id    bigint references sms_campaign_recipients(id) on delete set null;
alter table sms_messages add column if not exists flow_type       text;
alter table sms_messages add column if not exists message_class   text
  check (message_class in ('marketing','transactional','conversation'));
alter table sms_messages add column if not exists actor_user_id   bigint references sms_users(id) on delete set null;

-- The TCPA audit chain (doc 03 §5.6 fields 5, 6, 7)
alter table sms_messages add column if not exists consent_event_id       uuid references sms_consent_events(id);
alter table sms_messages add column if not exists suppression_checked_at timestamptz;
alter table sms_messages add column if not exists recipient_local_time   timestamptz;

-- Cost / encoding (doc 01 §1.8)
alter table sms_messages add column if not exists encoding        text check (encoding in ('GSM-7','UCS-2'));
alter table sms_messages add column if not exists segments_billed smallint;

create index if not exists sms_messages_campaign_idx
  on sms_messages (campaign_id, created_at desc) where campaign_id is not null;
create index if not exists sms_messages_actor_idx
  on sms_messages (actor_user_id, created_at desc) where actor_user_id is not null;
```

All nullable, no rewrite, no backfill required. Historical rows keep NULL, which correctly means "we do not know", and NULL is the honest value for a message sent before the ledger existed.

**⚠ The `db.js` trap — read this before writing any code.**

`db.js:24-45` implements a deliberate fallback: if `insertSmsMessage` gets a `PGRST204` (unknown column), it **strips a hardcoded list of columns and silently retries**:

```js
const MIGRATION_COLUMNS = ['media_urls', 'reply_to_message_id', 'reactions'];
```

This exists so deploys can precede migrations. It is a good pattern and it is also a loaded gun for this change. If any of the ten new columns is passed to `insertSmsMessage` before P2-04 has been applied, PostgREST returns `PGRST204`, the fallback strips only the three MMS columns, the retry **fails again**, and the insert throws. Worse, if someone "fixes" it by adding the new columns to `MIGRATION_COLUMNS`, then every message sent before the migration silently loses its `consent_event_id` and `suppression_checked_at` — the two fields whose entire job is to prove the check ran.

**Rule:** `consent_event_id` and `suppression_checked_at` must **never** be added to `MIGRATION_COLUMNS`. If they cannot be written, the send must fail, loudly. That is the correct failure mode for a compliance field.

### 4.3 `sms_scheduled` (602 rows)

```sql
alter table sms_scheduled add column if not exists campaign_id        bigint references sms_campaigns(id) on delete cascade;
alter table sms_scheduled add column if not exists variant_id         bigint references sms_campaign_variants(id) on delete set null;
alter table sms_scheduled add column if not exists recipient_id       bigint references sms_campaign_recipients(id) on delete cascade;
alter table sms_scheduled add column if not exists message_class      text
  check (message_class in ('marketing','transactional'));
alter table sms_scheduled add column if not exists priority           integer not null default 100;
alter table sms_scheduled add column if not exists cancelled_by       bigint references sms_users(id) on delete set null;
alter table sms_scheduled add column if not exists cancelled_at       timestamptz;
alter table sms_scheduled add column if not exists updated_at         timestamptz;

create index if not exists sms_scheduled_due_idx
  on sms_scheduled (send_at) where status = 'pending';
create index if not exists sms_scheduled_campaign_idx
  on sms_scheduled (campaign_id) where campaign_id is not null;
```

Safe; no backfill. `message_class` should be backfilled for the 602 existing rows from `flow_type` — every current flow type (`confirmed-*`, `shipped-*`, `hold-*`, `failed-*`) is transactional:

```sql
update sms_scheduled set message_class = 'transactional' where message_class is null;
```

That is a 602-row update, sub-second, and it is the correct classification: all nine live flow types are order-triggered.

`sms_scheduled_due_idx` is a genuine improvement independent of Phase 2 — `processScheduledQueue()` runs `status='pending' and send_at <= now()` every five minutes with no supporting index.

`routes/activity.js:104` cancels a queue item with no actor. `cancelled_by`/`cancelled_at` closes one of doc 06 §1.6's sixteen actor-less sites.

### 4.4 `sms_sent_log` (1,151 rows)

```sql
alter table sms_sent_log add column if not exists campaign_id bigint references sms_campaigns(id) on delete set null;
alter table sms_sent_log add column if not exists recipient_id bigint references sms_campaign_recipients(id) on delete set null;
```

Safe; no backfill. Doc 02 §3 asks for `campaign_id` here.

**`sms_sent_log` keeps its flow-dedup job and loses its opt-out job.** The `(order_id, flow_type)` unique index that makes `sendAndLog()` race-safe is genuinely good and stays exactly as it is. What moves out is the `flow_type='opted-out'` sentinel. Because there are **0 such rows** (verified), this migration is a code change with no data migration — but the code change is on the live send path and is ranked first in §10.

### 4.5 `call_logs` (115 rows)

```sql
alter table call_logs add column if not exists answered_by_user_id  bigint references sms_users(id) on delete set null;
alter table call_logs add column if not exists initiated_by_user_id bigint references sms_users(id) on delete set null;
```

Safe; no backfill possible. Doc 06 §2.6 Stage 5 notes these cannot be reliably populated until per-agent SIP credentials exist — one shared SIP credential is handed to every iPhone today, so "Dominic answered" is unknowable at the telephony layer. Until then, populate `initiated_by_user_id` from the authenticated caller on `POST /api/voice/logs`, which is a weaker but legitimate interim signal, and leave `answered_by_user_id` NULL rather than guessing.

### 4.6 `sms_orders` (1,497 rows) — no changes

Nothing is required. Attribution joins on `sms_orders.id` (uuid PK) and `woo_order_id`, both of which exist. `contact_phone` has zero orphans.

Two things were considered and rejected: `is_renewal boolean` (doc 05 §5.4 hard-excludes subscription renewals from attribution, but Woo Subscriptions is not in use at Vici and there is no signal to populate it from — add it when there is) and `margin_cents` (COGS is not in the system; `sms_attributions.order_margin_cents` is nullable and the UI must say "revenue, not margin" until it is).

### 4.7 Tables deliberately left alone

`sms_customer_profiles` (1 row) and `sms_campaign_suggestions` (1 row) are the existing, unused AI tables. **Do not build on them and do not extend them.** They have one row each because `OPENROUTER_MODEL` 404s in production and because suggestions had nowhere to go. Both problems are fixed by this design having somewhere for output to go (`sms_campaigns.builder_state`, `sms_contact_metrics`), which makes the old tables redundant rather than salvageable. Leave them in place, unread, and drop them in a later cleanup once nothing references them.

`session` (legacy, empty, unused since the move to `cookie-session`) can be dropped at any time; it is not worth a migration slot.

---

## 5. The segment membership model

### 5.1 The question, answered directly

**Can one contact be in multiple segments simultaneously? Yes, and the design must assume it.** The working hypothesis in the brief — *membership overlaps freely, conflicts resolve at send time via campaign priority plus a per-contact frequency cap, not by forcing segment exclusivity* — is **validated**. Here is the argument, and then the refutation of the alternative.

### 5.2 Why exclusivity is refuted

**On the data.** 166 of 477 buyers have ≥2 valid orders. A contact with 4 orders totalling $900, last purchased 55 days ago against a personal 30-day interval, is genuinely and simultaneously: a `champion` on RFM, `repeat_overdue` on lifecycle, `due_for_reorder` on replenishment, `engaged` if they have replied in 30 days, and `BPC-157 buyer` on affinity. Those are five true statements about one person. A model that forces you to pick one is a model that discards four facts.

**On the structure.** The segment dimensions are orthogonal by construction — doc 02 §3.3 says so explicitly of RFM and lifecycle. Orthogonal dimensions cannot be collapsed into one partition without taking a cross-product, and a 5×7×4 cross-product over 847 contacts produces cells of 6.

**On the mechanics.** Exclusivity requires a total order over segments. But the right order *changes per campaign*: for a replenishment send, "due for reorder" outranks "VIP"; for a new-product launch, "VIP" outranks "due for reorder". Encoding a fixed priority into the segment definition means re-partitioning the whole list every time a campaign is added. That is a segment model doing a scheduling model's job.

**On the failure mode.** Exclusivity fails *silently and in the wrong direction*. If a VIP is claimed by the replenishment segment, they are invisible to the VIP campaign, and nobody notices — because the count still looks plausible. Overlap plus a send-time cap fails *visibly*: the operator sees "22 frequency-capped" and can act on it. Doc 02 §3.6 makes this point in the exclusion context and it applies equally here.

**The one thing exclusivity gets right** — a person should not receive three marketing texts because they qualify for three campaigns — is a real problem. It is just not a segmentation problem. It is a *scheduling* problem, and solving it at the segment layer means solving it once, wrongly, forever.

### 5.3 Where membership is stored — the recommendation

**Hybrid, weighted heavily toward computed-on-read.** Three tiers:

| Tier | What | Storage | Why |
|---|---|---|---|
| 1 | Contact facts | `sms_contact_metrics` — **materialised table**, 847 rows, rebuilt nightly and on demand | Expensive to compute (JSONB unnest, window functions over 1,497 orders), cheap to store, changes slowly. |
| 2 | Segment membership | **Computed on read.** Never stored for dynamic segments. | Cheap to compute *given tier 1*: filter 847 in-memory rows. Changes constantly. Storing it means a staleness bug. |
| 3 | Campaign roster | `sms_campaign_recipients` — **materialised, frozen at build** | This is an audit record and an experiment log, not a cache. It must not change when the underlying facts change. |

**Justification at 847 contacts.** A `sms_segment_members` table for dynamic segments would hold, optimistically, 10 segments × ~200 contacts = 2,000 rows. Maintaining it requires either a refresh job (whose staleness window is a source of "why isn't this person in the segment" bugs) or triggers on `sms_orders` and `sms_messages` (which puts segment recomputation on the order-webhook hot path). The read it optimises — "who is in this segment" — is a filter over 847 rows that completes in under a millisecond in memory. **You would be adding a cache, a refresh job, and a staleness class of bug to speed up an operation that is already instant.**

The threshold where this flips is roughly 50,000 contacts, where the metrics snapshot stops fitting comfortably in a request's memory. That is 59× the current list. Revisit then; note it in a table comment.

**Where the hypothesis needs one amendment.** The brief says conflicts resolve at send time "via campaign priority plus a per-contact frequency cap". Both are necessary; neither is sufficient on its own. Priority alone lets the highest-priority campaign consume every contact's whole budget. A cap alone resolves ties arbitrarily (whichever campaign the scheduler happens to reach first), which produces non-deterministic, unexplainable outcomes. The resolution must be **priority-ordered greedy allocation under a per-contact budget**, and the losers must be *recorded* as `send_status='suppressed', suppression_reason='lost_priority'`, not silently dropped. Recording the loss is what makes it explainable.

### 5.4 The send-time gate

One function, one round trip, matching the `increment_unread` RPC precedent. Returns `NULL` if sendable, otherwise the blocking reason.

```sql
create or replace function sms_send_block_reason(
  p_phone         text,
  p_scope         text default 'marketing',      -- 'marketing' | 'transactional'
  p_campaign_id   bigint default null,
  p_ignore_soft   boolean default false          -- a logged human override; hard blocks ignore it
) returns text
language plpgsql stable as $$
declare
  v_caps        jsonb;
  v_cap         integer;
  v_tier        text;
  v_cooldown    integer;
  v_recent_days integer;
  v_reason      text;
begin
  -- ── HARD 1: explicit operational suppression (never overridable) ──────────
  select s.reason into v_reason
    from sms_suppressions s
   where s.contact_phone = p_phone
     and s.released_at is null
     and (s.scope = 'all' or s.scope = p_scope)
   limit 1;
  if v_reason is not null then return v_reason; end if;

  -- ── HARD 2: consent. Absence of a grant is a block, not a pass. ───────────
  if not exists (
    select 1 from sms_consent_state cs
     where cs.contact_phone = p_phone
       and cs.scope = p_scope
       and cs.status = 'granted'
  ) then
    return case when p_scope = 'marketing'
                then 'no_marketing_consent'
                else 'no_transactional_consent' end;
  end if;

  -- Transactional messages stop here: order confirmations, shipping updates,
  -- back-in-stock and replies in an open conversation are exempt from the
  -- budget (doc 02 §4.2).
  if p_scope = 'transactional' then return null; end if;

  select value into v_caps from sms_settings where key = 'frequency_caps';
  select engagement_tier into v_tier from sms_contact_metrics where contact_phone = p_phone;
  v_cap      := coalesce((v_caps ->> coalesce(v_tier,'unengaged'))::int, 2);
  v_cooldown := coalesce((v_caps ->> 'cooldown_hours')::int, 48);
  select coalesce((value)::int, 10) into v_recent_days
    from sms_settings where key = 'recent_purchaser_days';

  -- ── SOFT: overridable by a human, and the override is logged ──────────────
  if not p_ignore_soft then

    if v_cap = 0 then return 'fatigue_hold'; end if;

    if (select count(*) from sms_messages m
         where m.contact_phone = p_phone
           and m.direction = 'outbound'
           and m.message_class = 'marketing'
           and m.created_at > now() - interval '30 days') >= v_cap then
      return 'frequency_cap';
    end if;

    if exists (select 1 from sms_messages m
                where m.contact_phone = p_phone
                  and m.direction = 'outbound'
                  and m.message_class = 'marketing'
                  and m.created_at > now() - make_interval(hours => v_cooldown)) then
      return 'cooldown';
    end if;

    if exists (select 1 from sms_orders o
                where o.contact_phone = p_phone
                  and o.status in ('processing','completed','shipped','delivered')
                  and o.created_at > now() - make_interval(days => v_recent_days)) then
      return 'recent_purchaser';
    end if;

    if exists (select 1 from sms_scheduled s
                where s.phone = p_phone
                  and s.status = 'pending'
                  and s.send_at > now()) then
      return 'in_active_flow';
    end if;
  end if;

  -- ── HARD 3: Florida statutory cap — 3 contact attempts per rolling 24h,
  --            across all sending numbers (doc 02 §4.3). Not overridable.
  if exists (select 1 from sms_contacts c
              where c.phone = p_phone and c.state = 'FL')
     and (select count(*) from sms_messages m
           where m.contact_phone = p_phone
             and m.direction = 'outbound'
             and m.created_at > now() - interval '24 hours') >= 3 then
    return 'fl_daily_cap';
  end if;

  return null;
end;
$$;
```

Quiet hours are deliberately **not** in this function. They depend on `recipient_local_time`, which the caller computes and stamps onto `sms_messages.recipient_local_time` as the audit artefact. Putting the clock inside a `stable` SQL function would make its result non-reproducible for the same inputs, which is exactly what you do not want in the function that decides whether a send is legal.

Call sites, all three of which must change:

| Call site | Today | After |
|---|---|---|
| `routes/send.js:22` | `if (await isOptedOut(to))` | `sms_send_block_reason(to, 'transactional')` — an operator reply in an open conversation is conversational, not marketing |
| `flows/utils.js:84` (`sendAndLog`) | `if (await isOptedOut(phone))` | `sms_send_block_reason(phone, 'transactional')` |
| campaign sender (new) | — | `sms_send_block_reason(phone, 'marketing', campaignId, override)` |

`flows/utils.js:isOptedOut()` and `markOptedOut()` become thin wrappers over the new tables so that nothing outside `flows/utils.js` has to change in the same release. That is what makes the riskiest change in the plan a one-file change.

Bulk preview (the builder needs 847 answers at once, not 847 round trips):

```sql
select c.phone, sms_send_block_reason(c.phone, 'marketing') as block_reason
  from sms_contacts c
 where c.archived_at is null;
```

847 invocations of a stable function over indexed lookups. Tens of milliseconds. Good enough that no caching layer is justified.

### 5.5 Contention resolution across campaigns

When several approved campaigns want the same contact on the same day:

```sql
with candidates as (
  select r.id, r.campaign_id, r.contact_phone,
         c.priority,
         row_number() over (
           partition by r.contact_phone
           order by c.priority desc, c.scheduled_at asc, c.id asc
         ) as rank
    from sms_campaign_recipients r
    join sms_campaigns c on c.id = r.campaign_id
   where r.send_status = 'pending'
     and r.arm = 'treatment'
     and c.status = 'scheduled'
     and c.scheduled_at::date = current_date
)
update sms_campaign_recipients r
   set send_status = 'suppressed',
       suppression_reason = 'lost_priority'
  from candidates x
 where r.id = x.id and x.rank > 1;
```

Deterministic (`c.id` breaks any remaining tie), explainable, and it leaves a row behind saying what happened. Doc 02 §4.2's expected-value ranking (`p_flow × AOV_segment × (1 − haircut)`) is the *right* long-run objective and the wrong thing to ship first — it requires per-flow conversion estimates we do not have at 847 contacts. `priority` is an integer a human sets, and the schema does not prevent replacing the ordering expression later.

---

## 6. Dynamic vs. static segments — how a definition is stored

### 6.1 The three candidates, weighed

| Option | Safety | Expressiveness | "Who is in this right now" | Verdict |
|---|---|---|---|---|
| **Stored SQL** (`segment.sql_text`) | **Fails.** Arbitrary SQL from a UI against a service-key connection. An LLM writes this SQL. `DROP TABLE` is one hallucination away. | Total | Instant | **Rejected outright.** Not mitigable — there is no safe way to let a service-key connection run untrusted SQL. |
| **Named predicate + params** (`predicate_key='due_for_reorder', params={days:7}`) | Perfect — the SQL is in the repo and code-reviewed | Poor. Every new question needs a deploy. No ad-hoc AND/OR. | Instant | **Kept as an escape hatch**, not the primary mechanism. |
| **JSON rule tree** over a whitelisted field catalogue | Good, if literals are never interpolated | Good — nested AND/OR/NOT over ~35 named fields | Instant | **Recommended.** |

### 6.2 The recommendation

**Store a JSON rule tree in `sms_segments.rules`. Evaluate it in Node against the in-memory `sms_contact_metrics` snapshot. Do not compile it to SQL.**

The unusual half of that is not compiling to SQL, so here is the argument. Compiling to SQL — whether to a parameterised statement or to a PostgREST `or=(and(...))` filter string — reintroduces exactly the injection surface the rule tree was meant to remove. PostgREST's nested filter syntax is a string grammar where commas and parentheses are structural: a segment named after a product with a comma in it is a parser bug at best. And a generic `exec_sql(text)` RPC is stored SQL wearing a hat.

Evaluating in JavaScript removes the question entirely. There is no SQL, so there is no SQL injection. The evaluator is ~50 lines of pure function over a whitelisted field catalogue, is unit-testable without a database, and runs identically in the preview endpoint and the roster builder — which means the preview cannot disagree with the send, a class of bug that eats a lot of trust.

The cost is that a segment cannot participate in a SQL JOIN. That cost is zero here: rosters are written row by row into `sms_campaign_recipients` anyway, and all reporting joins through that table.

**The ceiling, stated plainly:** the full `sms_contact_metrics` snapshot is 847 rows × ~40 columns ≈ 300 KB. This approach is comfortable to roughly 50,000 contacts. Above that, compile the same rule tree to parameterised SQL — the tree is the durable artefact and the evaluator is the swappable part. Put that sentence in a comment on `sms_segments`.

### 6.3 The rule grammar

```jsonc
{
  "version": 1,
  "op": "and",
  "children": [
    { "field": "lifecycle_stage",     "cmp": "in",     "value": ["repeat_overdue", "repeat_lapsed"] },
    { "field": "revenue_total_cents", "cmp": "gte",    "value": 50000 },
    { "field": "reorder_overdue_days","cmp": "between","value": [0, 21] },
    { "op": "not", "children": [
      { "field": "top_sku", "cmp": "eq", "value": "BPC157-5MG" }
    ]}
  ]
}
```

- **Nodes** are either a group (`op` ∈ `and`|`or`|`not`, plus `children`) or a leaf (`field`, `cmp`, `value`).
- **Fields** must be a key in the field catalogue, which is a hand-maintained map from rule-field name → column on `sms_contact_metrics` (or `sms_contacts`) + type + allowed comparators. An unknown field is a validation error, not a fallthrough.
- **Comparators** by type: numbers/dates get `eq neq lt lte gt gte between is_null is_not_null`; strings get `eq neq in not_in contains starts_with is_null is_not_null`; booleans get `is_true is_false`; arrays (`skus`) get `contains_any contains_all`.
- **Relative dates**: `{"field":"last_order_at","cmp":"lt","value":{"relative_days":-60}}` — resolved against `now()` at evaluation time. Never store a computed absolute date in a definition; a segment that silently stops matching in March is worse than one that errors.
- **Limits**: max depth 5, max 25 leaves. Enforced on save, not just on evaluate.
- **Validation on write** is a hard requirement. An invalid tree must be rejected at `PUT /api/segments/:id`, not discovered at send time.

The AI wizard emits this JSON, never SQL. That is the point: the model's output is constrained to a grammar that cannot express anything destructive, and the worst a hallucinated rule can do is select the wrong people — which the mandatory human audience approval (`sms_campaigns.approved_before_scheduled`) then catches.

### 6.4 The three kinds

- **`dynamic`** — a rule tree. Re-evaluated every time it is read. The default and the overwhelming majority.
- **`static`** — an explicit member list in `sms_segment_members`. For an imported list, a hand-picked group, or a wholesale-accounts exclusion the operator maintains by hand. Note that a static segment carries doc 03 §8.4 S7's obligation: a first send to an externally-imported list needs a named human attestation of consent provenance, which lands in `sms_consent_events` with `channel='import'`, `consent_type='client_attested'`.
- **`predicate`** — a named function registered in code. Needed for the handful of definitions the rule tree cannot express because they are algorithms, not filters. Exactly one is required at launch: **`due_for_reorder`**, whose logic (log-space median interval, MAD dispersion, empirical-Bayes shrinkage toward a cohort ladder, plus a dose-based estimator for single-order customers — doc 02 §2.2) is a computation, not a predicate. It writes its answer into `sms_contact_metrics.predicted_reorder_at`, and the rule tree can then filter on that column like anything else. Which means, pleasingly, that even the escape hatch mostly resolves back into the rule tree.

---

## 7. The attribution chain

### 7.1 The chain, with exact join keys

```
sms_campaigns.id
   └─(campaign_id)→ sms_campaign_recipients.id
          ├─ contact_phone ──────────────→ sms_contacts.phone            (E.164, both sides)
          ├─ sms_message_id ─────────────→ sms_messages.id
          ├─ link_token ─── in the URL ──→ sms_link_clicks.recipient_id
          └─(recipient_id)→ sms_link_clicks.id  ── the uuid in ?vk= and the cookie
                 └─(click_id)→ sms_attributions
                        ├─ order_id ─────→ sms_orders.id          (uuid PK — referential integrity)
                        ├─ woo_order_id ─→ sms_orders.woo_order_id (integer — external correlation)
                        ├─ contact_phone → sms_contacts.phone
                        └─ call_log_id ──→ call_logs.id
```

| From | To | Key | Note |
|---|---|---|---|
| `sms_campaign_recipients` | `sms_contacts` | `contact_phone = phone` | Text E.164. 0 orphans verified. |
| `sms_campaign_recipients` | `sms_messages` | `sms_message_id = id`, fallback `telnyx_message_id` | Both stored; the id is authoritative. |
| `sms_link_clicks` | `sms_campaign_recipients` | `recipient_id = id`, resolved from `link_token` in the URL path | |
| `sms_attributions` | `sms_orders` | `order_id = id` **and** `woo_order_id = woo_order_id` | Both, deliberately. §7.4. |
| `sms_attributions` | `sms_link_clicks` | `click_id = id` | The uuid in the cookie / `?vk=` param. |
| `sms_attributions` | `call_logs` | `call_log_id = id` | Grade E only. |
| `sms_orders` | `sms_contacts` | `contact_phone = phone` | Existing. 0 orphans. |

### 7.2 The evidence-grade cascade, and what ships first

| Order | Method | Grade | Ships in Phase 2? |
|---|---|---|---|
| 1 | `order.meta._vk_click_id` → `sms_link_clicks.id` | A | **No — blocked.** Requires a WooCommerce-side snippet writing checkout meta. |
| 2 | Unique per-recipient coupon → `sms_campaign_recipients.coupon_code` | C | Optional. Needs coupon generation in Woo. |
| 3 | **Phone identity** — `sms_orders.contact_phone = recipient.contact_phone`, with a recorded non-bot click in window | **B** | **Yes. This is the workhorse.** |
| 4 | Email identity — via `sms_contacts.email`, 827/847 coverage | B | Yes, as a secondary. |
| 5 | Woo customer id — `sms_contacts.woo_customer_id` | B | Yes, for logged-in customers. |
| 6 | Exposure only — delivered, no click, order in window | D | Table supports it; **off by default**, separate line, never in a headline. |
| 7 | Operator-declared / call-assisted | E | Yes — cheap, and the reply-to-sale path is the most common real conversion at Vici. |

**The Grade A dependency is the most important practical finding in this section.** Doc 05 §4.1 designs the whole click path around a checkout meta field and a storefront JS snippet, neither of which lives in this repo. Both are plausible asks of the client's WooCommerce install and neither is on our critical path. Grade B via phone identity needs **nothing** on the store side: `sms_orders.contact_phone` is already populated by `sync-woocommerce.js:9` through `normalizePhone()`, and 0 of 1,497 orders have a phone that is missing from `sms_contacts`. So the sequencing is: ship Grade B, ship the redirector, ship Grade A when the snippet lands.

Doc 05 §4.3's warning about phone normalisation is already satisfied — `normalizePhone()` in `woocommerce.js` and `formatPhone()` in `flows/utils.js` are both in the path, and the new CHECK constraint in §4.1 makes bad data impossible going forward.

### 7.3 The last-click query, corrected

Doc 05 §4.5's Grade B query, adapted to the real schema (`sms_orders.id` is a uuid; `sms_campaigns` gains a `status` guard; holdouts and voided rows excluded):

```sql
insert into sms_attributions (
  order_id, woo_order_id, contact_phone, campaign_id, recipient_id, click_id,
  channel, grade, match_method, order_total_cents, ordered_at, touch_at,
  window_hours, is_repeat_buyer
)
select distinct on (o.id)
  o.id,
  o.woo_order_id,
  o.contact_phone,
  r.campaign_id,
  r.id,
  cl.id,
  'sms_campaign',
  'B',
  'phone_identity',
  round(o.total * 100)::int,
  o.created_at,
  cl.clicked_at,
  c.attribution_window_hours,
  coalesce(m.orders_valid, 0) >= 2
from sms_orders o
join sms_campaign_recipients r  on r.contact_phone = o.contact_phone
join sms_campaigns           c  on c.id = r.campaign_id
join sms_link_clicks        cl  on cl.recipient_id = r.id and cl.is_bot = false
left join sms_contact_metrics m on m.contact_phone = o.contact_phone
where r.arm = 'treatment'
  and r.send_status in ('sent','delivered')
  and o.created_at >  cl.clicked_at
  and o.created_at <= cl.clicked_at + make_interval(hours => c.attribution_window_hours)
  and o.status not in ('cancelled','failed','refunded')
order by o.id, cl.clicked_at desc          -- LAST click within the window wins
on conflict (order_id, campaign_id, channel, match_method) do nothing;
```

`distinct on (o.id) … order by o.id, cl.clicked_at desc` is the literal implementation of "last click within window". Grade A runs first when it exists; its rows occupy a different `match_method` so the unique constraint does not suppress the Grade B row — which is correct, because both claims are true and the *reporting* layer picks the best grade per order, not the writer. Reporting rule:

```sql
select distinct on (order_id) *
  from sms_attributions
 where voided_at is null
 order by order_id, grade asc;   -- 'A' < 'B' < 'C' < 'D' < 'E'
```

**Refund reconciliation**, nightly (doc 05 §4.5):

```sql
update sms_attributions a
   set voided_at = now(), void_reason = 'order_' || o.status
  from sms_orders o
 where o.id = a.order_id
   and a.voided_at is null
   and o.status in ('refunded','cancelled','failed');
```

Every rollup filters `voided_at is null`. At Vici this matters more than usual: 194 cancelled + 66 failed + 1 refunded out of 1,497 orders is 17% of the table.

### 7.4 Why both `order_id` and `woo_order_id`

- `order_id uuid → sms_orders(id)` is the real primary key, so the FK is guaranteed valid and `on delete cascade` is meaningful.
- `woo_order_id integer` is what every external system speaks — the Woo webhook payload, the client's admin screen, ShipStation, and any CSV that ever leaves this system. Reporting joins and human debugging both go through it.

Carrying both is one redundant integer per attribution row and it removes an entire class of "which order is 4097" confusion. Doc 05 carries only `woo_order_id` and types it as the FK target; that is not possible against the live schema without first confirming the UNIQUE constraint from `scripts/add-woo-order-unique.sql` was actually applied — which is itself an open question given two other migrations were forgotten. §3.15 includes the verification query.

### 7.5 The refusal list stands

Doc 05 §5.5's nine refusals are adopted verbatim and the schema supports enforcing them: holdout arms are excluded by `r.arm = 'treatment'`; bot clicks by `cl.is_bot = false`; pre-delivery orders by the `o.created_at > cl.clicked_at` predicate; coupon leaks by a `redemption_count > issued_count` check the coupon path must run before writing Grade C. Subscription renewals are the one refusal with no enforcement mechanism today, because there is no renewal signal in `sms_orders` — noted in §4.6 as a column to add when Woo Subscriptions appears.

---

## 8. Users, roles, and the two logs

Covered structurally in §3.3, §3.4, §3.16, §3.17. Three points that belong here:

**The split is not optional.** `sms_activity_events` is mutable (`batch_count` increments in place), curated, 90-day. `sms_audit_log` is trigger-enforced append-only, exhaustive, 5-year-plus. Doc 06 §6.1 shows every mature product in the category ships both with a 3×–12× retention gap. Merging them means inheriting the longest retention for the noisiest data *and* losing append-only, and losing append-only is the whole point of the audit log.

**Retention split by action class, not one window.** Doc 06 §6.6 is right that consent, opt-out and send events must be kept 5+ years (47 CFR 64.1200(d)(6)), while a "Dominic opened a conversation" row is worthless after a month. Because `sms_consent_events` is its own table with its own immutability trigger, the split is structural rather than a `WHERE action IN (...)` in a delete job — which is a better place for it, because a delete job with a filter is a delete job someone will eventually get wrong.

**Actor columns added to existing tables** (all in §4): `sms_messages.actor_user_id`, `sms_scheduled.cancelled_by` + `cancelled_at`, `call_logs.answered_by_user_id` + `initiated_by_user_id`, `sms_settings.updated_by`, `sms_segments.created_by`/`updated_by`, `sms_campaigns.created_by`/`approved_by`, `sms_suppressions.suppressed_by`/`released_by`, `sms_campaign_recipients.suppression_overridden_by`, `sms_campaign_test_sends.sent_by`. That closes most of doc 06 §1.6's sixteen actor-less sites. The ones it cannot close are the voice ones, which are blocked at the telephony layer by the shared SIP credential (§4.5).

**Migration without lockout** follows doc 06 §2.6 unchanged: add before switching, attribute the shared password to a `is_legacy_shared` placeholder user so the feed is useful from day one, migrate the two humans on web, then iOS, then per-agent SIP, then retire the shared password. Stages 1–3 need no iOS release, which matters because the iOS build pipeline is the slowest thing in the estate and this Mac cannot even build it.

---

## 9. Migration plan

### 9.1 Naming

Existing scripts have no ordering convention (`add-optout-column.sql`, `voice-migration.sql`, …), which is part of why two were lost. Phase 2 files use a sortable prefix and live alongside them:

```
scripts/P2-01-migration-ledger.sql
scripts/P2-02-consent-and-suppression.sql
scripts/P2-03-identity.sql
scripts/P2-04-contact-metrics-and-segments.sql
scripts/P2-05-campaigns.sql
scripts/P2-06-attribution.sql
scripts/P2-07-activity-and-audit.sql
```

Every file: idempotent (`if not exists` throughout), ends with its `schema_migrations` insert, ends with `notify pgrst, 'reload schema';`.

### 9.2 The seven files

| # | File | What it does | Reversible? | Run while live? | Rollback |
|---|---|---|---|---|---|
| **01** | `P2-01-migration-ledger.sql` | `schema_migrations`; `sms_settings` + seed rows; backfill ledger rows for the 19 pre-existing scripts (marking `ios-push-devices-migration.sql` and `add-optout-column.sql` as **not** applied). | Yes — `drop table` | **Yes.** Nothing reads it yet. | Drop both tables. |
| **02** | `P2-02-consent-and-suppression.sql` | `sms_consent_events` (+ immutability trigger), `sms_consent_state` (+ apply trigger), `sms_suppressions`, `sms_send_block_reason()`; the 847-contact consent backfill (§9.4). | **Partly.** Tables drop cleanly; the ledger rows are append-only by trigger and would need the trigger disabled to remove. | **Yes, and it must run before any code reads it.** Deploy order: SQL first, then code. Nothing existing queries these tables. | Drop the three tables and the function. `flows/utils.js` still reads `sms_sent_log` until the code change ships, so the old path is intact throughout. |
| **03** | `P2-03-identity.sql` | `sms_users`, `sms_user_devices`; actor columns on `sms_messages`, `sms_scheduled`, `call_logs`; copy the 6 `push_subscriptions` rows into `sms_user_devices` with `user_id = null`; create the `is_legacy_shared` "Team" user. | Yes — drop tables, drop columns | **Yes.** All added columns are nullable; `push_subscriptions` is copied, not moved, so push keeps working from the old table until the code switches. | Drop the two tables; the added columns are inert if unused. |
| **04** | `P2-04-contact-metrics-and-segments.sql` | `sms_contact_metrics`, `refresh_sms_contact_metrics()`, `sms_segments`, `sms_segment_members`; seed the system segments; run the first full refresh; `sms_contacts` timezone/archived/E.164 changes. | Yes | **Yes.** The first refresh is a ~100ms full rebuild over 847×1,497 rows. | Drop the tables and function; drop the three `sms_contacts` columns and the CHECK. |
| **05** | `P2-05-campaigns.sql` | `sms_campaigns`, `sms_campaign_variants`, `sms_campaign_recipients`, `sms_campaign_test_sends`; campaign/consent/encoding columns on `sms_messages`; campaign columns on `sms_scheduled` and `sms_sent_log`; backfill `sms_scheduled.message_class='transactional'` (602 rows). | Yes | **Yes**, with one caveat: after this file the `db.js` `PGRST204` fallback must not be relied on for the new `sms_messages` columns (§4.2). Run SQL **before** deploying code that writes them. | Drop the four tables; the added columns are inert. The 602-row backfill is a single reversible `UPDATE`. |
| **06** | `P2-06-attribution.sql` | Verify the `sms_orders.woo_order_id` UNIQUE constraint; `sms_link_clicks`, `sms_attributions`. | Yes | **Yes.** No existing table is touched except the verification read. | Drop both tables. |
| **07** | `P2-07-activity-and-audit.sql` | `sms_activity_events`, `sms_audit_log` (+ immutability trigger + grants). | Yes for the feed; the audit log needs the trigger dropped first. | **Yes.** Nothing reads them until the code ships. | Drop the feed table; for the audit log, drop the trigger then the table. |

**Ordering rationale.** 02 is second, ahead of identity, because it is the most urgent item in the whole plan and it does not need users (`actor_label text` carries the actor until `sms_users` exists, and `actor_user_id` is nullable). 03 before 04–07 because every subsequent table has a `created_by`. 06 after 05 because attribution FKs into recipients. 07 last because it is the only one with no downstream dependents.

**Each file is independently deployable and independently valuable.** 02 alone fixes the single most serious defect in the system (doc 00 §8) and can ship with nothing else.

### 9.3 Tracking what has been applied

Three layers, cheapest first:

1. **The ledger row is inside the migration file.** No separate step. Pasting the file records it.
2. **A startup check that is loud.** A new `lib/migration-check.js` reads `scripts/P2-*.sql` filenames from disk, queries `schema_migrations`, and logs the diff at boot. Shore Academy already has `lib/startup-check.js` — the pattern exists in the estate, it is just not in Vici. Behaviour: warn always; hard-fail only when `MIGRATIONS_STRICT=1`, which should be set on Railway once the two known-missing legacy migrations are resolved. The reason for the escape hatch is that a boot loop on a production inbox is worse than a missing index.
3. **A `GET /api/health/migrations` endpoint** returning `{applied, pending}`. Ten lines, and it turns "did we run that?" into a URL instead of a memory.

Also seed the ledger in file 01 with the 19 pre-existing scripts, marking the two known-missing ones as absent. That converts an oral tradition into a row.

Explicitly **not** recommended: adopting a migration tool (node-pg-migrate, Sqitch, Supabase CLI migrations). They all need a `DATABASE_URL` that does not exist in this deployment, and `scripts/run-migration.js` already tried that path and was abandoned for the same reason. The ledger plus a startup check gets ~90% of the value for ~2% of the change surface. Revisit when the fork question is settled and there is a CI pipeline to hang it on.

### 9.4 The consent backfill — the honest version

This is the part of the plan most likely to be got wrong, so it is spelled out.

**What must not happen:** inserting 847 rows asserting `express_written` consent. There is no evidence for it. Writing a consent record you cannot substantiate is not a backfill, it is fabricating the exhibit, and it is worse than having no record because it is discoverable.

**What the backfill does:**

| Cohort | Count | Grant | Consent type | Channel | `occurred_at` |
|---|---|---|---|---|---|
| Has ≥1 valid order | 477 | `transactional` only | `unverified_legacy` | `checkout` | first valid order date |
| No order, has ≥1 inbound message | (subset of 370) | `transactional` only | `implied` | `inbound_sms` | first inbound message |
| Neither | remainder | **nothing** | — | — | — |
| Marketing scope | **0 contacts** | — | — | — | — |

`disclosure_text` stays NULL. `actor_label = 'backfill:P2-02'`. Every row is honest about being weak.

**The consequence, stated plainly: after this backfill, zero contacts are eligible for a marketing send.** The five existing order-triggered flows keep working, because they are transactional. Nothing else can go out.

That is a correct result and it is also a business problem, so here are the two paths out, both of which are decisions for the client and their counsel, not for a data-model document:

- **(a) Client attestation.** A named person at Vici states in writing that the checkout collected SMS marketing consent, and supplies the disclosure copy and a screenshot of the form as it stood. That becomes 477–847 `consent_type='client_attested'` rows with `actor_user_id` set to the attesting user, `evidence_uri` pointing at the screenshot, and `disclosure_text` set to the copy they supply. It is a weaker basis than express written consent and the schema records exactly how weak and exactly who is standing behind it.
- **(b) Re-permission.** A service message with a clear opt-in CTA, tracked, granting `marketing` on reply. Note the genuine catch-22 doc 03 does not resolve: a re-permission message sent to someone with no marketing consent is arguably itself a marketing message. Path (a) is likely the pragmatic answer with (b) as a top-up for the long tail.

**Flagged as unresolved.** I am not confident which of (a) or (b) is correct and this document should not pretend otherwise. What the *data model* must do is make either representable, make the weakness visible, and make it impossible for the system to send marketing to someone with no row at all. It does all three.

---

## 10. Risk register

Ranked by expected damage × likelihood. The top three all touch the live send path.

### R1 — Rewriting `flows/utils.js:isOptedOut()` breaks five live order flows
**Severity: critical. Likelihood: moderate.**
`isOptedOut()` gates `sendAndLog()`, which is the single Telnyx call site for `confirmed.js`, `shipped.js`, `hold.js`, `failed.js` and the scheduled-queue processor — 1,151 sends of history and a real store's order confirmations. If the new gate returns a block where the old one did not, order confirmations stop silently, and nobody notices because the failure is a `return false` and a log line.

*Mitigations, all of which should be done:* (1) `sendAndLog` calls `sms_send_block_reason(phone,'transactional')`, and the transactional path short-circuits after the two hard checks — it never touches frequency caps, cooldowns or recent-purchaser. (2) Backfill `transactional` consent for all 477 buyers **in the same migration file** that creates the tables, so the grant exists before any code reads it. (3) Ship a shadow release first: compute the new reason, log it, but keep gating on the old `isOptedOut()`. Compare for one week. Since only 1 outbound message was sent in the last 30 days, a week of shadow costs almost nothing in elapsed learning — which argues for a longer shadow, or for driving synthetic traffic through it. (4) Keep `isOptedOut()` as the exported name so exactly one file changes.

### R2 — `db.js` PGRST204 fallback silently drops compliance columns
**Severity: critical. Likelihood: moderate-high.**
Detailed in §4.2. The fallback's hardcoded `MIGRATION_COLUMNS` list plus a well-meaning "just add the new columns to the list" fix produces messages sent with no `consent_event_id` and no `suppression_checked_at` — the two fields whose only job is to prove the check ran. The failure is silent and produces a *gap in the audit trail*, which is the worst possible shape of bug for this feature.

*Mitigation:* a comment in `db.js` naming the two columns as never-strippable, and a startup assertion that both columns exist before the process accepts traffic. Run P2-05 before deploying any code that writes them.

### R3 — PostgREST schema cache hides new tables
**Severity: high. Likelihood: high if not handled.**
`supabase-js` goes through PostgREST, which caches the schema. A new table or column can exist in Postgres and be invisible to the app, producing `PGRST205`/`PGRST204` with a confusing message. This has already happened in a sibling project (an `engine_config` table that existed but could never be read through PostgREST, forcing a workaround).

*Mitigation:* `notify pgrst, 'reload schema';` as the final statement of every migration file, and a post-migration smoke check that selects one row from each new table through the client, not through the SQL editor.

### R4 — Consent backfill locks out marketing, or is done dishonestly to avoid that
**Severity: high (either way). Likelihood: high.**
§9.4. Under-granting stops the product; over-granting fabricates evidence. There is real pressure toward the second and it must be resisted structurally, not by good intentions.

*Mitigation:* `consent_type` is a CHECK-constrained enum with no `express_written` value reachable by the backfill script; granting it requires an insert with `disclosure_text` and either `evidence_uri` or `ip_address`. Make the honest path the easy path.

### R5 — `on delete restrict` on `sms_campaign_recipients.contact_phone` breaks a delete path
**Severity: medium. Likelihood: low.**
Grep shows no contact-delete path exists today, but one will be written eventually, and it will error confusingly once rosters exist.

*Mitigation:* ship `sms_contacts.archived_at` in the same file (P2-04) and filter on it in the contact list query, so the archive path exists before anyone needs it.

### R6 — Double-send from two Railway instances
**Severity: high. Likelihood: low today, high if the app is ever scaled.**
Background jobs run in the web process with no locking (doc 00 §8). Today there is one instance. A campaign send is a much bigger blast radius than the existing queue, because it is 847 duplicate messages rather than one.

*Mitigation:* the conditional-update claim in §3.10 plus `unique (campaign_id, contact_phone)` on the roster makes a double-send structurally impossible for campaigns. Retrofitting the same pattern to `processScheduledQueue()` is a small, separate, worthwhile change.

### R7 — Segment preview disagrees with the actual send
**Severity: medium. Likelihood: medium.**
The classic campaign-tool bug: the preview says 137 and 119 go out, with no explanation. Causes: the preview reads `sms_contact_metrics`'s cached consent columns while the send reads the live tables; or the metrics snapshot is stale relative to the send.

*Mitigation:* (1) one evaluator function used by both paths (§6.2); (2) the preview shows the *live* `sms_send_block_reason` count, not the cached one, using the bulk query in §5.4; (3) `sms_contact_metrics.computed_at` is displayed in the builder UI with a refresh button; (4) the roster is frozen at build with its reasons, so any discrepancy is reconstructible after the fact.

### R8 — Timezone backfill from area code produces a quiet-hours violation
**Severity: high (statutory). Likelihood: low-medium.**
Doc 02 §6.3 is explicit that area code is a poor proxy for location, and doc 03 §4.4 notes quiet hours are genuinely unsettled law with FL/OK/OR stricter than federal. A contact with a 305 area code living in Seattle gets texted at 05:00 local.

*Mitigation:* `tz_source` records the weakness on every row; where `tz_source='area_code'` and the send would land in the first or last hour of the window, defer rather than send. Prefer `sms_contacts.state` (present on most order-derived contacts) over area code.

### R9 — Attribution overstates and the client believes it
**Severity: medium (commercial and reputational, not technical). Likelihood: high without deliberate design.**
Doc 05's entire thesis. The schema defends against it: `grade` is mandatory, `voided_at` handles refunds, exposure-only is grade D and off by default, `had_other_channel_touch` exists, and `is_repeat_buyer` is populated on every row. But a schema cannot stop a UI from summing all grades into one headline number.

*Mitigation:* a hard product rule that the headline number is grades A–C only, that D is a separate de-emphasised line, and that total store revenue is always shown as the denominator so a 60%-of-revenue claim is visibly absurd. That belongs in the UI spec, not here, but it is a data-model risk because the data model is what makes the bad number computable.

### R10 — 17 tables is a lot for a two-person team
**Severity: medium. Likelihood: certain.**
Simplicity is a stated requirement. Seventeen new tables is not, on its face, simple.

*Mitigation:* the seven-file split means no single deploy introduces more than four. Files 01–02 (four tables) deliver the highest-value item independently. Files 06–07 (four tables) can be deferred a month with no loss to campaigns. And §11 removes eleven tables that a naive reading of doc 05 and doc 06 would have added. The honest defence is that the count is the *floor*, not the design — each one was tested against "what breaks without it" and eleven others failed that test.

### R11 — `sms_orders.woo_order_id` UNIQUE constraint may not exist
**Severity: low. Likelihood: low.**
`scripts/add-woo-order-unique.sql` may have been forgotten like the other two. `sync-woocommerce.js:118` upserts with `onConflict:'woo_order_id'`, which would already be failing if it were missing, and 0 duplicates were observed — so it is very probably applied. But "very probably" is what was said about the other two.

*Mitigation:* the verification query in §3.15, run as the first statement of P2-06.

### R12 — Deferring `org_id` turns out to be wrong
**Severity: low. Likelihood: medium.**
If Phase 2 chooses multi-tenancy, every new table needs `org_id`.

*Mitigation:* at 847 contacts and a few thousand rows across all new tables, that is `ALTER TABLE … ADD COLUMN org_id uuid NOT NULL DEFAULT '<the-one-org>'` plus adding it to the leading position of ~12 indexes. An afternoon. Doing it now costs plumbing in every insert and every query for a decision not yet made. §11.6.

---

## 11. What NOT to build

Explicit rejections. Each names what proposed it and why it is premature at 847 contacts.

### 11.1 `sms_sessions` — rejected (doc 05 §4.5)
First-party session stitching between the redirector and the storefront. Requires a JS snippet on `vicipeptides.com` posting to a `/collect` endpoint. We do not control the storefront, the snippet is not on our critical path, and **without it the table holds zero rows**. Grade B phone-identity matching covers the cross-device case with no store change at all. Build the redirector; skip the session table until the snippet exists.

### 11.2 `sms_campaign_costs` — rejected as a table (doc 05 §4.5)
Six aggregate integers with a `campaign_id` primary key is a 1:1 table, which is four columns on `sms_campaigns` (§3.10). Doc 05 §6 computes the real number: one 390-person send costs **$4.12 total**, of which $2.75 is prorated fixed cost. Cost is not a variable worth a table at this scale — it is worth a column and a footnote.

### 11.3 `sms_experiment_snapshots` — rejected (doc 05 §4.5)
A nightly rollup of a holdout experiment. Doc 05's own maths says the programme-level holdout needs **~27 campaigns over six to fourteen months** before it says anything, and single-campaign holdouts are "theatre". A nightly snapshot table for a quantity that will be NULL for a year is a table that teaches the operator to ignore a screen. The same numbers compute on read from `sms_campaign_recipients` + `sms_attributions` in a single query whenever anyone asks. Build the query, not the table. Revisit when there are ≥10 campaigns with a real holdout.

### 11.4 `email_touches` — deferred (doc 05 §5.3)
Cross-channel overlap detection. Genuinely important — doc 05 §5.3's "total store revenue as the denominator" is the single best honesty mechanism in the research. But it needs a Klaviyo or Omnisend webhook, and **which email platform Vici runs, if any, is not established anywhere in the research or the codebase.** Do not build an ingestion table for a system we have not confirmed exists. `sms_attributions.had_other_channel_touch` is a boolean placeholder that costs nothing and can be populated the day the source appears.

### 11.5 Materialised dynamic-segment membership — rejected
§5.3. A cache, a refresh job and a staleness bug class, to accelerate a filter over 847 rows that is already sub-millisecond. Revisit at ~50,000 contacts.

### 11.6 `organisations` / `memberships` / `invitations` — deferred (doc 06 §2.5)
Doc 06's schema is correct for a multi-tenant product. This is a single-tenant deployment forked per client, and doc 00 §7 states the fork-vs-shared-core-vs-multi-tenant decision is unmade. Three tables and an `org_id` on every insert to model one organisation is speculative plumbing. `sms_users.role` covers the actual requirement (owner/admin/agent). Retrofit cost is quantified in R12: an afternoon. Also skipped: `invitations` — at two users, an admin creating an account directly is not a worse product, it is a smaller one.

### 11.7 A probabilistic device graph — rejected (doc 05 §4.3 rejects it too)
IP + user-agent fingerprint matching at n=847 produces false positives that swamp the signal, and it is a privacy liability in a vertical that already has an FDA overlay.

### 11.8 `sms_link_clicks.ip_asn` and datacenter-ASN bot filtering — rejected
Requires an IP-to-ASN service. The other five bot signals in doc 05 §4.4 need no external dependency. Add the lookup if bot clicks ever measurably distort a rate; at ~200 clicks per campaign it will be visible by eye first.

### 11.9 A predicted-LTV table or BG/NBD model — rejected (doc 02 §3.2)
Klaviyo requires 500+ customers with non-zero orders, 180+ days of history, and some customers with 3+ orders before it will turn predictive analytics on. Vici has 477 buyers, ~180 days of order history (Jan 18 → Jul 15), and 62 customers with 3+ orders. It fails the threshold Klaviyo sets for itself, on two of three criteria. `sms_contact_metrics` carries `revenue_total_cents` and `aov_cents` — observed value, labelled as observed. Revisit at ~2,000 customers with ≥400 repeat buyers.

### 11.10 A mined product-affinity / market-basket table — rejected (doc 02 §3.5)
26 SKUs and 738 valid orders. Every pair will look either always-co-occurring or never. Doc 02's recommendation — a hand-authored product-family adjacency map maintained by the client — is right, and it is a JSONB value in `sms_settings`, not a table.

### 11.11 A banned-words table — rejected (doc 01 §10)
The standard lists trace to vendor blogs citing vendor blogs. Carrier filtering is mostly infrastructure (branded short domain, campaign-type match, trust score); only 3 of 9 real factors touch copy. The compliance checks that *are* worth enforcing (doc 03 §8.2) are a fixed set of regexes in code, version-controlled and reviewable, not user-editable rows. A user-editable ruleset is also a user-disableable ruleset, which doc 03 §8.4 S9 explicitly forbids.

### 11.12 Partitioning, retention jobs, or archival infrastructure — rejected (doc 06 §6.7)
`sms_activity_events` grows ~3 MB/year. A single unpartitioned table serves past 50 million rows. Anyone proposing `pg_partman` here is optimising a problem three orders of magnitude away.

### 11.13 A separate `message_events` send log — rejected (doc 03 §5.6)
Doc 03 proposes it for the consent→send chain. We have it: `sms_messages`, 2,283 rows, already the universal outbound record, already written by every send path. Three added columns beat a parallel table that would diverge within a month.

### 11.14 A `sessions` table — rejected (doc 06 §2.5 also rejects it)
`cookie-session` is stateless; Supabase Auth manages its own. What a naive sessions table is usually a proxy for is a device registry, which is `sms_user_devices`.

### 11.15 Extending `sms_customer_profiles` / `sms_campaign_suggestions` — rejected
§4.7. One row each. They failed for reasons this design fixes elsewhere. Leave them; do not build on them.

### 11.16 A multi-step campaign approval workflow — rejected
`approved_by` + `approved_at` + `approval_note` + the audit log covers a two-person team. Approval chains, reviewer assignment and escalation are features for a client with a compliance department.

### 11.17 Things that only make sense above 100k contacts
Flagged so nobody proposes them by analogy with Attentive or Klaviyo: sharded or partitioned message storage; a real-time streaming segment engine (Kafka/Flink); a dedicated feature store; per-campaign incrementality tables; MMM (doc 05 §1.1 rules it out at any scale here — it needs 100+ periods); multi-armed bandit infrastructure for one-shot campaigns (doc 05 §3.4 — bandits work for flows with continuous arrivals, not for a 20-minute blast); predictive send-time optimisation per contact; and cross-client hierarchical pooling (doc 05 §3.5), which is genuinely the strongest structural argument for building a platform but needs J ≥ 5 clients before it estimates anything, and we have two.

---

## 12. Things I am not confident about

Stated rather than guessed, per the brief.

1. **Whether marketing consent can be established for the existing 847 at all.** §9.4. The data model supports both paths honestly; which is correct is a legal question and I would not want a UI built on an assumption either way.
2. **Whether Grade A attribution is achievable.** It depends on getting a snippet into a WooCommerce install we do not control. If the answer is no, Grade B via phone identity is the ceiling, and the ceiling is lower than doc 05 assumes.
3. **Whether the `sms_orders.woo_order_id` UNIQUE constraint exists.** Very probably yes; unverifiable through PostgREST without a SQL connection. R11.
4. **Whether `sms_contacts.phone` carries a UNIQUE constraint or only a unique index.** The `upsert(onConflict:'phone')` pattern works with either, but only a constraint can be an FK target. §4.1 includes the check; if it is only an index, one extra `ADD CONSTRAINT` is needed and it is safe at 847 rows.
5. **The right `priority` default and the eventual replacement of it with doc 02 §4.2's expected-value ranking.** An integer a human sets is defensible now; the EV formula needs per-flow conversion estimates the list is too small to produce. I do not know when that flips.
6. **Whether the holdout should be enabled at all in Phase 2.** The schema supports it (`holdout_pct`, `arm`, `randomisation_seed`, `pre_period_revenue_cents`) and the settings default it to 0/disabled, because doc 05's maths says a single-campaign holdout at this size is theatre and a 50/50 split costs half the reach for evidence that arrives in six to fourteen months. Turning it on is a product decision with a real cost. I have made the data model ready and the default off, and I think that is right, but it is a judgement call.
7. **Whether the email platform overlap problem is live.** §11.4.
8. **The performance of `sms_send_block_reason` invoked 847 times in one query.** I expect tens of milliseconds — every lookup is indexed — but I have not measured it, and `stable` function inlining behaviour in a `select` over `sms_contacts` is the kind of thing that is 10× off from intuition. Measure before putting it behind an interactive preview.

---

## Appendix A — Table inventory

| Table | New/Altered | Rows at launch | Grows with |
|---|---|---|---|
| `schema_migrations` | new | ~26 | migrations |
| `sms_settings` | new | 6 | rarely |
| `sms_users` | new | 3 | headcount |
| `sms_user_devices` | new | 6 | devices |
| `sms_consent_events` | new | ~600 (backfill) | consent acts; append-only forever |
| `sms_consent_state` | new | ~600 | contacts × 2 scopes |
| `sms_suppressions` | new | 0 | bounces + manual blocks |
| `sms_contact_metrics` | new | 847 | contacts (1:1) |
| `sms_segments` | new | ~8 seeded | operator |
| `sms_segment_members` | new | 0 | static segments only |
| `sms_campaigns` | new | 0 | ~2–4/month |
| `sms_campaign_variants` | new | 0 | 1–2 per campaign |
| `sms_campaign_recipients` | new | 0 | ~847 per campaign |
| `sms_campaign_test_sends` | new | 0 | a few per campaign |
| `sms_link_clicks` | new | 0 | ~10% of delivered |
| `sms_attributions` | new | 0 | ~2–5 per campaign |
| `sms_activity_events` | new | 0 | ~500/month; 90-day retention |
| `sms_audit_log` | new | 0 | ~100/month; 5-year retention |
| `sms_contacts` | +3 cols, +1 check | 847 | — |
| `sms_messages` | +10 cols | 2,283 | — |
| `sms_scheduled` | +8 cols | 602 | — |
| `sms_sent_log` | +2 cols | 1,151 | — |
| `call_logs` | +2 cols | 115 | — |

**Projected total growth: under 15,000 new rows in the first year at 4 campaigns/month.** Nothing in this design needs an index strategy more sophisticated than the btrees listed.

## Appendix B — Reconciliation summary against the research docs

| Doc 05 §4.5 proposal | Decision |
|---|---|
| `sms_campaigns` | Adopted, extended (approval, priority, message_class, autonomy_stage, cost columns) |
| `sms_campaign_variants` | Adopted as-is |
| `sms_campaign_recipients` | Adopted; `cascade`→`restrict` on contact; `rendered_body` added; no test arm |
| `sms_link_clicks` | Adopted; `ip_asn` dropped; `variant_id` added |
| `sms_sessions` | **Rejected** — §11.1 |
| `sms_attributions` | Adopted; FK corrected to `sms_orders(id)` uuid; `email_external` channel dropped; `voided_at` added |
| `sms_campaign_costs` | **Rejected as a table** → columns on `sms_campaigns`, §11.2 |
| `sms_experiment_snapshots` | **Rejected** → compute on read, §11.3 |

| Doc 03 §5.6 proposal | Decision |
|---|---|
| `consent_events` | Adopted as `sms_consent_events`; `disclosure_text` made nullable for the honest backfill; `client_attested` / `unverified_legacy` types added |
| `suppressions` | Split into `sms_consent_state` (consent status) + `sms_suppressions` (operational blocks) |
| `message_events` | **Rejected as a new table** → three columns on `sms_messages`, §11.13 |

| Doc 06 proposal | Decision |
|---|---|
| `activity_events` | Adopted as `sms_activity_events`; `org_id` dropped; batch index predicate corrected |
| `audit_log` | Adopted as `sms_audit_log`; `org_id` dropped |
| `users` | Adopted as `sms_users`; bigint PK, `auth_user_id` as a nullable side-column |
| `user_devices` | Adopted as `sms_user_devices`; supersedes `push_subscriptions` and the never-created `ios_push_devices` |
| `organisations`, `memberships`, `invitations` | **Deferred** — §11.6 |

| Doc 02 proposal | Decision |
|---|---|
| `sms_contacts.opted_out` | **Rejected** — superseded by the consent tables, §4.1 |
| `sms_contacts.timezone`, `consent_at` | `timezone` + `tz_source` adopted; `consent_at` lives in the ledger |
| `sms_sent_log.campaign_id` | Adopted |
| `sku → supply_days` lookup | Adopted as a `sms_settings` JSONB value, not a table |
| `sms_suppressed` view | Adopted as the `sms_send_block_reason()` function — a function can return *which* reason and take an override flag; a view cannot |
| 11-way RFM | **Rejected** → 5 buckets, §3.8 |
