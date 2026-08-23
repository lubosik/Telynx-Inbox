# Backfilling promotional SMS consent from paid orders

This document covers one script, `scripts/backfill-order-sms-consent.js`, and
the decision behind it.

It is the counterpart to `docs/campaigns/CONSENT-CAPTURE.md`, which describes
the checkout tick box — the strong, forward-looking basis. This document
describes a weak, backward-looking one. Read both; do not confuse them.

---

## 1. The basis, stated plainly

Vici has roughly 926 SMS contacts and 1281 paid orders, and **zero** recorded
promotional SMS consent. The consent ledger has always been empty, and every
promotional eligibility check therefore fails closed.

The business owner has decided that everyone who placed an order should be
treated as opted in to marketing SMS, on the basis of two published texts.

The WooCommerce checkout notice:

> Your personal data will be used to process your order, support your
> experience throughout this website, and for other purposes described in our
> privacy policy.

And the privacy policy, which says the business may send:

> marketing and promotional emails, as well as information regarding your order
> updates

### What is weak about it

This has been put to the owner in writing, and the decision was made anyway. It
is their business and their risk. It is recorded here so that the record is
complete, not to reopen the argument.

1. **No customer gave an explicit SMS opt-in.** Nobody ticked a box saying
   "text me". Nobody replied to a confirmation.
2. **The policy clause names EMAIL.** It says "marketing and promotional
   emails". It does not mention SMS, text messages, or a phone number.
3. **The checkout notice names no channel at all.** It points at the privacy
   policy, and the privacy policy points at email.
4. **US SMS marketing generally expects express written consent** with a
   channel-specific disclosure. A general data-processing notice is not that.
   Providers and carriers apply their own standards on top, and a 10DLC
   campaign can be rejected or shut down on this basis alone.

The script does not hide any of this. Every row it writes carries the verbatim
notice, the verbatim policy clause, the channel each one actually names, an
explicit `explicit_sms_opt_in: false`, and a written list of the limitations
above. A reader a year from now can tell exactly what happened from one row,
without asking anyone.

### What this is NOT

Recording consent is **not** permission to send. Delivery still requires all of
the existing brakes, none of which this script touches:

- `CAMPAIGNS_LIVE_SEND_ENABLED=true` in the backend environment
- `provider_approved=true` and `live_send_enabled=true` in
  `sms_campaign_settings`
- written provider approval covering the exact Vici products, registered use
  case, number/profile, and representative copy
- known-current HighLevel SMS DND clearance, STOP clearance, quiet hours,
  cadence limits, and the frozen approved revision

If someone reports "consent is backfilled, so we can send now", that is wrong.

---

## 2. What the script does

Code:

- `lib/campaigns/order-consent-backfill.js` — the selection logic, a pure
  function with no database, clock, or environment access.
- `scripts/backfill-order-sms-consent.js` — the CLI wrapper that reads Supabase
  and, only when told twice, writes.

### Selection

1. Read every row of `sms_orders`, paged. Deduplicate by `woo_order_id`, or by
   the row id when there is no WooCommerce id — keyed on **both** the kind and
   the id, as `woo_order:1001` and `sms_orders_row:1001`. The two kinds draw
   from unrelated number spaces, so keying on the bare id collapsed unrelated
   orders into one and dropped the second customer from the plan with no skip
   reason at all.
2. Keep orders whose status is `processing`, `completed`, `shipped`, or
   `delivered` — the same definition of "paid" used by
   `lib/campaigns/generation-service.js` and
   `scripts/dry-run-campaign-cadence.js`.
3. Resolve each `contact_phone` to strict E.164. A number that cannot be
   resolved is skipped, never guessed at.
4. Group by phone and take the **earliest** qualifying order. That order is the
   evidence, and its date is the consent date.
5. Skip the phone if any of the following is true.

| Skip reason | Source |
| --- | --- |
| `invalid_phone` | the stored phone is not resolvable to E.164 |
| `internal_or_test_identity` | `ANALYTICS_EXCLUDED_PHONES`, or an `internal_identity` / `test_identity` suppression |
| `ledger_opt_out` | the newest `sms_consent_events` row for the phone is an `opt_out` |
| `contact_opted_out` | `sms_contacts.opted_out = true` |
| `opt_out_sentinel` | an `sms_sent_log` row with `flow_type = 'opted-out'` — the row `flows/utils.js:isOptedOut()` actually reads |
| `ghl_sms_dnd` | `sms_contacts.ghl_dnd = true`, or `ghl_sms_dnd_status` in `active` / `permanent` — the same rule `lib/campaigns/eligibility.js` applies at send time |
| `authoritative_suppression` | an active row in `sms_campaign_suppressions` |
| `already_opted_in` | the newest ledger row is a valid `opt_in`; no duplicate is written |

Withdrawals are checked **before** `already_opted_in`, so the reported reason is
always the strongest fact about a person rather than the first one that matched.
A suppression whose window cannot be parsed is treated as blocking.

