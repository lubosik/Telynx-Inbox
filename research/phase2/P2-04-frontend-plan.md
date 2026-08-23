# P2-04 — Frontend Implementation Plan

**Written:** 12 August 2026
**Scope:** the web client (`public/`), plus the boundary with the two native iOS apps.
**Status:** plan only. No code written. Nothing here is approved to build.
**Reads from:** `research/ai-wizard/00`, `01`, `05`, `06`; `research/phase2/P2-01`, `P2-02`, `P2-06`.

---

## 0. The one-paragraph version

`public/app.jsx` is 3,269 lines, has no module system, no router, no memoisation, 220 inline
style objects and 151 hardcoded hex literals, and it already contains a live costing bug that
under-reports SMS segments by up to 3x. Adding a campaign builder, a segment previewer, a
pre-flight panel, an activity feed and an account system to it is not viable. The right fix
is the smallest one that actually works: **replace Babel CLI with esbuild, split the file into
modules, and change one line of `package.json`.** Net dependency count goes *down* by two, the
build command name and the output path stay identical, `index.html` and `sw.js` are untouched,
and Railway's `npm install && npm run build` keeps working unchanged. No bundler dev server, no
router, no state library, no TypeScript. Then the first genuinely useful slice is not the
campaign builder at all: it is the **live encoding, segment and cost meter plus a phone-accurate
preview, dropped into the composer that already exists**, which fixes a real cost bug for both
clients in about three days and is the exact component the wizard needs later.

---

## 1. Current architecture audit

### 1.1 The shape of the file

There is one file. It is loaded by `public/index.html:20` as a plain `<script defer>` after two
UMD CDN bundles (`react@18`, `react-dom@18`, lines 17-18). React and ReactDOM are **free
globals**, never imported. `app.jsx:1` destructures the hooks off the `React` global. This
detail matters enormously for §2: it means whatever we use to compile JSX must not try to
inject an import of React.

Precise map, with line ranges:

| Lines | Unit | Kind |
|---|---|---|
| 1-15 | prelude, `TZ`, `useIsMobile()` | reusable |
| 17-96 | pure formatters: `relativeTime` 19, `formatTime` 32, `formatDate` 42, `messageStatusMeta` 47, `getInitials` 69, **`charCount` 77**, `truncate` 83, `normalisePhoneFrontend` 88 | reusable (one is broken) |
| 98-159 | MMS/tapback helpers: `TAPBACK_EMOJI` 100, `isTapbackRow` 108, `messagePreviewText` 114, `downscaleImage` 128 | reusable, load-bearing |
| 161-169 | `api(method, path, body)` | **the entire data layer, 7 lines** |
| 171-179 | `ToastContainer` | reusable |
| 181-225 | `LoginScreen` | to be replaced (§10) |
| 227-263 | `OrderCard` | reusable |
| 265-288 | `SuggestionCard` | reusable |
| 290-489 | `ContactModal` | **dead code — zero call sites** |
| 491-546 | `ViciModal`, `ViciPinnedCard` | Vici-only branding, hardcoded phone number at 515 |
| 548-751 | `ContactsView` | container |
| 753-827 | `ContactRow` | presentational |
| 829-1013 | `ContactDetail` | container + form |
| 1015-1058 | `CreateContactModal` | presentational |
| 1060-1397 | `MessagesView` | **the inbox. The daily job. Do not disturb.** |
| 1399-1456 | `smartTime`, `ConvRow` | presentational |
| 1458-1500 | `flowBadgeStyle`, `FlowBadge`, `useCountdown` | reusable |
| 1502-1596 | `QueueRow`, `CancelModal` | automations |
| 1598-1675 | `RecentRow`, `LiveFeed` | automations |
| 1677-1702 | `StatCard`, `FLOW_FILTERS` | reusable |
| 1704-1945 | `ActivityTab` | **misnamed: this is the automation queue, not a team feed** |
| 1947-2262 | voice: `CallConfirmModal` 1949, `ActiveCallPanel` 1985, `DialerSection` 2048, `CallLogRow` 2089, `CallLogsSection` 2167, `VoiceTab` 2223 | container + presentational |
| 2266-3266 | `App` | everything else |
| 3268-3269 | mount | |

### 1.2 State

All application state lives in `App` (2266-3266): **22 `useState` calls and 12 `useRef` calls**,
declared 2267-2314. There is no context, no reducer, no store, no memoisation anywhere in the
file.

The shapes that matter:

- `conversations` (2268) — flat array of contact-with-last-message. Sorted **on every render**
  in two places (`ContactsView` 572-584, `MessagesView` 1085-1101) and filtered again
  (587-595, 1103-1107). At 847 contacts this is survivable; it is not free, and nothing is
  wrapped in `useMemo`.
- `messages` (2270) — `{ [phone]: Message[] }`. A cache that is never evicted. Grows for the
  session.
- `activePhone` (2269) — the selected thread. Drives a `useEffect` at 2549-2551 that fetches.
- `mainTab` (2278) and `mobileSub` (2279) — **this is the entire navigation system.** Two
  strings. `mainTabRef` (2303) exists because the SSE closure needs the current value.
- Voice state 2285-2301: `callState` object plus six refs. `voiceReady` is permanently `false`
  in this build — `initVoiceClient` (2565-2568) is a deliberate no-op and the browser never
  requests a SIP token. Browser calling was removed; the iPhone is the only endpoint.

Prop drilling is already at its limit. `MessagesView` takes **19 props** (1062-1068). Adding a
wizard with seven steps to this pattern would be untenable.

### 1.3 Data fetching

`api()` at 161-169. Seven lines: `fetch` with `credentials: 'include'`, throw on `!ok`, parse
JSON. There is no cache, no request dedupe, no abort on unmount, no retry, no loading-state
convention. Each container hand-rolls its own `loading` boolean. Some call sites bypass `api()`
entirely and use raw `fetch` (614-618, 2622-2628, 2753-2757, 2787, 2941-2956, 3004).

Errors are handled in three incompatible ways: swallowed (`.catch(() => {})` at 2332, 2339),
toasted (2604, 2830, 2859), or `console.error`'d (1740, 1795, 2789).

**This is fine and should not be rewritten.** It is small, it works, and replacing it with a
query library is exactly the kind of complication the user does not want. It needs two
additions only: an `AbortController` on the wizard's live-count calls (which fire on every
keystroke), and a single shared `useAsync` helper so new screens stop reinventing the loading
boolean.

### 1.4 SSE

One `EventSource('/api/sse')` created in `connectSSE()` (2383-2496), stored on `sseRef`,
reconnected with exponential backoff capped at 30s (2488-2495). `sseStatus` drives the pill at
3102-3105.

`onmessage` (2389-2487) is a 100-line chain of `if (evt.type === ...)` handling
`connected`, `status_update`, `reaction_update`, `order_status_updated`, `call_update`,
`call_recording_saved`, `new_message`.

The important architectural detail is **line 2413**:

```js
window.dispatchEvent(new CustomEvent('vici-sse', { detail: evt }));
```

Every event that is not handled inline is re-broadcast on a **global DOM event bus**, and
`ActivityTab` subscribes to it at 1783. A cross-component pub/sub already exists in this
codebase. New screens (activity feed, campaign send progress, presence) should use the same
mechanism rather than lifting more state into `App`. Formalise it as `lib/bus.js` with
`subscribe(type, fn)` and keep the wire format identical.

Two real defects to note and not inherit:
- The handler closes over `conversations` (2481) and `activePhone` (2453) from the render in
  which `connectSSE` ran. The effect at 2342-2362 depends only on `[auth.ok]`, so those are
  **stale after the first render**. It mostly works because `setConversations` uses the updater
  form, but line 2481's `conversations.find(...)` is genuinely stale.
- SSE is in-process and single-instance (research 00 §2). Every redeploy drops every client.
  New features must tolerate a gap: the campaign send-progress view needs a poll fallback, not
  just the stream.

### 1.5 Navigation

There is none, in the router sense. `mainTab` is a string compared four times in the render
(3148, 3159, 3185, 3188) and set by six buttons (3069-3097 desktop, 3231-3260 mobile).

Consequences:
- No URL state. Refreshing always returns to `contacts`.
- No back button. On mobile, `mobileSub` (2279) fakes one for the thread view only.
- Deep links are read **once** at mount (2311) and then destroyed with
  `history.replaceState({}, '', '/')` (2369, 2379).

The wizard needs URL state. A seven-step flow with no addressable steps cannot be resumed,
shared, or linked from a push notification, and browser Back will exit the whole builder.
**This is the one place a real router would be justified, and it still is not worth it.** §3
specifies a 30-line hash-route hook instead.

### 1.6 Styling

`public/styles.css` is 876 lines with a token block at `:root` (9-31): `--bg #030712`,
`--accent #00f5a0`, `--surface`, `--text`/`--text2`/`--text3`, `--mono`. It covers login,
header, contacts grid, messages view, modals, toast, spinner, bottom nav, MMS/reactions.

It covers roughly half the app. The other half is inline: **220 `style={{...}}` objects and 151
hardcoded hex literals** in `app.jsx`. Top offenders: `#9ca3af` x39, `#2a2a2a` x26, `#16a34a`
x25, `#1a1a1a` x16, `#6b7280` x14, `#ef4444` x13.

So **two design systems coexist in one file**: the CSS-variable "terminal green" system
(`#00f5a0` on `#030712`) used by login/header/messages, and an inline "GitHub dark green" system
(`#16a34a` on `#0a0a0a`/`#1a1a1a`) used by contacts, voice and parts of activity. They do not
match, and the inline one is invisible to any theming attempt. This is the single largest
mechanical obstacle to §12 (per-client theming without forking).

### 1.7 The bug already in production

```js
// app.jsx:77-81
function charCount(text) {
  const chars = text.length;
  const segments = chars === 0 ? 1 : Math.ceil(chars / 160);
  return { chars, segments, isWarning: chars >= 140 && chars <= 160, isDanger: chars > 160 };
}
```

Rendered in the composer footer at 1339-1348 as `{cc.chars}/160` and `{cc.segments} SMS`.

It is wrong three ways, all of which cost money (research 01 §4, P2-06 §5.2):

1. No GSM-7 / UCS-2 classification. One curly apostrophe from iOS autocorrect drops capacity
   from 160 to 70 and the counter does not notice.
2. Concatenated segments are 153 (GSM-7) or 67 (UCS-2), not 160. The formula over-counts
   headroom on every multi-part message.
3. Extension-table characters (`{ } [ ] ~ ^ | \ €`) cost two septets each and are counted as one.

A 155-character message with one `'` is reported as **1 segment** and actually costs **3**. This
is live today in both Vici's and Shore's inbox composer. Fixing it is 40 lines of pure function
plus a UI band, requires no campaign object, no new table and no backend change, and is the
first thing in the phase plan (§13).

### 1.8 What is reusable, and what must not be disturbed

**Reusable as-is** (move, do not rewrite): all of 17-159, `api()` 161-169, `ToastContainer`,
`OrderCard`, `SuggestionCard`, `ContactRow`, `ConvRow`, `FlowBadge`, `StatCard`, `useCountdown`,
`CancelModal`, `useIsMobile`.

