# Capturing promotional SMS consent at WooCommerce checkout

`sms_consent_events` is currently empty. Nothing in this repository infers
consent from an order, a phone number, a past purchase, or a transactional
message, so every promotional eligibility check fails closed and will keep
failing closed until real evidence starts arriving.

This document describes the one mechanism that produces that evidence: a tick
box on the WooCommerce checkout. Until the store owner completes the setup
below, this code is inert by design — it looks for a field, does not find it,
and records nothing.

Code: `lib/campaigns/checkout-consent.js`.
Ledger: `lib/campaigns/consent.js` and `sms_consent_events`.

---

## 1. What you must build in WooCommerce

### The checkbox

Add a **required-nothing, unticked-by-default** checkbox to the checkout, and
store its value on the order as post/order meta.

| Property | Value |
| --- | --- |
| Meta key | `_sms_marketing_optin` (or your own — see below) |
| Default state | **Unchecked.** A pre-ticked box is not consent under the TCPA or CTIA guidance, and several providers treat it as a violation on its own. |
| Required | No. Consent must not be a condition of purchase. |
| Stored value when ticked | `1`, `yes`, `true`, or `on` |
| Stored value when not ticked | `0`, `no`, empty, or the key omitted entirely — all of which this code reads as "no consent" |

The field must be written to the **order**, not only to the customer profile,
because the order is the evidence this system references. Classic checkout
plugins usually write order meta by default. WooCommerce Blocks / Store API
checkout requires the field to be registered so that it is persisted onto the
order.

Where the checkbox goes matters: it must be visibly near the phone number field
and near the place order button, so the disclosure is in front of the customer
at the moment they give us the number.

### The disclosure wording

The label next to the checkbox must contain all of the following. Missing any
one of them is the usual reason a 10DLC campaign is rejected or a complaint
succeeds.

1. A clear statement that they agree to receive **marketing text messages**
   (not just "updates" or "notifications").
2. Who is sending them — the brand name.
3. That **consent is not a condition of purchase**.
4. That **message and data rates may apply**.
5. Message frequency (a "recurring" or "varies" statement).
6. How to stop — reply STOP — and how to get help — reply HELP.
7. Links to the Privacy Policy and Terms / Messaging Terms.

Wording you can use as-is:

