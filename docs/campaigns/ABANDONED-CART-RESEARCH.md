# Abandoned carts: do not build this

Researched 2026-08-23. Source tiers: **[A]** primary or regulatory,
**[B]** large-sample study with disclosed method, **[C]** vendor blog,
**[U]** unverified.

## Recommendation

**Do not build it. Instrument it for free, and revisit in 90 days with real
numbers instead of estimates.**

Three independent reasons, any one sufficient on its own.

### 1. The SMS half is not legally available

47 CFR 64.1200(f) defines prior express written consent as an agreement in
writing **bearing the signature of the person called**, with a clear and
conspicuous disclosure that they are authorising marketing messages and that
consent is not a condition of purchase. `[A]`

A phone number typed into a checkout field and never submitted has no
agreement, no disclosure, and no signature. **It is not consent.** This is not
a grey area, and since the entire point of the integration is to feed the SMS
engine, it is close to dispositive.

Three exemptions people reach for, and why each fails:

- **Established business relationship.** EBR exempts from the do-not-call
  rules in 64.1200(c) and (d). It has never been a substitute for written
  consent on marketing texts to mobiles.
- **The one-to-one rule was struck down.** True, on 2025-01-24 in *Insurance
  Marketing Coalition v. FCC* (11th Cir. No. 24-10277) `[A]`. What was vacated
  was the requirement to give consent to one seller at a time. The baseline
  written-consent requirement is untouched. It helps lead buyers. It does
  nothing for someone who obtained no consent at all.
- **It is only a reminder, not marketing.** A message encouraging completion
  of a purchase is a message encouraging the purchase of goods, which is the
  regulatory definition of a solicitation.

"Abandoned cart text message" is an established plaintiff-bar category with
its own intake pages; Walmart, Amazon, Zulily, JC Penney and eBay have all been
named. Damages are $500 per text, trebled to $1,500 for willful. `[A]`

Run the asymmetry. 300 messages in a first year to non-consented numbers is
**$150,000 of statutory exposure, $450,000 if willful**, against maybe $5,000
of recovered revenue. There is no version of that arithmetic that clears.

More than 15 states now run mini-TCPAs with their own consent definitions and
private rights of action. Florida, Oklahoma and Maryland are the strictest. A
national store cannot geofence out of them cleanly.

**The realistic worst case is not a lawsuit. It is losing the 10DLC campaign
the entire SMS programme depends on, to chase two extra orders a month.**

### 2. The volume is not there

WooCommerce core does not track abandoned carts and never has. A cart lives in
`wp_woocommerce_sessions` as a serialized blob with no identity attached, and
it is garbage-collected. `wc_customer_lookup` is derived from placed orders
only. There is no REST path from a Node backend to "list all live carts", which
is exactly why the three endpoints probed returned 404.

The `checkout-draft` status looked like a way in and is a dead end: drafts are
deleted daily, usually carry no contact details, exist only on Blocks checkout,
and **WooCommerce 10.9 (released 2026-06-23) removed the behaviour entirely**,
deferring draft creation until close to place-order time. `[A]` Any design
scraping draft orders is building against something that no longer exists.

Modelling from a ~64 order/month run rate, with 70.22% average documented cart
abandonment `[B: Baymard, 50 studies, updated 2025-09-22]`:

| Scenario | Captures/mo | Conversion | Recovered orders/mo |
|---|---:|---|---:|
| Pessimistic | 25 | 3.97% | 1.0 |
| Central | 32 | 7.84% | 2.5 |
| Optimistic | 40 | 9.6% | 3.8 |

Discount 30 to 50% for shoppers who would have returned anyway: **1 to 3
genuinely incremental orders per month.** Against 2 to 3 engineering days plus
counsel.

### 3. The message cannot say the thing that makes it work

Abandoned-cart recovery converts because it names the product left behind. Here
it cannot.

FDA's 31 March 2026 warning letters cited **Prime Sciences**, which listed its
products as "GLP1-R", "GLP1-S", "GLP1-T" and "BAC water" `[A: MARCS-CMS
721805]`. That is the same abbreviation strategy as this catalogue's RT, TZ and
SM. FDA cited them as unapproved new drugs regardless, reaching its conclusion
on the totality of the marketing.

This corroborates, from an independent letter, the finding already recorded in
`REPEAT-PURCHASE-RESEARCH.md`. Abbreviating is not a shield, and the
abbreviation is not what creates the risk. Any signal of intended human use is.

So a compliant abandoned-cart message may contain: a generic reference to items
left in a cart, a recovery link, sender identity, an opt-out. It may not
contain a product name in any form, a dose or vial size, a claim, a
reconstitution or injection reference, a comparison to an approved drug, or a
product image.

