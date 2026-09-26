# VIP customers

## Permanent definition

Vici's Best Repeat Customers audience is:

- at least 3 distinct paid orders; and
- at least $500 in lifetime paid-order spend.

Both conditions must be true. The accepted paid states are the same states used
by the existing segment facts engine: processing, completed, shipped, and
delivered. Failed and cancelled orders do not count.

This is a commercial-history label, not permission to contact somebody. SMS
consent, STOP and suppression state, DND, quiet hours, and campaign cadence are
still evaluated by their existing systems at send time.

## One customer, two inbox views

All Customers and VIP are two views of the same canonical conversation list.
They do not create a second contact, a second message thread, or copied order
history. Opening a customer from either view reaches the same conversation and
uses the same one-to-one reply flow.

The server computes the automatic tier from current authoritative `sms_orders`
on every inbox read. A manager may also force-include an existing contact using
the automatic segment's existing audited override ledger. Removing that manual
include is allowed only when the customer does not also meet the automatic
rule.

## Attention and progress

VIP state is a prioritisation aid, not a purchase or dosing claim:

- Active: the customer is within their own reliable observed purchase cadence,
  or there is not enough history to calculate a cadence.
- Due soon: time since the last paid order is over their median observed gap.
- Needs attention: time since the last paid order is over 1.5 times that gap.

The inbox never tells an operator that a customer is running low, needs a dose,
or should change a regimen. Cadence is used only to order human attention.

Standard customers can carry one factual progress label:

- One order from VIP: 2 paid orders and at least $500 spend.
- High-value first order: 1 paid order and at least $500 spend.
- Building VIP value: at least 3 paid orders and under $500 spend.

## Workbook evidence and limitations

`Vici_Repeat_Customers.xlsx` was used as historical design evidence, not as an
import or a second source of truth. Its snapshot contained 1,089 unique billing
email customers through 2026-09-22. Repeat buyers were 31.2% of customers and
55.7% of revenue. Applying the permanent 3-order and $500 rule to that snapshot
identified 96 VIP customers and $86,850 of historical revenue.

The workbook has no phone number, stable Woo customer id, consent, refund, or
currency fields, so it cannot safely create or update production contacts. Live
membership always comes from the application's current contact and paid-order
records.

## Analytics leaderboard

Analytics contains a separate VIP Top 10 view. It ranks only VIP customers who
placed a paid order in the selected date range and recalculates whenever paid
orders change. The score is transparent and gives equal weight to paid-order
frequency, total paid spend, and average paid order value within that period.
Today, week, month, quarter, year, all-time and custom filters use the store's
configured timezone. Staff/test identities configured in Analytics exclusions,
failed/cancelled orders, and duplicate order webhook rows never enter the score.

The ranking is a prioritisation aid. It does not change VIP membership, consent,
suppression, or who may be messaged.

## Deployment

Apply `scripts/vip-customer-segment-migration.sql` once. It is repeatable and
creates the stable automatic segment without sending anything. Recompute that
segment through the existing segment service after applying it so Growth and
campaign audience selection receive the same membership the inbox displays.