**Load-bearing. Touch only with a screenshot before and after:**
- `MessagesView` 1060-1397 and everything it renders. This is the product.
- `handleSend` 2834-2864 and the attachment pipeline 2799-2819 + `downscaleImage` 128-159. The
  MMS path is recent and fragile.
- `connectSSE` 2383-2496. Every real-time behaviour on web depends on it.
- The push-subscription dance 2929-3038. It contains a deliberate re-POST-and-verify recovery
  for dead APNs endpoints (2948-2969) that took effort to get right.
- `/auth/check` at 2322-2326 and the `auth.ok` gate at 3057. The iOS app replays a stored
  password against this same endpoint (see §10.4, §11.3).

**Delete on the way past:** `ContactModal` 290-489 (200 lines, zero call sites).

---

## 2. The 3,269-line problem: a decision

### 2.1 What is actually being added

Rough line budget for the Phase 2 surface, based on the specs in P2-01/02/06 and research 05/06:

| Feature | Est. lines |
|---|---:|
| Campaign builder, 6 steps | 1,400 |
| Segment builder + live preview | 700 |
| Phone preview + encoding meter | 450 |
| Pre-flight panel (24 checks) | 500 |
| Honest dashboard, 3 tiers | 800 |
| Activity feed + presence | 450 |
| Login / invite / users / roles | 600 |
| Settings (test numbers, kill switch) | 350 |
| **Total** | **~5,250** |

That is 8,500 lines in one file. Not a judgement call.

### 2.2 The three options, honestly

**(a) Split into files, keep Babel CLI.** Babel with `--preset @babel/preset-react` only
transforms JSX; it leaves `import`/`export` alone. So `babel public/src --out-dir public/js`
plus `<script type="module">` and native browser ESM genuinely works, with no bundler.

The catches are real: every import specifier must name the *compiled* filename
(`import { Composer } from './inbox/Composer.js'` from inside a `.jsx` file), which is a
permanent papercut; the browser fetches ~40 modules in a request waterfall on every cold load,
over a service worker that is network-first (`sw.js:11`); there is no minification; and
`index.html` must change to `type="module"`, which changes execution timing relative to the
`defer` script it uses today. Cost: low. Ceiling: also low.

**(b) esbuild.** One dependency, one command, output artefact and path identical to today.

**(c) Keep one file.** Not viable at 8,500 lines. Every merge is a conflict, every screenshot
loop reloads a 300KB parse, and the file already exceeds what can be held in one reading.

### 2.3 Recommendation: (b), and it is smaller than what exists now

The user's instruction is not to overcomplicate things, and that instruction argues *for*
esbuild, not against it, for one concrete reason:

**esbuild replaces Babel rather than joining it.** `@babel/cli`, `@babel/core` and
`@babel/preset-react` all come out of `package.json`. `esbuild` goes in. **Net dependency count
falls by two.** There is no dev server, no HMR, no config file, no plugin ecosystem, no
`vite.config.js`, no framework. There is one command that turns JSX into a file, exactly as
today, and it runs in about 30 milliseconds instead of about 3 seconds.

What is *not* being adopted, deliberately: no Vite, no router library, no Redux/Zustand/Jotai,
no TypeScript, no CSS-in-JS, no component library, no test runner for the frontend. React stays
on the CDN. The output is still one `<script defer src="/app.js">`.

### 2.4 The concrete migration

**Step 1 — `package.json`.** Note `esbuild` goes in `dependencies`, not `devDependencies`:
Railway's Nixpacks build sets `NODE_ENV=production`, which is why `@babel/cli` is a runtime
dependency today. Copy that placement or the build breaks on deploy.

```diff
   "scripts": {
-    "build": "babel public/app.jsx --presets @babel/preset-react -o public/app.js",
+    "build": "esbuild public/src/main.jsx --bundle --outfile=public/app.js --loader:.jsx=jsx --jsx=transform --target=es2019 --sourcemap",
+    "build:watch": "npm run build -- --watch",
     "test": "node --test test/*.test.js"
   },
   "dependencies": {
-    "@babel/cli": "^7.29.7",
-    "@babel/core": "^7.29.7",
-    "@babel/preset-react": "^7.29.7",
+    "esbuild": "^0.25.0",
```

`--jsx=transform` is mandatory. The default in recent esbuild is the automatic runtime, which
emits `import { jsx } from "react/jsx-runtime"` and would break instantly against a CDN global.
`transform` emits `React.createElement`, exactly what Babel emits today, and esbuild leaves the
free `React` identifier alone because nothing imports it.

No `--minify` in the first pass. Unminified output is ~300KB, gzips to ~70KB, and keeping it
readable means the first deploy can be diffed against the Babel output to prove equivalence.
Add `--minify` in a separate commit once that is confirmed.

**Step 2 — verify what does not change.** `railway.json` runs `npm install && npm run build`:
unchanged. `public/app.js` is gitignored and built on deploy: unchanged. `index.html:20`
(`<script src="/app.js" defer>`): unchanged. `sw.js` SHELL is `['/', '/styles.css',
'/manifest.json']` and its fetch handler is network-first: unchanged. This is the property that
makes the migration low-risk.

**Step 3 — the file layout.**

```
public/
  index.html            unchanged
  styles.css            unchanged in phase 0; split in phase 1
  app.js                build output (gitignored, as today)
  app.js.map            build output
  src/
    main.jsx            mount + <App/>
    App.jsx             shell, session, SSE wiring, tab state
    lib/
      api.js            api() from 161-169 + useAsync + AbortController helper
      bus.js            formalises the window CustomEvent bus (2413 / 1783)
      format.js         17-96 minus charCount
      encoding.js       NEW: GSM-7/UCS-2, segments, cost. Replaces charCount.
      merge.js          NEW: merge-field parse, render, fallback, junk detect
      media.js          downscaleImage + tapback helpers, 98-159
      caps.js           NEW: the capability flags object (§12)
    state/
      SessionContext.jsx   user, role, capabilities, toast, sseStatus
    shell/
      Header.jsx  BottomNav.jsx  Toasts.jsx  AccountMenu.jsx
    inbox/
      MessagesView.jsx  ConvRow.jsx  Composer.jsx  MessageBubble.jsx
      ActionSheet.jsx   Lightbox.jsx
    contacts/
      ContactsView.jsx  ContactRow.jsx  ContactDetail.jsx  CreateContactModal.jsx
      OrderCard.jsx     SuggestionCard.jsx
    calls/
      CallsView.jsx  Dialer.jsx  CallLogRow.jsx  ActiveCallPanel.jsx
    automations/
      AutomationsView.jsx  QueueRow.jsx  RecentRow.jsx  CancelModal.jsx
    campaigns/
      CampaignsList.jsx   CampaignBuilder.jsx
      steps/{Audience,Message,Preview,TestSend,Schedule,Review}.jsx
      PhonePreview.jsx    EncodingMeter.jsx   AiPanel.jsx
      PreflightPanel.jsx  SendProgress.jsx
      results/{CampaignResults,MoneyTiers,MeasurabilityMeter,TrustLedger}.jsx
    segments/
      SegmentsList.jsx  SegmentBuilder.jsx  RuleGroup.jsx  AudiencePreview.jsx
    activity/
      ActivityRail.jsx  ActivityLine.jsx  PresenceBadge.jsx  StaleReplyGuard.jsx
    account/
      LoginScreen.jsx  ForgotPassword.jsx  ResetPassword.jsx  AcceptInvite.jsx
      ClaimAccount.jsx UsersView.jsx  TestNumbersView.jsx
```

**Step 4 — the split itself is mechanical.** Cut each unit at the line ranges in §1.1, paste
into its file, add `export function X`, add imports at the top of the consumer. One commit per
directory, `npm run build` after each, and a Playwright screenshot of all four existing tabs at
390px / 820px / 1920px before the first commit and after the last. The diff should be
`git diff --stat` showing only moves.

**Step 5 — one state change, and only one.** Introduce `SessionContext` carrying
`{ user, role, capabilities, addToast, sseStatus }`. Everything else stays exactly as it is,
including `mainTab` as a string. Rationale: those five values are needed by nearly every new
screen, and threading them through a six-step wizard as props is how the 19-prop
`MessagesView` signature happened. One context, no reducer.

**Estimated cost of the whole of §2: 2 to 3 days**, including the screenshot regression pass.

---

## 3. Navigation and information architecture

### 3.1 The constraint

The shared inbox is the daily job and the new features must not bury it. Today the app opens on
**Contacts** (`mainTab` defaults to `'contacts'`, line 2278), which is already wrong. Fix that
in phase 0: default to the inbox.

Desktop has room for five top-level tabs. The mobile bottom nav has four slots
(3229-3262) and should keep four.

### 3.2 The IA

```
┌─ TOP LEVEL ────────────────────────────────────────────────────────────┐
│                                                                        │
│  INBOX          the shared conversation list + thread.  DEFAULT TAB.   │
│                 unchanged from MessagesView 1060-1397                  │
│                                                                        │
│  CONTACTS       list, detail, orders, create/edit                      │
│                                                                        │
│  CALLS          (renamed from VOICE) dialler + call log                │
│                                                                        │
│  SEND           NEW. Everything outbound-at-scale lives here.          │
│                 ├─ Campaigns    list, builder, results                 │
│                 ├─ Segments     list, builder, preview                 │
│                 └─ Automations  (renamed from ACTIVITY) the flow queue │
│                                                                        │
│  [ Vici only. Hidden entirely for Shore — see §12 ]                    │
└────────────────────────────────────────────────────────────────────────┘

Not tabs:
  ACTIVITY FEED   bell icon in the header → right rail (desktop) /
                  full-screen sheet (mobile). Peripheral awareness, not a
                  destination. Follows research 06 §9.1's argument for iOS,
                  which applies equally on web.

  SETTINGS        avatar menu in the header → modal with left nav:
                  Account · Team · Test numbers · Notifications ·
                  Sending controls · Integrations
```

This resolves the `routes/activity.js` naming collision flagged in research 00 §8 and 06 §1.5:
the existing automation queue becomes **Automations** under Send, and the word "Activity" is
freed for the team feed. Backend rename to `/api/automations` per research 06 §10.2; the
frontend keeps calling `/api/activity/*` until the server route moves, then flips in one commit.

### 3.3 Header and mobile nav

```
DESKTOP HEADER (52px, extends .header at styles.css:99)
┌────────────────────────────────────────────────────────────────────────────┐
│ VICI//SMS   INBOX  CONTACTS  CALLS  SEND        ● live   🔔³  ⚙  (LK)▾    │
└────────────────────────────────────────────────────────────────────────────┘
                                                    │     │   │    └ account menu
                                                    │     │   └ settings
                                                    │     └ activity, dot not count
                                                    └ existing conn-pill 3102

MOBILE BOTTOM NAV (4 slots, unchanged structure at 3229-3262)
┌──────────┬──────────┬──────────┬──────────┐
│    ✉     │    ◎     │    📞    │    ⚡    │
│  Inbox   │ Contacts │  Calls   │   Send   │
│   (3)    │          │          │          │
└──────────┴──────────┴──────────┴──────────┘
Activity bell and account live in the mobile header, not the nav.
For Shore the Send slot is absent and the nav renders three items.
```

