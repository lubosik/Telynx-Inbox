# Vici Inbox Client Onboarding Guide

This is a short call-side guide for introducing a client to Vici Inbox.

## The five main areas

**Inbox** is the shared customer conversation list. Open a thread to read messages, send SMS or MMS, and handle customer replies. The unread badge falls as messages are opened.

**Contacts** stores customer details and commercial context. Search here before starting a new conversation. Contact presence does not mean promotional consent.

**Growth** contains Automations and Campaigns. Automations are established operational workflows. Campaigns are controlled promotional drafts and performance views.

**Calls** handles business calls and history. A saved contact name is shown when available; otherwise the number is used.

**Settings** contains account, appearance, notifications, team access, security, messaging and calling, campaign information, integrations, diagnostics, help, and app information.

## Campaign review and approval

Campaigns begin as drafts. An Admin reviews why each customer qualifies, the exact audience, exclusions, the exact message, and timing. Editing a material detail creates a new revision that must be reviewed again.

Approval never silently sends a campaign. Current consent, opt-out state, quiet hours, frequency limits, product relevance, and other suppressions are checked again before any future delivery. A customer can be part of the approved snapshot and still be skipped safely at send time.

The first release keeps live promotional delivery disabled until provider approval and operational readiness are explicitly recorded. The app shows that state honestly.

## Analytics and attribution

Analytics answers what measurable value the communications system is supporting.

- **Direct** means the app action and resulting payment or order can be clearly connected.
- **Strong** means identity, timing, and authoritative order evidence strongly connect them, without explicit direct confirmation.
- **Influenced** means the app probably helped, but causation cannot fairly be claimed.
- **Unattributed** means the evidence is insufficient. It remains visible for trust and is not forced into a stronger category.

Campaign detail shows recipient, delivery, reply, order, revenue, refund, conversion, opt-out, failure, and suppression metrics only when real evidence exists. Provider acceptance is not counted as delivery.

## Roles

An **Admin** can create and edit campaign drafts, submit them, approve or reject frozen revisions, schedule when live delivery is explicitly enabled, cancel, and view financial analytics.

A **Support Agent** can work in Inbox, Contacts, calling, and approved day-to-day areas. Campaign access is read-only. They cannot modify an audience, approve, schedule, launch, cancel, or enable delivery.

Server permissions enforce these boundaries. Hidden buttons are convenience, not the security control.

## Activity and notifications

Activity records important team and campaign-level decisions such as draft creation, edits, approval, rejection, scheduling, and cancellation. It does not flood the feed with one entry per recipient.

Message and call notifications follow each user’s iPhone permission and app settings. When campaign-ready notifications are enabled in a future release, only users with the appropriate review permission should receive them, and a tap should open the exact campaign.

## First-time tour

A genuinely new named account sees a role-aware tour on its first authenticated session. Completing or skipping it is stored on the server, so reinstalling the app or using another iPhone does not restart it. Existing accounts are not interrupted. The tour can be replayed from Settings without changing the saved completion state.

## Consent responsibility

The client business is responsible for collecting valid customer consent for its messages and call recording where required. Vici Inbox stores and checks supplied consent evidence, honors revocation, and fails closed when promotional consent is missing or uncertain. Orders, contacts, transactional messages, and phone numbers are never treated as automatic promotional consent.

## Before a client starts

Confirm the client’s team roles, notification permissions, business timezone, quiet hours, consent evidence source, provider approval, sending limits, integration health, and escalation owner. Test messaging and calling with internal identities that are excluded from analytics. Do not enable promotional delivery until the provider and compliance checks are complete.
