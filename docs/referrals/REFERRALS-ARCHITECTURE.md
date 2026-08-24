# Conversation Referrals

Conversation referrals are an internal handoff layer over the existing shared
business-number inbox. They do not create a second conversation, change the
customer-visible thread, or send a customer message.

## Data model

`sms_conversation_referrals` holds the current state for one handoff. The
conversation identity is the same E.164 `contact_phone` already used by
`sms_contacts` and `sms_messages`; the application does not have a separate
conversation table. A partial unique index permits only one `pending` or
`owned` referral for a phone in a workspace.

`sms_conversation_referral_events` is the append-only history. Create, claim,
reassign, hand-back, and resolve each add a named-actor event in the same
database transaction as the state transition. Update, delete, and truncate are
blocked. The event note is internal referral context, not an SMS.

The tables have RLS enabled with no client policies. Direct table reads and all
transition RPCs are service-role only. The migration is additive and
re-runnable.

## Permissions and eligibility

The closed permissions are `referral.read`, `referral.create`, and
`referral.act`. Owner, Admin, and Support Agent receive them. The legacy shared
identity receives none and is independently refused in SQL and in the service.

A recipient must be an active, named account with effective
`conversation.read`, `message.send`, `referral.read`, and `referral.act`.
Directed referral is the default workflow. “Any Admin” must be explicitly
selected and targets eligible Owner/Admin accounts only.

Support Agents see referrals they created, were targeted by, or own. Owners and
Admins can inspect referrals for oversight, because they can resolve or
reassign stuck work. The default list query remains participant-focused;
`oversight=true` is an explicit Owner/Admin view.

## Ownership transitions

All transitions are database-owned SECURITY DEFINER functions:

- Create inserts a pending directed or any-admin referral and its event.
- Claim is one conditional `UPDATE ... WHERE state = 'pending' AND owner IS
  NULL`. Concurrent claimants cannot both win; the loser receives a conflict.
- Reassign transfers an owned referral directly to one eligible person.
- Hand Back is a separate transition to the original referrer and requires an
  internal note. Generic reassign cannot bypass it.
- Resolve is available to the current owner or an Owner/Admin. It releases the
  partial unique constraint so a later referral for the conversation can be
  created.

The `version` increments on every state transition and is included in audit
fingerprints.

## API

The authenticated routes are:

- `GET /api/referrals/recipients`
- `GET /api/referrals`
- `GET /api/referrals/:id`
- `POST /api/referrals`
- `POST /api/referrals/:id/claim`
- `POST /api/referrals/:id/reassign`
- `POST /api/referrals/:id/hand-back`
- `POST /api/referrals/:id/resolve`

Every route is declared in `lib/route-policy.js`. Mutations write the Activity
audit after the atomic database effect. The immutable audit stores only
referral IDs, state, target/owner IDs, and whether a note exists. It never
stores the raw note. The append-only referral event ledger remains the
authoritative transition record if an audit insert is temporarily unavailable.

## Notification safety

Referral pushes target only devices owned by the prepared user IDs. Unowned
compatibility devices are excluded. The `referrals` account preference defaults
to true but fails closed if preferences cannot be read. Real delivery is also
held off unless `REFERRAL_NOTIFICATIONS_ENABLED=true` exactly; referral state
and Activity events still work while the flag is off.

The push carries the referral ID and existing conversation phone, so the shared
typed iOS router can open that thread directly. It carries no badge. APNs
failure never rolls back an already-created or transitioned referral.

## The not-sendable boundary

No file under `lib/referrals/` and no referral route imports the outbound send
route, Telnyx, GHL, or writes `sms_messages`. Internal notes enter only the
referral RPC and the short-lived prepared APNs payload. The static regression
test in `test/referrals-migration.test.js` makes an accidental outbound
dependency a CI failure.

## Deployment sequence

1. Apply `scripts/referrals-migration.sql` with the Supabase service role.
2. Re-apply `scripts/notification-preferences-migration.sql` to add the
   `referrals` preference column on existing installations.
3. Deploy the backend with `REFERRAL_NOTIFICATIONS_ENABLED=false`.
4. Ship and validate the iOS recipient picker, lifecycle UI, typed deep link,
   and notification preference.
5. Dry-run APNs targeting for directed and any-admin cases.
6. Only after that validation, separately approve the feature flag change to
   `true`.

The migration must precede the backend deploy because startup validates every
route-policy permission against the database catalogue and fails closed when a
key is missing.

## Regression coverage

Offline tests cover the partial uniqueness contract, conditional atomic claim,
legacy refusal, recipient eligibility, participant visibility, hand-back note,
Activity redaction, default-off APNs delivery, preference veto, unowned-device
exclusion, deep-link payload, and the prohibition on outbound messaging.