The activity indicator is a **dot, not a count** (research 06 §9.3). The existing unread badge
(3244) means "things waiting for you" and must not be diluted.

### 3.4 URL state, in 30 lines

The wizard needs addressable steps. Use `location.hash`, not a router:

```
#/inbox
#/inbox/+13055551234
#/contacts
#/calls
#/send/campaigns
#/send/campaigns/new/audience
#/send/campaigns/41/message
#/send/campaigns/41/results
#/send/segments/7
#/send/automations
#/settings/team
```

A `useHashRoute()` hook reads `location.hash`, listens to `hashchange`, and returns
`[segments[], navigate]`. `mainTab` becomes derived from `segments[0]` rather than independent
state. Browser Back works, refresh preserves position, and the push-notification deep link at
2311 stops being destroyed by `replaceState` — it becomes a hash and survives.

Do this in phase 0, before the builder exists, so the builder is born addressable.

---

## 4. The campaign builder, screen by screen

### 4.1 Step model

Six steps. AI drafting is a **panel inside step 2**, not a step of its own: the loop between
writing and critiquing is continuous, and making it a step forces back-navigation on every
iteration. The phone preview becomes a **persistent right rail from step 2 onwards**, with step
3 adding the things a rail cannot do (recipient cycling, notification render, honest
disclosures).

```
 1 AUDIENCE  →  2 MESSAGE  →  3 PREVIEW  →  4 TEST  →  5 SCHEDULE  →  6 REVIEW
 ──────────     ─────────     ─────────     ──────     ──────────     ────────
 pick or        compose,      per-contact   the hard   window,        pre-flight,
 build a        AI panel,     render,       gate       tranches,      approve,
 segment        live meters   disclosures   §6         quiet hours    send
```

**Step rail behaviour.** Always visible. Steps you have completed are clickable. Steps ahead of
the furthest you have reached are not. Going back never discards work; it may **invalidate the
test** (§6.4) and that is shown immediately, in the rail, as a red dot on step 4.

**Persistence.** Autosave to `PATCH /api/campaigns/:id` on a 1.5s debounce and on step change.
A campaign exists as a `draft` row from the moment step 1 completes. The URL carries the id
(`#/send/campaigns/41/message`), so a closed tab is a resumable draft, not lost work.

### 4.2 Step 0 — Campaigns list

```
┌ SEND ▸ Campaigns ─────────────────────── Segments │ Automations ──────────┐
│                                                                           │
│  [ + New campaign ]              filter: All ▾   Draft(3) Scheduled(1)    │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ ● SCHEDULED   Spring restock — Semaglutide                          │  │
│  │   Due-a-reorder · 214 recipients · Thu 14 Aug, 12:00 ET             │  │
│  │   ✓ tested by Dominic 2h ago   $1.61 est.        [ View ] [ Hold ]  │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │ ○ DRAFT       Win-back 90d                                          │  │
│  │   Lapsed 90-180d · 108 recipients                                   │  │
│  │   ⚠ not tested                                   [ Continue ]       │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │ ✓ SENT        BPC-157 back in stock          sent 4 Aug             │  │
│  │   187 sent · 24 clicks · $1,410 click-attributed                    │  │
│  │   Evidence: send 4 of ~27          [ Results ]                      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

Status is the strongest visual signal on the row. Test state is on the card, not buried in the
builder, because "which of my drafts is safe to schedule" is the question this list answers.

### 4.3 Step 1 — Audience

```
┌ 1 AUDIENCE ─ 2 Message ─ 3 Preview ─ 4 Test ─ 5 Schedule ─ 6 Review ──────┐
│                                                                           │
│  Who is this going to?                                                    │
│                                                                           │
│  ○ Use a saved segment                                                    │
│    ┌───────────────────────────────────────────────────────────────────┐  │
│    │ ◉ Due a reorder (high confidence)          214 people   updated 3m│  │
│    │ ○ Lapsed 90-180 days                       108 people   updated 3m│  │
│    │ ○ Bought BPC-157, never reordered           47 people   updated 3m│  │
│    │ ○ Everyone with consent                    782 people   updated 3m│  │
│    └───────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ○ Build a new segment            [ opens the builder, §7 ]               │
│                                                                           │
│  ┌ WHO IS ACTUALLY IN THIS ─────────────────────────────────────────────┐ │
│  │  Segment matched            214                                      │ │
│  │    − opted out               6   ⓘ                                   │ │
│  │    − no consent record       0   ⓘ                                   │ │
│  │    − messaged in last 72h   11   ⓘ frequency cap                     │ │
│  │    − invalid number          1                                       │ │
│  │    − duplicate after norm.   0                                       │ │
│  │  = Will receive            196                                       │ │
│  │                                                                      │ │
│  │  ⚠ 138 of these 196 also received "BPC-157 back in stock" 8 days ago │ │
│  │                                                                      │ │
│  │  Also in: "Everyone with consent" (196), "VIP" (31)     [ overlap ]  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Holdout   ○ none   ◉ 10%   ○ 50%      ⓘ what a holdout does              │
│            10% = 20 people held back, 176 messaged                        │
│                                                                           │
│                                          [ Cancel ]   [ Next: Message → ] │
└───────────────────────────────────────────────────────────────────────────┘
```

**Blocks Next:** no segment chosen; segment resolves to 0; segment resolves above the
blast-radius cap (P2-06 §5, check 6); segment declares no filter clauses (it would match
everyone).

**Warns but allows:** the fatigue overlap line; recipient count more than 30% different from the
last send of this segment (P2-06 check 7).

Overlap is shown as information, never as an error. Per P2-02 §2, segments overlap freely by
design and contention resolves at send time on the priority ladder. The UI's job is to say
"these people are also in X" and, at review, to say which of them will be **deferred** rather
than dropped. Wording matters: "deferred to 16 Aug" not "excluded".

### 4.4 Step 2 — Message

```
┌ 1 Audience ─ 2 MESSAGE ─ 3 Preview ─ 4 Test ─ 5 Schedule ─ 6 Review ──────┐
│                                                                           │
│ ┌─ COMPOSE ───────────────────────────┐ ┌─ PREVIEW ──────────────────┐    │
│ │                                     │ │      ┌──────────────┐      │    │
│ │ {{first_name}}, it's Vici. You're   │ │      │  9:41    ▪▮  │      │    │
│ │ about 4 days from running out of    │ │      │ ‹ Vici Pept. │      │    │
│ │ BPC-157. Same order, one tap:       │ │      ├──────────────┤      │    │
│ │ go.vicipeptides.com/r/8f2           │ │      │              │      │    │
│ │ Reply STOP to end                   │ │      │ ┌──────────┐ │      │    │
│ │                                     │ │      │ │Sarah,    │ │      │    │
│ │ [ ＋ image ]        137 chars       │ │      │ │it's Vici.│ │      │    │
│ └─────────────────────────────────────┘ │      │ │You're    │ │      │    │
│                                         │      │ │about 4…  │ │      │    │
│ ┌─ MERGE FIELDS ──────────────────────┐ │      │ └──────────┘ │      │    │
│ │ {{first_name}}   96% filled  ⚠      │ │      │      Delivered│     │    │
│ │   8 of 196 are empty                │ │      └──────────────┘      │    │
│ │   fallback: [ there          ]  ✓   │ │  showing: Sarah Chen ▾     │    │
│ │ ⚠ 3 look like junk: "N/A",          │ │  [ ‹ ] 1 of 196 [ › ]      │    │
│ │   "3055551234", "TEST"              │ └────────────────────────────┘    │
│ │   [ use fallback for these too ]    │                                   │
│ └─────────────────────────────────────┘                                   │
│                                                                           │
│ ┌─ COST AND ENCODING ─────────────────────────────────────────────────┐   │
│ │ GSM-7 · 137 chars                                                   │   │
│ │ ████████████████████████░░░░░░  137 / 160   1 segment               │   │
│ │                                                                     │   │
│ │ Across 196 recipients:   1 seg → 191    2 seg → 5  (longest name:   │   │
│ │                                          "Konstantinos")            │   │
│ │ Total billable segments 201        Cost $1.51                       │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│ ┌─ AI ────────────────────────────────────────────────────────────────┐   │
│ │ [ Draft from a brief ]  [ Critique this ]  [ Shorten to 1 segment ] │   │
│ │                                                                     │   │
│ │ Score 88 / 100 · ship                                               │   │
│ │  Opening 40 chars        20/20  names sender + individual reason    │   │
│ │  Knows this customer     20/20  actual SKU + individual interval    │   │
│ │  Specificity             15/15                                      │   │
│ │  Single action           15/15                                      │   │
│ │  Channel-native tone     15/15                                      │   │
│ │  Credible urgency        10/10  depletion-based, from real data     │   │
│ │  Segment economy          5/10  1 segment, 23 chars of headroom     │   │
│ │                                                                     │   │
│ │  Reads on a lock screen as:                                         │   │
│ │  ┌───────────────────────────────────────────┐                      │   │
│ │  │ Vici Peptides                       now   │                      │   │
│ │  │ Sarah, it's Vici. You're about 4 days f…  │                      │   │
│ │  └───────────────────────────────────────────┘                      │   │
│ │                                                                     │   │
│ │  Highest-leverage edit: none. Ship it.                              │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│                                          [ ← Back ]   [ Next: Preview → ] │
└───────────────────────────────────────────────────────────────────────────┘
```

**Live meters, all client-side, all recomputed on a 150ms debounce:**
- Encoding classification and segment count from `lib/encoding.js`, per P2-06 §5.2. Computed
  **per recipient**, not once on the template, and reported as a distribution. That is the
  correction from P2-06 and it changes the UI: the meter shows a distribution row, not a single
  number.
- Cost, exact, from the distribution.
- Merge-field coverage, from a `GET /api/segments/:id/merge-coverage` call cached per segment.

**The UCS-2 trap, when triggered:**

```
┌─ COST AND ENCODING ───────────────────────────────────────────────────┐
│ ⚠ UCS-2 forced by:  ’  curly apostrophe, position 34                  │
│                     —  em dash, position 88                           │
│                                                                       │
│   Now:       UCS-2 · 155 chars · 3 segments · $4.41 for 196 people    │
│   If fixed:  GSM-7 · 155 chars · 1 segment · $1.47 for 196 people     │
│                                                                       │
│   [ Fix the encoding ]   shows a character diff before applying       │
└───────────────────────────────────────────────────────────────────────┘
```

The fix never applies silently. It opens a diff (`’`→`'`, `—`→` - `, `…`→`...`, `“”`→`"`) with
Apply / Cancel. Per P2-06 §5.2 and the house no-em-dash rule, which point the same way.

**Blocks Next:** empty body; any merge field with empty values and no declared fallback (HARD
BLOCK, P2-06 §5.1); any recipient exceeding 4 segments; a public shortener in the body
(`bit.ly`, `tinyurl.com`, `goo.gl`, `t.co`, `is.gd`).

**Warns:** UCS-2; any recipient above 2 segments; junk merge values; more than one URL.

### 4.5 Step 3 — Preview

Specified in full in §5.

### 4.6 Step 4 — Test send

Specified in full in §6.

### 4.7 Step 5 — Schedule

