# Handoff — Vici Inbox, state of play

Written 22 August 2026 for the agent picking up **Campaigns**. Everything below
was verified against the live codebase and the running production service, not
recalled. Read `AGENTS.md` first; it holds the architecture rules.

The previous handoff in this file (two call-routing bugs, 6 August) is done and
has been removed.

---

## Who built what

**You (Codex) built Analytics**, in the release before this one. It is live and
must not be broken. Its methodology, architecture and provisional historical
audit are in `docs/analytics/`. Read `REVENUE-ATTRIBUTION-METHODOLOGY.md` before
touching anything that displays or attributes revenue.

**Claude Code built, in this session:** named accounts and roles, the Activity
Center, team invitations, release notifications, and the iOS navigation
restructure. All merged and deployed. Details below.

Nothing in this session altered attribution logic. `/api/analytics/*` now
requires the `analytics.read` permission, which Owner and Admin hold and Support
Agent does not. That is the only change to the Analytics surface.

---

## What exists now

Numbers are current as of this file:

| | |
|---|---|
| Tests | 439 passing, 0 failing, fully offline (no sockets, no DNS) |
| Route policy | 66 entries, 29 distinct permissions, strict bijection with mounted routes |
| Audit event types | 36, of which 6 reserved and 2 consent-bearing |
| Files | 26 routes, 35 lib modules, 39 test files |

### Accounts and roles — `docs/team/RBAC.md`
Four roles: `owner`, `admin`, `agent` ("Support Agent"), `legacy`. Enforcement is
server-side from one declarative table, `lib/route-policy.js`, with **default
deny** — an `/api` path with no entry is refused, so a new endpoint cannot ship
open by omission. `test/route-policy.test.js` asserts a bijection in both
directions and fails CI if the table and the mounted routes disagree.

Nothing authority-bearing lives in the cookie. There is no role field to forge;
identity is read from the database per request.

The shared `INBOX_PASSWORD` still works and resolves to one named "Team"
identity whose role comes from `LEGACY_SHARED_ROLE` (currently `admin`).
Retiring it is an environment-variable flip, not a deploy.

An Owner may promote someone to Owner but may not edit or deactivate a peer
Owner (409 `CANNOT_MODIFY_PEER_OWNER`). Multiple Owners are permitted.

### Activity Center — `docs/team/ACTIVITY-CENTER.md`
Append-only `sms_audit_log`, read at `/api/audit`, surfaced in the iOS app behind
the Account button. Immutable via trigger plus revoked grants; the docs are
explicit that this is tamper-**resistance**, not tamper-**evidence**, because
the backend holds the service-role key.

**Message bodies are never stored** — only a length and a sha256 digest, plus a
reference by id. The table has `REVOKE DELETE`, so putting customer content in
it would convert an erasure request into an incident.

**Name collision, important:** `routes/activity.js` and `/api/activity/*` are the
scheduled-SMS **queue**, not the audit trail. The audit trail is `/api/audit`.
The live route was deliberately not renamed.

### Campaigns — `docs/campaigns/APPROVAL-MODEL.md`
**Read this before writing any campaign code.** The owner has closed the
approval question: every campaign requires human approval, an Admin may
hand-edit the draft before approving, a Support Agent may read but never
approve, edit, launch or cancel. **There is no autonomous mode.**

Already reserved and deliberately not implemented:
- Audit types `campaign.created`, `.edited`, `.approved`, `.scheduled`,
  `.launched`, `.cancelled` exist and **throw if emitted**, so nothing can
  quietly start writing campaign activity early. `.approved` and `.launched`
  are consent-bearing.
- `campaign.suggestion.sent` and `.dismissed` are live and belong to the
  existing AI suggestion feature, not to this.
- The `campaigns` category exists in the CHECK constraint.
- The Growth tab has a Campaigns section that states plainly it is not built.

**Not created on purpose:** the `campaigns.*` permission keys. They land with
their routes, or the bijection test stops meaning anything.

### Other subsystems touched
- Invitations by email through the existing Maton Gmail connection, sending as
  `support@vicipeptides.com`. No DNS changes; Gmail's own SPF and DKIM apply.
- Invitations open the **iOS app** via universal links. `/accept-invite` serves a
  standalone page, not the React app. Inviting someone also adds them as a
  TestFlight tester through the App Store Connect API.
- Release notifications fire automatically on every TestFlight build, targeted by
  build staleness. `docs/notifications/RELEASE-NOTIFICATIONS.md`.