DND is in that list even though the send path would block it anyway. This script
does not send; it writes an assertion that somebody consented. Recording
positive promotional consent for a person the CRM has on a do-not-disturb list
is a false statement in a compliance ledger whether or not a downstream gate
happens to save us from acting on it. A missing or stale DND status is **not**
treated as a withdrawal — "not synced recently" is not evidence that somebody
said no, and the send path has its own `dnd_unknown` freshness gate.

All five table reads are mandatory — `sms_orders`, `sms_consent_events`,
`sms_contacts` (which carries both `opted_out` and the DND columns),
`sms_campaign_suppressions`, and the filtered `sms_sent_log`. If any of them
cannot be read, the run aborts.
Proceeding on a partial view of who has said no is the worst thing this script
could do.

"Cannot be read" includes **read incompletely**. `fetchAllRows()` defaults to
warning and returning a truncated array at its row ceiling, which is right for a
screen and catastrophic here, because this script reads absence as permission: a
withdrawal past the ceiling becomes a fresh opt-in for somebody who said no,
with the warning scrolled off above the plan. Every source read therefore passes
`throwOnCeiling: true`, matching `fetchFilteredRows()`, which has always thrown.

### What is written

One `opt_in` row per eligible phone, via `recordOptIn()` in
`lib/campaigns/consent.js`. The script does not write to that module's table
directly and does not modify the module.

| Field | Value |
| --- | --- |
| `source` | `woocommerce_order_privacy_policy` (`SOURCE.ORDER_PRIVACY_POLICY`) |
| `evidence_ref` | `order_privacy_policy:woo_order:<id>` — the earliest qualifying order, never a vague string. `order_privacy_policy:sms_orders_row:<id>` for a legacy row with no WooCommerce id |
| `occurred_at` | that order's `created_at`, **not** the time of the run |
| `dedupe_key` | `order_privacy_policy_backfill:v1:<E.164>` — stable per phone |
| `metadata` | the object below |

The reference is namespaced by **basis**, not merely by order.
`lib/campaigns/checkout-consent.js` writes the bare `woo_order:<id>` for the
checkout tick box — the strongest basis in the system. This script writing the
identical string for the weakest one let both rows exist for the same person and
the same order with nothing but insertion order to tell them apart, and it broke
the verification procedure in `docs/campaigns/CONSENT-CAPTURE.md` section 6,
which counts rows by `evidence_ref = 'woo_order:<id>'` to prove the unticked
checkout case records nothing. With the namespace, that query means exactly what
it says again and needs no correction.

`occurred_at` is the purchase date on purpose. The consent, such as it is,
dates from the purchase; backdating it to "now" would misrepresent when the
basis arose and would distort every cadence and recency calculation downstream.

The dedupe key is per **phone**, not per order. Re-running after new orders
arrive cannot create a second row for the same person: the unique index
`sms_consent_events_dedupe_idx` rejects it and the script counts it as a
duplicate, which is success.

### The metadata recorded on every row

```json
{
  "basis": "policy_derived_determination",
  "explicit_sms_opt_in": false,
  "basis_summary": "Promotional SMS consent was DERIVED from a completed WooCommerce purchase plus the published checkout notice and privacy policy, as a documented business decision by the Vici owner. The customer did not give an explicit SMS opt-in.",
  "relied_upon": {
    "checkout_notice_verbatim": "Your personal data will be used to process your order, support your experience throughout this website, and for other purposes described in our privacy policy.",
    "privacy_policy_clause_verbatim": "marketing and promotional emails, as well as information regarding your order updates",
    "privacy_policy_channel_named": "email",
    "channel_recorded_here": "sms"
  },
  "limitations": [
    "This is not an explicit SMS opt-in. No recipient ticked an SMS consent box, confirmed a link, or otherwise named SMS as a channel they wanted.",
    "The privacy policy clause relied on names marketing and promotional EMAIL. It does not mention SMS or text messages.",
    "The checkout notice relied on says \"other purposes described in our privacy policy\". It names no channel at all.",
    "Treat this basis as weaker than woocommerce_checkout_sms_optin or email_invite_confirmed_link. Do not report it as equivalent to either."
  ],
  "qualifying_order": {
    "reference": "order_privacy_policy:woo_order:1001",
    "woo_order_id": 1001,
    "sms_orders_row_id": 1,
    "status": "completed",
    "created_at": "2025-03-01T10:00:00.000Z"
  },
  "qualifying_paid_orders": 3,
  "determination": {
    "made_by": "vici_business_owner",
    "recorded_at": "2026-08-22T12:00:00.000Z",
    "recorded_by_process": "scripts/backfill-order-sms-consent.js",
    "backfill_version": 1,
    "run_id": "<uuid generated per run>"
  },
  "reversal": "To reverse: record an opt_out for this phone via lib/campaigns/consent.js recordOptOut(). See docs/campaigns/CONSENT-BACKFILL.md for the sweep."
}
```

---

## 3. How to run it

### Dry run (the default, and always do this first)

```bash
node scripts/backfill-order-sms-consent.js
```