```
┌ 1 Audience ─ 2 Message ─ 3 Preview ─ 4 Test ✓ ─ 5 SCHEDULE ─ 6 Review ────┐
│                                                                           │
│  When?      ○ As soon as it is approved                                   │
│             ◉ At a specific time                                          │
│                [ Thu 14 Aug 2026 ]  [ 12:00 ]  America/New_York           │
│                                                                           │
│  ┌─ QUIET HOURS ────────────────────────────────────────────────────────┐ │
│  │ House rule: everyone receives between 09:00 and 20:00 their local    │ │
│  │ time. Tighter than the law by one hour on each side, because we      │ │
│  │ infer timezone from area code and area codes move house.             │ │
│  │                                                                      │ │
│  │ At 12:00 ET:   ET 12:00 ✓   CT 11:00 ✓   MT 10:00 ✓   PT 09:00 ✓     │ │
│  │ ✓ All 196 recipients land inside the window.                         │ │
│  │                                                                      │ │
│  │ ⚠ 24 recipients (12%) had no state or usable area code and were      │ │
│  │   assumed Eastern.                              [ see who ]          │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ ROLLOUT ────────────────────────────────────────────────────────────┐ │
│  │ Sent in tranches with a pause between each, so a mistake stops at    │ │
│  │ 25 people instead of 196.                                            │ │
│  │                                                                      │ │
│  │   25 ──15m──▶ 75 ──20m──▶ 96                                         │ │
│  │   ▲ canary     ▲ delivery   ▲ remainder                              │ │
│  │                  rate                                                │ │
│  │                                                                      │ │
│  │  Finishes about 12:37 ET.        [ edit tranches ]                   │ │
│  │  Auto-abort if delivery drops below 85% or opt-outs exceed 2%.       │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│                                          [ ← Back ]   [ Next: Review → ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Blocks Next:** any recipient outside 09:00-20:00 local at their projected tranche time, with
two offered remedies (shift the window, or enable per-recipient deferral as an explicit choice);
scheduled time in the past.

**Warns:** more than 10% of the roster resolving timezone via the default fallback.

Default the picker to **12:00 ET**, which is 09:00 Pacific and satisfies every US mainland
timezone without deferral (P2-06 §5.3).

### 4.8 Step 6 — Review and approve

```
┌ 1 Audience ─ 2 Message ─ 3 Preview ─ 4 Test ✓ ─ 5 Schedule ─ 6 REVIEW ────┐
│                                                                           │
│  Spring restock — Semaglutide                                             │
│  196 people · Thu 14 Aug 12:00 ET · 3 tranches · $1.51                    │
│                                                                           │
│  ┌─ PRE-FLIGHT ─────────────────────────────────── 21 pass · 2 warn ──┐   │
│  │                                                                    │   │
│  │ ✓ Campaign integrity            ✓ Duplicate recipients             │   │
│  │ ✓ Sending not paused            ✓ Opt-out and suppression          │   │
│  │ ✓ Sender configured             ✓ Merge-field coverage             │   │
│  │ ✓ Production environment        ⚠ Merge-field junk        3 rows ▾ │   │
│  │ ✓ Segment resolves              ✓ Encoding and segments            │   │
│  │ ✓ Blast-radius cap              ✓ Link format                      │   │
│  │ ✓ Recipient-count sanity        ✓ Link reachability                │   │
│  │ ✓ Audience drift    +2%         ✓ Compliance lint                  │   │
│  │ ✓ Quiet hours                   ⚠ Deliverability posture         ▾ │   │
│  │ ✓ Frequency cap                 ✓ Cost ceiling                     │   │
│  │ ✓ Daily volume cap              ✓ TEST SEND GATE                   │   │
│  │                                                                    │   │
│  │ Two warnings need you to say you have read them:                   │   │
│  │  ☐ 3 recipients have a junk first name and will get the fallback   │   │
│  │  ☐ Delivery rate on this number fell from 97% to 91% over 30 days  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌─ WILL THIS BE MEASURABLE? ─────────────────────────────────────────┐   │
│  │ Holdout 10% (20 held / 176 messaged). Your baseline is 3.0%.       │   │
│  │                                                                    │   │
│  │ This send on its own could only prove a lift if conversion rose    │   │
│  │ above 10.3%. A strong campaign moves it about 1 point.             │   │
│  │ So: this send cannot be measured on its own. That is arithmetic,   │   │
│  │ not a fault in the campaign.                                       │   │
│  │                                                                    │   │
│  │ It is send 4 of about 27 needed to measure a +1 point lift.        │   │
│  │ ████░░░░░░░░░░░░░░░░░░░░░░░  4 / 27                                │   │
│  │ On your current cadence, around February 2027.                     │   │
│  │                                          [ what does this mean? ]  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌─ WHAT IT MIGHT PRODUCE ────────────────────────────────────────────┐   │
│  │ Cost                     $1.51    exact                            │   │
│  │ Orders                   6        90% range 2 to 11                │   │
│  │ Click-attributed revenue $857     90% range $290 to $1,640         │   │
│  │                                                                    │   │
│  │ This projects ATTRIBUTED revenue: orders from people who clicked.  │   │
│  │ It is not a projection of incremental revenue. Most of these       │   │
│  │ orders would probably have happened anyway.                        │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Tested by Dominic, acknowledged 14:22 today, for this exact message.     │
│  Authorised by: Lubosi Kongwa                                             │
│                                                                           │
│           [ ← Back ]  [ Save as draft ]  [ ✓ Approve and schedule ]       │
└───────────────────────────────────────────────────────────────────────────┘
```

The Approve button is disabled until: zero BLOCKs, every WARN checkbox ticked, and (for the
first five campaigns, P2-06 §5.6) the authorising operator differs from the one who
acknowledged the test. The button label says exactly what it does. There is no "send now"
shortcut anywhere in the builder.

### 4.9 Moving backwards

| From | To | Effect |
|---|---|---|
| any | any earlier completed step | allowed, nothing discarded |
| 6 → 2 and edit the body | | test invalidated, step 4 shows a red dot, step 6 blocked |
| 6 → 1 and change segment | | test invalidated (segment definition is in the content hash) |
| 6 → 5 and change the time | | test **not** invalidated (`scheduled_at` is outside the hash) |
| 6 → 5 and change tranches or holdout | | test **not** invalidated |
| edit the campaign name or notes | | test **not** invalidated |

That mapping comes straight from P2-06 §2.3, and the UI must mirror it exactly. Nothing erodes
trust in a gate faster than it firing on a change that could not possibly matter, or staying
green after one that did.

---

## 5. Preview: getting this right

### 5.1 What the preview is for

The user's stated want is "see how it looks on a phone before sending". There are three distinct
questions hiding in that, and the UI should answer all three separately:

1. **Does the text render correctly?** Merge fields, encoding, line breaks, the link. Answerable
   with high confidence in the browser.
2. **What does the recipient see in the two seconds that decide everything?** The lock-screen
   notification, truncated. Research 01 §2.1 argues this is the real headline of an SMS.
   Answerable with high confidence.
3. **Will the carrier and the handset render it the way I expect?** Not answerable in a browser,
   at all. Only a real test send answers this (§6), and the UI must say so rather than implying
   otherwise.

### 5.2 The step 3 screen

```
┌ 1 Audience ─ 2 Message ─ 3 PREVIEW ─ 4 Test ─ 5 Schedule ─ 6 Review ──────┐
│                                                                           │
│  Previewing as:  [ Sarah Chen  ·  +1 305 ••• 4821 ▾ ]   [ ‹ 1/196 › ]     │
│                  ○ typical recipient    ◉ worst case (most empty fields)  │
│                  ○ random               ○ pick someone…                   │
│                                                                           │
│  ┌── LOCK SCREEN ─────────────┐   ┌── IN THE THREAD ────────────────┐     │
│  │  ╭──────────────────────╮  │   │  ╭───────────────────────────╮  │     │
│  │  │ ● Vici Peptides  now │  │   │  │  9:41         ▪ ▮ ▮▮▮     │  │     │
│  │  │ Sarah, it's Vici.    │  │   │  ├───────────────────────────┤  │     │
│  │  │ You're about 4 days… │  │   │  │  ‹  (305) 404-3184        │  │     │
│  │  ╰──────────────────────╯  │   │  ├───────────────────────────┤  │     │
│  │                            │   │  │                           │  │     │
│  │  Cut at 47 characters.     │   │  │  ┌─────────────────────┐  │  │     │
│  │  Everything after "days"   │   │  │  │ Sarah, it's Vici.   │  │  │     │
│  │  is invisible until they   │   │  │  │ You're about 4 days │  │  │     │
│  │  open it.                  │   │  │  │ from running out of │  │  │     │
│  │                            │   │  │  │ BPC-157. Same order,│  │  │     │
│  │  ⚠ This is an unknown      │   │  │  │ one tap:            │  │  │     │
│  │    sender for 12 of your   │   │  │  │ go.vicipeptides.com │  │  │     │
│  │    196 recipients. They    │   │  │  │ /r/8f2              │  │  │     │
│  │    see the number, not     │   │  │  │ Reply STOP to end   │  │  │     │
│  │    the name.               │   │  │  └─────────────────────┘  │  │     │
│  └────────────────────────────┘   │  │              Delivered    │  │     │
│                                   │  ╰───────────────────────────╯  │     │
│  GSM-7 · 137 chars · 1 segment    └─────────────────────────────────┘     │
│  This recipient costs $0.0075                                             │
│                                                                           │
│  ┌─ WHAT THIS PREVIEW CANNOT SHOW YOU ────────────────────────────────┐   │
│  │ This is our rendering of your text. It is accurate about the       │   │
│  │ words, the merge fields, the encoding and the cost. It cannot      │   │
│  │ show:                                                              │   │
│  │                                                                    │   │
│  │  · whether the carrier delivers or filters it                      │   │
│  │  · how their specific phone lays out the bubble                    │   │
│  │  · whether iOS builds a link preview card under the message        │   │
│  │  · what is above this message in their thread with you             │   │
│  │  · their text size, dark mode, or language settings                │   │
│  │  · whether the number shows as "Vici Peptides" or as digits        │   │
│  │                                                                    │   │
│  │ A test send to a real handset is the only thing that shows those.  │   │
│  │                                              [ Next: Test send → ] │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Rendering rules

**Bubble geometry.** Match iOS Messages closely enough to be honest, not pixel-perfectly:
max bubble width 262px inside a 320px thread column, 17px SF text at 1.29 line height, 16px
horizontal / 9px vertical padding, 18px corner radius with the tail on the inbound side. Do not
claim pixel accuracy; claim "close". Reuse the existing `.msg-bubble` styles
(`styles.css:499-530`) so the preview and the real inbox cannot drift apart.

**Merge substitution.** Rendered against a **real contact row**, never a fixture. Two presets
matter and both must be one click away:
- *typical*: a random roster member.
- *worst case*: the roster member with the most null merge fields. This is where `Hi ,` shows
  up, and it is the render that catches the bug (P2-06 §2.2).

Substituted values get a faint highlight on hover with a tooltip naming the field and the
source row, so an operator can tell "Sarah" came from data rather than from the template.

**Empty and junk fields.** An empty field with no fallback renders as a red `▮` block, not as
nothing, so it cannot be missed. A junk value (`3055551234`, `N/A`, `TEST`) renders as-is in
amber with a warning underneath: `Hi 3055551234, reads worse than Hi there.`