---

## Constraints that will fail the build

Each is enforced by a test, or learned from a production incident here.

1. **No unbounded `.in()`.** A computed array serialised into a Supabase `.in()`
   overflows the URL and took the whole inbox down on 20 August 2026. Use
   `selectIn()` from `lib/fetch-all-rows.js`, which chunks at 200.
   `test/no-unbounded-in.test.js` scans recursively.
   **A campaign audience is exactly this shape.**
2. **Unpaged Supabase reads silently cap at 1,000 rows.** An audience query that
   "returns everyone" quietly returns the first thousand.
3. **Never `.catch()` a Supabase query builder.** It is a thenable with no
   `catch`; calling it throws *before* the query is sent and skips every
   following statement. This silently broke the opt-out path in this app and its
   Shore fork. `test/no-builder-catch.test.js` guards it.
4. **Opt-out is checked before every send**, and must be re-checked **at send
   time** for a campaign, not only when the audience was built.
5. **Every new `/api` endpoint needs a `lib/route-policy.js` entry**, and any
   route flagged `audit: true` must actually write an audit row — a test
   enforces both.
6. **Audit writes must never break the operation they describe**, except
   consent-bearing ones, which must fail the action if they cannot be recorded.
   The missing-schema check runs *before* the consent throw, deliberately.
7. **All AI calls go through `lib/openrouter-private.js`.** Direct provider calls
   are forbidden; the boundary enforces PII tokenisation and approved providers.
8. **Tests are offline.** No sockets, no DNS.
9. **`public/app.js` is a committed build artifact.** Run `npm run build` after
   editing `public/app.jsx`; CI diffs them.
10. **The Xcode project is generated.** Run `python3 ios/scripts/generate-xcodeproj.py`
    after adding a Swift file. Also run `swiftc -typecheck` on the Foundation
    layer — `-parse` is syntax-only and has let two errors reach CI.

---

## Data available for campaign targeting

All live in Supabase. Counts as of this file:

| Table | Rows | Use |
|---|---|---|
| `sms_orders` | 1,623 | reorder cadence, payment status, delivery dates, `items`, `total` |
| `sms_contacts` | 922 | identity, `last_seen`, `woo_customer_id`, location |
| `sms_messages` | 2,715 | full history — the "asked but never bought" signal |
| `sms_sent_log` | 1,391 | every automated send, deduped by `(order_id, flow_type)` |
| `call_logs` | 135 | call outcomes |

`routes/catchup.js` is the closest existing bulk-send analogue; read it for the
rate-limiting shape before writing a campaign sender. Telnyx throttles, and a
campaign to hundreds of people needs a real queue rather than a loop.

---

## Open questions the campaign instructions should settle

1. Does approving **schedule**, or **send immediately**?
2. Is the audience **frozen at approval** or **recomputed at send**? They differ
   for anyone who orders, or opts out, in between.
3. Should a large enough audience require a **second Admin's** approval?
4. Who writes the message — template with merge fields, or AI-generated copy an
   Admin edits?
5. Is a campaign **one send to a fixed audience**, or a **standing rule** that
   keeps firing as customers become eligible? The second is much closer to
   autonomous than it sounds and sits awkwardly against the approval decision.
6. **Frequency capping.** There is no global per-customer send cap today.
7. How is campaign revenue attributed? Extend the existing methodology in
   `docs/analytics/`, do not invent a parallel scheme.

---

## Known gaps, stated rather than hidden

- **The iOS app has no change-password screen.** An admin-created account with a
  temporary password can sign in and then be refused by every screen. Invitees
  are unaffected. Should be built.
- **`push_subscriptions` has no RLS** and now carries a `userId`. Needs its own
  deliberate migration. Several older tables (`call_logs`, `sms_sent_log`,
  `sms_messages`, `sms_contacts`) are also unmanaged.
- **No forgot-password flow** anywhere in the service.
- **`POST /api/invitations/:id/resend`** needs the caller to supply the original
  token, because only its sha256 is stored.
- **Same-domain universal links do not re-open the app** — an iOS design
  behaviour, documented on the fallback page.
- **CRLF header injection in `vici-revenue-engine`** (a different repo, live):
  `core/maton-email-client.js` interpolates recipient and subject straight into
  RFC822 headers, and subjects carry customer-supplied first names from
  WooCommerce. `lib/email.js` in this repo has the `headerSafe()` fix to port.
