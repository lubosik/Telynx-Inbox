# Before the win-back can be approved

Four things. The first is required, the second is a correction to a record
that is currently untrue, the third is a decision only you and Vin can make,
and the fourth is a collision between this and a draft already sitting there.

Nothing here sends a message. The campaigns are drafts and stay drafts until
you approve them in the app.

---

## 1. Apply the migration (required)

**Paste `scripts/personalised-approval-migration.sql` into the Supabase SQL
editor and run it whole.**

Until you do, approving either win-back campaign fails with "Personalised
campaigns need scripts/personalised-approval-migration.sql". That refusal is
deliberate and it happens *before* any coupon is minted, so nothing is wasted
by trying.

### What it fixes

Approval used to do this, for every recipient:

```sql
rendered_message = v_campaign.final_message
```

The same string, copied to every row. The delivery worker then sends
`rendered_message` verbatim. So approving a campaign whose copy says
`Hi {{first_name}}` sent the literal characters

```
Hi {{first_name}}, ... use {{code}} for 15% off
```

to every person on the list. On the win-back that is 376 customers receiving
visibly broken mail merge from a business asking them to come back.

After the migration, messages are rendered per person before approval and the
function verifies them instead of overwriting them. It also adds
`sms_campaigns.discount_percent`, which is what tells the coupon minter to
issue 15% and not something else.

---

## 2. Replace the placeholder compliance reference (should do)

`sms_campaign_settings.provider_approval_reference` currently reads, literally:

```
PUT-YOUR-TELNYX-10DLC-CAMPAIGN-ID-HERE
```

That field is the recorded evidence that Telnyx approved this business to send
this kind of message, and it has your user id and a timestamp against it. Right
now it is a signed statement pointing at nothing.

Your registration is real. Queried from the Telnyx API on 29 Aug 2026:

| | |
|---|---|
| Brand | Vici Peps LLC, VERIFIED, TCR `BWAW3HM` |
| Campaign | TCR `CYIFMYJ`, Telnyx `4b30019d-e41f-7293-475b-9bdf7ac114ef` |
| Status | ACTIVE, `MARKETING` in the registered use cases |
| Number | `+13054043184`, ASSIGNED, T-Mobile registered, not suspended |

So the fix is to put the true value in:

```sql
UPDATE sms_campaign_settings
   SET provider_approval_reference = 'TCR CYIFMYJ / Telnyx 4b30019d-e41f-7293-475b-9bdf7ac114ef',
       updated_at = now()
 WHERE workspace_id = 'vici';

SELECT provider_approved, live_send_enabled, provider_approval_reference
  FROM sms_campaign_settings WHERE workspace_id = 'vici';
```

---

## 3. Two things to look at before you press send

Neither is mine to decide. Both are on the record and you should know them.

### The campaign carries a rejection note

The live 10DLC campaign record has this against it:

> "This brand or program includes illegal substances,"

The campaign is ACTIVE and T-Mobile registered in spite of it, so traffic
flows today. But that sentence is the stated grounds on which a carrier can
filter or suspend the campaign, and 376 marketing messages is a larger and more
visible burst than anything this number has sent. Worth raising with Telnyx
before the send rather than after.

### The consent basis does not match what you registered

Your 10DLC registration tells carriers that promotional consent is collected
verbally on a phone call, followed by a confirming **YES** reply, and states
explicitly:

> "If user does NOT reply YES, they will not be opted in to promotional
> messaging and will only be receiving informational messaging."

The 942 opt-ins in the database were backfilled from WooCommerce account
registration (`scripts/consent-backfill.sql`). Nobody replied YES.

The backfill is honest about what it is and excludes anyone who ever opted out,
four different ways. The question is not whether the code is careful. It is
that if Telnyx or a carrier asks for proof of opt-in for one of these 376
people, the evidence on file describes a different opt-in method than the one
registered.

That is Vici's call to make, not the platform's, and the responsibility model
in `docs/campaigns/SMS-COMPLIANCE-RESEARCH.md` says so. Make it knowingly.

---

## 4. There is a third draft, and it targets the same people

A campaign staged on 25 Aug is still sitting in drafts:

> **Shipping covered on the next order for Bought once and never came back** — 511 recipients

Its audience is the whole `one_time_buyers` cohort, and it **contains all 376
of the win-back people**. Every single one:

| | Overlap with the 511 |
|---|---|
| Win-back: bought once, by product (221) | 221 |
| Win-back: bought once (155) | 155 |

Approve both and those 376 get two different offers within days of each other:
free shipping from one, 15% off from the other. The frequency caps allow it,
two promotional messages in seven days is inside the limit, so nothing will
stop it. It just makes the business look like it does not know what it is
offering, and it spends two of a customer's four monthly messages arguing with
itself.

Pick one. If it is the win-back, archive the shipping campaign in the app
first, or at minimum do not schedule them in the same fortnight.

---

## Then, in the app

Campaigns → the two drafts:

| Campaign | People |
|---|---|
| Win-back: bought once, by product | 221 |
| Win-back: bought once | 155 |

Each shows **What each person receives**: the real messages, the number that
render, and the number that cannot. Both currently render for everybody.

Edit the copy if you want it in your own words, submit for review, approve,
then schedule. Approval is the step that mints the 376 single-use codes in
WooCommerce, one per person, 15% off, expiring in 30 days.

**Suggested send time: Tuesday or Wednesday, 12–2pm ET.** Not the weekend.
Quiet hours are already set to 20:00–09:00 America/New_York, so a late-evening
schedule would be held anyway.