**Links.** SMS has no link preview; a URL is plain text and counts character for character. The
preview renders the shortened branded URL exactly as it will appear and does **not** draw a rich
card. What it does say is that Apple Messages may generate a preview card of its own when the
URL is the only thing in the message, that we cannot predict it, and that our message is not URL-only
so it probably will not. Per-recipient tokens differ, so the preview shows a real token from the
test roster and labels it: `link shown is a sample token; each recipient gets their own`.

**MMS.** Render the image at its real post-downscale dimensions using the existing
`downscaleImage` (app.jsx:128-159), with the file size and a warning above 500KB. Say plainly
that MMS is billed differently from SMS, that some carriers re-compress, and that Android and
iOS crop thumbnails differently. Show the image above the text, as both platforms do.

**Reduced motion / dark mode.** The preview panel is a fixed light-mode iOS render regardless of
the operator's theme. A dark preview inside a dark app reads as part of the app rather than as a
phone, and most recipients are in light mode. State it in a caption.

### 5.4 The rail version

From step 2 onwards the preview is a persistent right rail at desktop widths above 1180px: the
thread bubble, the recipient selector, and the encoding line. No disclosures panel, no lock
screen. Below 1180px and on mobile it collapses to a `[ Preview ]` button that opens a sheet.
Step 3 is the full screen above.

---

## 6. Test sends: a hard gate

### 6.1 The rule, stated in the UI

P2-06 §2.6 is unambiguous: **no override, by anyone, ever.** The interface must say why, in the
place where someone would look for the override, because an unexplained wall invites a
workaround:

> **Every campaign is tested on a real phone before it can be scheduled.**
> There is no way around this and there is deliberately no override. Testing costs about
> thirty seconds and one and a half cents. There is no emergency where that is too expensive.

### 6.2 Test numbers: managed, in Settings

`Settings ▸ Test numbers`, backed by `sms_test_numbers` (P2-06 §2.1).

```
┌ Settings ▸ Test numbers ──────────────────────────────────────────────────┐
│                                                                           │
│  Every campaign is sent to these phones first. Only numbers on this list  │
│  can receive a test.                                                      │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ★ Dominic iPhone    +1 631 742 6316   US · Verizon · iOS   active │    │
│  │   PRIMARY. A US primary must accept the send before any campaign  │    │
│  │   can be scheduled.                                    [ edit ]   │    │
│  ├───────────────────────────────────────────────────────────────────┤    │
│  │   Lubosi UK         +44 7506 440284   GB · EE · iOS       active  │    │
│  │   ⚠ UK numbers do not travel over US A2P 10DLC. This phone can    │    │
│  │     confirm the words look right. It cannot confirm the message   │    │
│  │     will be delivered in the US, and it cannot satisfy the gate   │    │
│  │     on its own.                                        [ edit ]   │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  [ + Add a test number ]                                                  │
│                                                                           │
│  ⚠ You have one US primary. If that phone is off or out of signal, no     │
│    campaign can be scheduled. Two US primaries on different carriers is   │
│    the fix, and a prepaid SIM costs about $15 a month.                    │
└───────────────────────────────────────────────────────────────────────────┘
```

The single-point-of-failure warning is not decoration. With no override, one dead phone stops
all sending, and the operator should learn that from a settings page rather than from a blocked
campaign at 11pm.

### 6.3 Step 4 — the test screen

```
┌ 1 Audience ─ 2 Message ─ 3 Preview ─ 4 TEST ─ 5 Schedule ─ 6 Review ──────┐
│                                                                           │
│  Send this to a real phone and look at it.                                │
│                                                                           │
│  Two messages go to each test phone: one rendered for a typical           │
│  recipient, one rendered for the recipient with the most empty fields.    │
│  Same sending number, same links, same encoding as the real send.         │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ☑ ★ Dominic iPhone   +1 631 ••• 6316   US primary                 │    │
│  │ ☑   Lubosi UK        +44 7506 ••• 284  rendering check only       │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  Typical:     Sarah Chen        "Sarah, it's Vici. You're about 4…"       │
│  Worst case:  contact ••• 9014  "there, it's Vici. You're about 6…"       │
│                                                                           │
│                        [ Send test now ]    2 phones · 4 messages · $0.03 │
│                                                                           │
│  ── after sending ─────────────────────────────────────────────────────   │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │  Sent 14:20:06 by Lubosi                                          │    │
│  │                                                                   │    │
│  │  ★ Dominic iPhone   ✓ delivered 14:20:09                          │    │
│  │    Lubosi UK        ✓ delivered 14:20:11                          │    │
│  │                                                                   │    │
│  │  Delivery receipts say the carrier accepted it. They do not say   │    │
│  │  a human looked at it. Someone has to look.                       │    │
│  │                                                                   │    │
│  │      ┌──────────────────────────────────────────────────┐         │    │
│  │      │  I received it on my phone and it looks right    │         │    │
│  │      └──────────────────────────────────────────────────┘         │    │
│  │      note (optional): [                                    ]      │    │
│  │                                                                   │    │
│  │  Or reply OK from a test phone and we will record it here.        │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ── once acknowledged ─────────────────────────────────────────────────   │
│                                                                           │
│  ✓ Tested and confirmed by Dominic at 14:22 today.                        │
│    Valid until 14:22 tomorrow, and only for this exact message.           │
│                                                                           │
│                                          [ ← Back ]  [ Next: Schedule → ] │
└───────────────────────────────────────────────────────────────────────────┘
```

**Acknowledgement, not delivery, is the gate** (P2-06 §2.5). The DLR is corroborating evidence
and is shown as such. The acknowledge button is enabled as soon as the send is accepted, so a
carrier that returns no receipt cannot deadlock the operator.

**Reply-to-acknowledge.** An inbound message from a registered test number within 30 minutes of
a test send auto-acknowledges it, attributed to that number's owner. This is worth building: the
tester is holding the phone the message arrived on, and asking them to walk to a laptop to press
a button is the friction that produces "let's just skip it this once".

### 6.4 Invalidation

The gate keys on `content_hash` (P2-06 §2.3). The UI must make the binding legible and must
never surprise.

**On any change that alters the hash**, a persistent banner appears at the top of the builder
and a red dot appears on step 4:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⚠ Your last test no longer applies.                                       │
│   You changed the message body at 14:31, after the test at 14:22.         │
│   Test again before this can be scheduled.        [ Go to test send ]     │
└───────────────────────────────────────────────────────────────────────────┘
```

The banner names **what** changed and **when**, from a client-side diff against the tested
snapshot. Generic invalidation is what makes gates feel arbitrary.

Changes that invalidate: body text (down to one space or one `'`→`'`), media added/removed, link
destinations, sending number or messaging profile, which merge fields are used, declared
fallbacks, the segment definition.

Changes that do not: campaign name, notes, tags, scheduled time, tranche sizes, pacing, holdout
percentage.

**Audience drift is separate and is shown separately**, because it is not something the operator
did:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⓘ Your audience has moved since you tested.                               │
│   196 at test time → 203 now  (+3.6%)                                     │
│   7 joined, 0 left.                                    [ see who ]        │
│   Under 10%, so your test still stands.                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

At 10-30% this becomes an amber WARN requiring a tick at review. Above 30% it is a hard block
reading `Your audience changed by 34% since you tested. Test again.` (P2-06 §2.3).

**Expiry.** The 24-hour window is shown as an absolute time, not a countdown
(`Valid until 14:22 tomorrow`). A ticking clock creates pressure to rush, which is the opposite
of the point. Within two hours of expiry the line turns amber.

### 6.5 Test history

Under the acknowledgement block, collapsed by default:

```
▾ Test history for this campaign
   14:22  ✓ acknowledged by Dominic   "looks right"      current message
   11:04  ✓ acknowledged by Dominic                      superseded, body changed
   10:51  ✗ not acknowledged                             superseded, body changed
```

Rows carry a short hash prefix on hover. This is the audit trail for "who tested this and when",
and it is the same data an approver reads at step 6.

---

## 7. Segment builder and preview

### 7.1 Principles from P2-02 that constrain the UI

- Segments **overlap freely**. The UI must never suggest that membership is exclusive, must
  never ask the operator to resolve an overlap, and must present overlap as information.
- Conflicts resolve at send time on a **static priority ladder**, and losers are **deferred, not
  dropped** (except broadcast/promo, which drops). So the exclusion breakdown says
  "deferred to 16 Aug" where that is true, and "not sent" only where it is.
- `lifecycle_stage` is **single-valued**. In the field picker it is a radio-style single-select
  attribute, visually distinct from the multi-valued labels around it, with a one-line
  explanation.

### 7.2 The builder

```
┌ SEND ▸ Segments ▸ Due a reorder (high confidence) ────────────────────────┐
│                                                                           │
│  Name  [ Due a reorder (high confidence)                              ]   │
│                                                                           │
│  Include people who match  ◉ all  ○ any  of these:                        │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │  Lifecycle stage        is           [ repeat_active        ▾ ] ✕ │    │
│  │     ⓘ single value: a person is in exactly one lifecycle stage    │    │
│  ├───────────────────────────────────────────────────────────────────┤    │
│  │  Predicted reorder date within        [ 5 ] days                ✕ │    │
│  ├───────────────────────────────────────────────────────────────────┤    │
│  │  Reorder confidence     is           [ high (CV < 0.35)     ▾ ] ✕ │    │
│  ├───────────────────────────────────────────────────────────────────┤    │
│  │  ┌ any of ────────────────────────────────────────────────────┐   │    │
│  │  │  Bought product     is   [ BPC-157            ▾ ]        ✕ │   │    │
│  │  │  Bought product     is   [ Semaglutide        ▾ ]        ✕ │   │    │
│  │  │  [ + condition ]                                          │   │    │
│  │  └───────────────────────────────────────────────────────────┘ ✕ │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  [ + condition ]   [ + group ]                                            │
│                                                                           │
│  ┌ IN PLAIN ENGLISH ──────────────────────────────────────────────────┐   │
│  │ People who are repeat customers, are predicted to run out within   │   │
│  │ 5 days, whose reorder timing we can predict confidently, and who   │   │
│  │ have bought BPC-157 or Semaglutide.                                │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│                                  [ Cancel ]  [ Save ]  [ Save and use → ] │
└───────────────────────────────────────────────────────────────────────────┘
```

The plain-English restatement regenerates on every change. It is the cheapest defence against a
rule that reads correctly and means something else, and it is what a non-technical operator will
actually verify against.

**Field picker**, grouped, with the source named on each so nobody has to guess:

```
Orders        order count · lifetime value · average order value ·
              first order date · last order date · days since last order ·
              bought product · bought category · order status
Reorder       predicted reorder date · reorder confidence · average interval
Engagement    last messaged · last replied · replied ever · clicked ever ·
              last clicked · campaigns received (30d)
