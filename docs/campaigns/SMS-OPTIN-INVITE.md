# Emailed promotional SMS opt-in invitations

> **STATUS: STAGED CAPABILITY. NOT LIVE.**
>
> Everything described here is built and tested, and none of it is running.
> `scripts/sms-optin-migration.sql` has not been applied to production, nothing
> mints an invitation automatically, no cron touches this, and email is sent by
> a separate agency rather than by this backend. Until somebody deliberately
> runs the mailing script and the agency sends the result, this flow issues
> zero invitations and records zero consent. Do not describe it as a working
> opt-in programme, and do not count on it in any plan that assumes a growing
> SMS list.

This document covers the second of the three ways promotional SMS consent can
arrive in `sms_consent_events`. `CONSENT-CAPTURE.md` covers the ticked box at
checkout, and `CONSENT-BACKFILL.md` covers the order-derived determination.

| Basis | Source recorded |
|---|---|
| Confirmed an emailed link | `email_invite_confirmed_link` |
| Declined an emailed link | `email_invite_declined_link` |

## 1. Why the flow exists at all

Vici holds roughly 926 SMS-reachable contacts and, at the time of writing,
zero rows of promotional SMS consent. The campaign engine is therefore correct
to suppress every one of them, and it will keep being correct for as long as
the ledger is empty. The privacy policy those customers accepted grants
marketing **email** permission and says nothing whatsoever about text messages.

So the only lawful route to an SMS list is the slow one. Use the email
permission that genuinely exists to ask, and record the click as documented
consent with the evidence attached. Nothing in this flow creates consent by
itself. A contact who never clicks stays exactly as suppressed as they are
today.

## 2. The pieces

| Path | What it is |
|---|---|
| `scripts/sms-optin-migration.sql` | `sms_optin_invitations` plus two SECURITY DEFINER RPCs. **Apply before deploying the router.** |
| `lib/campaigns/sms-optin-invite.js` | Minting, answering, the withdrawal gate, the store seam |
| `routes/sms-optin.js` | `GET /sms-optin`, `POST /sms-optin/confirm`, `POST /sms-optin/decline` |
| `public/sms-optin.html` | The static landing page. No framework, no third-party asset |
| `lib/email-templates.js` | `smsOptInInviteEmail()`, the message body and its disclosures |
| `scripts/send-sms-optin-invites.js` | Mints a batch and renders the emails. Sends nothing |
| `test/sms-optin.test.js` | Offline. No database, no network, no provider |

## 3. Deployment order, which is not optional

1. Apply `scripts/sms-optin-migration.sql`. It is transaction-wrapped,
   re-runnable, enables RLS with no policies, and creates no consent. Applying
   it alone changes nobody's state and sends nothing.
2. Deploy the backend. `POST /sms-optin/confirm` returns 503 for every caller
   until step 1 has happened, because the RPCs it calls do not exist.
3. Set `APP_URL`. Without it no link can be built and the mailing script
   refuses to run.

Reversed, `main` auto-deploys a router whose only possible answer is a 503.

## 4. Running a mailing

```bash
# Dry run. Reads, counts, prints one sample rendering, writes nothing.
node scripts/send-sms-optin-invites.js --campaign-ref=sms_optin_invite_2026_08

# Commit. Opens invitations and writes the rendered emails to a private file.
node scripts/send-sms-optin-invites.js \
  --campaign-ref=sms_optin_invite_2026_08 \
  --commit --mailing-approved --out=/private/tmp/invites-2026-08.json
```

Two flags, deliberately awkward, the same discipline as
`scripts/backfill-order-sms-consent.js`. `--limit=N` stages a rollout, and
SIGINT stops cleanly between recipients.

**The output file contains live consent tokens.** Each rendered email holds a
256-bit token in a URL, and pressing that link is what creates a consent
record, so the file is exactly as sensitive as a batch of password-reset links.
`--commit` therefore refuses to run without `--out`, writes the file `0600`,
and refuses to overwrite an existing one. Hand it to whoever sends the email,
then delete it. The invitations themselves live in the database.

The script excludes: no email address, no valid E.164 number, an active
withdrawal in any of the four places one can live, an existing positive consent
record, and anybody already invited under the same `campaign_ref`. Every
exclusion is counted and named in the printed plan, so the totals add up and an
operator can audit a nine-hundred-person mailing rather than trust it.

## 5. Why a GET can never record consent

Corporate mail scanners, link previewers and antivirus proxies follow every URL
in an inbound email, unprompted, within seconds of delivery. If opening the
link recorded an opt-in, this system would manufacture consent for people who
never even saw the message, and it would look completely legitimate in the
ledger, which is worse than having no consent at all.

So `GET /sms-optin` sends a static file and does not read, validate, log or
even look at the token. Consent is written only by a POST that a human has to
press a button to produce. There is also no "who is this link for?" endpoint,
because that would be an oracle: feed it tokens, read back phone numbers. The
page shows no name, no address and no number.

## 6. Tokens

`crypto.randomBytes(32)` rendered base64url, the same construction as a
password reset. The raw token goes into exactly one place, the email body, and
is then discarded. What is stored is its sha256 hex plus an 8-character prefix
**of that hash**, never of the token, so a dump of `sms_optin_invitations`
yields neither a working link nor a head start on guessing one.

Invitations last 30 days, stated in the email as a courtesy and checked in SQL
against `now()` as the control. A new mailing to the same number cancels that
number's unanswered invitation, so only the newest link works.

