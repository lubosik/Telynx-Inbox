# 07 — Source Doc Digest: SMS Marketing A-to-Z (practitioner transcript)

Extracted from `research/ai-wizard/_source-transcript.txt` (3,437 lines / ~27,700 words).
Purpose: seed knowledge for an AI campaign-writing assistant. Author numbers, thresholds, timings and copy are preserved verbatim where given.

> **Critical framing note before you use any of this:** the file is **not one video**. It is **three separate transcripts concatenated**, by three different people, covering three different SMS games (B2B lead follow-up, ecommerce retention, mass-volume cold blasting). Their advice **directly contradicts** in several places. Do not let a downstream model treat this as one coherent doctrine. See §10.

---

## 1. Source & credibility

### 1.1 What the document actually is

| # | Lines | Runtime | Speaker | Domain | What they sell |
|---|---|---|---|---|---|
| **V1** | 1–2212 | 0:00–1:14:00 | "Tristan" (self-named at 11:03, 18:28) | High-ticket / appointment-based B2B: coaching, healthcare, real estate, SaaS, gyms | An **iMessage-at-scale sending platform** (never named on-mic; dashboards shown throughout). Ends with a CTA to a second video. |
| **V2** | 2212–3108 | 0:00–25:12 | "Max", runs **Well Copy** | Ecommerce / DTC, "8- and 9-figure brands", 100+ clients | Free doc at **wellcopy.net/sms**, plus "book a call below" for done-for-you SMS strategy. Also promotes **Olia** pop-ups. |
| **V3** | 3109–3438 | 0:00–10:35 | Unnamed; says he built "my own marketing company to over $200,000 a month" | Mass-volume / cold SMS, reactivation lists, 1M+ sends/day | **Send Evo** — an SMS platform. Explicit pitch: "custom SMS pricing 90% cheaper than any text platform on the market", "compared to platforms like Twilio", book-a-call for volume >500k msgs/month. |

### 1.2 Claims made, and what backs them

| Claim | Speaker | Evidence shown |
|---|---|---|
| "I've personally sent millions of text messages across dozens of industries" | V1 | None. Assertion. |
| "watched it add up to $17 million to businesses in a single year from just a few simple flows" | V1 | None. No breakdown, no client, no timeframe definition, no attribution model. **This is the headline number and it is entirely unsourced.** |
| 75% / 65% / 61% average response rates on three named business types | V1 | Screen-recorded dashboards of **his own product**. Unverifiable, unlabelled sample sizes, no date range on two of three. |
| "$1,000 MRR" close from a re-engaged no-show | V1 | One CRM opportunity record shown on screen. n=1. |
| "$604,000 / $952,000 / $231,000 from SMS in the past 30 days" | V2 | Screenshots of (presumably Klaviyo) revenue dashboards. Attribution model not stated — almost certainly platform-side last-click/attribution-window revenue, which systematically over-credits. |
| Flow revenue: $517,000 total; $293k welcome, $107k cart abandon, $46k browse abandon, $20k cart-abandon-retention, $13k site abandon | V2 | Dashboard screenshot, single month ("in January"). |
| "$100,000 over SMS in 1 month with just five SMS… 16% of that total store revenue" | V2 | Dashboard screenshot. |
| Olia pop-ups get 16% phone submit vs Klaviyo's 3–4% | V2 | One screenshot showing 9% ("pretty low… because this offer isn't a very good offer"). The 16% figure is asserted, not shown. **He is promoting Olia.** |
| "2.6 million [sent] over the last 3 days… about a million per day"; 96.7% delivery; 89.4% delivery at 2.6M; 2.74% opt-out; 2.82% response; 132 campaigns | V3 | Screenshots of **his own platform's** dashboard, partially blurred. |
| Hormozi: an owner who reaches every lead "within 60 seconds… closes 55% of them" | V3 | Second-hand attribution to Alex Hormozi. No citation. |

### 1.3 Where the self-interest is

Flag all of these to any downstream model:

- **V1's entire thesis — "switch from A2P SMS to iMessage/P2P" — is a product pitch.** Every deliverability problem he raises (10DLC, opt-out footers, green bubbles, carrier filtering, iOS inbox placement) is framed as solvable only by moving off SMS onto iMessage. He sells iMessage sending. The five "things working against your SMS" are a problem-agitation sequence for that product.
- **V1 explicitly instructs you to break the appearance of automation while automating** ("even though we know that this is an automation that is actually running in the background", 33:41). The advice is optimised for *evading* the recipient's ability to identify a commercial message.
- **V1 tells you to remove the STOP opt-out line entirely** by switching channel. That is the stated purpose: "the only way to remove that opt-out language entirely… is you need to switch your channel from an A2P channel to a P2P channel" (22:00–22:11).
- **V2 promotes Olia** (oliapopups.com) directly and has a book-a-call CTA mid-video and a lead-magnet CTA at wellcopy.net/sms.
- **V3 is a 10-minute product demo** wrapped in four Hormozi principles. Roughly half the runtime is Send Evo UI walkthrough. The Hormozi framing is borrowed authority.
- None of the three discloses a client, a control group, a sample size, or an attribution methodology.

---

## 2. The core thesis

### 2.1 Why SMS (all three agree)

- **98% open rate** (V1 at 1:09, V2 at 0:33 — same stat, both unsourced).
- Americans send/receive **32 texts a day**, vs **6 phone calls, 15 emails, 11 DMs** (V1).
- "Text is the number one form of communication for every American under 50" (V1).
- **81% of people read a text within the first 5 minutes** of receiving it (V1).
- "Industry data puts the average response rate of SMS at **45%**. Compare that to email's **6%**." (V1)
- V1's personal claim: "When you use SMS correctly, you could push that response rate much closer to **75%**."
- V2: inboxes are cluttered; SMS is 10–20% of total store revenue for his brands.
- V3: it's a throughput game — "speed literally only counts if your messages are actually landing on your prospect's phone."

### 2.2 V1's channel argument (the load-bearing, most self-interested claim)

Five things breaking SMS before the copy matters:

1. **A2P 10DLC registration** — "brutal" checklist: privacy policy in the right format, specifically-worded opt-in language, campaign registration, describing exactly what messages you'll send. "Carriers could still reject your campaign or block specific messages because a single word in your campaign triggered that filter."
2. **Inbox saturation** — OTPs, delivery tracking, bank alerts, appointment reminders, system notifications, plus an explosion of scam texting. "When an unknown business number shows up on their phone, their guard is already up before they even read a single word."
3. **The green bubble problem** — every business text lands green. For iPhone users, green + unknown number "already signals spam or automation."
4. **Mandatory opt-out footer** — "no matter how good you are at reframing the copy of the opt-out language, that line at the bottom of all your text tells them exactly what this is, an automated business blast."
5. **Inbox placement** — "With iOS 26, Apple introduced inbox placement for text messages", routing messages to an unknown-senders or spam folder "buried behind a drop-down menu". No notification, no lock screen, no vibrate. "The message reached the phone, but it just never reached them." He claims "more than half of your messages may never be seen."

**The iMessage argument:** iMessage runs P2P, "travels through the same path as a text between two friends. There's no carrier filtering. There's no compliance registration. There's no mandatory opt-out footer." Plus voice notes, high-res video, typing indicators.

**Market-size argument:** "iPhone holds about 57 to 65% of the US smartphone market"; for high-ticket coaching/healthcare/real estate/SaaS or millennial/Gen-Z targeting, "70 to 75, even 80% of their leads coming in that are iPhone users."

### 2.3 Channel-comparison dashboards V1 shows

| Business | Combined avg response | SMS response | iMessage response |
|---|---|---|---|
| SaaS, opt-in flow | 75% | 32%, 31%, 36% | 85%, 90%, 84% |
| Brick-and-mortar gym, appointment reminders | 65% | 33%, 29%, 35% | ~80–85% ("at least two times higher") |
| Coaching, webinar reminder flow | 61% | ~30% | 70–80%, "sometimes 90%" |

He describes the SaaS gap as "upwards of a **2.5% increase**" — from his own numbers this must mean **2.5x**, not 2.5 percentage points. Treat as a transcription/misspeak; the pattern he asserts elsewhere is "at least a 2x increase."

### 2.4 V2's ecommerce thesis (different game)