Lifecycle     lifecycle stage  ⓘ single value
Consent       has consent record · consent source · opted out
Contact       first name present · email present · state · city · country
Labels        VIP · any custom label
```

### 7.3 The live preview panel

Docked right on desktop, collapsible sheet on mobile. Recomputes 400ms after the last edit, with
an `AbortController` cancelling the in-flight request.

```
┌─ WHO IS IN THIS RIGHT NOW ───────────────────────┐
│                                                  │
│                    214                           │
│              people match                        │
│           recomputed just now                    │
│                                                  │
│ ─ WOULD ACTUALLY RECEIVE A MESSAGE ────────────  │
│   matched                        214             │
│     − opted out                    6   ⓘ         │
│     − no consent record            0   ⓘ         │
│     − messaged in last 72h        11   ⓘ         │
│     − invalid number               1   ⓘ         │
│   = eligible                     196             │
│                                                  │
│ ─ A SAMPLE ──────────────────────── [ see all ]  │
│  Sarah Chen        last order 12 Jul   $340      │
│  M. Delgado        last order  8 Jul   $180      │
│  contact •••9014   last order 14 Jul   $220      │
│      ⚠ no first name                             │
│  J. Okafor         last order  2 Jul   $410      │
│  K. Papadopoulos   last order 11 Jul   $95       │
│                                     [ 5 of 196 ] │
│                                                  │
│ ─ ALSO IN OTHER SEGMENTS ──────────────────────  │
│  Everyone with consent          196 of 196       │
│  VIP                             31 of 196       │
│  Lapsed 90-180 days               0 of 196       │
│                                                  │
│  Overlap is normal and expected. If two           │
│  campaigns want the same person on the same       │
│  day, the higher-priority one sends and the       │
│  other waits its turn.        [ how priority     │
│                                  works ]         │
│                                                  │
│ ─ RECENT CONTACT ──────────────────────────────  │
│  138 of 196 received a campaign in the last      │
│  14 days. That is high. Consider narrowing.      │
└──────────────────────────────────────────────────┘
```

Every subtraction line is clickable and opens the list of who and why. Per research 05 §7.1, the
exclusion ledger is the thing that stops an operator wondering where people went.

The overlap block is deliberately reassuring rather than alarming, and the deferral explanation
is one click away. This is the direct UI consequence of P2-02 §2.4: overlap without a visible
deferral story is worse than exclusivity, because the campaign silently shrinks.

### 7.4 Saving and reuse

Segments are named, saved, and versioned by definition hash. Editing a segment used by a
scheduled campaign shows:

```
⚠ "Spring restock" is scheduled for Thursday and uses this segment.
  Changing it will change who that campaign goes to, and will invalidate
  its test.        [ Cancel ]  [ Save a copy instead ]  [ Change it anyway ]
```

`Save a copy instead` is the default focus. Editing a live segment is a real footgun and the
easiest safe path should be the one under the cursor.

---

## 8. The honest dashboard

### 8.1 The design problem

Three tiers of decreasing defensibility have to be shown together, and tier 3 will read
"not yet measurable" for months. The failure mode is that the screen looks broken or apologetic,
the operator stops opening it, and the honesty becomes worthless because nobody sees it.

Four devices avoid that:

1. **Descending confidence is the layout.** Tier 1 is a real number in the largest type on the
   screen. It is genuinely knowable and genuinely useful. Nobody is deprived of a number.
2. **Tier 3 is framed as an instrument that is still filling, not a result that failed.** Its
   headline is a **progress bar**, not a blank. Progress bars read as "working", and this one is
   truthfully working: every send moves it.
3. **Texture, not just words, encodes evidence.** Solid fill = deterministic. Hatched = inferred.
   Outline only = not yet measurable. Legible at a glance without reading a legend.
4. **The honesty is stated as a claim about us, not an apology about the data.** "We only count
   what we can trace" is a boast. "We don't have enough data" is a shrug. Same fact.

### 8.2 The campaign results screen

```
┌ SEND ▸ Campaigns ▸ Spring restock ────────────────────────────────────────┐
│  Sent 4 Aug 12:00 ET · 176 messaged · 20 held back · $1.51 spent          │
│                                                                           │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ ① MONEY WE CAN TRACE TO A CLICK                              $1,410   │ │
│ │   ████████████████████████████████  solid = traced                    │ │
│ │                                                                       │ │
│ │   9 orders from people who tapped your link within 72 hours.          │ │
│ │   Grade A, matched by click token   $1,180  (7 orders)                │ │
│ │   Grade B, matched by phone/email     $230  (2 orders)                │ │
│ │                                                                       │ │
│ │   Every one of these is a row you can open.   [ see the 9 orders ]    │ │
│ ├───────────────────────────────────────────────────────────────────────┤ │
│ │ ② MONEY THAT MIGHT BE RELATED                                  $620   │ │
│ │   ▨▨▨▨▨▨▨▨▨▨▨▨  hatched = inferred, not traced                        │ │
│ │                                                                       │ │
│ │   4 more orders from people who received this and did not click.      │ │
│ │   This is a coincidence in time, not evidence. Some of it is real     │ │
│ │   and some of it would have happened anyway. We cannot tell which,    │ │
│ │   so it is not added to ① and it is not in any return figure.         │ │
│ │                                              [ show ▾ ] off by default│ │
│ ├───────────────────────────────────────────────────────────────────────┤ │
│ │ ③ MONEY THIS CAMPAIGN ACTUALLY CAUSED         NOT YET MEASURABLE      │ │
│ │   ░░░░░░░░░░░░░░░░░░░░░░░  outline = we are still measuring           │ │
│ │                                                                       │ │
│ │   Evidence collected:  ████░░░░░░░░░░░░░░░░░░░░  4 of ~27 sends       │ │
│ │                                                                       │ │
│ │   Running estimate across all 4 sends so far:                         │ │
│ │        +$180     (90% range: −$1,900 to +$2,300)                      │ │
│ │                                                                       │ │
│ │   That range crosses zero. We cannot yet tell this apart from no      │ │
│ │   effect at all. Do not act on the +$180.                             │ │
│ │                                                                       │ │
│ │   Keep the holdout running and this narrows with every send.          │ │
│ │   On your current cadence, around February 2027.                      │ │
│ │                                        [ why 27 sends? ]              │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Cost $1.51  ·  Traced return 933x  ⓘ this is not the same as profit      │
│                                                                           │
│  Delivered 174 of 176 (98.9%)  ·  Clicked 22 (12.6%)  ·  Opted out 1      │
│  Replied 4                                     [ open the 4 replies ]     │
│                                                                           │
│  Traced SMS revenue is 9% of total store revenue this month.              │
└───────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Concrete label and tooltip copy

Labels, exactly:

| Element | Copy |
|---|---|
| Tier 1 heading | `MONEY WE CAN TRACE TO A CLICK` |
| Tier 1 sub | `9 orders from people who tapped your link within 72 hours.` |
| Tier 1 proof line | `Every one of these is a row you can open.` |
| Tier 2 heading | `MONEY THAT MIGHT BE RELATED` |
| Tier 2 badge | `not counted` |
| Tier 3 heading | `MONEY THIS CAMPAIGN ACTUALLY CAUSED` |
| Tier 3 value, early | `NOT YET MEASURABLE` |
| Tier 3 progress | `Evidence collected: 4 of ~27 sends` |
| Zero-crossing line | `That range crosses zero. We cannot yet tell this apart from no effect at all.` |
| Return line | `Traced return 933x` + `this is not the same as profit` |
| Self-check | `Traced SMS revenue is 9% of total store revenue this month.` |

Tooltips, exactly:

- **Grade A** — `Matched by the unique link this person tapped. The strongest evidence there is: this specific person clicked, then bought.`
- **Grade B** — `Matched by phone number or email rather than by a click. Strong, but it assumes the person who bought is the person we messaged.`
- **Why not counted (tier 2)** — `They received the message and bought, but never tapped the link. That is a coincidence in time. Counting it is how other platforms produce numbers that look better than they are.`
- **Why 27 sends** — `With 176 people and a 10% holdout, one send could only prove a lift if orders jumped by more than 245%. Real campaigns move it a percentage point or two. It takes about 27 sends before the numbers can separate a real effect from luck. This is arithmetic about your list size, not a judgement about your campaigns.`
- **Traced return** — `Revenue we could trace, divided by what the messages cost. It is not profit: it does not subtract the cost of the goods, and it does not mean these orders would not have happened without the message.`
- **Store revenue check** — `We show this so you can sanity-check us. If our number ever claims most of your revenue, something is wrong with our attribution and we would rather you caught it.`

### 8.4 The programme dashboard

```
┌ SEND ▸ Campaigns ▸ Results ───────────────── last 90 days ▾ ──────────────┐
│                                                                           │
│  ┌─ WHAT WE KNOW TODAY ──────────┐  ┌─ WHAT WE WILL KNOW ──────────────┐  │
│  │                               │  │                                  │  │
│  │  Traced to a click            │  │  Whether SMS causes extra sales  │  │
│  │        $4,830                 │  │  at all, and roughly how much.   │  │
│  │  31 orders across 4 campaigns │  │                                  │  │
│  │                               │  │  ████░░░░░░░░░░░░░░  4 of ~27    │  │
│  │  Cost      $6.04              │  │  around Feb 2027                 │  │
│  │  Opt-outs  4  (0.5%)          │  │                                  │  │
│  │            ⓘ half your list   │  │  Every send with a holdout       │  │
│  │              in 17 months at  │  │  moves this. Turning the holdout │  │
│  │              this rate        │  │  off resets it.                  │  │
│  └───────────────────────────────┘  └──────────────────────────────────┘  │
│                                                                           │
│  Per campaign                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ Campaign          Sent  Deliv  Click  Traced $  Cost   Opt-outs   │    │
│  │ Spring restock     176  98.9%  12.6%    $1,410  $1.51        1    │    │
│  │ BPC-157 restock    187  97.9%  15.1%    $1,840  $1.61        0    │    │
│  │ Win-back 90d       108  96.3%   4.6%      $340  $1.02        3    │    │
│  │ July replenish     193  98.4%  11.4%    $1,240  $1.90        0    │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  Not enough campaigns yet to draw a trend line. We will start at 8.       │
│                                                                           │
│  [ Trust ledger: every order we counted, and why ]                        │
└───────────────────────────────────────────────────────────────────────────┘
```

The two-column "what we know / what we will know" split is the single most important framing
device here. It converts an absence into a schedule. The right column has a number in it, and
that number goes up.

Note the deliberate refusal on the trend line, rendered as UI copy rather than as a blank chart
(research 05 §8.2 rule 7). A refusal that explains itself reads as rigour. An empty chart reads
as a bug.

### 8.5 The trust ledger

A plain table, deliberately in a different visual language from the dashboard: no cards, no
colour, fixed row height, filters above, CSV export. Columns: order id, contact, order total,
grade, match method, touch time, order time, hours to convert, whether an email touch also
qualified, repeat buyer.

Header line: `Every dollar in the headline is one of these rows. If it is not here, we did not
count it.`

### 8.6 First-send empty state