The token is never logged. Not at error level, not in development, and not
inside a URL assembled for a log line. The page also drops it out of the
address bar and out of the history entry as soon as the first POST resolves,
whatever that POST resolved to.

## 7. The opt-out is not symmetrical with the opt-in

Four separate asymmetries, and each one is load-bearing.

**What is accepted.** "No thanks" is accepted from an invitation that has
expired and from one that has been superseded. "Yes" is accepted from neither.
Refusing to record somebody's refusal for want of paperwork would be
indefensible. And once a person has declined, a later click of the same emailed
link cannot flip them to opted in; anyone who can see that email can press that
button, so a change of mind has to be a fresh act.

**The write order.** The invitation row and the consent ledger are two separate
round trips, and whichever is written second can be lost.

- A **confirmation** claims the invitation first and writes the ledger second.
  Losing the ledger write means the person is not opted in, which is the safe
  direction, because the send path reads the ledger and nothing else.
- A **withdrawal** writes the ledger **first** and stamps the invitation row
  second. This is mandatory. `sms_optin_invitations` is read by nothing on the
  send path and there is no reconciliation job, so an invitation committed as
  declined with no matching ledger row is a refusal that has silently vanished.
  Written this way round, a failure can only lose the bookkeeping stamp.

This ordering is the reason the eligibility path does not need to read
`sms_optin_invitations`: a declined invitation always implies a ledger
`opt_out`, and every eligibility check already honours those. The invariant is
asserted directly in `test/sms-optin.test.js`.

**What the customer is told.** `OPTIN_RECORD_FAILED` promises that nothing was
written and may only be returned from a path that reached neither storage.
`OPTIN_NOT_CONFIRMED` exists for the confirmation case where the invitation was
claimed and the ledger was not, because telling somebody "nothing has been
recorded" when a row says otherwise is how a person stops pressing the button
that would repair it.

**The rate limit.** `/confirm` and `/decline` have separate budgets and
separate stores. `req.ip` is one address for an entire corporate NAT, an entire
CGNAT range and an entire mobile carrier gateway. You may make somebody wait
for a permission they can grant later. You may not answer a withdrawal with a
429.

## 8. An emailed link cannot undo a STOP

An invitation is minted days or weeks before it is answered, and a person can
text STOP in between. A later `opt_in` with a later `occurred_at` would win the
tuple comparison in every eligibility check, and the ledger would then
positively assert that consent was obtained after a withdrawal.

The withdrawal state is therefore consulted twice:

- `issueOptInInvite()` refuses to mint at all, because emailing a marketing
  permission request to somebody who has texted STOP is itself the problem, not
  merely the click that might follow it;
- `confirmOptInInvite()` re-reads it immediately before writing an `opt_in`,
  because the mint is not the moment that matters.

Both look in all four places a withdrawal can live: the consent ledger, the
`sms_sent_log` `'opted-out'` sentinel, active `sms_campaign_suppressions`, and
`sms_contacts` (`opted_out` or a positive HighLevel SMS DND). The check is
fail-closed on the confirmation path and on the mint, and is never run on the
decline path, because a refusal must not depend on a read succeeding. A person
who has withdrawn and then sends a genuine START is not blocked: the ledger
comparison is "latest event wins", so a fresh positive act outranks the old
STOP.

## 9. The evidence a confirmed click leaves

```
source        email_invite_confirmed_link
evidence_ref  sms_optin_invite:<uuid>
metadata.ip / metadata.user_agent   captured from the request at the click
metadata.confirmed_at               server time, never client time
```

`evidence_ref` is deliberately resolvable. Take the string, look the row up in
`sms_optin_invitations`, and it names the address the email went to, the
mailing it belonged to, when it was sent and when it was answered. "Email"
would not be a source and "clicked a link" would not be evidence.

**Resolving one when the person changed their mind.** A confirm followed by a
decline used to overwrite `response`, `responded_at`, `responded_ip` and
`responded_user_agent` in place, so an auditor following an `opt_in` event's
`evidence_ref` landed on a row saying `opt_out`, dated later, carrying the
declining device's address. The row now keeps both answers:

- `first_response` / `first_responded_*` are written by the first transition
  and never touched again;
- `response` / `responded_*` are the answer that stands today.

The consent event's own `metadata` also carries the ip, user agent and
timestamp of **its** click, so a single ledger row is defensible without
resolving anything at all.

## 10. Idempotency

Two properties, enforced in two independent places.

1. `claim_sms_optin_invitation` does `SELECT ... FOR UPDATE`, so exactly one
   concurrent caller performs the state transition. The loser is told the
   answer is already recorded rather than being handed an error.
2. Every consent write carries a `dedupeKey` of
   `sms_optin_invite:<uuid>:<response>`, and `sms_consent_events_dedupe_idx` is
   unique on `(workspace_id, dedupe_key)`. `consent.js` treats the resulting
   23505 as success.

Because of (2) the consent write is safely repeatable, which is why a repeat
click re-runs it instead of skipping it: if the first attempt claimed the row
and then died before writing to the ledger, the second click repairs the ledger
rather than inheriting the gap.

## 11. Recording consent is not permission to send

Nothing here opens a send gate. A recipient still needs
`CAMPAIGNS_LIVE_SEND_ENABLED`, `provider_approved` and `live_send_enabled` in
`sms_campaign_settings`, known-current HighLevel DND clearance, STOP clearance,
quiet hours, cadence limits and the frozen approved revision. A confirmed
invitation removes exactly one of those obstacles.