SMS is **not** email. "You cannot do nurture content on SMS. It's a lot more intrusive." Unsubscribe on email ≈ **0.3%**; on SMS **3–5%**. SMS costs real money per send. Therefore: fewer messages, higher intent, save the channel for events that genuinely warrant a phone ding.

### 2.5 V3's mass-volume thesis

Three Hormozi principles reframed as infrastructure problems:
- Speed to lead becomes throughput ("your volume is always capped at the campaign and brand level… at volume, speed is literally a throughput problem").
- Follow-up becomes automation (5–7 touches, AI reply bot).
- Reactivation is the cheapest possible send ("one re-engagement send to your entire list can literally outperform a month of buying fresh new numbers").
- Lead with value, not "buy now", because "the carriers score you like a credit score… they watch your complaint rates, your opt-out rates in real time."

---

## 3. Every flow described

### 3.1 V1 — the four core lifecycle flows

V1: "Every business needs these four SMS flows built out. Doesn't matter what you sell or what industry you're in."

---

#### FLOW 1 — Opt-in / Speed-to-Lead

- **Goal:** get a text out as soon as they opt in and get a conversation going.
- **Trigger:** any opt-in — website opt-in, ad opt-in, VSL opt-in, "any other type of opt-in funnel."
- **Delay before first message: exactly 3 minutes.** Rationale: >5 min and "they're no longer at their highest level of intent. They might go back to scrolling. They might find a competitor." <3 min and "it's nearly impossible for a human to get that opt-in and to text a lead under just a couple of minutes."

| Step | Delay | Message |
|---|---|---|
| 1 | +3 min | Intro, exact format: `Hey [contact first name], it's [your name] with [company name]` |
| 2 | +5 sec | `just looked over your form. What made you want to check this out?` |
| 3 | wait 45 min for reply | — |
| 3a | reply received | Internal **Slack notification** → human enters the thread and nurtures manually |
| 3b | no reply in 45 min | Apply tag: **opted in + never replied** → fires Re-engagement Flow A |

- **Why the intro format matters:** "this could get picked up by Siri suggested contact. So Siri could suggest your name and your profile picture to that lead along with your business phone number."
- **Revenue mechanism:** a reply opens a human conversation; every downstream step (booking, show, close) depends on it. "We paid for these leads… the worst thing that could happen is for us just to lose them and have paid top dollar to get them into our funnel."

---

#### FLOW 2 — Booking Confirmation

- **Goal:** text the lead as soon as they book (in-person event, webinar, demo call, any appointment).
- **Trigger:** appointment booked, via "iClosed or Calendly or even Google Calendar".

| Step | Delay | Message |
|---|---|---|
| 1 | +3 min | Same intro format (first contact with this lead): `Hey [first name], it's [your name] with [company]` |
| 2 | +5 sec | `just got your call booked in. Is this a good place to send some action items before we meet?` |
| 3 | wait 45 min | — |
| 3a | reply received | Internal Slack notification → human enters thread |
| 4 | +2 min after their reply | `All right, I'll send those over in a second` |
| 5 | +5 sec | `by the way, what kind of business do you have?` |
| 3b | no reply in 45 min | Tag: **booked appointment + never replied** |

- **Why 2 minutes at step 4:** "we want to make it seem like we received that text from our lead. We took the time to read it and then to type out our answer and then clicked on send. And 2 minutes is really the sweet spot."
- **Note on the copy:** deliberate lowercase `just` — "it looks like I was typing, I made a typo and then I corrected myself afterwards by adding a capital letter."
- **Revenue mechanism:** pre-call intel. "You get to the call with all the information that you need to ideally be able to close on that call because you did all the work beforehand."

---

#### FLOW 3 — Show-Up Flow

- **Goal:** guarantee attendance. "A series of texts, of videos, of voice messages, and of gifs to guarantee that that lead is committing to show up."
- **Trigger:** appointment confirmed.
- **All timings deliberately off-the-hour.**

| Step | Timing | Format | Content |
|---|---|---|---|
| 1 | **22.3 hours before** event start | **Video** (selfie, unscripted, low-effort) | Script given: "Hey, what's going on? Just sending over this little video to share what we're going to be talking about on our call tomorrow. We're going to be talking about X, Y, and Z. And if you have any questions before that or any topics that you want to cover tomorrow when we talk, just text me right here and yeah, I'll let you know." |
| 2 | **43 minutes before** | **Voice memo** | Script given: "Hey, what's up? We've got our call coming up in just about 45 minutes from now. What I'm going to do is I'm going to text you the Zoom link that you could join either from your computer or directly from your phone. And if you have any problems joining it, just text me back and we'll get that sorted. See you there." |
| 3 | **6 minutes before** | Plain text | `Hey, I'm in the call. Here's the Zoom link to join` |
| 3b | +5 sec | Link | The Zoom link itself, sent directly in-thread |
| 4 | **1 minute before** | **GIF** | A GIF reading `it's go time` |
| 4b | immediately after | Plain text | `Text me here if you have any problems joining the call` |

- **Branch after event:** tag **appointment booked + showed** or **appointment booked + no-showed**. The no-show tag fires Re-engagement Flow B.
- **Why send the Zoom link by text:** "It happens so often that people are ready for calls, their computer breaks, their Zoom has to update, or they're just not sitting at their computer… their phone most likely is working."
- **Revenue mechanism:** show rate. Format-switching (video → voice → text → GIF) is explicitly to cover different consumption preferences and to build face/voice trust pre-call.

---

#### FLOW 4 — Post-Call Follow-Up

- **Goal:** "keep a dialogue between us and the lead even after the appointment to make sure that they end up closing."
- **Trigger:** appointment completed.

| Step | Delay | Message |
|---|---|---|
| 1 | +3 min | A **cheers emoji** (🥂 / celebration emoji), nothing else |
| 2 | +5 sec | `Where did we land for you after all that?` |
| 3 | wait 45 min | — |
| 3a | reply | Internal Slack notification → human answers; V1 recommends replying with **screen-recorded video demonstrations** for feature questions |
| 3b | no reply in 45 min | Tag: **showed + ghosting** → fires Re-engagement Flow C |

- **Why that question:** "it's going to allow the lead to self-reflect and verbalize their position on your offer… if there's something that didn't go right on that call, if they have any fears that they want to share with you, this would be the opportunity."
- **Revenue mechanism:** stays top-of-mind at peak emotional state; surfaces objections while they're still soft.

---

### 3.2 V1 — the three re-engagement flows

Segmentation principle: "Someone who opted in and ghosted you is totally different from someone who showed up to a call and ghosted you during the closing process. And each one of those requires a slightly different angle because the reason they went cold is totally different."

Framing: "Those leads aren't dead, though. They're just dormant."

---

#### RE-ENGAGEMENT A — Opted in, never replied

- **Trigger:** tag `opted in + never replied` (set 45 min after Flow 1 with no reply).

| Step | Timing | Message |
|---|---|---|
| 1 | on tag (i.e. 45 min after the unanswered opener) | `this is [contact first name]` — e.g. `this is John` |
| 2 | wait 2 hours | reply → Slack notification; no reply → continue |
| 3 | +2 h | **Bump** the previous question (re-send / bump `what made you want to check this out?`) — explicitly **not** a new question |
| 4 | wait 24 hours | reply → Slack notification; no reply → continue |
| 5 | +24 h | `Must not be [contact first name]'s number. My bad.` — e.g. `must not be John's number. My bad.` |

- **Why "this is John" works:** "you are calling out their name… When they do receive 'this is John' right on their lock screen, they will click on it and they will then go see the previous messages that you had sent them."
- **Why bump, not new question:** "then you're just stacking question after question after question, which is going to make it very hard for the lead to know what to respond to… no automation would ever send a bump to a lead."
- **Stop rule:** "We pretty much stopped after four to five follow-ups here because that's the rule." Then switch to email or phone.

---

#### RE-ENGAGEMENT B — Booked but no-showed

- **Trigger:** tag `appointment booked + no-show`.

