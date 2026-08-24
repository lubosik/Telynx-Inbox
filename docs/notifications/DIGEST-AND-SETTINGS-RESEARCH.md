# Digest Notifications and Settings — Research

**Compiled:** 2026-08-24
**Scope:** Vici Inbox (SwiftUI iPhone + Node/Railway backend), adding a daily segment-change digest
**Sourcing rule used:** Apple's own docs preferred; peer-reviewed studies for behavioural claims; vendor blogs quarantined and labelled. Anything unverifiable is labelled **UNVERIFIED** or **NOT SPECIFIED BY APPLE**.

---

## 0. DECISIONS

Implement these literally. Justification for each is in the numbered section that follows.

**D1 — Interruption level per notification type**

| Notification | `interruptionLevel` | `relevanceScore` | Notes |
|---|---|---|---|
| Incoming customer SMS | `.timeSensitive` | 1.0 | Requires the Time Sensitive Notifications capability in Xcode (S1.2). Also donate `INSendMessageIntent` so it becomes a communication notification. |
| Missed call | `.timeSensitive` | 0.9 | Real inbound calls should go through PushKit/CallKit, not this path. |
| Daily segment digest | `.active` | 0.9 | Not time-sensitive. It must not break through Focus. High relevance score so it is the featured item if it lands in a Scheduled Summary. |
| Campaign proposal ready | `.active` | 0.8 | **Do not send as its own push.** Fold into the daily digest. |
| Job/engine failure (owner only) | `.active` | 0.7 | Exempt from the daily cap. |
| New TestFlight build | `.passive` | 0.1 | Must never light the screen. |

**D2 — Cadence.** One digest push per user per day, maximum. Hard-enforced in the database, not in application logic. Suppress entirely when nothing passes the materiality gates (D4). No "nothing changed today" push, ever.

**D3 — Time.** 08:30 in the recipient's own IANA timezone, Monday to Friday, user-configurable in Settings. `Europe/London` for one user, `America/New_York` for the other. Store IANA names, never UTC offsets (S4.4).

**D4 — Threshold for notifying.** A change is push-worthy only if it passes **all four** gates: Actionable, Material, Novel, Attributable (S5.2). Materiality is the conjunction of an absolute and a relative test: `delta >= 3 AND delta >= 10% of the segment's prior size`, with a lower bar (`delta >= 1`) for revenue-critical segments. Everything that fails the gates still appears in an in-app Changes feed. Suppress the digest entirely on the first run and after any bulk data import (S5.4).

**D5 — Settings screen.** Per-category toggles, **no app-level master switch** — iOS already owns the master. Read live OS state via `notificationSettings()` on every `scenePhase == .active`. When authorization is not `.authorized`, show a dismissible-but-persistent banner with a deep link to `UIApplication.openNotificationSettingsURLString`; do **not** grey out the app's own toggles. Request `.providesAppNotificationSettings` so iOS Settings links back into the app (S2.3). Server-side preference record is the source of truth for what gets sent; suppression happens on the server, never on the client.

**D6 — Scheduling mechanism.** Replace `setInterval` with **croner** (`timezone`, `protect`, and `catch` options) running a **5-minute UTC tick**, not a per-user cron. On each tick, for each user, resolve their local wall-clock time via `Intl.DateTimeFormat` and claim a row in a `digest_runs` table with a `UNIQUE (user_id, local_date)` constraint. The unique constraint is the idempotency mechanism. Use a lease (`claimed_at` / `completed_at`) so a crashed run retries but a completed one never repeats. Set `apns-collapse-id: digest-{userId}-{localDate}` as a second line of defence. Add an **external** dead-man's switch (Healthchecks.io or equivalent) — an in-process watchdog cannot detect its own process being dead (S4.5).

**D7 — Notification content.** Title in title case, no ending punctuation. Body in sentence case, complete sentences. No customer names or phone numbers in the digest. Set `threadIdentifier = "segment-digest"` and `hiddenPreviewsBodyPlaceholder = "Daily summary"`. Badge = count of pending proposals, computed server-side.

**D8 — Actions.** Ship two actions on the digest category: `REVIEW` (`.foreground`, opens the proposals list) and `SNOOZE` (background, re-delivers this evening). **Do not** ship Approve/Reject on the digest — it is technically possible but semantically ambiguous across N proposals, and approving AI-written customer-facing marketing copy sight-unseen from a Lock Screen is the wrong affordance (S1.4).

---

## 1. Apple's rules and guidance

### 1.1 Permission: when to ask, and whether `.provisional` fits

Apple's guidance is to request in context, not on first launch:

> "Make the request in context where users understand why it's needed... This provides better UX than requesting on first launch."
> — [Asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), Apple Developer Documentation (retrieved 2026-08-24)

On provisional authorization, the mechanics matter:

> "Provisional authorization... Delivered quietly without sounds, banners, or lock screen appearance. Only appear in the notification center's history. Include buttons to 'Keep' or 'Turn Off'."
> — same source

**Verdict for Vici Inbox: `.provisional` is the wrong choice.** Provisional exists so an app can prove notification value to a stranger before spending its one permission prompt. That is not this situation. Both users have signed in, use the app daily, already granted full authorization for SMS and missed calls, and the owner explicitly asked for the digest. Provisional would be a downgrade — the digest would land silently in Notification Center with no banner and no Lock Screen presence, the opposite of "opening the app to see what changed."

Note the trap in provisional: even after the user taps **Keep**, `authorizationStatus` becomes `.authorized` but the app still has no permission for alerts, sounds, or badges unless the user then changes settings. You would look authorized and be invisible.

**Do:** the digest ships under the existing authorization. Add `.providesAppNotificationSettings` to the options set (S2.3). If a third user is ever onboarded, request `[.alert, .sound, .badge, .providesAppNotificationSettings]` at the moment they flip the digest toggle on — that is "in context."