"You left something in your cart" is the weak version of the tactic, and the
benchmark conversion rates above were measured on messages that name products.
**Halve the projection again. The central case becomes roughly one incremental
order per month.**

One further cost that is easy to miss: an abandoned-cart message is by
construction a message sent because someone tried to buy a specific unapproved
drug. Even a generic message creates a durable timestamped record linking a
named individual to that intent. That is a discovery artefact.

## The comparison that settles it

| | Abandoned cart | One-time buyer reactivation |
|---|---|---|
| Addressable now | 25 to 40 a month, in a trickle | **504, today, all at once** |
| Proven they will pay | No, they left | **Yes, they completed a purchase** |
| Consent posture | None. TCPA exposure. | Existing customer relationship |
| New infrastructure | Plugin, webhook, schema, suppression | **None. Already built and gated.** |
| Time to first send | 2 to 3 days plus legal | **Hours** |
| Product-naming constraint | Applies, and guts the mechanism | Applies, and is survivable |
| Realistic first campaign | ~2 orders | **15 to 25 orders** |

A single reactivation send to 504 proven buyers plausibly produces more revenue
in a week than an abandoned-cart programme produces in six months. And the
second-order value is higher: converting a one-time buyer moves the 1.65
orders-per-buyer ratio, which compounds. Recovering a cart just captures a
transaction that was already halfway to happening.

## What to do instead

1. **Do not send abandoned-cart SMS.** Not now, not with a plugin, not as a
   soft reminder.
2. **Install `woo-cart-abandonment-recovery` (free) in capture-only mode**,
   every email template disabled, zero sends. One hour, reversible. It exists
   purely to replace the estimates above with measurements. Of the plugins
   surveyed it is the only one that is free, actively maintained (v2.1.3,
   2026-06-19, 300k installs), captures **phone** as well as email, and keeps
   the data in your own database rather than a vendor's. Metorik and Retainful
   were ruled out for being hosted suites, and Metorik captures no phone at all.
3. **Count the rows weekly.** Do not build a Supabase sync yet.
4. **Review at 60 to 90 days.** Sustained above 150 capturable carts a month
   would make an **email-only** recovery flow worth building. CAN-SPAM permits
   unsolicited commercial email with disclosure and an opt-out; TCPA does not
   permit unsolicited marketing SMS. That asymmetry is the whole story.
5. **Spend the engineering time on the 504.**

## What would change the answer

| Trigger | Threshold |
|---|---|
| Measured capturable carts | above 150/month for two months, and then email only |
| A real SMS opt-in checkbox at checkout, logged with IP, timestamp and disclosure version | makes the SMS path arguable, not safe |
| Counsel sign-off on the catalogue and messaging | relaxes the naming constraint |

On that second row: a ticked checkbox is widely treated as an electronic
signature under E-SIGN, so the theory is coherent. But the form was never
submitted, there is no confirmation event, and **no case law was found on the
enforceability of a ticked-but-unsubmitted consent checkbox** `[U]`. That is an
attorney question. Even if it works, only shoppers who both reach checkout and
tick the box are addressable, which is 10 to 25% of captures, or 3 to 10 carts
a month. The compliance work costs more than the revenue.

## Unverified, and worth knowing

- Which checkout the store renders, Blocks or classic. `/checkout/` redirected
  to an age-gated cart page. This determines whether capture would work at all:
  jQuery blur listeners silently do nothing on the React-rendered Blocks
  checkout, and the failure mode is an empty table with no error.
- Store AOV was not supplied, so every revenue figure here is conditional.
- The 3.97 to 7.84% conversion figures could not be located in Postscript's
  published pages; their 2025 data shows ~9.1 to 9.6%. The directional claim
  that abandoned checkout is a top-two automation is well supported.
- CartFlows' exact webhook payload. Phone inclusion is confirmed, the full
  field list is not.
- Whether a ticked-but-unsubmitted checkbox is enforceable. No case law found.
- The consent basis recorded for the existing ~930 SMS contacts. Not checked
  here, and worth auditing independently of this question.

## Sources

47 CFR 64.1200 (Cornell LII). *Insurance Marketing Coalition Ltd. v. FCC*, No.
24-10277 (11th Cir. 2025-01-24). FDA warning letters MARCS-CMS 721805 and
721806, 2026-03-31. Telnyx forbidden messaging use cases. CTIA Messaging
Principles. Baymard cart abandonment, updated 2025-09-22. WooCommerce developer
blog on checkout-draft, 2020-11-23. WooCommerce 10.9 release analysis, 2026.
WC_Cart_Session code reference. Cart Abandonment Recovery plugin, WordPress.org
v2.1.3. Metorik cart tracking docs. FunnelKit. Top Class Actions TCPA intake.
AvairAI state mini-TCPA tracker 2026. ICO email marketing guidance on the soft
opt-in.