The dashboard before any campaign has sent must not look like a failure:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Nothing sent yet.                                                        │
│                                                                           │
│  When you send your first campaign this page will show three things,      │
│  in order of how sure we are:                                             │
│                                                                           │
│   1. Money we can trace to a click.       Available immediately.          │
│   2. Money that might be related.         Available immediately, and      │
│                                            never counted as revenue.      │
│   3. Money the campaign actually caused.  Needs about 27 sends with a     │
│                                            holdout before it can be       │
│                                            answered honestly.             │
│                                                                           │
│  Most tools show you one number and call it revenue. We will show you     │
│  which of the three it is.                     [ Create a campaign ]      │
└───────────────────────────────────────────────────────────────────────────┘
```

### 8.7 Rules the components enforce in code

- No dollar figure renders without an evidence-grade badge.
- No point estimate renders next to an interval crossing zero without the words
  `We cannot yet tell this apart from no effect at all.` in the same block.
- No figure renders that cannot be drilled to rows.
- Changing the attribution window draws a vertical annotation on every time series reading
  `attribution window changed here; figures before and after are not comparable`.
- No trend line under 8 points, no trend line over counts under 30.
- Anywhere the honest answer is "not yet", the component renders the progress meter rather than
  a dash, an em dash, or a zero.

---

## 9. Activity Center UI

### 9.1 Placement

Bell in the header (desktop) and in the mobile header. Opens a **340px right rail** on desktop
that pushes the main content rather than overlaying it, and a full-screen sheet on mobile. Not a
tab, per research 06 §9.1. Dot when unread `act`-tier items exist; never a count.

### 9.2 The feed

Exactly **six event types at launch** (research 06 §10.2): `message.sent` (human actors only),
`call.answered`, `call.missed`, `call.ended`, `automation.cancelled`, `contact.opted_out`.
Adding a seventh requires someone to ask for it by name.

```
┌ ACTIVITY ────────────────────── ✕ ┐
│ [ All ] [ Needs you ] [ Team ▾ ]  │
├───────────────────────────────────┤
│  NEEDS YOU                        │
│ ┌───────────────────────────────┐ │
│ │ ↙ Missed call from            │ │
│ │   (305) 555 0142        2m    │ │
│ │   rang 24s        [ call back]│ │
│ └───────────────────────────────┘ │
├───────────────────────────────────┤
│  TODAY                            │
│                                   │
│ (D) Dominic replied to            │
│     Sarah Chen              12m   │
│     "Yes, that ships Monday…"     │
│                                   │
│ (D) Dominic sent 9 messages       │
│     to Sarah Chen           41m   │
│                                   │
│ (•) Call answered           1h    │
│     (631) 555 9902 · 4m 12s       │
│     ⓘ we cannot yet tell who      │
│                                   │
│ (D) Dominic cancelled a queued    │
│     hold-msg2 to M. Delgado  2h   │
│                                   │
│ (!) +1 305 ••• 7781 opted out 3h  │
│                                   │
│ ─────── Yesterday ───────         │
│ …                                 │
└───────────────────────────────────┘
```

**Line anatomy** (research 06 §3.12): 20px round avatar, actor name in semibold as the only bold
text, verb phrase in regular muted weight, object as an inline chip, relative time right-aligned
and muted with the absolute time on hover.

**Pre-rendered server-side.** The row carries the sentence; the client does not compose it from
parts. Three independent products converged on this and it also means changing wording does not
require a client release, which matters for iOS.

**Grouping happens at write time.** The client renders `batch_count` and never regroups. No
client-side collapsing of consecutive rows, which is what makes Linear's feed visibly thrash
while paging.

**Self-suppression.** The reader never sees their own actions. This needs per-user addressed SSE
and is the single most-missed detail in feed implementations.

**Read state.** A watermark, not per-item. Opening the rail marks everything above the newest
item read. Unread items carry a 6px dot on the left; there is no "mark all as read" button
because opening the rail is that button.

**`call.answered` with no name.** Renders as `Call answered` with an info glyph and the tooltip
`Everyone shares one calling credential, so we cannot yet tell who picked up. Individual
credentials would fix this.` Shipping it nullable is correct; hiding it would be worse.

### 9.3 Collision detection: build this before the feed

At two users this is worth more than the feed (research 06 §8.1). Three mechanisms, in build
order.

**(1) Stale-reply guard. Build first. No presence infrastructure at all.** On submit, if a newer
message exists in the thread than the one loaded when the composer was focused, the send pauses:

```
┌───────────────────────────────────────────────────────────────┐
│  Something arrived while you were typing.                     │
│                                                               │
│  Sarah Chen · 14s ago                                         │
│  "actually ignore that, I found it"                           │
│                                                               │
│  Your message:                                                │
│  "It's under Orders in your account."                         │
│                                                               │
│              [ Send anyway ]     [ Let me look ]              │
└───────────────────────────────────────────────────────────────┘
```

`Let me look` is the default focus. This is a server-side comparison of message ids, it cannot
produce a false negative from a dropped heartbeat, and it is the cheapest of the three.

**(2) Viewing indicator.** A small avatar on the conversation row in the list and in the thread
header:

```
conv list row:            thread header:
┌──────────────────────┐  ┌────────────────────────────────────┐
│ (SC) Sarah Chen  12m │  │ ‹  Sarah Chen                      │
│      Yes, that ship… │  │    (305) 555 0142                  │
│                 (D)  │  │                    (D) Dominic is  │
└──────────────────────┘  │                        viewing     │
     └ Dominic is here    └────────────────────────────────────┘
```

**(3) Composing indicator.** The expensive case: two people sending near-duplicate replies. It
appears **inside the composer**, in amber, because that is where the eyes are:

```
┌────────────────────────────────────────────────────────────┐
│ ⚠ Dominic is replying to this right now                    │
├────────────────────────────────────────────────────────────┤
│ [ ＋ ]  Type a message…                              [ ↑ ] │
└────────────────────────────────────────────────────────────┘
```

Transport: heartbeat on the existing SSE bus, `POST /api/presence/heartbeat` every 10s, 30s TTL
(research 06 §8.3). Do not add Supabase Realtime as a second transport for this; it would land
on iOS too. Presence dying on redeploy is acceptable and self-heals in 30 seconds. The UI must be
idempotent about join/leave and must not animate on every event.

**Debounce:** fire on first keystroke, refresh every 10s while typing, clear after 30s idle or on
send or blur.

---

## 10. Login and account screens

### 10.1 Screens

| Screen | Route | Notes |
|---|---|---|
| Login | `#/login` | email + password. Replaces `LoginScreen` 181-225 |
| Forgot password | `#/login/forgot` | email entry, always shows the same confirmation |
| Reset password | `#/reset?token=` | from an emailed link |
| Accept invite | `#/invite?token=` | set name + password, then straight into the app |
| Claim account | `#/claim` | **transition only**, see §10.4 |
| Account | `Settings ▸ Account` | name, email, change password, sign out other devices |
| Team | `Settings ▸ Team` | list, invite, role change, deactivate |

### 10.2 Login

The existing login is genuinely good and Shore's is better: an animated canvas wave backdrop
(`shore/app.jsx:183-274`) mirroring `ShoreTheme.waveDeep/waveMid/waveShallow`, with a static
frame under `prefers-reduced-motion`. **Keep both.** The structural change is that
`LoginScreen` takes a `backdrop` slot and brand tokens rather than hardcoding
`VICI<small>// SMS</small>` (line 202) and the accent colour:

```jsx
<LoginScreen
  backdrop={caps.loginBackdrop}      // <WaveBackdrop/> for Shore, null for Vici
  wordmark={caps.wordmark}           // "VICI // SMS" | "The Shore Academy"
  subtitle={caps.loginSubtitle}      // "Secure Inbox Access" | "Team Inbox"
/>
```

One auth component, two brands, no fork.

```
┌────────────────────────────────────────────┐
│              VICI // SMS                   │
│           Secure Inbox Access              │
│                                            │
│   Email                                    │
│   [ dominic@vicipeptides.com          ]    │
│                                            │
│   Password                                 │
│   [ ••••••••••••                   ◉  ]    │
│                                            │
│   [        SIGN IN                    ]    │
│                                            │
│   Forgot your password?                    │
└────────────────────────────────────────────┘
```

Failed login says `Email or password is incorrect` for both cases and never distinguishes them.
Lockout messaging after repeated failures says how long, not how many attempts remain.

### 10.3 Team and roles