Authorization states to handle: `.notDetermined`, `.denied`, `.authorized`, `.provisional`, `.ephemeral` ([UNAuthorizationStatus](https://developer.apple.com/documentation/usernotifications/unauthorizationstatus), retrieved 2026-08-24). Treat both `.authorized` and `.provisional` as "will deliver something," and check the granular settings separately.

### 1.2 Interruption levels

Apple defines four, and the HIG gives an explicit behaviour matrix:

| Level | Overrides Scheduled Delivery | Breaks through Focus | Overrides Ring/Silent |
|---|---|---|---|
| Passive | No | No | No |
| Active (default) | No | No | No |
| Time Sensitive | Yes | Yes | No |
| Critical | Yes | Yes | Yes |

— [Managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications), Apple HIG (retrieved 2026-08-24)

Apple's descriptions:

> **Passive:** "Information people can view at their leisure, like a restaurant recommendation."
> **Active:** "Information people might appreciate knowing about when it arrives, like a score update on their favorite sports team."
> **Time Sensitive:** "Information that directly impacts the person and requires their immediate attention, like an account security issue or a package delivery."
> **Critical:** "Urgent information about health and safety... Critical notifications are extremely rare and typically come from governmental and public agencies or apps that help people manage their health or home."
> — same source

And the warning that maps directly onto the risk here:

> "Build trust by accurately representing the urgency of each notification. People have several ways to adjust how they receive your notifications — including turning off all notifications — so it's essential to be as realistic as possible when assigning an interruption level."
> "Use the Time Sensitive interruption level only for notifications that are relevant in the moment."
> "Never use the Time Sensitive interruption level to send a marketing notification."
> — same source

**Applying this:**

- **Incoming customer SMS -> `.timeSensitive`.** A customer message in a two-person business inbox is "relevant in the moment"; the cost of a two-hour delay is real. This is the honest use of the level.
- **Daily segment digest -> `.active`.** It is emphatically not relevant in the moment. It is a scheduled summary of things that already happened. Using `.timeSensitive` here would break through the owner's Focus for a report, and per Apple's own framing, that is how an app earns a global mute.
- **Campaign proposals -> `.active`, and inside the digest.** An AI-generated marketing proposal is close enough to a marketing notification that the HIG's explicit prohibition applies in spirit even if the recipient is the business owner rather than a consumer.
- **`.critical` is off the table.** It requires an Apple-approved entitlement and is reserved for health and safety.

**Entitlement note (implementation blocker):** `.timeSensitive` requires enabling the Time Sensitive Notifications capability in Xcode. Per Apple's WWDC21 session "Send communication and Time Sensitive notifications," you enable the capability in Xcode; unlike Critical, it does **not** require a separate Apple approval request ([WWDC21 session 10091](https://developer.apple.com/videos/play/wwdc2021/10091/)). Neither the [interruptionLevel](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/interruptionlevel) property page nor the enum page states the entitlement requirement — **this is documented in the WWDC session and Xcode capability list, not in the API reference**, which is why it is easy to miss.

For remote pushes, set `"interruption-level": "time-sensitive"` (or `"passive"` / `"active"` / `"critical"`) inside the `aps` dictionary.

Also check `settings.timeSensitiveSetting` before relying on it — the user can turn Time Sensitive off per-app ([UNNotificationSettings](https://developer.apple.com/documentation/usernotifications/unnotificationsettings), retrieved 2026-08-24).

### 1.3 Grouping, `threadIdentifier`, and summary text

> "You may specify any value for the string, but assign the same thread identifier string to all notifications that you want to group together visually."
> — [UNMutableNotificationContent.threadIdentifier](https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/threadidentifier), iOS 10.0+ (retrieved 2026-08-24)

`categorySummaryFormat` on `UNNotificationCategory` (iOS 12.0+) supplies the localized summary line for a group, with `%u` standing in for the count of grouped notifications ([categorySummaryFormat](https://developer.apple.com/documentation/usernotifications/unnotificationcategory/categorysummaryformat), retrieved 2026-08-24).

**Important gotcha.** The other half of the classic summary-format pattern is dead:

> `summaryArgument` — **Deprecated in iOS 15.0**. Deprecation message: *"summaryArgument is ignored."*
> — [UNNotificationContent.summaryArgument](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/summaryargument) (retrieved 2026-08-24)

So the older `"%u more messages from %@"` pattern no longer substitutes the `%@`. **Use `%u` only.** Apple does not document a replacement for the argument portion.

**UNVERIFIED:** `categorySummaryFormat` has not been device-tested on iOS 18 or iOS 26. The property page carries no deprecation notice, so `%u` should still render, but confirm on hardware before relying on the exact string.

**Honest assessment for this case:** at one digest per day, grouping barely engages. It matters only if the owner leaves several days of digests uncleared. Set `threadIdentifier = "segment-digest"` and a `categorySummaryFormat` of `"%u more daily summaries"` because it costs nothing and is correct — but do not treat grouping as the mechanism that solves digest volume. **The digest itself is the grouping mechanism.** Batching server-side (one push containing five facts) is strictly better than five pushes that iOS visually stacks, because the stack still fires five times.

Related but separate: `relevanceScore` (0.0 to 1.0, iOS 15+) determines which of your notifications gets featured in the system's Scheduled Summary — "The highest score gets featured in the notification summary" ([relevanceScore](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/relevancescore), retrieved 2026-08-24). Because `.active` does not override Scheduled Delivery, a user with Scheduled Summary enabled may see the digest held until their summary window. Set the digest's score high (0.9) so it leads that summary.

### 1.4 Categories, actions, and Approve/Reject

Yes, technically supported. Apple's HIG:

> "A notification can present a customizable detail view with **up to four buttons** for actions without opening the app."
> — [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications), Apple HIG (page last updated 2023-10-24, retrieved 2026-08-24)

Mechanics ([Declaring your actionable notification types](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types), retrieved 2026-08-24):

- Actions are registered **client-side** via `UNUserNotificationCenter.setNotificationCategories(_:)` at launch. The push payload only carries `"category": "IDENTIFIER"`. If the client has not registered the category, you get a plain notification with no buttons and no error.
- Action options: `.foreground` (launches the app), `.destructive` (distinct appearance), `.authenticationRequired` (must unlock first).
- `UNTextInputNotificationAction` for typed replies — useful for the SMS notification, not the digest.
- All action identifiers must be unique across all categories.
- On Apple Watch Series 9 / Ultra 2 and later, Double Tap invokes **the first non-destructive action**, so ordering has real consequences.

Apple's own guidance argues against a bare "open the app" button:

> "Don't provide an action that merely opens your app. Tapping a notification already displays related content."
> — HIG, Notifications

**Recommendation: do not put Approve/Reject on the digest.** Three reasons, in order of weight:

1. **Semantic ambiguity.** The digest says "2 proposals waiting." Approve *which*? A per-notification action cannot address N items. You would have to send one push per proposal, which defeats the entire digest design.
2. **Judgement risk.** These proposals are AI-generated marketing campaigns that will go out to real paying customers. A one-tap Approve from a Lock Screen, with no visibility of the copy, is a defect dressed as a convenience. If it ever ships, gate it with `.authenticationRequired`.
3. **Execution fragility.** A non-`.foreground` action launches the app into the background with limited execution time to complete the network round-trip in `userNotificationCenter(_:didReceive:withCompletionHandler:)`. On a poor connection the approve call fails after the notification has already been dismissed, and the user believes they approved something they did not.

Ship instead: `REVIEW` (`.foreground`, deep-links to the proposals list) and `SNOOZE` (background, reschedules a local notification for 18:00 local). If a single-proposal notification is ever added later, Approve/Reject on *that* is defensible.

### 1.5 Rate limits, throttling, and budget

This is widely misunderstood, so be precise about which limit applies to what.

**Background pushes — Apple publishes a number:**

> "The system treats background notifications as low priority... the system may throttle the delivery of background notifications if the total number becomes excessive. The number of background notifications allowed by the system depends on current conditions, but **don't try to send more than two or three per hour**."
> — [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app) (retrieved 2026-08-24)

**Alert pushes — Apple publishes no rate limit.** No stated cap, quota, or budget on `apns-push-type: alert` volume per app or per device was found. **NOT SPECIFIED BY APPLE.** Do not generalise the "two or three per hour" figure to alert pushes; it is scoped to background notifications.

What Apple *does* document about APNs behaviour ([Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), retrieved 2026-08-24):

- APNs is best-effort with **no delivery guarantee**.
- Notifications sent with `apns-priority` 5 or 1 "may be grouped and delivered in bursts," and "may be throttled, saved in storage, and in some cases not delivered."
- Historically APNs stored only one notification per bundle ID for an offline device. Apple's June 2024 update added an offline queue store allowing multiple notifications per bundle ID, keyed by `apns-collapse-id` ([UserNotifications updates](https://developer.apple.com/documentation/updates/usernotifications), retrieved 2026-08-24).
- `apns-collapse-id` (max 64 bytes): *"An identifier you use to merge multiple notifications into a single notification for the user... When sending the same notification more than once, use the same value in this header to merge the requests."* — use this for digest idempotency.
- Payload limit: 4096 bytes for standard alerts.
- Priority 10 = immediate (default), 5 = power-considerate, 1 = maximum power saving. `background` push type **must** use priority 5; priority 10 is an error.

**Practical conclusion.** Apple is not the rate limiter here. Two users receiving one digest per day is nothing. The rate limiter is the human being and, secondarily, App Review guideline 4.5.4's "Abuse of these services may result in revocation of your privileges." Budget against the person, not the platform.

### 1.6 What App Review expects

The governing rule, verbatim:

> **4.5.4 Push Notifications.** "Push Notifications must not be required for the app to function, and should not be used to send sensitive personal or confidential information. Push Notifications should not be used for promotions or direct marketing purposes unless customers have explicitly opted in to receive them via consent language displayed in your app's UI, and you provide a method in your app for a user to opt out from receiving such messages. Abuse of these services may result in revocation of your privileges."
> — [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (retrieved 2026-08-24)

And relatedly:

> **5.1.2(i)** "Your app may not require users to enable system functionalities (e.g. push notifications, location services, tracking) in order to access functionality, content, use the app, or receive monetary or other compensation."

**Is the in-app toggle required or merely good practice?** Two different answers, and the distinction matters:

- **The HIG states it as a requirement, in mandatory language:**
  > "Make sure people can manage their notification settings within your app. In addition to requesting permission to send informational or marketing notifications, **you must also provide an in-app settings screen that lets people change their choice**."
  > — [Managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications), Apple HIG (retrieved 2026-08-24)

  Note the scope: "informational **or** marketing." A segment digest is informational. This applies.

- **Guideline 4.5.4 requires an in-app opt-out only for promotional/marketing pushes.** Whether the digest counts as "marketing" is arguable — it is operational data about the recipient's own business, delivered to the business owner, not a promotion aimed at a consumer. On a plain reading, 4.5.4's marketing clause is **not** triggered.

**Bottom line:** build the toggle. The HIG says you must, it is the right product decision anyway, and the ambiguity in 4.5.4 is not worth litigating with a reviewer. **UNVERIFIED:** no published data was found on whether App Review actually rejects apps for the absence of an in-app notification settings screen. No enforcement pattern is asserted here.

Two more content rules from Apple that bind the digest copy:

> "Never include sensitive, personal, or confidential information in notifications. People could be doing anything when they receive a notification, and private information may be visible to others." — HIG, Notifications

Combined with 4.5.4's "should not be used to send sensitive personal or confidential information," this rules out putting **customer names or phone numbers in the digest body**. Counts and segment names only. (The incoming-SMS notification is different — the preview is the point — but set `hiddenPreviewsBodyPlaceholder` so it degrades to "New message" when previews are off.)

> "Don't send multiple notifications for the same thing, even if someone hasn't responded. Multiple notifications fill up Notification Center and may cause users to disable all notifications from your app." — HIG, Notifications

This is Apple stating the exact failure mode. It is the direct textual basis for the Novelty gate in S5.2.

### 1.7 iOS 18 / iOS 26 specifics

- **Apple Intelligence Notification Summaries** (iOS 18.1+, capable devices): the system may rewrite or condense a notification. Users control it per-app in Settings > Notifications > Summarize Notifications > Choose Notifications to Summarize ([Apple Support: Summarize notifications](https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios), retrieved 2026-08-24). **No developer API to opt a notification out of summarization was found — NOT SPECIFIED BY APPLE / UNVERIFIED.** Mitigation: front-load the single most important number in the first sentence and keep the body to one or two short sentences, so that a lossy summary is still correct.
- **`UNNotificationAttributedMessageContext`** — iOS 26 addition allowing Genmoji and image glyphs in *communication* notifications. Relevant only to the SMS path, not the digest. **UNVERIFIED** beyond a developer-forum reference surfaced in search; the API reference page could not be retrieved.
- **No** iOS 26 changes affecting interruption levels, grouping, `threadIdentifier`, or the settings-deep-link APIs were found. The documented June 2024 UserNotifications changes (offline queue store, multiple pushes per bundle ID via `apns-collapse-id`, Live Activity broadcast) remain the most recent material server-side changes.

---

## 2. The settings pattern

### 2.1 Per-category toggles, no app-level master

**Do not build an app-level master switch.** iOS already provides one, in Settings > Vici Inbox > Allow Notifications. Duplicating it gives three states to reconcile (OS permission, app master, app category) and creates a scenario where the app says "Notifications: On" while iOS is silently dropping everything.

Structure:

```
Notifications
- [Banner — shown only when authorizationStatus != .authorized]
     "iOS is blocking notifications from Vici Inbox."
     [ Open iOS Settings ]

- CONVERSATIONS
     Incoming messages ................. [on]
     Missed calls ...................... [on]

- DAILY DIGEST
     Daily digest ...................... [on]
     -- shown only when on --
     Delivery time ................ 08:30
     Time zone .......... Europe/London     (read-only, from account)
     Weekdays only ..................... [on]
     Include segment changes ........... [on]
     Include campaign proposals ........ [on]

- APP
     New TestFlight builds ............. [off]

- "Sounds, banners, and Lock Screen appearance are managed by iOS."
  [ Open iOS Notification Settings ]
```

Why this shape:
- **Categories match the user's mental model of *kinds of events*, not of delivery mechanics.** Delivery mechanics belong to iOS; do not rebuild a sound picker.
- **Delivery time lives here, not in iOS**, because it is a scheduling parameter, not an OS setting. This is the one genuinely app-owned control on the screen.
- **Timezone is displayed read-only.** Showing it prevents the single most likely support question ("why did it arrive at 3am") and makes the London/Miami difference visible.

### 2.2 Deep-linking to iOS Settings

```swift
if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
    await UIApplication.shared.open(url)
}
```
— [UIApplication.openNotificationSettingsURLString](https://developer.apple.com/documentation/uikit/uiapplication/opennotificationsettingsurlstring), **iOS 16.0+** (retrieved 2026-08-24)

This lands directly on the app's Notifications pane, which is better than `openSettingsURLString` (the app's root settings page, one extra tap). The older `UIApplicationOpenNotificationSettingsURLString` constant is deprecated. For iOS 15 or earlier, fall back to `openSettingsURLString` — but iOS 16 is a safe floor for an app targeting 18/26.

### 2.3 The reverse link — the part most apps miss

Request `.providesAppNotificationSettings` in the authorization options:

> **`providesAppNotificationSettings`** (iOS 12.0+) — "An option indicating the system should display a button for in-app notification settings."
> — [UNAuthorizationOptions](https://developer.apple.com/documentation/usernotifications/unauthorizationoptions) (retrieved 2026-08-24)

Then implement:

```swift
optional func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    openSettingsFor notification: UNNotification?
)
```

> "The system calls this delegate method when the user taps the settings option related to a notification. This allows your app to display custom in-app notification preferences rather than directing users to the system Settings app."
> — [userNotificationCenter(_:openSettingsFor:)](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:opensettingsfor:)), iOS 12.0+ (retrieved 2026-08-24)

The effect: a "Vici Inbox Notification Settings" button appears **inside iOS Settings**, and long-pressing a notification exposes a route into the app's settings screen. Confirm the system is honouring it by reading `settings.providesAppNotificationSettings` (a `Bool` on `UNNotificationSettings`).

That gives a bidirectional link — app to iOS Settings, and iOS Settings to app. This pairing is what "apps that do this well" actually means in practice; it is far more consequential than toggle styling. Slack, Things, and Reeder all ship the app-to-Settings direction; the Settings-to-app direction is rarer and is free once the option is added.

### 2.4 Keeping the app's toggle and the system toggle from disagreeing

The disagreement is real and has a specific cause: **OS permission is device state that can change while the app is backgrounded, and it is not observable via any notification or callback.** There is no `NotificationCenter` event for "the user just denied you in Settings."

Rules:

1. **Re-read `UNUserNotificationCenter.current().notificationSettings()` on every `scenePhase == .active` transition**, not just at launch. This is the only reliable way to catch a change made in Settings.
2. **Never cache OS permission in `UserDefaults` as a proxy.** It goes stale the moment the user backgrounds the app and visits Settings. Read the live value.
3. **Two distinct sources of truth, answering different questions.**
   - `notificationSettings()` answers *"will iOS display this?"* — device-scoped, read-only.
   - The server preference record answers *"should we send this?"* — account-scoped, writable.
   Never conflate them. Never let one overwrite the other.
4. **Enforce preferences on the server, not the client.** There is no client-side filter for an alert push. If the backend sends a digest to a user who turned digests off, iOS will display it. The toggle must gate the send.
5. **Do not disable the app's toggles when OS permission is denied.** Keep them editable and show the banner. Two reasons: the preference remains meaningful for the moment permission is restored, and greying out a control the user is trying to configure without explaining why is a dead end. *(This is a judgement call. The opposing pattern — grey out everything until permission is fixed — is also common and is more honest about the immediate effect. The banner is recommended because it does not block the user, but either is defensible.)*
6. **Handle token death server-side.** APNs returns `410 Unregistered` or `BadDeviceToken`. Delete the token on receipt. Otherwise the logs say "sent" indefinitely while nothing arrives — a silent failure that looks identical to a working system.
7. **Optimistic UI with reconciliation.** Flip the toggle immediately, PATCH the server, and on failure revert with a visible error. A toggle that silently fails to persist is worse than one that is slow.

### 2.5 The digest content, as designed

Following the HIG's title/body rules ("short, contextual title using title-style capitalization and no ending punctuation"; body in "complete sentences, sentence case, and proper punctuation"):

```
Title: 3 Customers Due to Reorder
Body:  2 campaign proposals are waiting for approval. 1 customer moved out of At Risk.
```

- Title carries the single highest-value fact — survives Apple Intelligence summarization and Apple Watch short-look truncation.
- Body carries the rest in complete sentences.
- No names, no phone numbers.
- `hiddenPreviewsBodyPlaceholder: "Daily summary"` — HIG suggests generic descriptors like "Friend request," "New comment," "Shipment."
- Badge = pending proposal count. HIG: keep badges current, and "reducing badge count to zero removes related notifications from Notification Center."
- Do **not** include the app name or icon in the text — the system renders those already.

---

## 3. Digest cadence and fatigue: what is measured vs. what is asserted

### 3.1 Measured — peer-reviewed

**Fitz, Kushlev, Jagannathan, Lewis, Paliwal & Ariely (2019). "Batching smartphone notifications can improve well-being." *Computers in Human Behavior*, 101, 84-94.**
Randomized field experiment, **n = 237**. Conditions: notifications as normal (control), batched hourly, batched three times a day, and notifications off entirely.

Findings:
- The **three-times-a-day batch** group reported feeling more attentive, more productive, in better mood, and more in control of their phones than control.
- **Hourly batching produced little change relative to control** — batching only helps once the interval is long enough.
- The **notifications-off** group reported *higher* anxiety and fear of missing out than control.

This is the single most directly relevant piece of evidence, and it points three ways at once: batch, batch coarsely, and do not batch all the way to zero. ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596) - [PDF](https://static1.squarespace.com/static/57a40c19414fb54f51f8095f/t/685daca461a93c25f5b3dabe/1750969509917/2019+Fitz+Batching.pdf))

**Sahami Shirazi, Henze, Dingler, Pielot, Weber & Schmidt (2014). "Large-scale assessment of mobile notifications." CHI '14.**
Approximately **200 million notifications from more than 40,000 users** — by far the largest dataset in this literature.

Findings relevant here:
- Users value notifications very differently **depending on source**; a meaningful portion are rated unimportant or unwanted.
- **Only a fraction of users consciously manage their notification settings.**

That second finding is the operationally important one: *do not design on the assumption the owner will tune the thresholds himself.* Tune them for him and make the settings screen a correction mechanism, not a configuration burden. ([ACM DL](https://dl.acm.org/doi/abs/10.1145/2556288.2557189) - [PDF](https://pielot.org/pubs/Sahami2014-CHI-NotificationsLarge.pdf) — the per-category importance tables could not be extracted from the PDF, so no specific ratings are quoted.)

**Pielot, Church & de Oliveira (2014). "An in-situ study of mobile phone notifications." MobileHCI '14.**
In-situ logging plus diary, **n = 15, one week**. Increasing notification volume — particularly email and social — correlated with negative emotions including stress and feeling overwhelmed; but more messages also correlated with feeling *more connected*. Small sample; treat as directional. ([ACM DL](https://dl.acm.org/doi/10.1145/2628363.2628364) - [PDF](https://pielot.org/pubs/Pielot2014-MobileHCI-Notifications.pdf))

**Mark, Gudith & Klocke (2008). "The cost of interrupted work: More speed and stress." CHI '08.**
Interrupted work is completed *faster* but at the cost of higher stress, frustration, time pressure and effort. ([PDF](https://ics.uci.edu/~gmark/chi08-mark.pdf))

**Correction on a figure quoted everywhere.** The famous "23 minutes 15 seconds to return to a task" number is **not a stated result of the CHI '08 paper**; it traces to interviews and press coverage of Mark's work, and at least one detailed source-check argues it is misattributed ([oberien's blog, 2023-11-05](https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html)). Do not put it in a design doc as a hard finding. The defensible version of Mark's result is the stress/frustration cost, not a specific recovery duration.

### 3.2 Asserted — vendor benchmarks, use with suspicion

These come from push-notification vendors with a commercial interest in the answer, mostly without published methodology, and are drawn from **consumer** apps — a population structurally unlike a two-person internal business tool.

- "~50% of people opt out because they receive too many notifications daily" — widely repeated, original source not traceable.
- "Optimal frequency is 1 to 2 per day" — an industry rule of thumb, not a measurement.
- Airship 2021 benchmark: iOS push opt-in median ~51% (range 29-73%); Android median ~81%.
- Airship: 63M users across 1,500 apps, retention ~3x higher for users receiving one or more pushes in their first 90 days. **Note the obvious confound** — users who have notifications enabled are already more engaged. This is correlational and almost certainly overstates causation.

([Business of Apps push statistics](https://www.businessofapps.com/marketplace/push-notifications/research/push-notifications-statistics/) - [MobiLoud](https://www.mobiloud.com/blog/push-notification-statistics) - [CleverTap](https://clevertap.com/blog/push-notification-metrics-ctr-open-rate/))

Use these to sanity-check that the design is not wildly out of range. Do not use them to set a threshold.

### 3.3 What could not be found

**No peer-reviewed study of notification cadence in B2B or internal business tools was located.** The entire measured literature is consumer smartphone usage. Anyone who says "research shows business users prefer X" is extrapolating. Flagging that rather than dressing up an extrapolation as evidence.

### 3.4 The recommendation, and its actual justification

**Daily, once, at 08:30 local, weekdays, suppressed when empty.**

Which parts are evidenced:

- **Batching over real-time: evidenced.** Fitz et al. is a randomized experiment and supports coarse batching directly.
- **Coarse rather than fine batching: evidenced.** Fitz found hourly batching approximately equal to control. Fine-grained batching buys nothing.
- **Not zero: evidenced.** Fitz's no-notification group was measurably worse off. Do not let "reduce notifications" become "remove them."
- **Once daily specifically: not directly evidenced.** Fitz tested three-times-daily, not once. The extrapolation direction is favourable but it is an extrapolation.

The real justification for once-daily is not borrowed from the literature at all, and it is stronger:

> **Match notification frequency to the frequency at which the underlying data can change.** The segment recompute runs once per day. There is therefore at most one new fact per day. A second push could only ever repeat the first.

That argument is airtight and does not depend on any study.

**On the time of day: no good evidence exists.** 08:30 is a judgement call, justified by two arguments rather than data:
1. Delivering at the start of the recipient's working day maximises the chance the information is acted on the same day. A 6pm digest describes things forgotten by morning.
2. Avoid 09:00 exactly — it is the most contended minute in everyone's notification day.

Make it configurable and ask the two users after two weeks.

**A note on measurement.** With n = 2 there will never be statistically meaningful engagement data. Do not build an A/B test. Do not optimize open rate. Log opens for debugging, and ask the owner directly whether the digest is useful. This is the correct methodology at this sample size and it is cheaper than the alternative.

---

## 4. Server-side scheduling

### 4.1 Why `setInterval` breaks for a daily job

Node's own docs are explicit that timers are best-effort:

> "The `callback` will likely not be invoked in precisely `delay` milliseconds. Node.js makes no guarantees about the exact timing of when callbacks will fire, nor of their ordering."
> — [Node.js Timers API](https://nodejs.org/api/timers.html) (v26.7.0 docs, retrieved 2026-08-24)

That per-tick imprecision is the *least* of the problems. The failure modes that actually bite, in order of severity:

1. **Phase is anchored to process start time.** `setInterval(job, 86_400_000)` fires 24 hours after the process booted. Deploy at 14:07 and the digest now goes out at 14:07 every day. **Every redeploy silently relocates the delivery time.** With Railway auto-deploying on push, the send time is effectively random and drifts with commit habits.
2. **A deploy inside the delivery window skips that day entirely, with no catch-up.** The interval restarts from zero on the new process. No error, no log, no digest. This is the single most likely way the feature quietly stops working.
3. **No DST awareness.** A fixed 86,400,000 ms interval is a *duration*, not a *time of day*. Twice a year it desynchronises from local wall-clock by an hour and stays wrong until the next deploy accidentally re-anchors it.
4. **Unhandled async rejections keep the interval alive but useless.** If the callback is `async` and rejects without a `.catch`, the interval keeps firing forever and doing nothing. Zero signal.
5. **Long intervals are capped.** `delay > 2147483647` (about 24.8 days) silently collapses to `1` ms. A daily interval is safely under this, but the footgun is real for anything monthly.

*(Points 1-4 are engineering consequences, not statements from the Node docs; only the imprecision quote and the `TIMEOUT_MAX` value are documented.)*

### 4.2 Should Railway's native cron be used?

Railway ships a Cron Schedule feature, and it is a poor fit here:

- **UTC only.** "Cron jobs are scheduled based on UTC (Coordinated Universal Time)." No per-job IANA timezone. The London/Miami problem would still have to be solved separately.
- **Minimum 5-minute interval**, and "Railway does not guarantee execution times to the minute as they can vary by a few minutes."
- **The service must exit.** "Services must terminate immediately after completing their task and close all connections." The API server is long-running, so a cron schedule cannot be attached to it — it would need a **separate Railway service** with its own build, deploy, and env-var surface.
- Overlap is handled by skipping: "If a previous execution is still running when the next scheduled execution is due, Railway will skip the new cron job."

— [Railway Cron Jobs docs](https://docs.railway.com/reference/cron-jobs) (retrieved 2026-08-24)

The exit requirement is the disqualifier. Splitting out a second service to run a job that takes a few seconds, for two users, is operational overhead with no payoff. **Keep it in-process.**

### 4.3 Use croner

**croner** (v10.x, zero dependencies, TypeScript-native) over `node-cron` and `node-schedule`, for three specific option names:

- **`timezone`** — accepts IANA identifiers (`Europe/London`). Resolves via the `Intl` API, with documented DST semantics: *"Jobs scheduled during DST gaps are skipped; jobs in DST overlaps run once at first occurrence."* That explicit statement of gap/overlap behaviour is the differentiator — the other libraries do not commit to it as clearly.
- **`protect`** — accepts `true` or a callback; "block new triggers as long as an old trigger is in progress." Overrun protection built in, so a slow run never overlaps itself.
- **`catch`** — `true` to suppress, or a callback to handle exceptions. **Pass a callback and log it.** This is the defence against failure mode #4 above.

Also available: `maxRuns`, `startAt`/`stopAt` (ISO 8601), pause/resume/stop, and native async function support.

— [croner on GitHub](https://github.com/hexagon/croner) (retrieved 2026-08-24). Download share is lower than `node-cron` (~600K/wk vs ~3M/wk as of Feb 2026, per [PkgPulse](https://www.pkgpulse.com/guides/node-cron-vs-node-schedule-vs-croner-task-scheduling-2026)) — a comparison-site figure not independently verified, and not a reason to prefer the more popular library given the DST guarantees.

### 4.4 Timezone: London and Miami

Store **IANA names** on the user record. `Europe/London` and `America/New_York`. Never store a UTC offset, and never store "GMT+1".

**The specific trap here:** the UK and US do not switch DST on the same dates.

- **US** (`America/New_York`): second Sunday in March to first Sunday in November.
- **UK** (`Europe/London`): last Sunday in March to last Sunday in October.

So for roughly two to three weeks in March, and about one week from late October into early November, **the London-Miami gap is 4 hours instead of the usual 5.** Any implementation that computes an offset once and reuses it will deliver an hour off for several weeks a year, twice a year, and it will look like an intermittent bug.

The fix is to never compute offsets at all. Resolve wall-clock time per user, per tick, from the IANA name. Zero dependencies required:

```js
// Illustrative sketch, not production code.
function localParts(instant, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant).map(x => [x.type, x.value])
  );
  return {
    localDate: `${p.year}-${p.month}-${p.day}`,  // "2026-08-24"
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}
```

`en-CA` is chosen because it yields ISO-ordered `YYYY-MM-DD` parts. `localDate` becomes the idempotency key; `minutes` is what gets compared against the user's configured send time. DST is handled by the platform's tz database, correctly, including historical rules.

### 4.5 The scheduling design: tick + ledger

**Do not create one croner job per user with that user's timezone.** It works, but the schedule lives only in process memory: a redeploy at 08:29 loses that day's tick with no way to notice or recover. For two users the difference in complexity is negligible and the difference in reliability is not.

**Use a coarse UTC tick plus a database ledger.**

```
Cron: */5 * * * *   (UTC, croner, protect: true, catch: logAndAlert)

On each tick:
  for each active user:
    { localDate, minutes } = localParts(now, user.timezone)

    if (user.digestEnabled === false) continue
    if (user.weekdaysOnly && isWeekend(localDate, user.timezone)) continue
    if (minutes < user.digestSendMinutes) continue          // not yet
    if (minutes > user.digestSendMinutes + 180) continue     // too stale, skip today

    claimed = INSERT INTO digest_runs (user_id, local_date, claimed_at)
              VALUES (...)
              ON CONFLICT (user_id, local_date) DO UPDATE
                SET claimed_at = now()
                WHERE digest_runs.completed_at IS NULL
                  AND digest_runs.claimed_at < now() - interval '10 minutes'
              RETURNING *

    if (!claimed) continue        // already sent, or another run holds the lease

    changes = computeChanges(user)
    if (passesGates(changes)) {
      sendDigestPush(user, changes, collapseId: `digest-${user.id}-${localDate}`)
    }
    UPDATE digest_runs SET completed_at = now(), sent = ..., summary = ... WHERE id = claimed.id
```

Why each piece is there:

- **`UNIQUE (user_id, local_date)`** is the idempotency mechanism. Not a flag, not an in-memory `Set` — a database constraint. A double-run, a manual trigger, a rogue second instance: all collide on the constraint. This is the answer to "how do I make sure a double-run does not double-notify."
- **The tick runs every 5 minutes, and the condition is `>=` not `==`.** This is what makes it self-healing. If a redeploy eats the 08:30 tick, the 08:35 tick sees no row for today and sends. `setInterval` cannot do this because it has no persistent record of what it owes.
- **The 3-hour staleness window** stops a service that was down all day from firing a stale 08:30 digest at 4pm. Log the skip.
- **The lease (`claimed_at` + `completed_at`)** distinguishes *crashed mid-run* (retry after 10 minutes) from *completed* (never retry). Without it the choice is between never retrying and always double-sending.
- **`apns-collapse-id: digest-{userId}-{localDate}`** is defence in depth. If a bug somehow sends twice, APNs merges them into one notification rather than stacking two ([apns-collapse-id](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), max 64 bytes).
- **Compute changes *inside* the claim**, so the expensive work happens exactly once.

**Why 5 minutes and not 1?** Railway's own guidance is that timing varies by a few minutes anyway, the digest is not time-critical, and a 5-minute tick means 288 cheap iterations a day over two users. There is nothing to optimize.

### 4.6 Failing silently — the part that actually matters

Three layers, and the third is the one people skip.

1. **In-process:** croner's `catch` callback logs the exception with a stack trace and writes `digest_runs.error`. Also register `process.on('unhandledRejection')` — the async-rejection failure mode is the most common way a scheduled job goes quiet.
2. **In-database:** every attempt writes a row, successful or not. `SELECT * FROM digest_runs WHERE completed_at IS NULL AND claimed_at < now() - interval '1 hour'` is the "stuck runs" query. Surface the last run's status on the app's Settings screen — "Last digest: today at 08:31" is a one-line health indicator the owner will read for free.
3. **External heartbeat — non-negotiable.** Ping Healthchecks.io / Better Stack / Cronitor on every successful completion, configured to alert if no ping arrives within 26 hours. **An in-process watchdog cannot detect its own process being dead.** If the Railway service crashes or fails to boot after a bad deploy, every internal monitor dies with it. Only an external observer expecting a signal that stops arriving will catch it. This is the single most valuable 20 minutes of work in the whole feature.

Additionally: on Railway with a single instance, handle `SIGTERM`. Stop accepting new claims, let an in-flight digest finish, then exit. Otherwise a deploy mid-run leaves a claimed-but-incomplete row that blocks for the full lease duration.

---

## 5. What not to notify about

This is the section that determines whether the feature survives a month.

### 5.1 The governing principle

> **Interrupt only when the notification changes what the person will do in the next 24 hours.**

Everything else is a report, and reports belong in the app.

Apple states the failure mode directly:

> "Don't send multiple notifications for the same thing, even if someone hasn't responded. Multiple notifications fill up Notification Center and may cause users to disable all notifications from your app."
> — HIG, [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)

### 5.2 Four gates — all must pass

**Gate 1 — ACTIONABLE.** There is a specific thing the recipient can do today.
- NO: "Segments recomputed." — describes the system's activity, not the business.
- NO: "Customer lifetime value distribution shifted." — no next step.
- YES: "3 customers are due to reorder" — *only if* the app provides the follow-through (a call list, a proposal, a one-tap campaign).

If the notification's honest next step is "and then nothing," it is not a notification.

**Gate 2 — MATERIAL.** The change is large enough to matter on **both** an absolute and a relative measure.

```
material = (delta >= 3) AND (delta >= 0.10 * priorSegmentSize)
```

Both tests, conjoined, because each alone fails in the opposite direction:
- Absolute-only: 3 out of 500 is noise, but passes.
- Relative-only: 1 out of 3 is 33%, but is still one person.

For **revenue-critical segments** — `Due to reorder`, `At risk`, `Churned high-value` — drop to `delta >= 1`, but gate on customer value: notify on a single customer only if their LTV exceeds a threshold set once. One high-value customer entering At Risk is genuinely worth an interruption; one low-value customer is not.

**Gate 3 — NOVEL.** Not substantially the same message as the last one sent.

Hash the digest's *headline claim* (segment + direction, not the exact count) and compare against the previous N days. If "Due to reorder up" fired yesterday and the only change today is that it went up again with no new proposals, **downgrade to in-app only**. This is the direct implementation of Apple's "don't send multiple notifications for the same thing." Without this gate a slow-moving trend generates an identical push every morning for a fortnight, and that is precisely the pattern that trains someone to ignore, then disable.

Exception: re-notify if the trend *reverses direction* or crosses a round threshold (10, 25, 50) it had not before.

**Gate 4 — ATTRIBUTABLE.** The specific thing that changed can be named, in the body, in plain language.

If the body would have to say "several segments changed" or "multiple updates available," the change set is too diffuse to be worth interrupting for. This gate is a forcing function: it makes an unnotifiable change *visibly* unnotifiable at compose time, rather than letting vague copy paper over a weak signal.

### 5.3 The always-suppress list

Never push for any of these, regardless of the gates:

- Recompute completed / job succeeded — that is a log line.
- Zero material changes — **send nothing.** A daily "no changes" push is the fastest possible route to a disabled toggle, because it is 100% noise by construction.
- Net-zero churn (3 in, 3 out, same segment). Interesting in-app, not push-worthy.
- Segments the owner has not marked as watched. Let him pick which of the 12 matter; default to the 3-4 revenue-linked ones rather than all 12.
- Anything already surfaced in yesterday's digest.
- Changes attributable to a data import or sync (see below).
- Anything containing a customer name or phone number, per HIG and 4.5.4 (S1.6).

### 5.4 Two edge cases that will fire on day one

**Cold start.** The very first recompute has no prior state, so *every* customer "moves into" a segment. Suppress notification on the first run per segment and record the baseline silently. Without this, the owner's first-ever digest is "487 customers moved into 12 segments," and his first impression of the feature is that it is broken.

**Bulk import.** If someone imports a customer list, every segment changes at once. Guard: if the total customer count changed by more than ~15% since the previous run, **suppress the digest entirely** and record `reason: 'bulk_change_detected'`. Optionally send a single, differently-worded "Segments rebaselined after data import" — or send nothing. Never let an import masquerade as organic business movement, because the whole value of the digest is that it reports on customer behaviour.

### 5.5 The safety net: caps that survive a bug

Gates are logic and logic has bugs. Add hard caps enforced in the same `digest_runs` table:

- **Max 1 non-conversation push per user per day.** Enforced by the `UNIQUE (user_id, local_date)` constraint already present — the schema does double duty as the rate limiter.
- **Max 7 digest pushes per rolling 7 days** per user.
- **Circuit breaker:** if more than 6 of 12 segments report material changes in a single run, that is almost certainly a bug or a data event, not twelve simultaneous business developments. Suppress, log, and alert the developer (not the owner) on the ops channel.

These caps are what save the feature when a threshold gets mistuned. The gates decide *what* to send; the caps bound *how bad it can get* when the gates are wrong.

### 5.6 The escape valve that makes strict gates safe

**Everything that fails a gate must still be visible in the app.** Build an in-app Changes feed (chronological, all segment movements, all proposals, unfiltered) and make the digest push a *pointer into it*.

This inverts the risk. Without a feed, an over-strict gate means the owner *misses* things, so there is pressure to loosen the gates and the whole design collapses toward notify-everything. With a feed, an over-strict gate means the owner *checks the app*, which is the outcome wanted anyway. It also makes tuning safe — start conservative and loosen based on what he actually opens.

Tapping the digest should land on that feed, scoped to the day.

---

## 6. Source list

**Apple — API reference** (all retrieved 2026-08-24)
- [UNNotificationInterruptionLevel](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel)
- [UNNotificationContent.interruptionLevel](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/interruptionlevel)
- [UNNotificationContent.relevanceScore](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/relevancescore)
- [UNNotificationContent.summaryArgument](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/summaryargument) *(deprecated iOS 15, ignored)*
- [UNMutableNotificationContent.threadIdentifier](https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/threadidentifier)
- [UNNotificationCategory.categorySummaryFormat](https://developer.apple.com/documentation/usernotifications/unnotificationcategory/categorysummaryformat)
- [UNAuthorizationOptions](https://developer.apple.com/documentation/usernotifications/unauthorizationoptions)
- [UNAuthorizationStatus](https://developer.apple.com/documentation/usernotifications/unauthorizationstatus)
- [UNNotificationSettings](https://developer.apple.com/documentation/usernotifications/unnotificationsettings)
- [userNotificationCenter(_:openSettingsFor:)](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:opensettingsfor:))
- [UIApplication.openNotificationSettingsURLString](https://developer.apple.com/documentation/uikit/uiapplication/opennotificationsettingsurlstring)
- [Asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
- [Declaring your actionable notification types](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types)
- [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)
- [UserNotifications updates](https://developer.apple.com/documentation/updates/usernotifications)

**Apple — design and policy**
- [HIG: Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications) *(page last updated 2023-10-24)*
- [HIG: Managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) *(4.5.4, 5.1.2(i), 2.5.4)*
- [WWDC21 — Send communication and Time Sensitive notifications](https://developer.apple.com/videos/play/wwdc2021/10091/)
- [Apple Support: Summarize notifications with Apple Intelligence](https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios)

**Peer-reviewed**
- Fitz et al. (2019), *Computers in Human Behavior* 101:84-94 — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596) - [PDF](https://static1.squarespace.com/static/57a40c19414fb54f51f8095f/t/685daca461a93c25f5b3dabe/1750969509917/2019+Fitz+Batching.pdf)
- Sahami Shirazi et al. (2014), CHI '14 — [ACM DL](https://dl.acm.org/doi/abs/10.1145/2556288.2557189) - [PDF](https://pielot.org/pubs/Sahami2014-CHI-NotificationsLarge.pdf)
- Pielot, Church & de Oliveira (2014), MobileHCI '14 — [ACM DL](https://dl.acm.org/doi/10.1145/2628363.2628364) - [PDF](https://pielot.org/pubs/Pielot2014-MobileHCI-Notifications.pdf)
- Mark, Gudith & Klocke (2008), CHI '08 — [PDF](https://ics.uci.edu/~gmark/chi08-mark.pdf) - [source-check on the "23 minutes" figure](https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html)

**Engineering**
- [Node.js Timers API](https://nodejs.org/api/timers.html) (v26.7.0)
- [Railway Cron Jobs](https://docs.railway.com/reference/cron-jobs)
- [croner (GitHub)](https://github.com/hexagon/croner)
- [PkgPulse: node-cron vs node-schedule vs croner, 2026](https://www.pkgpulse.com/guides/node-cron-vs-node-schedule-vs-croner-task-scheduling-2026) *(comparison site, download figures unverified)*

**Vendor benchmarks — directional only, see 3.2**
- [Business of Apps](https://www.businessofapps.com/marketplace/push-notifications/research/push-notifications-statistics/) - [MobiLoud](https://www.mobiloud.com/blog/push-notification-statistics) - [CleverTap](https://clevertap.com/blog/push-notification-metrics-ctr-open-rate/)

---

## Items flagged UNVERIFIED or NOT SPECIFIED BY APPLE

1. **Alert-push rate limits** — Apple publishes none. The documented "two or three per hour" applies only to *background* pushes. Do not generalise it.
2. **`categorySummaryFormat` with `%u` on iOS 18/26** — no deprecation notice on the property page, but not device-tested. Verify on hardware.
3. **Opting out of Apple Intelligence notification summaries** — no developer API found. User-controlled per-app only.
4. **App Review rejection for a missing in-app notification settings screen** — the HIG uses "must," but no published rejection data was found. Build it regardless.
5. **`UNNotificationAttributedMessageContext` (iOS 26)** — surfaced only via a developer-forum reference; the API page could not be retrieved. Affects communication notifications, not the digest.
6. **Time-of-day for a business digest** — no measured evidence found for any specific hour. 08:30 is a reasoned default, not a finding.
7. **Cadence in B2B/internal tools** — no peer-reviewed study located. The entire measured literature is consumer smartphone use.
8. **`setInterval` failure modes 1-4 (4.1)** — engineering consequences reasoned from the runtime's behaviour, not statements in the Node docs. Only the "no guarantees about exact timing" quote and the `2147483647` cap are documented.
9. **Sahami Shirazi per-category importance rankings** — the PDF would not parse cleanly; only abstract-level findings are quoted, no specific figures invented.

---

Sections 1, 2 and 5.2 are the frontend/iOS contract; 4 and 5.3-5.6 are the backend contract.
