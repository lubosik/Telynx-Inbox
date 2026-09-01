# Contract — Client Profiles (Phases 0-2)

This is the shared contract two backend workstreams build against in parallel.
It is authoritative. If something here is wrong, say so before writing code
around it rather than diverging quietly.

Approved scope: **Phases 0, 1 and 2 only. No LLM call anywhere in this build.**
Phases 3-4 (narrative summaries, generated copy) are explicitly deferred until
these have run and been reviewed.

Approved policy decision: **context shapes selection and tone, and is never
quoted back at the customer.** No message may reference something a customer
previously said. `lib/campaigns/check-in.js` already commits to this in its
header; this build keeps that promise rather than weakening it.

---

## 1. The table

Extend the EXISTING `sms_customer_profiles`. Do not create a second profile
table. It currently holds, written by `analyseConversation()` in
`intelligence.js`:

    id, contact_phone, ghl_contact_id, inferred_interests, order_signals,
    restock_interests, campaign_recommendations, sentiment, last_analysed,
    raw_summary, updated_at

### Sole-writer rule — the one that matters

Every column has exactly one writer.

| Columns | Owner | Notes |
|---|---|---|
| the eleven above | `intelligence.js` (unchanged) | legacy; do not read them for anything in this build |
| everything added below | the new profile builder | nothing else may write these |

This repository's recurring production fault is several places holding one
answer and the emptiest one winning. It has caused a 15% coupon on a message
promising 20%, a dead send path, and analytics reporting zero opt-outs when ten
people had left. Do not add another instance.

### Columns to add — all deterministic, all computed from data

    -- identity / bookkeeping
    profile_version              integer      not null default 1
    deterministic_built_at       timestamptz
    orders_fingerprint           text         -- change detection, see §3
    messages_fingerprint         text

    -- from sms_orders (paid only: processing, completed, shipped, delivered)
    order_count                  integer      not null default 0
    first_order_at               timestamptz
    last_order_at                timestamptz
    days_since_last_order        integer
    total_spend_cents            bigint       not null default 0
    avg_order_value_cents        bigint       not null default 0
    distinct_skus                text[]       not null default '{}'
    top_skus                     text[]       not null default '{}'   -- most-ordered first, max 5
    last_order_skus              text[]       not null default '{}'
    last_product_name            text
    last_product_sku             text
    has_only_unpaid_orders       boolean      not null default false

    -- reorder rhythm (lib/campaigns/reorder-cadence.js)
    reorder_interval_days        integer      -- null when not measurable
    reorder_interval_source      text         -- 'personal' | 'shop_median'
    reorder_due_at               timestamptz  -- last_order_at + interval
    cadence_confidence           text         -- 'high' | 'low' | 'none'

    -- from sms_messages
    inbound_message_count        integer      not null default 0
    outbound_message_count       integer      not null default 0
    last_inbound_at              timestamptz
    has_replied_ever             boolean      not null default false
    engagement_tier              text         not null default 'silent'

    -- from campaigns
    campaigns_received_count     integer      not null default 0
    last_checkin_at              timestamptz
    last_checkin_variant         text

Indexes: `reorder_due_at`, `engagement_tier`, `last_checkin_at`, and a unique
index on `contact_phone` if one does not already exist.

**Not stored here:** name, email, opt-out state, DND. Each already has exactly
one home, and copying them here would create a second answer to a question that
already has one.

### engagement_tier

Derived from `inbound_message_count`, measured against the live distribution
(809 contacts with any message: 559 zero inbound, 102 one, 89 two-to-four, 59
five-plus):

    silent      0 inbound      559 people
    flicker     1              102
    talker      2-4             89
    regular     5+              59

These names exist so a campaign can say "silent buyers who are overdue" without
re-deriving thresholds in four places.

---

## 2. Paid vs unpaid — get this right

`sms_orders.status` holds FULFILMENT states, not WooCommerce states. The live
distribution is shipped 642, delivered 608, cancelled 252, failed 83,
completed 47.

**Paid** = `processing | completed | shipped | delivered`.
Everything else is not a purchase.

`has_only_unpaid_orders` exists because 335 rows are cancelled or failed, and a
contact whose only orders failed must never be treated as a customer who came
back. Treating a cancelled order as recent activity would withhold outreach
from exactly the person who needs it.

---

## 3. Fingerprints and staleness

A rebuild is two indexed reads and no LLM, so it is cheap — but it must be
skippable, or the nightly sweep rewrites 843 identical rows every night.

- `orders_fingerprint` = `${count}:${latest created_at ISO}` over that contact's
  paid orders.
- `messages_fingerprint` = `${count}:${latest created_at ISO}` over that
  contact's `sms_messages`.

If both match what is stored, skip the row entirely — no write, not even
`updated_at`.

Refresh triggers: the WooCommerce order webhook, inbound SMS, and a nightly
drift sweep. All three call the same builder; none has its own logic.

---

## 4. Reads must be paged

Unbounded `.in()` overflows the request URL and an unpaged read silently caps at
1000 rows. Both are silent, and both have already caused a production outage in
this codebase. Every read over orders, messages or contacts pages at 1000 and
chunks `.in()` lists. `readIn` in `lib/campaigns/personalise.js` is the existing
pattern — reuse it rather than writing a third one.

---

## 5. Variant bank contract (Phase 2)

`selectCheckInVariant({ profile, lastVariant })` returns
`{ key, template, reason }`.

Rules:
- Never returns `lastVariant` when any other eligible variant exists.
- Every variant is hand-written, pre-approved, and passes `validateCopy()` at
  **worst-case merge expansion** (see `checkRenderedLength` in
  `copy-validator.js`), not just as written.
- Every variant keeps the invariants that are non-negotiable for 10DLC: the
  brand named within the first 6 characters or immediately after a greeting,
  and the message ending in exactly `Reply STOP to opt out.`
- Selection is by profile only — first-time vs repeat buyer, whether an
  approved product code is available, engagement tier. **Nothing the customer
  said may appear in any variant.**
- Deterministic: the same profile and same `lastVariant` always give the same
  result. No randomness — a test cannot pin a coin flip, and neither can a
  reviewer.

The chosen key is written to `last_checkin_variant` when the campaign is
approved, not when the draft is built, so an abandoned draft does not burn a
variant.

---

## 6. Definition of done

**Phase 0** — `gatherFacts()` stops discarding order history; facts carry the
full paid-order list. Merge-field behaviour is byte-identical to today, proven
by existing tests still passing untouched.

**Phase 1** — migration applied; every contact with a paid order has a row;
backfill is idempotent (running twice changes nothing on the second pass);
fingerprint skip proven by a test; `reorder_due_at` populated for the 289
contacts with 2+ orders.

**Phase 2** — a bank of at least 5 variants, each validated at worst case;
selection never repeats the previous variant; the check-in recipe uses it;
nobody receives wording they have received before.

Every phase: full `npm test` green, no console.log left in production paths, no
secret in source, and no column with two writers.
