# Campaigns: the approval model

Decided by the owner, 22 August 2026, before any campaign code was written.
Read this before building anything under Growth → Campaigns.

## The decision

**Every campaign requires human approval before it sends. There is no
autonomous mode.**

A detected opportunity produces a *draft*: an audience, a reason, and a proposed
message. It sits in an approval queue until a person acts on it. Nothing
addressed to a customer leaves this system because a rule matched.

**An Admin may edit the draft by hand before approving it.** Not just approve or
reject — the copy, the audience and the timing are all editable. The generated
draft is a starting point, not a fait accompli.

**A Support Agent may not approve, edit, launch or cancel a campaign.** They may
read them, because a customer will reply to a campaign message and land in the
Inbox where the agent has to answer. Handling that reply requires seeing what
was sent.

## Why this is written down

The earlier planning sketched three modes — suggest-only, approval-required and
autonomous — and left the choice open. It is now closed. Autonomous sending is
not a later phase of this design; adding it would be a reversal of it, and
should be treated as one.

The reason is scale of blast radius. A campaign is the only thing in this
product that messages hundreds of customers from a single action. Every other
send is one operator typing to one person, or an order-triggered flow that
follows a transaction the customer initiated. `POST /api/catchup/send` is the
closest existing analogue and it is already the highest-risk endpoint in the
app. A rule that fires on "no order in 30 days" fires on everyone who matches,
including the people who did not order because they complained.

## What that means concretely

Permissions to add WITH the feature, not before — a permission with no route
weakens the bijection test in `test/route-policy.test.js`:

| Key | Owner | Admin | Support Agent |
|---|---|---|---|
| `campaigns.read` | yes | yes | **yes** |
| `campaigns.manage` (create, edit drafts) | yes | yes | no |
| `campaigns.approve` | yes | yes | no |
| `campaigns.launch` | yes | yes | no |
| `campaigns.cancel` | yes | yes | no |

There is deliberately no `autonomous_workflows.manage`. Reserving a permission
for a capability the owner rejected invites someone to grant it.

## Audit

`lib/audit/event-types.js` already reserves `campaign.created`, `.edited`,
`.approved`, `.scheduled`, `.launched` and `.cancelled`. They currently THROW if
emitted, so nothing can quietly start writing campaign activity before the
feature exists. Un-reserve them as each call site is built, not in one batch.

`campaign.approved` and `campaign.launched` are marked `consentBearing`. That is
not decoration: an approval is the human act that authorises a bulk send, and if
the record of it cannot be written the send must not proceed. See the ordering
note in `lib/audit/log.js` — a missing table fails open, a table that exists and
refuses the write fails closed.

Approval and launch must be separately recorded even when they happen in one
click, because "who approved this" and "when did it actually go" are different
questions and an investigation asks both.

## Not yet decided

- Whether approving a campaign schedules it or sends it immediately.
- Whether an approved audience is frozen at approval time or recomputed at send
  time. These differ for anyone who orders, or opts out, in between. Opt-outs
  must be re-checked at send time regardless of what is decided here.
- Whether a second Admin's approval is required above some audience size.