Writes nothing. Prints the basis, the source row counts, the eligible count,
every skip reason with a count, the exact metadata that would be written for
the first candidate, and the first ten candidates with masked phone numbers.

Add `--show-phones` to print full numbers when you need to spot-check specific
customers. The output contains order references either way — keep it private.

### Commit

```bash
node scripts/backfill-order-sms-consent.js --commit --basis-acknowledged
```

Both flags are required. Passing one without the other exits 1 and writes
nothing. The second flag is deliberately awkward: it means you have read this
document and accept that you are recording a policy-derived determination
across roughly 900 people, not an explicit SMS opt-in.

Optional:

- `--limit=N` — write only the first N candidates, for a staged rollout.
- Ctrl-C stops the run cleanly between records. Re-running is safe.

### Verify afterwards

```sql
SELECT count(*), min(occurred_at), max(occurred_at)
FROM sms_consent_events
WHERE workspace_id = 'vici'
  AND source = 'woocommerce_order_privacy_policy'
  AND event_type = 'opt_in';

-- Nobody with a withdrawal should have been given a record. This must return 0.
SELECT count(*)
FROM sms_consent_events e
JOIN sms_contacts c ON c.phone = e.contact_phone
WHERE e.source = 'woocommerce_order_privacy_policy'
  AND (c.opted_out = true
       OR c.ghl_dnd = true
       OR c.ghl_sms_dnd_status IN ('active', 'permanent'));

-- The two bases must never share an evidence reference. This must return 0.
SELECT count(*)
FROM sms_consent_events
WHERE source = 'woocommerce_order_privacy_policy'
  AND evidence_ref NOT LIKE 'order_privacy_policy:%';
```

---

## 4. How to reverse it

The ledger is append-only. You do not delete these rows; you supersede them
with a later `opt_out`, which is exactly how a real withdrawal works and which
every eligibility check in the system already honours.

If the business changes its mind, or a provider or lawyer rejects the basis,
run an opt-out sweep over the same population:

```js
// scripts/, run once, dry run first, same two-flag discipline.
const { fetchAllRows } = require('./lib/fetch-all-rows');
const { recordOptOut, SOURCE } = require('./lib/campaigns/consent');

// throwOnCeiling: a truncated read here under-reverses, leaving people opted in
// on a basis the business has just withdrawn.
const rows = await fetchAllRows(supabase, 'sms_consent_events',
  'contact_phone, source, event_type, dedupe_key',
  { orderBy: 'id', ascending: true, throwOnCeiling: true });

for (const row of rows) {
  if (row.source !== SOURCE.ORDER_PRIVACY_POLICY || row.event_type !== 'opt_in') continue;
  await recordOptOut({
    client: supabase,
    phone: row.contact_phone,
    source: 'order_privacy_policy_backfill_reversed',
    evidenceRef: row.dedupe_key,
    occurredAt: new Date().toISOString(),
    dedupeKey: `${row.dedupe_key}:reversed`,
    metadata: {
      reason: 'The order/privacy-policy consent basis was withdrawn by the business.',
      supersedes: row.dedupe_key,
      note: 'This does not delete the original record. The ledger is append-only, ' +
            'and the original row remains as the honest history of what was decided.'
    }
  });
}
```

Notes on the reversal:

- Use `occurredAt: now`. The withdrawal happened when the business decided it,
  not on the original purchase date. Backdating a withdrawal would falsely
  imply the person was never contactable.
- Do **not** reverse anybody whose newest event is already an `opt_out`; a
  second opt-out is harmless but noisy. The dedupe key above makes it
  idempotent either way.
- Do **not** reverse rows from `woocommerce_checkout_sms_optin` or
  `email_invite_confirmed_link`. Those are real opt-ins from a different
  mechanism and are unaffected by this decision. Filter on `source`, as above.
- Reversing does not remove the audit trail. That is the point.

---

## 5. Tests

`test/backfill-order-sms-consent.test.js`, 50 offline cases. Every one was
verified by mutation — the fix was reverted and the test confirmed to fail. The
ones that matter most:

- **A dry run writes nothing.** The injected Supabase client is a Proxy that
  throws on any property access, so touching the database is not a wrong count,
  it is a thrown error. Deleting the guard fails the test; weakening it to a
  single flag also fails it.
- **Opt-out wins.** Asserted separately for all five withdrawal sources, and
  specifically for the case where the person also has a valid existing opt-in,
  which is where a careless precedence order would report "already opted in"
  and quietly hide a withdrawal.
- **Nobody disappears without a reason.** Two paid orders whose identities
  collide across kinds must produce two candidates, and `skippedByReason` must
  stay empty. A person dropped with no reason is invisible to the operator
  reviewing a ~900-row compliance write.
- **A truncated source read aborts.** `fetchAllRows` is exercised directly at
  its ceiling in both modes, and a shape guard fails if any source read in the
  script omits `throwOnCeiling: true`.
- **A failure reports a code, never provider text.** A PostgREST message quotes
  the offending row, and the CLI prints failures on the same line as a
  deliberately masked phone number. Both the data and the print line are
  guarded.
