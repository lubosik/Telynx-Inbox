# Account-Owned Onboarding Architecture

## Purpose

The guided tour is offered automatically only to a genuinely new, named user.
It is not an install counter and it is not a device preference. The backend
account record is the positive source of truth, while a small local negative
cache prevents a temporary network failure from repeatedly interrupting a user
who already completed or skipped the tour.

The shared legacy login is never eligible because more than one person can use
that identity.

## State model

`sms_users` stores:

| Field | Meaning |
| --- | --- |
| `onboarding_status` | `not_started`, `completed`, `skipped`, or `ineligible` |
| `onboarding_version` | Internal version of the first-run tour |
| `onboarding_decided_at` | Time completion, skip, or legacy exclusion was recorded |

`not_started` is the only status that can make a user eligible. The response
must also say `eligible: true`. Missing data, malformed data, an older backend,
and a failed request all remain ineligible on the client.

## Existing and future accounts

The migration first adds `onboarding_status` with an `ineligible` default. This
protects every row that already exists. It then changes the default to
`not_started`, so accounts created after the migration are eligible without
requiring each creation path to remember a special flag.

This ordering matters. Adding the column with `not_started` would incorrectly
treat every existing owner, administrator, and support agent as a first-time
user after an app update.

## API contract

`GET /api/users/me` may include:

```json
{
  "onboarding": {
    "status": "not_started",
    "version": 1,
    "eligible": true,
    "decidedAt": null
  }
}
```

The envelope is omitted when state cannot be loaded safely. Clients must never
infer eligibility from its absence.

`POST /api/users/me/onboarding` accepts:

```json
{
  "status": "completed",
  "version": 1,
  "userId": "42"
}
```

Only `completed` and `skipped` are client decisions. Authority always comes
from the authenticated actor. `userId` is an optional optimistic identity check
and never selects the database row to update.

The database transition is atomic and idempotent. The first terminal decision
wins. Repeating that same decision succeeds; trying to replace `skipped` with
`completed`, or using a stale version, returns a conflict.

## iOS behavior

1. An explicit successful sign-in can show the short premium welcome.
2. The coordinator starts an automatic tour only when the signed-in named user
   has `eligible: true`, `status: not_started`, and a positive version.
3. Tour steps are built from effective permissions, not just a role label.
4. Completion or skip writes a local suppression marker immediately, dismisses
   the UI, then persists the decision to the server.
5. If that best-effort write temporarily fails, the local marker prevents a
   loop on the same device. Another device still fails closed unless the server
   positively reports eligibility.
6. Manual **Replay App Tour** does not reset or update first-run state.

The custom coordinator supports the existing iOS 16 deployment target. TipKit
can still be used for later contextual tips on newer systems, but it is not the
cross-tab tour's only implementation.

## Role and permission awareness

The administrator plan can include Growth, Campaigns, Analytics, attribution,
and account settings only when the corresponding effective permissions are
present. A Support Agent is not taught controls they cannot use, such as
campaign approval, financial Analytics, integration management, or team role
management.

Server-side RBAC remains authoritative. Hiding a tour step is usability, not an
authorization boundary.

## Privacy and security

- No message content, customer data, token, password, or device identifier is
  stored in onboarding state.
- The self-service endpoint updates only `req.actor.id`.
- The internal `SECURITY DEFINER` function is revoked from `PUBLIC`, `anon`, and
  `authenticated`; only the backend service role may execute it.
- The route-policy table explicitly lists the endpoint and otherwise fails
  closed.
- Onboarding state is returned with `Cache-Control: no-store, private`.

## Safe rollout and rollback

Roll out in this order:

1. Apply `scripts/onboarding-migration.sql`.
2. Deploy the backend endpoint.
3. Release the iOS client.

The iOS client is backward compatible with a backend that omits the envelope,
but migration-first avoids an unnecessary period where new users cannot be
recognized. Rollback may leave the additive columns and function in place;
older backend and app versions ignore them. Do not drop the columns during an
ordinary rollback because doing so would discard completed or skipped state.

## Verification matrix

| Scenario | Expected result |
| --- | --- |
| Existing account after migration | No automatic tour |
| New named account first sign-in | Welcome and one automatic tour offer |
| Complete tour | Server stores `completed`; no automatic replay |
| Skip tour | Server stores `skipped`; no automatic replay |
| Second session | No automatic tour |
| App reinstall | No automatic tour |
| Same account on another iPhone | No automatic tour |
| Sign out and explicit sign-in | Welcome allowed; automatic tour remains suppressed |
| Shared legacy login | Never eligible |
| Missing or malformed server state | No automatic tour |
| Replay App Tour | Runs manually without changing first-run state |