> **Text me offers.** Yes, I agree to receive recurring automated marketing text
> messages from Vici Peptides at the mobile number provided. Consent is not a
> condition of purchase. Message frequency varies. Message and data rates may
> apply. Reply STOP to unsubscribe or HELP for help. See our
> [Privacy Policy](https://vicipeptides.com/privacy-policy/) and
> [Messaging Terms](https://vicipeptides.com/sms-terms/).

Two things must remain true about that text:

- The mobile number it refers to is the **billing phone on the order**. That is
  the only number this code will ever record consent against.
- If you change the wording, bump `WC_SMS_OPTIN_DISCLOSURE_VERSION` (below).
  Otherwise a future reader cannot tell which version of the statement any
  historical row was collected under.

### Keep the checkout copy and the recorded evidence in step

The same disclosure text should be saved somewhere durable and versioned — the
store's Messaging Terms page is the usual place — because the ledger stores a
version label, not the sentence.

---

## 2. What you must set in the backend environment

Both are optional; both are in `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WC_SMS_OPTIN_META_KEY` | `_sms_marketing_optin` | The order meta key the checkbox writes. **Must match WooCommerce exactly.** A near-miss (different case, stray underscore, trailing space) is treated as "field not present", so no consent is ever recorded and nothing warns you. |
| `WC_SMS_OPTIN_DISCLOSURE_VERSION` | `unversioned` | A label for the checkout wording in force, stored on every row. Bump it whenever the disclosure text changes, e.g. `checkout-2026-08`. |

`WC_WEBHOOK_SECRET` is not new, but it now matters more — see section 4.

---

## 3. Where the capture runs, and where it deliberately does not

It runs in **`routes/webhook-woocommerce.js`**, on the live `order.*` webhook,
immediately after the order sync and before any SMS flow. It is not awaited: a
consent write can never delay or fail an order confirmation SMS.

It does **not** run in `sync-woocommerce.js`, which means `runWooSync()` — the
full-store historical backfill — records nothing. That is deliberate:

- Those orders were placed before the checkbox existed, so none of those
  customers saw the disclosure.
- If a meta key with a similar name already exists on historical orders for some
  unrelated reason, a backfill would silently mint thousands of consent rows
  that no human ever agreed to. The ledger's whole value is that a row means
  someone actually said yes.
- Backfills also re-run. Consent is dated evidence, not a state to re-sync.

Historical contacts therefore stay `unknown` and stay excluded, which is what
`docs/campaigns/SMS-COMPLIANCE-RESEARCH.md` requires. If genuine historical
evidence exists elsewhere (a form export, a written record), importing it is a
separate, reviewed exercise with its own source and evidence references — not a
side effect of an order sync.

---

## 4. Webhook signatures now gate consent

The order webhook endpoint is unauthenticated and processes orders even when a
signature does not verify, for operational reasons that predate this feature.
Consent capture is stricter:

- `WC_WEBHOOK_SECRET` **set** and the signature valid → consent recorded,
  `metadata.signature_verified = true`.
- `WC_WEBHOOK_SECRET` **set** and the signature missing or invalid → **nothing
  recorded**. An unverified body is an assertion by a stranger, and a forged
  order could otherwise plant consent for any number.
- `WC_WEBHOOK_SECRET` **unset** → consent recorded, but
  `metadata.signature_verified = false`, so the weaker basis stays visible.

Set `WC_WEBHOOK_SECRET` in Railway. It is the difference between evidence and an
assertion.

---

## 5. What a recorded row looks like

| Column | Value |
| --- | --- |
| `event_type` | `opt_in` |
| `purpose` | `promotional_sms` |
| `source` | `woocommerce_checkout_sms_optin` |
| `evidence_ref` | `woo_order:12345` |
| `contact_phone` | billing phone in strict E.164 |
| `occurred_at` | the order's `date_created_gmt`, read as UTC |
| `dedupe_key` | `woo-order-optin:12345` |
| `metadata` | order id, customer id, order status, meta key, the stored value, disclosure version, capture path, signature verified |

No name, email, or address goes into `metadata`. The order reference carries the
identity; duplicating it into the ledger only widens the blast radius of a leak.

`dedupe_key` is what makes webhook retries safe. WooCommerce fires `order.updated`
on every status change, and retries on any non-200, so the same order arrives
many times. Exactly one consent row results.

---

## 6. How to verify it works, end to end

1. Set the two environment variables and deploy.
2. Place a real test order on the store with the box **unticked**. Confirm no
   row appears:
   `select count(*) from sms_consent_events where evidence_ref = 'woo_order:<id>';`
   → must be `0`.
3. Place a second test order with the box **ticked**. The same query must return
   exactly `1`, with `source = 'woocommerce_checkout_sms_optin'`.
4. Re-deliver that webhook from WooCommerce (Settings → Advanced → Webhooks) and
   confirm the count is still `1`.

Step 2 is the important one. A system that records consent for the ticked case
but also for the unticked case is worse than no system at all.

---

## 7. What this does not do

- It does not make anyone eligible to receive a promotional message on its own.
  Consent is one of several independent gates: `CAMPAIGNS_LIVE_SEND_ENABLED`,
  `provider_approved` and `live_send_enabled` in `sms_campaign_settings`,
  current HighLevel DND clearance, STOP clearance, quiet hours, cadence limits,
  and the frozen approved revision all still apply.
- It does not capture consent from any other surface — no popups, no landing
  pages, no keyword opt-ins. Each of those would need its own source, its own
  evidence reference, and its own entry in this document.
- It does not opt anyone out. Withdrawal is `recordOptOut` on the inbound STOP
  path, and a later opt-out always beats an earlier opt-in.

## 8. The other two ways consent can arrive

This document covers the strongest basis — a ticked box under a disclosure.
Two other paths exist, and each records a different `source` so the difference
stays visible for as long as the row does.

| Basis | Source | Where it is documented |
|---|---|---|
| Ticked box at checkout | `woocommerce_checkout_sms_optin` | this document |
| Clicked a signed link in an email we were already permitted to send | `email_invite_confirmed_link` | `SMS-OPTIN-INVITE.md` |
| Derived from a purchase plus the published privacy policy | `woocommerce_order_privacy_policy` | `CONSENT-BACKFILL.md` |

They are deliberately never merged into one flag. If a carrier, a 10DLC
reviewer or a lawyer asks how a given person came to be on the list, the answer
is one query away and it is specific.

Read `CONSENT-BACKFILL.md` before running the backfill: the basis it records is
the weakest of the three, and the document sets out plainly why, including the
part where the privacy policy names email rather than SMS.