| Step | Timing | Message |
|---|---|---|
| 1 | on tag | `Hey [contact first name], just missed you on our call` |
| 2 | +5 sec | `I could send you a rescheduling link here?` |
| 3 | wait 2 hours | — |
| 3a | reply | Slack notification, **and** +2 min → `grab a time here` + event booking link (with thumbnail preview) |
| 3b | no reply in 2 h | **Bump** the rescheduling-link question |
| 4 | wait 24 hours | reply → jump to 3a |
| 5 | no reply in 24 h | **GIF**: `Are you ghosting me?` (author: "this is literally my favorite gif to use") |
| 6 | wait 3 days | reply → jump to 3a |
| 7 | no reply in 3 days | `I'll let you grab a time here once you are ready` → +5 sec → event booking link |

- **Why the link is OK at the end:** "we've already had a conversation thread with this lead… They might be on vacation."
- **Why the GIF:** "everyone has been ghosted before… This is a clear pattern interrupt… you'll probably get a 'haha, I'm so sorry, let me rebook.'"
- **Link hygiene:** "make sure that whenever you set up your Calendly link or your iClosed link or your Google Calendar link to test this out first to make sure that it comes with a nice preview."

---

#### RE-ENGAGEMENT C — Showed, then ghosted during close

- **Trigger:** tag `appointment showed + ghosted us`.

| Step | Timing | Message |
|---|---|---|
| 1 | on tag | **Bump** of `Where did we land for you after all that?` |
| 2 | wait 24 hours | reply → Slack notification |
| 3 | +24 h | **GIF**: `you there?` |
| 4 | wait 3 days | reply → Slack notification |
| 5 | +3 days | **Voice message**: "Hey, what's up? So, how you feeling about our last call?" |
| 6 | wait 7 days | reply → Slack notification |
| 7 | +7 days | `Giving up on [the outcome they were chasing] 👀` — e.g. `giving up on losing weight for the summer`, `giving up on 40 new leads this month` |

- Longer waits here than in the other flows because "after an appointment, a lead sometimes has to take the time to review the call, go talk to their partner, go talk to their spouse."
- Step 7 is described as "my favorite message to send and that gets tons of responses and gets tons of people back re-engaged into our funnel."
- **Real-world example given:** a lead opted in 24 Feb, was run through the speed-to-lead flow, booked a demo, **no-showed**, was re-engaged with "videos, plain text, voice messages, calls, links that are sent, gifs" — and closed for **$1,000 MRR**.

---

### 3.3 V2 — the ecommerce flows

He says "five key flows… at an absolute minimum" then enumerates six: welcome, site abandon, browse abandon, cart abandon, checkout abandon, and post-purchase/replenishment/winback.

---

#### FLOW 1 — Welcome

- **Trigger:** joining the list via pop-up form, usually with a discount.
- **Goal:** "get somebody to buy off the discount and introduce somebody to the brand."
- **Structure: 3 SMS.**

| Step | Timing | Content |
|---|---|---|
| 1 | Day 1 | Intro + the discount, straight to the point |
| 2 | Day 3 | Educational / brand information + discount reminder |
| 3 | Day 5 | Absolute last chance |

- "We want to have this tight window right here rather than delaying SMS to send like 2 weeks. We want to send people messages right after they signed up while they're warm."
- Aggressive alternative (Grooons, 9-figure): **one message every single day**, opening with "Hey, welcome to the Grooons family right here. Here's your discount for 52% off."
- Two-message minimal template given (see §9).
- Wild's 3-message version, cited as "the best layout for SMS": welcome + 20% off → **3 days later** "Don't forget to use this discount" → **2 days later** "Last reminder to save 20%."
- Recommends **A/B testing images** in the welcome flow specifically.

---

#### FLOWS 2–5 — The four abandonment flows

Definitions given:
- **Site abandon** — visits the website, views no product page.
- **Browse abandon** — views an actual product page.
- **Cart abandon** — adds to cart, leaves.
- **Checkout abandon** — reaches checkout, leaves.

**Hard constraint he states:** "technically in the US, it's illegal to send more than one SMS message in an abandonment flow… you can only use one SMS per recipient in the cart abandon flow, and then it has to be within 48 hours of the event. Of course, that person needs to have consent." He sources this to **Klaviyo's in-app warning**, not to a statute. (See §10 — this is a platform policy restatement, not a citation of law.)

- **Browse abandon timing: wait 60 minutes** from the browse event.
- Copy for all four: dead simple, one message, get them back on the site.
- **Split on prior purchase:** if they've never bought, give them the welcome discount inside the abandonment message. Cited as "definitely high leverage that eight- and nine-figure brands should do."
- Test image (MMS) vs no image on every one.
- **Revenue mechanism / numbers shown (one month):** total $517,000 across flows — welcome series **$293k**, cart abandon **$107,000**, browse abandon **$46,000**, cart abandon (retention) **$20,000**, session/site abandon **$13,000**.

---

#### FLOW 6 — Post-purchase / Replenishment / Winback

"This just varies so much brand to brand that it's really hard for me to create a verified set template." Can all live in one flow triggered on order placed.

| Message | Timing | Purpose | Copy given |
|---|---|---|---|
| 1 | **Day 10–14** (a couple of days after delivery, "honeymoon phase") | Cross-sell / upsell | "Hey, are you liking this product? You should buy again or try this product." |
| 2 (optional, replenishment brands only) | **Product duration + shipping time + margin** — worked example: 30-day supply + 7-day delivery ⇒ **day 35** | Re-up reminder | "Hey, are you running low? Re-up. Place another order." |
| 3 | **2× average time between purchases** — worked example: 45-day average ⇒ **day 90** | Winback with a flash offer | "Hey, get 30% off just cuz we miss you. Here's an exclusive discount code. It lasts for 72 hours." |
| 4 | **+2 days after msg 3** | Last chance | "Hey, last chance." |

- "I don't recommend adding offers until later down the line" for messages 1–2.
- "People are also receiving your campaigns if you're sending SMS campaigns. So, I don't like to oversend too much in my post-purchase period. Those two well-timed messages are perfect."

---

#### V2 — Campaigns (one-off blasts, not a flow)

- **Cadence: ~2 SMS campaigns per week** for a typical brand. Minimum **1 per week**. Never zero.
- Aggressive acquisition brands (e.g. Grooons): **daily** is acceptable **to people who have never bought**.
- Ease off for past purchasers. **"If somebody's actively subscribed in your subscription brand, you shouldn't send them any text messages."**
- 9-figure observed cadence: sends on the 26th, 28th, 1st, 3rd, 8th, 10th, 12th, 13th — "kind of like every other day", escalating to **two a day** during a Valentine's sale push, then back to baseline.
- **What SMS campaigns are for:** back in stock, new product releases, sales, private events, insider details/information, trend alerts, urgency-based "selling fast this week" content.
- **What they are not for:** nurture content, testimonials. "That just doesn't work on SMS, and in the long term, it's really just going to hurt you cuz you're going to get high unsubscribe rates." He shows a nurture-ish campaign that "generated clearly the least compared to the others. And it got a lot more unsubscribes."
- **Restock framing hack:** "we had a restock on a past collection, which didn't actually restock, but we just framed it as a restock because restocks just do really well, and they have urgency." Also: "even if the product isn't necessarily running low… say restock."
- **Worked example month:** 5 SMS = **>$100,000**, **16% of total store revenue**. Sequence was: pre-order collection announce → quick offer (free X on orders above X, exclusive to email+SMS list) → "restock" of a past collection → reminder → collection launch.
- Sample calendar: social media giveaway → October collection launch → "running low" → restock → flash sale + double-up.

---

### 3.4 V3 — the mass-volume pattern

Not a flow diagram, but a stated pattern:

- **Every contact gets a full 5–7 touches**, automated. "Most people quit way too early… five, six, seven touches before they even stop."
- **AI reply bot** handles the back-and-forth. Configurable: reply speed, number of conversations, number of message threads it will go back and forth, personality, tone, objective.
- **Target: leads handled within 30–60 seconds** of their reply.
- **On reply: sequence stops, lead is logged to CRM, tags applied** for building reactivation lists later.
- **Reactivation campaign:** upload CSV → create list → SMS blast → choose campaign + purchased number + list → either send all at once or rate-limit (e.g. "every 5 minutes, every 20 minutes… 10,000 per day dripped over an 8-hour period") → schedule + delivery window → message template with custom fields (first name, last name, email, phone number, company, address) → reply labels (e.g. "positive reply") → auto-add to a list on reply.
- **Message strategy: lead with value, not "buy now".** "If you blast a message that says buy now, buy now to a million people all at once who half remember you from 6 to 12 months ago, opt-out rates and spam reports spike through the roof. And the carriers read that as nobody wants this."