```
┌ Settings ▸ Team ──────────────────────────────────────────────────────────┐
│                                                          [ + Invite ]     │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ (LK) Lubosi Kongwa    lubosi@…        Owner    you                  │  │
│  │ (D)  Dominic          dominic@…       Admin    active 2m ago    ▾   │  │
│  │ (JS) Jess             jess@…          Agent    invited 3d, pending  │  │
│  │                                                [ resend ] [ cancel ]│  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Owner   everything, including billing and removing other owners          │
│  Admin   everything except billing. Can approve and send campaigns.       │
│  Agent   inbox, contacts and calls. Can draft and test a campaign but     │
│          cannot approve or schedule one.                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

Three roles, not five. The only permission boundary that carries real money is
approve-and-schedule, so that is the one the role model exists to draw. Adding roles later is
easy; removing them is not.

Role affects the UI in exactly four places: the Approve button at step 6 (disabled with
`Only an Admin or Owner can schedule a campaign. Ask one of them to review it.`), the kill
switch, Team management, and Test numbers.

### 10.4 The transition without locking anyone out

Two live users, a shared password, and an iOS app whose call answering depends on replaying that
password. The order matters.

**Stage 1 — seed, no visible change.** Create user rows for Lubosi and Dominic with real emails.
No UI change. Shared password still works.

**Stage 2 — dual auth.** `POST /auth/login` accepts either `{ password }` (legacy) or
`{ email, password }` (new). The legacy path mints a session with `user_id = null` and everything
still works. The login screen shows both fields with a small `Use the shared access code
instead` link that collapses to the single-field form. Nobody is locked out at any point.

**Stage 3 — claim.** On a successful legacy login, a one-time interstitial appears before the
app:

```
┌────────────────────────────────────────────────────────────┐
│  We are moving to personal logins.                         │
│                                                            │
│  Everyone currently shares one code, which means the app   │
│  cannot tell who did what. Personal logins fix that and    │
│  take about twenty seconds to set up.                      │
│                                                            │
│  Which one are you?                                        │
│    ◉ Lubosi Kongwa   lubosi@…                              │
│    ○ Dominic         dominic@…                             │
│    ○ Someone else                                          │
│                                                            │
│  Choose a password  [ ••••••••••••              ]          │
│  Confirm            [ ••••••••••••              ]          │
│                                                            │
│  [ Set it up now ]        [ Remind me tomorrow ]           │
└────────────────────────────────────────────────────────────┘
```

Dismissible for 14 days, then mandatory. After that the shared code stops working on web while
still working for the iOS compatibility path.

**Stage 4 — iOS.** One release, after web is stable for at least a week. See §11.3.

**Stage 5 — retire.** Remove the legacy branch only once telemetry shows zero legacy logins for
14 consecutive days, including from iOS.

**The operator selector stopgap.** P2-06 §5.6 proposes a `['dominic','lubosi']` dropdown on the
login screen as 15 lines of attribution-without-authentication, so campaigns are not blocked on
the 6-8 week auth programme. If campaigns ship before auth, build it, label it honestly in the
UI (`Who is using this device? This is for the record, not for security.`), and make sure the
column it writes migrates cleanly to a user id. Do not let it become permanent.

---

## 11. iOS scope

### 11.1 The campaign builder is web-only. Argue it properly.

Not because phones cannot do it, but because:

- **Every iOS change is slow and hard to reverse.** The app cannot be built on the current
  machine (macOS 13 against an Xcode 26 requirement) and ships through GitHub Actions to
  TestFlight. A bad wizard build is days to fix, not minutes.
- **The wizard is six dense screens** whose value is in seeing the exclusion ledger, the segment
  distribution and the pre-flight table at once. Reflowed to 390px they become six scrolls of
  numbers, and the design intent (see everything before you spend money) is lost.
- **Nothing about it is time-critical from a phone.** Campaigns are scheduled, not urgent.
- **The one genuinely phone-shaped part is already covered by SMS.** The tester holds the phone
  the test arrived on, and §6.3's reply-to-acknowledge means the acknowledgement is a text reply,
  not an app screen.

### 11.2 What iOS does get, in order

1. **Auth migration.** Mandatory, highest risk, §11.3.
2. **Campaign approval, read-only plus two buttons.** Push `Spring restock is ready for
   approval` deep-linking to a scrollable summary (audience count, the rendered message, the
   pre-flight result, who tested and when) with Approve and Send back for changes. Approving from
   a phone is genuinely useful and building it costs one screen. It creates no path to
   *authoring* on the phone, which is the point.
3. **Activity as a sheet behind a bell in the inbox nav bar.** Later, and only after the web feed
   has been in use long enough to know it is not wallpaper.
4. **Never:** the segment builder, the encoding meter, the dashboard, test-number management.
   Those are `Open on the web` links.

Push rules (research 06 §9.2): push only missed calls, send failures on messages this user sent,
conversations assigned to this user, opt-outs, and campaign-awaiting-your-approval. Never push
`aware`-tier activity. Do not add activity to the app badge, which currently means "things
waiting for you" (`lib/apns-notify.js:175-192`).

### 11.3 The re-auth path is load-bearing. Do not break it.

`APIClient.swift` caches the inbox password in `CredentialStore` on login and
`restoreSessionIfNeeded()` replays it on cold launch before fetching SIP credentials. That path
is what lets the phone ring when it wakes from a VoIP push on a locked screen. Breaking it is a
production incident for a live client.

Sequence:

1. Server keeps accepting the legacy `{ password }` body for at least one full release after web
   cuts over. Non-negotiable.
2. The iOS release adds `{ email, password }` and stores a refresh token, but **keeps the
   password replay as a fallback** when the token path fails for any reason.
3. Verify on a physical device, from a **locked** phone, from a cold launch, that an inbound call
   still rings, before that build leaves TestFlight. P2-06 §7.3 specifies this check; it is the
   one manual test that cannot be skipped.
4. Only after 14 days of clean telemetry does the password branch come out, in a separate
   release.

Shore has its own bundle id and the same path. Both apps need the same sequence, twice.

---

## 12. Shared versus forked

Shore needs the auth and activity work and explicitly wants **no automations and no campaigns**.
Three mechanisms keep that from becoming a third fork.

### 12.1 A capability object from the server

`GET /api/session` returns, alongside the user:

```json
{
  "user": { "id": "...", "name": "Lubosi Kongwa", "role": "owner" },
  "capabilities": {
    "campaigns": true, "segments": true, "automations": true,
    "voice": true, "orders": true, "intelligence": true,
    "activityFeed": true, "presence": true
  },
  "brand": {
    "wordmark": "VICI", "wordmarkSuffix": "// SMS",
    "loginSubtitle": "Secure Inbox Access",
    "loginBackdrop": null,
    "theme": "vici",
    "ourNumber": "+13054043184",
    "ourName": "Vici Peptides"
  }
}
```

Derived server-side from environment, never from a client build flag, so one artefact serves
both deployments and a capability cannot be re-enabled from devtools.

Consumed in exactly two ways:

```jsx
const caps = useCapabilities();
// 1. navigation
{caps.campaigns && <Tab id="send" label="Send" />}
// 2. guarded regions
<Feature name="campaigns"><CampaignsList/></Feature>
```

`<Feature>` renders nothing when off. It does not render a locked or upsell state; Shore is not a
downgraded Vici, it is a different configuration.

### 12.2 Kill the inline hex literals

151 hardcoded colours across 220 inline style objects is the actual reason theming means forking
today. Shore already has a full token set in `styles.css` (`--wave-backdrop` and an ocean palette
with a dark-mode block); Vici has one at `styles.css:9-31`. Neither can reach the inline styles.

The mechanical sweep, done during the §2 file split so it costs almost nothing extra:

| Literal | Count | Token |
|---|---:|---|
| `#9ca3af` | 39 | `var(--text2)` |
| `#2a2a2a` | 26 | `var(--border)` |
| `#16a34a` | 25 | `var(--accent)` |
| `#1a1a1a` | 16 | `var(--surface)` |
| `#6b7280` | 14 | `var(--text3)` |
| `#ef4444` | 13 | `var(--red)` |
| `#3b82f6` | 8 | `var(--blue)` |

Then `styles.css` splits into `tokens-vici.css` / `tokens-shore.css` plus a shared
`components.css`, and `index.html` loads the token file named by the deployment. Theming becomes
a stylesheet swap.

The two coexisting design systems (§1.6) should be reconciled to one at the same time. Pick the
CSS-variable system; the inline `#16a34a` family is the one with no variables behind it.

### 12.3 Hardcoded client facts

`ViciModal` (491-533) hardcodes `+1 (305) 404-3184` at line 515, `vicipeptides.com` at 517, and
`Vici Peptides` at 514. `callerNumberRef` defaults to `'+13054043184'` at line 2299. All of these
move to `brand`. Any new screen that names a client, a number or a domain is a review failure.

### 12.4 What this does not solve

Nothing here addresses the 21 diverged backend files (research 00 §7). This is frontend
containment: it makes the *client* single-source while the servers stay forked, so the campaign
builder does not have to be written twice. The fork-versus-multi-tenant decision is still owed,
and this work makes it cheaper rather than making it unnecessary.

---

## 13. Phased delivery

One frontend developer, backend endpoints available as needed. "Visible" means the user can see
a change in the running app.

| # | Phase | Days | Visible | Contents |
|---:|---|---:|:---:|---|
| 0 | Build system and split | **3** | no | esbuild swap; split into `src/`; delete dead `ContactModal`; `SessionContext`; `lib/bus.js`; `useHashRoute`; default tab to Inbox; screenshot regression at 3 widths |
| 1 | **Composer intelligence** | **3** | **yes** | `lib/encoding.js` replacing `charCount`; live encoding/segment/cost band in the existing inbox composer; UCS-2 detector with the diff-confirmed fix; `PhonePreview` component. **Ships to both clients. Fixes a live cost bug. Needs no backend.** |
| 2 | Theme tokens and capabilities | **2** | no | inline hex sweep; token split; `caps` object; `<Feature>`; brand extraction; Shore renders with `campaigns:false` |
| 3 | Auth screens | **4** | **yes** | login with email; forgot/reset; invite acceptance; claim interstitial; Team view; role gating |
| 4 | Collision detection | **2** | **yes** | stale-reply guard; then viewing and composing indicators over SSE presence |
| 5 | Segments | **4** | **yes** | list, rule builder, plain-English restatement, live preview panel, exclusion ledger, overlap block |
| 6 | Campaign builder, steps 1-4 | **7** | **yes** | list, shell, autosave, Audience, Message with AI panel, Preview, **Test send gate**, invalidation banners, Settings ▸ Test numbers |
| 7 | Campaign builder, steps 5-6 | **4** | **yes** | Schedule with quiet-hours and tranche visualisation; Review with the 24-check pre-flight table, measurability pre-flight, projection, approval |
| 8 | Send progress and kill switch | **2** | **yes** | live tranche progress over SSE with poll fallback; abort; global kill switch in Settings |
| 9 | Dashboard tiers 1 and 2 | **4** | **yes** | campaign results, click-attributed and associated, grade badges, drill-through, trust ledger table, empty states |
| 10 | Dashboard tier 3 | **3** | **yes** | measurability meter, running incremental estimate with interval, zero-crossing copy, programme two-column view, refusal states |
| 11 | Activity feed | **4** | **yes** | rail and sheet, six event types, pre-rendered lines, read watermark, filters, self-suppression |
| 12 | iOS approval screen | **3** | **yes** | push, deep link, read-only review, approve/reject. Separate release train. |

**Total: 45 days**, about nine working weeks, excluding the iOS auth migration which belongs to
the auth programme rather than to this plan.

**The order is deliberate.** Phase 1 is the smallest genuinely useful slice: three days, visible
to both clients on day four, fixes a real bug that is costing money now, requires no new table
and no new endpoint, and produces the exact component the wizard needs at phase 6. If the
programme is paused after phase 1, the work still paid for itself.

Phases 0 and 2 produce nothing visible and total five days. Say so up front rather than letting
them read as a stalled week.

Phase 4 is deliberately early and cheap. Research 06 §8.1 argues that at two users, collision
detection is worth more than the feed. Two days at position four, against four days at position
eleven, is the plan agreeing with that.

**Hard dependencies:** phase 3 needs the auth tables and endpoints. Phases 5-8 need
`sms_campaigns`, `sms_segments`, `sms_campaign_tests`, `sms_test_numbers` and the pre-flight
endpoint. Phases 9-10 need the click redirector and the attribution ledger, and those cannot be
backfilled: **the redirect service should ship before phase 6 even though the dashboard is
phase 9**, because attribution data accumulates in calendar time and there is no way to
reconstruct clicks that were never recorded.

---

## 14. Open items this plan depends on

1. **Does `npm run build` still run on Railway with esbuild in `dependencies`?** Verify on a
   preview deploy before merging phase 0. Nixpacks sets `NODE_ENV=production`, which is why
   `@babel/cli` is a runtime dependency today; copying that placement should be sufficient, but
   confirm rather than assume.
2. **Does the pre-flight run server-side or client-side?** This plan assumes a single
   `POST /api/campaigns/:id/preflight` returning all 24 results, rendered by a dumb table. The
   client must not reimplement any check, or the two will drift and the gate becomes advisory.
   Encoding is the exception: it runs in both places, client-side for the live meter and
   server-side as the authority, from the same shared algorithm.
3. **Is the operator-selector stopgap (P2-06 §5.6) being built?** If campaigns ship before auth,
   the wizard needs a named actor for test acknowledgement and approval. This plan assumes real
   auth (phase 3) lands first. If it does not, phases 6-7 need the stopgap wired in.
4. **What is the AI endpoint contract, and does the model 404 still stand?** Research 00 §8
   records `OPENROUTER_MODEL` returning 404 in production, which is probably why
   `sms_customer_profiles` has one row. The AI panel at step 2 must degrade to a plain composer
   with a visible explanation rather than an empty box.
5. **Does `go.vicipeptides.com` exist yet?** The preview renders a real short link. Until the
   redirector exists, it renders the destination URL and says so.
6. **Two-person authorisation for the first five campaigns** (P2-06 §5.6) needs two real user
   accounts, which makes phase 3 a hard prerequisite for phase 7 rather than a soft one.
7. **Shore's activity feed scope.** Shore gets auth and activity but no campaigns. The
   `campaign.*` event types simply never fire there, so the feed needs no Shore-specific code,
   but someone should confirm Shore actually wants the feed at all rather than just the auth.
