# Production UI Guidelines

## Product character

Vici Inbox should feel calm, capable, and commercially focused. The interface uses the existing Vici teal and mint palette, native SwiftUI controls, clear hierarchy, and restrained motion. It should not resemble an enterprise BI dashboard or advertise implementation details such as models, queues, providers, or AI.

## Navigation

Keep the iPhone tab bar at five primary destinations. Inbox, Contacts, Growth, Calls, and Settings remain the top-level structure. Automations and Campaigns live inside Growth, preserving existing muscle memory and avoiding an iOS More tab.

Deep links and onboarding steps must select the correct top-level tab before presenting a child destination. A Support Agent may see Campaigns in read-only form, but the interface must never imply they can approve, schedule, or cancel.

## Hierarchy and components

- Put the most commercially meaningful number first, with a short plain-English explanation.
- Use native cards, lists, sheets, menus, date pickers, charts, and progress treatments where available on iOS 16.
- Use one primary action per decision screen. Destructive actions use a confirmation step and the system destructive role.
- Separate loading, empty, permission-denied, disabled, and failure states. An empty dataset is not an error.
- Never render sample revenue or invented campaign performance in a production path.
- Explain suppression and attribution decisions with human-readable labels while retaining machine-readable reason codes in the data layer.

## Campaigns

A campaign screen must show the opportunity, customer reasoning, exclusions, exact message, audience count, timing, revision, and approval state. The reviewed revision must be visually unambiguous. Approval does not mean sending, and the interface must say so.

When provider approval or the delivery worker is unavailable, show the honest disabled state. Do not present a Send button that cannot work. Dry-run results distinguish selected, currently eligible, and suppressed recipients. Recipient details may show an eligibility reason, but sensitive consent evidence should not be copied into general UI logs.

## Analytics

Revenue cards distinguish Direct, Strong, Influenced, and Unattributed. Do not combine Influenced revenue into a recovered-revenue headline. Every attributed total should lead toward the actual supporting orders and event sequence.

Charts adapt their bucket labels to the selected period. Use hourly points for short periods, then daily, weekly, or monthly points as the range grows. Avoid overlapping axis labels, false precision, and chart decoration that does not aid a decision.

## Appearance and accessibility

- Support System, Light, and Dark appearance, persisted locally.
- Check foreground contrast on every branded surface in both color schemes.
- Respect Dynamic Type and avoid fixed-height containers around body text.
- Add meaningful VoiceOver labels to icons, badges, charts, status pills, and unlabeled controls.
- Keep touch targets at least 44 by 44 points.
- Do not rely on color alone for status or confidence.
- Respect Reduce Motion. Decorative welcome effects must not block interaction.
- Use locale-aware currency, date, time, and number formatting.

## Copy

Use concise, natural sentences. Avoid em dashes in customer-facing app copy. Prefer terms a business owner can explain, such as “Ready for review,” “Suppressed,” and “Strong attribution.” Do not claim a provider accepted message was delivered, and do not claim revenue was generated when the evidence only supports influence.

## Manual QA checklist

Before each TestFlight release, inspect the welcome experience, Admin and Support Agent tours, Settings hierarchy, appearance controls, Campaign list/detail/audience states, Analytics hero and attribution explanation, messaging chart, empty/loading/error states, and the smallest supported iPhone in light and dark mode. A non-technical client should understand the screen without a developer narrating it.