---

## 4. Copywriting rules

### 4.1 V1 — conversational / 1:1 outbound rules

| Rule | Detail |
|---|---|
| **Be a person, not a business** | "I am a person that's texting. I am Tristan that's texting. You are not a business texting." If a lead thinks "this could be automated", "you've already lost." |
| **Conversation starters, not conversation killers** | Never push information out with no route back in. "Engineer a reply" with "a very low friction question that's super easy to respond to." |
| **Best low-friction questions are about them** | "By asking the business owner about their business, they are almost guaranteed to reply to us because everyone is interested in talking about their business." Also: asking about their car — "they're probably proud of the car that they drive." |
| **Or engineer a one-word yes** | "I could send you a video of what we'll talk about here?" → "We are literally engineering the reply from our lead, which is going to be a simple yes or yeah." |
| **Length: never over 80 characters** | "My normal rule of thumb is to say that your text should never be over 80 characters. So, if it's 80 characters or more, you should separate it into two texts." |
| **Double-texting is good** | "It is totally okay to double text a lead because that's just a normal texting behavior." |
| **No links in the first outreach** | Raises red flags "to carriers and also to the lead." Carriers "often see links associated to spam or to scams. That's why they block them." |
| **Send the link only after a reply** | Bonus: "it actually attaches a thumbnail preview to your link compared to these first texts that didn't get a reply." Thumbnail → "so much more likely to actually follow through and click." |
| **Make the link fit the conversation** | Several back-and-forths, then the link arrives naturally. |
| **Never sign off** | "Texting isn't like emailing… You don't sign off on your texts when you're texting your friends." |
| **Introduce yourself exactly once, in this exact format** | `Hey [contact name], this is [your name] from [company name]`. Reason: Siri Suggested Contact pickup → name + photo + number → trust. |
| **Set up your own iCloud identity** | iPhone → Settings → iCloud → Personal Information → full name under shared name + a real photo (selfie or LinkedIn headshot), so the Siri-suggested contact card carries a face. |
| **Zero corporate language** | Delete "I hope you're doing well today", "many thanks", "best regards". "These are never going to be used when you text your friends." |
| **Deliberate imperfect capitalisation** | "I deactivate auto-capitalization. That way I have full control… This seems like I made a little mistake in my text, which is so human and clearly is not something that an automation would do." |
| **Use your own abbreviations** | "Mon, Tues, wed", plus "thanks, no problem, let me know, FYI and stuff like that." |
| **Remove the opt-out line entirely** | "The only way to remove that opt-out language entirely… is you need to switch your channel from an A2P channel to a P2P channel." Their eyes "have been subconsciously trained to look right at the bottom of the text." |
| **Not everything should be a text** | Mix in video, voice memos, GIFs and memes. "Put a face to all of those reminders." |
| **Pattern interrupts for ghosts** | Videos, voice messages, GIFs/memes — "stop the scroll." |
| **Bump, don't stack** | When ghosted, re-send/bump the last question rather than asking a new one. |
| **Emojis** | Only concrete use shown is a single cheers emoji as a standalone post-call message. No emoji rule is stated. |

### 4.2 V1 — timing rules (treated as copy, because it signals humanity)

| Rule | Value | Rationale |
|---|---|---|
| Speed to lead | **3–5 minutes** after opt-in (flows use **3 min**) | >5 min they've moved on; <3 min "only a system could reach out that fast." |
| Reply after their reply | **1–2 minutes** | "Give you the time to read the text, think about what you want to respond, take the time to actually type that out." |
| Between double-texts | **5 seconds** | Mimics type-send-type-send; also triggers **typing indicators** on the recipient's device. |
| Second message after a lead's reply (booking flow) | **2 minutes** | Same read-think-type logic. |
| Never text on the hour | Use **22.3 hours**, **43 minutes**, **6 minutes**, **1 minute** instead of 24h / 1h / 15min | "Humans are imperfect… in our case, imperfect timing actually ends up being perfect timing." Every text carries a visible timestamp. |
| Aim for **3 replies** before pitching | — | Claimed to permanently remove the Report Junk button (see §5). "Optimize for that three replies before moving into your pitch." Source the questions from your existing lead-capture form. |
| **Four follow-ups without a reply = stop** | Hard rule | "After four texts without a reply you need to switch the channel. Go email them, go phone call them, go DM them." (He later says "four to five" when describing his own flow.) |

### 4.3 V2 — ecommerce copy rules

| Rule | Detail |
|---|---|
| **Under 160 characters** | "If you go to 161 characters, that email technically is two SMS, and you have to pay double for it. That's why we see so many just quick, snappy SMS." |
| **Emojis are expensive** | "One emoji is equivalent to around 60 to 70 characters in an SMS message." Avoid them if you're managing cost. |
| **Images turn SMS into MMS at 3× cost** | Use them only for genuinely high-impact moments: new flavour/product drops, cart abandon with the product, welcome-flow infographics. "For important things, include an image." Then drop back to plain text. |
| **Get straight to the point** | "People just signed up for the discount. Just give them that." |
| **No nurture, no testimonials** | Ever, on SMS. |
| **Frame around urgency and events** | Launches, restocks, flash sales, private events, insider info, trend alerts, "selling fast this week." |
| **Pop-up phone-step copy** | Use `Finish signing up with text to activate your discount`. Do **not** use `Sign up for texts to be the first to know about news`, or "Get exclusive deals, da da da." |
| **Pop-up button copy** | `Claim now`, not `Continue` — "then people are going to think, 'Oh, continue, I'm going to have to enter my phone number.'" |
| **Extra discount for SMS opt-in** | Not worth it. "I really haven't seen a meaningful impact, so I wouldn't do it." |

### 4.4 V3 — mass-volume copy rules

- **Lead with value, not "buy now."** "Send something people actually want, a real answer, a genuine offer, something useful, and your complaints stay low, your reputation stays high, and your volume keeps landing."
- Use custom fields (first name, last name, email, company, address) for personalisation at blast scale.
- Nothing else specific — no examples of actual message copy are given in V3.

---

## 5. Compliance & deliverability

### 5.1 A2P 10DLC (V1)

"The compliance framework that every business sending text in the USA has to go through and it is brutal." The checklist as he states it:
1. Your **website needs a privacy policy in the right format**.
2. Your **opt-in language needs to be worded in a very specific way**.
3. **Register your campaign**.
4. **Describe exactly what kind of messages you're going to send**.
5. Even then: "carriers could still reject your campaign or block specific messages because a single word in your campaign triggered that filter."

Consequence of skipping/rushing/doing it wrong: "their messages get throttled or blocked entirely before they even leave the gate."

The opening line claims businesses "get blocked by A2P 10DLC restrictions and [get] fined thousands of dollars for even the smallest mistake." **No fine amount, authority, or mechanism is ever named again in 90 minutes of transcript.**

### 5.2 The Report Junk mechanic (V1 — the single most consequential unverified claim)

- Recipients can report as junk with **one tap**: "It's literally a one-tap button."
- **"It literally takes one or two of these report junks to officially poison our number and kill our deliverability of our SMS campaigns from that phone number moving forward."**
- **The claim:** "Something that I discovered pretty recently is that if you get **three replies** back from your lead on your first initial text outreach to them, that report junk button is going to **disappear from the conversation for good**. So, whether you text them a month from now, 3 months from now, or 2 years from now, that report junk button will never be there again."
- Therefore: optimise for 3 replies before any pitch.

Presented as personal discovery. No mechanism, no Apple/carrier documentation, no test data. Flagged in §10.

### 5.3 Carrier behaviour (V1 + V3)

- V1: too many consecutive follow-ups without a reply "is going to send a red flag to the carrier, to Apple, to block your text moving forward." Two risks named explicitly: "our number being blocked by carriers because they're seeing too many follow-ups without a response" and "our lead just simply tapping that report junk button."
- V3: **"the carriers score you like a credit score. So, they watch your complaint rates, your opt-out rates in real time."** If those spike, "they'll start to filter you. So, you paid for a million texts, but you only reached a fraction of that."
- V3: A2P volume "is always capped at the campaign and brand level."
- V3: bad data is a deliverability problem — "clean your data, make sure that you have good data, accurate phone numbers."

### 5.4 iOS 26 inbox placement (V1)

- Apple introduced inbox placement for SMS with iOS 26. Messages can be "quietly routed to an unknown senders folder or a spam folder buried behind a drop-down menu most people will never even open."
- Consequences: no notification, no lock-screen appearance, no vibrate/ping.
- "Delivered and seen is no longer the same thing." He claims "more than half of your messages may never be seen."
- Therefore delivery rate is a worthless metric.

### 5.5 Opt-in / opt-out requirements

- V1: "Every business text that you send out is **legally required** to include the opt-out language, the 'reply STOP to opt out'. You have no choice."
- V1's remedy is channel arbitrage: **"on iMessage, the opt-out language isn't required."** Alternatives he names for the same purpose: WhatsApp, Telegram, "a normal Android texting" (RCS implied).
- V2: abandonment flows — one SMS per recipient, within 48 hours of the event, "of course, that person needs to have consent" (quoting Klaviyo's in-app restriction, which he describes as US law).
- V2: unsubscribe rates on SMS run **3–5%** vs email **0.3%**; oversending directly costs you list.

### 5.6 Opt-out rate thresholds (V3 — the only hard numbers in the doc)

- **"Opt-out rate is crucial. Like I like to be around under 5%. Anything like over 5, 6%, you start raising flags with the carriers."**
- Observed on his own accounts: **2.74% opt-out** across 2.6M messages; **96.7% delivery** on one account, **89.4% delivery** across all sub-accounts.

### 5.7 The specific mistakes they warn about

1. Skipping or rushing 10DLC registration (V1).
2. Putting a **link in the first message** (V1) — carrier red flag and lead distrust.
3. **Big blocks of text** — read as spam/automation, get reported (V1).
4. **Signing off / corporate language** — instantly reads as business (V1).
5. **Perfect on-the-hour send times** — subconscious automation tell (V1).
6. **More than four follow-ups without a reply** (V1).
7. **Stacking new questions** on a ghosting lead instead of bumping (V1).
8. **Copy-pasting SMS copy onto iMessage** without rewriting for the channel (V1 — "that is why normally… you won't see that two to three [x] increase").
9. **Optimising for delivery rate** instead of reply rate (V1).
10. **Reps texting from personal devices** — zero visibility, zero reporting, follow-ups locked on a personal phone (V1).
11. **Nurture content and testimonials on SMS** — drives unsubscribes (V2).
12. **Overusing MMS images** — 3× cost, frequently negative ROI (V2).
13. **Texting active subscribers** of a subscription brand (V2).
14. **Emojis** blowing you past 160 characters (V2).
15. **"Buy now" blasts to a semi-cold list** — complaint/opt-out spike → carrier filtering (V3).
16. **Dirty data / inaccurate numbers** (V3).

---

## 6. Segmentation & list building

### 6.1 V1 — behavioural tagging (B2B)

Tags drive everything. The taxonomy in use:

- `opted in + never replied`
- `booked appointment + never replied`
- `appointment booked + showed`
- `appointment booked + no-showed`
- `appointment showed + ghosted us`

Each tag is a re-engagement flow trigger. The governing principle: "Someone who opted in and ghosted you is totally different from someone who showed up to a call and ghosted you during the closing process… When you segment your list that way, your re-engagement hits so much harder than a one-size-fits-all blast."

No list-*growth* advice in V1 — the list is assumed to arrive from paid ads and opt-in funnels.

### 6.2 V2 — list building (ecommerce)

- **"Your SMS list is only going to make you as much money as the amount of people in your list."**
- **Collect phone numbers now even if you have no SMS programme.** "What happens a year from now when you want to have an SMS list… You're going to have zero list."
- **Pop-up forms are the growth engine.** Klaviyo native forms: **3–4% opt-in**. Olia (oliapopups.com): **9% phone submit** on a weak offer, "typically we sit at like 16%." Most pop-ups he reviews are **5–6%**; an optimised one gets **15%** — "three times the number of leads and three times your list growth."
- **Volume achieved:** 5,900–6,000 new phone numbers per month for one brand.
- **Form structure that works in 2026: start with a quiz.** "We don't ask for the email address or phone number right off the bat." Sequence: discount headline ("You've got 10% off") → engagement question → email → phone.
- Button copy `Claim now`; phone-step copy `Finish signing up with text to activate your discount`.
- Final step: `Shop now` button (on Klaviyo; "if you use Postscript or Attentive, then there's a different sort of setup").

### 6.3 V2 — segmentation philosophy (deliberately minimal)

- **"A lot of people get way too segmented on their SMS, and I prefer not to. I prefer to blast the list. I usually make the most amount of money that way."**
- Standard send: **all subscribers minus one exclusion list** of unengaged people.
- **The exclusion rule:** "somebody has received a text at least **15 times**, but they've **never ever clicked** after 15. Typically, that's where you can exclude them."
- **But:** "if at any point anybody ever clicked an SMS, even if it was 2 years ago, they are going to continue receiving most my emails."
- Rejects click-based engaged segments: "I see a lot of people buy from SMS who have literally never clicked an SMS. A lot of times, people will see a message, and then they'll go to the website on their own and then place an order."
- **Clean the list monthly.**
- **Roughly once a month, send to the entire list with no exclusion** — reserved for big announcements (his example: a New Year's Eve sale).
- Split abandonment flows on prior-purchaser status.
- Do not text active subscription customers.

### 6.4 V3 — list mechanics

- Lists built by CSV upload or from existing contacts.
- **Reply labels** (e.g. "positive reply") applied automatically, and contacts auto-added to lists on reply, "that way you can continuously reactivate… your previous list of positive replies."
- Reactivation lists are the highest-ROI asset: "a reactivation campaign to a dormant list of people who already opted in costs almost nothing. And on top of that, it converts way better than any cold traffic ever will."

---

## 7. Metrics & tracking

### 7.1 The primary metric (V1)

**Replies. Not delivery, not opens, not clicks.**

"Replies are king in our SMS system and we have to do everything possible to optimize for replies… Everything goes downstream from getting a reply."

The chain he asserts: reply → conversation → learn their problem → present an appointment → booking → show-up follow-up → shows → revenue.

Why not delivery rate: "They are always optimizing for delivery rates because that's what their SMS platform currently supports. The problem with delivery rates is that they don't give us any information… your delivery rate is 100% but none of your text messages are getting seen."

### 7.2 V1's target numbers

| Metric | Threshold |
|---|---|
| Healthy average response rate (combined SMS + iMessage) | **>45%** |
| What you should hit with the full system | **70 / 75 / 80%** |
| Dashboard shown as "very good" | **75%** |
| 365-day consistency example | **62%** average response rate over the past 365 days — evidence of daily sending |
| Unhealthy | **<45%** — "should raise a flag that something in your strategy is not working" |
| iMessage vs SMS gap (healthy) | **at least 2×**, ideally 2–3× |
| iMessage vs SMS gap (unhealthy) | "hovering around the same numbers", or only "a 0.5 increase" — diagnostic of copy being copy-pasted across channels |
| Example SMS-only reply rate | **34%** |

Diagnostic checklist when reply rate is under 45%: "Is it your copy? Is it the delay between your messages? Is it the fact that you're only using SMS and not using iMessage? Is it the fact that people are replying stop to you and opting out of your funnels?"

### 7.3 V1's A/B testing programme

Test **one variable at a time on a specific day**, then look for **spikes or dips in reply rate** on the reporting dashboard.

1. **Conversation starters.** Three shown side by side: "How many years have you been in sales?", "What kind of business do you have?", "I could send you a video of what we'll talk about here?"
2. **Formats.** Video vs voice note vs plain text. His prior: millennials/Gen Z prefer voice notes and video for long explanations; "people over 50… might rather just receiving plain text."
3. **Timing and sequencing.** Specifically, on-the-hour vs off-the-hour sends. "I've been tracking this across thousands and thousands of conversations. I could tell you right now, it does make an effect on the micro level."
4. **iMessage vs SMS response rate.** "The test that you should absolutely run in your business, no matter what."

Reporting structure: report a combined reply rate, but always break it down by channel — "they're going to tell a completely different story."

### 7.4 V2's ecommerce metrics

| Metric | Value |
|---|---|
| SMS share of total store revenue | **10–20%** (his brands); one example at **16%** |
| Email unsubscribe rate | **0.3%** |
| SMS unsubscribe rate | **3–5%** |
| SMS cost per send | **1–3 cents**, "typically something like 1½ cents" |
| Email cost per send | "a fraction of a cent" |
| MMS cost multiplier | **3×** SMS |
| Character limit before double-billing | **160** (161 = 2 credits) |
| Emoji character cost | **60–70 characters** |
| Klaviyo pop-up opt-in rate | 3–4% |
| Optimised pop-up phone submit rate | 9% observed / 16% typical claimed / 15% quoted as achievable |
| Typical pop-up he reviews | 5–6% submit |

**Attribution:** entirely platform-side flow/campaign revenue dashboards. He also reasons in **net profit**, not revenue — the MMS analysis explicitly nets send cost against incremental revenue:
- Test 1: image variant made **1.3× revenue** but cost **3×** to send ($300 vs $100). "Costed us $200 to make $1,300 back." Net positive.
- Test 2: no image **$620** revenue vs image **$1,200** revenue, $15 extra send cost. Net positive.
- His caveat: "you really do want to be careful and don't use images too often, cuz a lot of times it doesn't play out this way."
- Also observed: image-based SMS get **lower clicks but higher-intent clicks** ("this one is like 'click here to buy'").

**What to test on flows:** "test your time delays, test your offers, and test using images versus not using images."

### 7.5 V3's mass-volume metrics

| Metric | Value / target |
|---|---|
| Delivery rate (single account, ~1M msgs) | 96.7% |
| Delivery rate (all sub-accounts, 2.6M msgs) | 89.4% |
| Opt-out rate observed | 2.74% |
| **Opt-out rate target** | **under 5%**; "over 5, 6% you start raising flags with the carriers" |
| Response rate observed | 2.82% |
| **Response rate "common in this space"** | **3–10%** |
| Campaigns live | 132 |

Dashboard dimensions he names: delivery rate, opt-out rate, response rate, campaigns live, outbound vs inbound message counts, **top failure reasons**, all broken out per day, per week, per campaign and per sub-account.

**Note the collision:** V1 calls anything under 45% reply rate a red flag; V3 calls 3–10% normal. They are describing entirely different populations (warm inbound opt-ins vs cold/dormant mass lists). Any AI writing assistant must know which regime it is in before quoting a target.

---

## 8. Tooling & stack

| Tool | Mentioned by | Role |
|---|---|---|
| **Klaviyo** | V2 | Default email+SMS platform; source of the abandonment-flow restriction warning; native pop-up forms (3–4% opt-in) |
| **Attentive** | V2 | Klaviyo alternative; use for price leverage |
| **Postscript** | V2 | Klaviyo alternative; different pop-up final-step setup |
| **Omnisend** | V2 | Alternative if email already lives there |
| **One Text** | V2 | Named but dismissed — "I prefer just the big dogs" |
| **Olia / oliapopups.com** | V2 | Recommended pop-up builder; quiz templates; the 16% phone-submit claim |
| **Send Evo** | V3 | The mass-volume platform being sold. Features shown: SMS Blast, campaign/brand selection, purchased numbers, list creation via CSV, rate-limited sending, scheduling + delivery windows, message templates, custom merge fields, reply labels, auto-add-to-list on reply, sub-accounts, AI reply bot (speed, thread depth, personality, tone, objective, test mode), full metrics dashboard |
| **Twilio** | V3 | Named only as the price benchmark to beat |
| **Slack** | V1 | Internal notification target on every "lead replied" branch — the human handoff mechanism in all seven flows |
| **iClosed / Calendly / Google Calendar** | V1 | Booking triggers and booking links; must be tested for link thumbnail previews |
| **Zoom** | V1 | Call platform; link sent in-thread 6 min before |
| **iMessage** | V1 | The recommended sending channel. Also names WhatsApp, Telegram and Android/RCS as other P2P options |
| **iPhone iCloud settings** | V1 | Personal Information → shared name + photo, to power Siri Suggested Contacts |
| **CRM (unspecified)** | V1, V3 | Tagging, opportunity records, conversation sync |
| **Virtual phone lines** | V1 | Cloud-hosted, "ideally an iMessage iPhone phone line that is virtual stored in the cloud" |

### 8.1 V1's scaling ladder (team/infrastructure)

| Volume | Setup |
|---|---|
| Solo owner, **<5 leads/day** | Text directly from your personal phone; track reply rates manually |
| **5–50 leads/day** (small sales team: setter + closer + rep) | **One shared virtual phone line**, cloud-based, ideally iMessage-capable. Never personal devices — "you have no visibility on conversation performance… those are all stored on a personal device." |
| **>50 leads/day** | **Multi virtual phone line setup**: one line per rep, rep sees only their own line/leads; plus a **sales manager with visibility across all conversations** who tweaks copy and workflows |

What breaks first as you scale, per V1: (1) **phone number health** — "it only takes just a few reports to poison your number for good"; (2) **inbox management and conversation visibility** — "having visibility across all of those conversations in real time synced into your system or your CRM is going to become a really big bottleneck."

### 8.2 V2's platform selection advice

"Prioritize doing SMS within the platform that you're doing email." Then: get a quote from your current email provider, take it to Attentive and Postscript, "and try to get these people to compete on their prices." Conclusion: "platform does not matter… They're all going to sell you on all these different benefits… but these are all benefits and little AI features that you're probably never going to use. The basics will drive 99% of your revenue."

---

## 9. Verbatim message bank

Transcribed exactly as spoken/shown. `[brackets]` mark merge fields the speaker described rather than dictated. Minor ASR artefacts are preserved and annotated.

### 9.1 V1 — anti-patterns ("conversation killers")

| # | Context | Message |
|---|---|---|
| K1 | Booking confirmation, bad | "Hey Alex, just saw you booked an appointment on my calendar. I wanted to reach out and introduce myself. I'm Sam with the Sam Blue team. Please reply yes to confirm your appointment." *(ASR garbles the company; elsewhere the same example reads "the Horizon team")* |
| K2 | Cold/warranty outreach, bad | "Hey John, the reason I'm reaching out is because we received a form from you regarding an extended warranty for your car. You could book a call with us here to learn more about how we could help you save thousands of dollars down the line. [link] Joe's Automotive. Reply stop to opt out." |
| K3 | The "brick", bad | "Hey Alex. Just saw you booked an appointment on my calendar. I wanted to reach out and introduce myself. I'm Sam with the Horizon team. Before I call, I'd like to 1. confirm your appointment 2. check out this video we put together on how Horizon works. If you have any questions, please let me know. Have a great day." |

### 9.2 V1 — conversation starters and flow copy

| # | Flow / step | Message | Notes |
|---|---|---|---|
| S1 | Universal intro format | "Hey [contact name], this is [your name] from [company name]" | Exact format required for Siri Suggested Contact pickup |
| S2 | Intro, example | "Hey Trish, this is Tristan from Fitness Biz" | |
| S3 | Intro, example | "Hey Sam, it's Andrea's from Cole Gordon's team" | ASR: likely "it's Andreas from…" |
| S4 | Booking, fixed version of K1/K3 | "hey Alex it's Sam with Horizon. Just got your call booked for Tuesday. What kind of business do you have?" | Deliberate lowercase "hey" |
| S5 | Booking, yes-engineering | "We're locked in for Tuesday 10 a.m. I could send you a video of what we'll talk about here?" | Engineers a "yes"/"yeah" |
| S6 | Warranty, fixed version of K2 | "Hi John, this is Rick from Joe's Automotive. Are you still driving an Audi A4?" | |
| **Opt-in / Speed-to-Lead** | | | |
| O1 | msg 1, +3 min | "Hey [contact first name], it's [your name] with [company name]" | |
| O2 | msg 2, +5 sec | "just looked over your form. What made you want to check this out?" | Lowercase "just" is deliberate |
| **Booking Confirmation** | | | |
| B1 | msg 1, +3 min | "Hey [contact first name], it's [your name] with [company name]" | |
| B2 | msg 2, +5 sec | "just got your call booked in. Is this a good place to send some action items before we meet?" | Lowercase "just" called out explicitly as a humanising typo |
| B3 | +2 min after their reply | "All right, I'll send those over in a second" | |
| B4 | +5 sec | "by the way, what kind of business do you have?" | |
| **Show-Up** | | | |
| U1 | −22.3 h, **video script** | "Hey, what's going on? just sending over this little video to share what we're going to be talking about on our call tomorrow. We're going to be talking about X, Y, and Z. And if you have any questions before that or any topics that you want to cover tomorrow when we talk, just text me right here and yeah, I'll let you know." | Unscripted selfie video |
| U2 | −43 min, **voice memo script** | "Hey, what's up? We've got our call coming up in just about 45 minutes from now. What I'm going to do is I'm going to text you the Zoom link that you could join either from your computer or directly from your phone. And if you have any problems joining it, just text me back and we'll get that sorted. See you there." | |
| U3 | −6 min | "Hey, I'm in the call. Here's the Zoom link to join" | |
| U4 | −6 min, +5 sec | *(the Zoom link itself)* | |
| U5 | −1 min, **GIF** | "it's go time" | |
| U6 | −1 min, immediately after | "Text me here if you have any problems joining the call" | |
| **Post-Call** | | | |
| P1 | +3 min | *(cheers emoji, standalone)* | "a little cheers emoji just celebrating the fact that we had that call" |
| P2 | +5 sec | "Where did we land for you after all that?" | Designed for self-reflection and verbalising position |
| **Re-engagement A — opted in, never replied** | | | |
| RA1 | on tag (45 min) | "this is [contact first name]" → e.g. "this is John" | Designed to be read on the lock screen |
| RA2 | +2 h | *(bump of O2: "what made you want to check this out?")* | |
| RA3 | +24 h | "Must not be [contact first name]'s number. My bad." → e.g. "must not be John's number. My bad." | Final attempt |
| **Re-engagement B — booked, no-showed** | | | |
| RB1 | on tag | "Hey [contact first name], just missed you on our call" | |
| RB2 | +5 sec | "I could send you a rescheduling link here?" | Low-friction yes |
| RB3 | +2 min after reply | "grab a time here" + *(event booking link with thumbnail preview)* | |
| RB4 | +2 h no reply | *(bump of RB2)* | |
| RB5 | +24 h no reply, **GIF** | "Are you ghosting me?" | "literally my favorite gif to use" |
| RB6 | +3 d no reply | "I'll let you grab a time here once you are ready" → +5 sec → *(booking link)* | |
| **Re-engagement C — showed, then ghosted** | | | |
| RC1 | on tag | *(bump of P2: "Where did we land for you after all that?")* | |
| RC2 | +24 h, **GIF** | "you there?" | |
| RC3 | +3 d, **voice message** | "Hey, what's up? So, how you feeling about our last call?" | |
| RC4 | +7 d | "Giving up on [the outcome they were chasing] 👀" | Examples given: "giving up on losing weight for the summer", "giving up on 40 new leads this month". "My favorite message to send." |
| **A/B test starters** | | | |
| T1 | starter variant | "How many years have you been in sales?" | |
| T2 | starter variant | "What kind of business do you have?" | |
| T3 | starter variant | "I could send you a video of what we'll talk about here?" | |

### 9.3 V2 — ecommerce message bank

| # | Flow / step | Message | Notes |
|---|---|---|---|
| W1 | Welcome msg 1 (template) | "Welcome to [brand]. Here, we're focused on delivering you clean ingredients. Use code WELCOME20 for 20% off your first order. Shop now." | |
| W2 | Welcome msg 2/3, +5 days (template) | "Hey there, notice you signed up but haven't shopped. 20% off yet. Don't miss. This is about to expire. Shop now." | ASR slightly garbled; intent is "haven't shopped your 20% off yet" |
| W3 | Welcome msg 1, Grooons | "Hey, welcome to the Grooons family right here. Here's your discount for 52% off." | 9-figure brand, sends daily |
| W4 | Welcome msg 1, Elite | "Hey, we're Elite. [brand information]. Here's your discount." | Also reusable as message 2 with the greeting stripped |
| W5 | Welcome msg 1, Wild | "Hey, welcome. 20% off. Use this discount." | "Not giving them any extra information. Just take this discount." |
| W6 | Welcome msg 2, Wild, +3 days | "Don't forget to use this discount. 20% off. Here's the discount code." | |
| W7 | Welcome msg 3, Wild, +2 days | "Last reminder to save 20%. Use this discount code." | Cited as the best SMS welcome layout |
| A1 | Browse abandon, +60 min | "Have your eye on something? You've good taste. Keep shopping." | ASR: "have your eye on something. You've good taste." |
| A2 | Cart / checkout abandon | "It looks like you forgot something in your cart. Finish your order." | |
| A3 | Cart abandon, aggressive variants | "your order is ready to ship" / "We can only save your cart for so long" | |
| A4 | Checkout abandon, non-purchaser split (Wild) | "Use code wildwelcome20 at checkout to get 20% off" | |
| PP1 | Post-purchase, day 10–14 | "Hey, are you liking this product? You should buy again or try this product." | Honeymoon-phase cross/upsell |
| PP2 | Replenishment, day 35 (30-day supply + 7-day ship) | "Hey, are you running low? Re-up. Place another order." | |
| PP3 | Winback, day = 2× avg inter-purchase interval | "Hey, get 30% off just cuz we miss you. Here's an exclusive discount code. It lasts for 72 hours." | |
| PP4 | Winback, +2 days | "Hey, last chance." | |
| F1 | Pop-up phone step (use this) | "Finish signing up with text to activate your discount" | |
| F2 | Pop-up phone step (avoid) | "Sign up for texts to get be the first to know about news and whatnot" | ASR garbled; the point is the generic "be first to know" framing |
| F3 | Pop-up phone step (avoid) | "Get exclusive deals, da da da" | |
| F4 | Pop-up button | "Claim now" (not "Continue") | |
| F5 | Pop-up headline | "You've got 10% off" | |
| C1 | Campaign framing | "these are the products that are selling super fast this week" | Urgency-based, still passes as SMS-worthy |
| C2 | Campaign framing | "Yo, big news, this is happening right now" | Trend alert |
| C3 | Campaign framing | "free X on orders above X" | Flash offer, exclusive to email+SMS list |

### 9.4 V3

No example message copy is given anywhere in V3. Only the directional rule: send "a real answer, a genuine offer, something useful" rather than "buy now, buy now."

---

## 10. What is missing or questionable

### 10.1 Unsupported numbers — treat every one of these as unsourced

- **"$17 million to businesses in a single year."** The headline credibility claim. No client, no vertical, no attribution model, no time period definition, never mentioned again after 0:19.
- **98% open rate.** Repeated by two of three speakers, sourced by neither. This figure circulates widely in SMS vendor marketing; there is no named study behind it here.
- **"32 texts a day / 6 calls / 15 emails / 11 DMs"**, **"81% read within 5 minutes"**, **"45% SMS response rate vs 6% email"**, **"iPhone holds 57–65% of the US smartphone market"** — all presented as "industry data" with no source.
- **All response-rate dashboards in V1 are screenshots of the speaker's own unnamed product.** No sample sizes, no date ranges on two of three, no control, no independent verification. The claim "these are the exact same text messages sent at the exact same time through the exact same automations" describes a natural experiment (iPhone vs Android recipients) that is **not** randomised — iPhone ownership correlates with income, age and vertical, all of which independently predict reply rate. The iMessage lift is real-looking but confounded, and the confound is never acknowledged.
- **"2.5% increase"** where the surrounding numbers imply 2.5×. Either a misspeak or a transcription error; do not propagate the literal figure.
- **"Olia typically sits at 16%"** — the only screenshot shown is 9%, self-described as low. The 16% is asserted while he is promoting the product.
- **"$200,000 a month" / "$200 million a year" (Hormozi)** — borrowed authority, no citation, and the Hormozi principles are paraphrased, not quoted.
- **Every revenue screenshot in V2** is platform-attributed flow/campaign revenue. Klaviyo-class attribution windows credit any purchase within N days of a click or even an open. Real incremental lift is invariably lower. He never mentions holdout testing.

### 10.2 The three claims most likely to be wrong, and most costly if wrong

1. **"Three replies permanently removes the Report Junk button."** Presented as a personal discovery with zero mechanism, zero documentation and zero test data. Apple's junk-reporting affordance behaviour is not publicly documented in these terms. **An AI assistant should never state this as fact.** If the whole "optimise for 3 replies before pitching" doctrine rests on this, the doctrine needs a different justification (it has one — conversation depth correlates with conversion — but that is not what he says).
2. **"One or two junk reports poison your number for good."** Directionally plausible for sender reputation; stated with a precision no carrier publishes.
3. **"The only way to remove the opt-out language is to switch to iMessage/P2P."** This conflates a *legal/regulatory* obligation with a *technical* one. TCPA-class opt-out obligations attach to the **commercial nature of the message and the relationship**, not to the transport protocol. Sending automated commercial messages at scale over iMessage does not obviously discharge consent or revocation duties, and it plainly conflicts with Apple's terms for iMessage. **This is the single riskiest recommendation in the document and it is made by the person selling the iMessage tool.**

### 10.3 Direct contradictions between the three sources

| Topic | V1 (B2B) | V2 (Ecom) | V3 (Mass) |
|---|---|---|---|
| Max message length | **80 characters** | **160 characters** (cost-driven) | not addressed |
| Links in the first message | **Never** — carrier red flag | **Always** — every welcome/abandon message is a link | not addressed |
| Healthy reply rate | **>45%**, target 70–80% | not a tracked metric (clicks/revenue) | **3–10% is "common"** |
| Segmentation | Deep behavioural tagging, 5 states | **Deliberately minimal** — "blast the list" | List-level, reply-label tagging |
| Opt-out footer | Remove it by changing channel | Assumed present, unsubscribes budgeted at 3–5% | Opt-out rate is the key health metric |
| Primary metric | Replies | Revenue and net profit per send | Delivery rate + opt-out rate |
| Automation posture | Hide it completely | Openly automated, brand-voiced | Fully automated + AI bot |

An assistant seeded on this material must first classify the campaign type (1:1 warm follow-up / ecommerce lifecycle / cold mass reactivation) before applying any rule. Applying V1's rules to an ecommerce blast or V2's rules to a high-ticket booking flow will produce bad output in both directions.

### 10.4 US-centric assumptions

- **A2P 10DLC is US-only.** Everything V1 says about registration, carrier filtering and opt-out footers maps to the US carrier ecosystem. The UK/EU (GDPR + PECR), Canada (CASL) and Australia (Spam Act) have materially different consent regimes — generally **stricter on prior consent** and with **no equivalent 10DLC campaign registration**. None of this is mentioned.
- **The iMessage argument is a US-market argument.** "iPhone holds about 57–65% of the US smartphone market" — in most of Europe, Asia, Africa and Latin America iPhone share is far lower (often 15–30%), which collapses the entire thesis. WhatsApp, named in passing, is the actual dominant channel across most of those markets and has its own Business API rules (template approval, 24-hour customer service window, per-conversation pricing) that are nothing like what's described here.
- **"Legally illegal to send more than one SMS in an abandonment flow"** (V2) is a restatement of a **Klaviyo product restriction**, presented as US law. The underlying constraint is closer to CTIA/carrier messaging principles and consent scope than to a statute. Do not repeat the word "illegal."
- **No mention of quiet hours anywhere in 27,000 words.** TCPA restricts calls/texts to 8am–9pm in the recipient's local time; several US states are stricter (e.g. Florida's mini-TCPA). Several timings in V1's flows — "22.3 hours before", "43 minutes before", speed-to-lead at any hour of the day or night — will send outside quiet hours unless explicitly gated. **This is a real, fineable omission and it is the single biggest compliance gap in the document.**
- **No mention of consent records, revocation handling beyond STOP, help keywords (HELP/INFO), double opt-in, or age gating.**

### 10.5 What would not survive contact with a high-risk vertical

Directly relevant if this seeds an assistant writing for regulated or SHAFT-adjacent verticals (peptides/supplements, cannabis, firearms, alcohol, tobacco, lending/debt, gambling, adult, crypto, healthcare/PHI):

- **SHAFT-C content is categorically blocked by US carriers** regardless of copy quality, consent or sender reputation. V1's "a single word in your campaign triggered that filter" is the only nod to this and it massively understates the problem: for these verticals, 10DLC campaign approval itself is frequently denied outright, and the "just switch to iMessage" answer is a way of *evading* a block rather than clearing it — which is exactly the behaviour that gets numbers, Apple IDs and merchant accounts terminated.
- **Health claims.** V2's welcome/replenishment templates ("clean ingredients", "are you running low?") are benign, but any peptide/supplement adaptation immediately runs into FDA/FTC substantiation rules and, in the US, potentially DSHEA structure-function limits. Nothing in the source discusses claim substantiation at all.
- **PHI / HIPAA.** V1 lists healthcare as a target vertical and recommends texting appointment details, pre-call intel, and internal Slack notifications containing lead context. There is no mention of BAAs, PHI in SMS, or Slack as an unencrypted PHI channel.
- **The "restock" fabrication** (V2: "which didn't actually restock, but we just framed it as a restock") is straightforward deceptive advertising. In a regulated vertical, in the UK/EU, or under FTC scrutiny, it is actionable. An assistant must not learn this as a tactic.
- **The "hide that it's automated" doctrine** (V1) is in direct tension with emerging AI-disclosure expectations and with several state-level bot-disclosure laws (e.g. California B.O.T. Act for commercial persuasion). V3's AI reply bot compounds this — an AI conversing with prospects under a human persona at 30–60 second response times is exactly the pattern those rules target.
- **Debt, lending and financial promotions** would additionally need risk warnings and, in the UK, FCA financial-promotion sign-off — impossible inside an 80-character "conversational" text.

### 10.6 Operational gaps

- **No inbound handling doctrine.** Every V1 flow ends at "internal Slack notification" and hands off to a human with zero guidance on what to say next. The whole system is optimised to generate replies it then has no scripted way to handle.
- **No STOP/HELP/unsubscribe handling logic** in any flow diagram.
- **No mention of number warming, throughput ramping, or number rotation** — despite "phone number health" being named as the first thing to break.
- **No cost model in V1.** V2 is the only speaker who thinks in cost per send or net profit.
- **No holdout/incrementality testing anywhere.** All three attribute revenue by association.
- **V2's "five key flows" list actually contains six**, and the post-purchase/replenishment/winback flow is explicitly un-templated ("really hard for me to create a verified set template").
- **No guidance on international numbers, number formatting, or carrier lookup / line-type validation** beyond V3's one line about clean data.
- **V1's 45-minute, 2-hour, 24-hour, 3-day, 7-day waits are given without any stated derivation.** Unlike the 3-minute and 5-second delays (which have a stated human-plausibility rationale), these are asserted.

---

## Quick-reference cheat sheet for the campaign assistant

**Classify first:** (A) warm 1:1 lead follow-up → V1 rules. (B) ecommerce lifecycle/blast → V2 rules. (C) cold/dormant mass reactivation → V3 rules. Never mix.

**V1 constants:** 3 min speed-to-lead · 5 sec between double-texts · 1–2 min reply latency · 2 min before a follow-up to their reply · 45 min reply window in core flows · 2 h → 24 h → 3 d → 7 d escalation in re-engagement · off-the-hour reminders (22.3 h / 43 min / 6 min / 1 min) · ≤80 chars · 4 follow-ups max without a reply · no links until they reply · introduce once, never sign off · reply rate >45% healthy, 70–80% target, iMessage ≥2× SMS.

**V2 constants:** ≤160 chars · emoji = 60–70 chars · MMS = 3× cost · welcome day 1/3/5 · abandonment = 1 SMS, within 48 h, browse abandon at +60 min · post-purchase day 10–14 · replenishment at supply + shipping (e.g. day 35) · winback at 2× avg inter-purchase interval, +2 days for last chance · 2 campaigns/week (min 1) · exclude "15 sends, zero clicks, ever" · clean monthly · full-list blast ~monthly · never text active subscribers · no nurture, no testimonials.

**V3 constants:** 5–7 touches · reply within 30–60 s · stop sequence on reply · opt-out rate <5% (>5–6% raises carrier flags) · 3–10% response rate is normal for cold · value first, never "buy now."

**Always add, because the source omits it:** quiet-hours gating (8am–9pm local, stricter in some US states), STOP/HELP handling, consent provenance, and a vertical-specific content check before any send.
