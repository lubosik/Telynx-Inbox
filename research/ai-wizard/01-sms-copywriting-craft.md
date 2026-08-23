# SMS Copywriting Craft: A Knowledge Base for the AI Campaign Assistant

**Purpose.** Source material for (a) the system prompt of an AI assistant that writes revenue-generating SMS campaigns from customer order history, and (b) the critique/scoring logic that grades its drafts.

**Date compiled:** 2026-08-11. Carrier fee figures and vendor benchmarks decay fast; see §4.6 and §8.

---

## 0. How to read this file

Marketing literature is polluted by statistics that were invented once and then laundered through a thousand blogs. Every empirical claim below carries a provenance tag. Do not promote a claim up this ladder without a new source.

| Tag | Meaning |
| --- | --- |
| `[ACADEMIC]` | Peer-reviewed, with methodology and sample size. Trustworthy but often not about SMS specifically. |
| `[PRIMARY-INDUSTRY]` | A carrier, CTIA, the FTC, or a CPaaS provider stating its own operational policy. Authoritative about itself. |
| `[VENDOR]` | Published by a company that sells the thing being measured. Directionally useful, structurally self-serving. |
| `[UNVERIFIED]` | Widely repeated, no traceable primary source found. |
| `[FOLKLORE]` | Traced and found to originate in vendor SEO content citing other vendor SEO content. |

Two findings up front, because they should change how you read everything else:

1. **The "98% SMS open rate" is unsourced and structurally unmeasurable.** `[UNVERIFIED]` SMS has no tracking pixel. There is no mechanism by which a carrier or handset reports "read" back to a sender for standard SMS. The figure is inferred from delivery receipts and lock-screen exposure, then reported as if it were an engagement metric. Attribution to the Mobile Marketing Association is repeated everywhere and links to nothing. ([Rally Corp, which sells SMS and still calls it a myth](https://www.rallycorp.com/blog/90-sms-open-rates-are-a-myth)) Do not let the assistant cite it, and do not build the scoring logic on the assumption that everything gets read.

2. **Peer-reviewed SMS research is overwhelmingly about *when, where, and to whom*, not *what you wrote*.** The rigorous field experiments (§3.1) manipulate timing, location, and targeting while holding copy roughly constant. There is no large randomized trial isolating SMS phrasing. This means the copy principles in §1 and §3 are *transferred* from adjacent literatures (long-form direct response, email, advertising psychology, pricing) and should be treated as strong priors to test, not settled law. The assistant should be built so its outputs are A/B testable.

---

## 1. Direct-response fundamentals and whether they survive 160 characters

The value of the old direct-response canon is that it was written by people whose income depended on measured response, in media where they could not hide behind brand-awareness metrics. Hopkins, Caples, Halbert, and Kennedy all worked in channels with a hard, countable feedback loop. That is exactly the epistemology we want.

But a great deal of that canon is about *sustaining* attention across 4,000 words. SMS has no room to sustain anything. Below, each principle gets an explicit transfer verdict.

### 1.1 Claude Hopkins, *Scientific Advertising* (1923)

Public domain. ([Library of Congress](https://www.loc.gov/item/23009362/), [Internet Archive](https://archive.org/details/scientificadvert0000hopk))

**"Platitudes and generalities roll off the human understanding like water from a duck. They leave no impression whatever."** (Ch. 7, Being Specific) ([quote compilation](https://chiandhuang.medium.com/quotes-from-great-marketing-books-scientific-advertising-by-claude-hopkins-13c7cc1ef2cb))

**TRANSFERS: completely, and it is the single highest-leverage rule in SMS.** In 160 characters you have room for exactly one concrete thing or several vague things. Hopkins says the vague ones are worth zero, which means they are worse than nothing because they consume the budget. "Big savings inside" and "$18 off your usual order" cost roughly the same characters. One of them is an impression.

**"To say 'Best in the world', 'Lowest prices in existence,' etc., is at best simply claiming the expected... Superlatives of that sort are usually damaging. They suggest looseness of expression, a tendency to exaggerate,"** which leads readers to discount everything else in the message.

**TRANSFERS, and is sharpened by the channel.** Superlatives are the default register of bulk SMS ("HUGE SALE", "BEST DEALS EVER"). Because that register is so strongly associated with junk, a superlative in SMS does not merely fail to persuade, it actively classifies the sender as bulk in the first half-second of the notification preview. This is a stronger effect than Hopkins described in print.

**"Measure ads by salesmen's standards, not by amusement standards. Ads are not written to entertain."** and **"Ad writers abandon their parts. They forget they are salesmen and try to be performers."**

**TRANSFERS.** The cleverness impulse is the main failure mode of both human and LLM SMS copy. Puns, alliteration, and wordplay consume characters and signal "this was written by a marketing department", which is precisely the signal you cannot afford in a personal channel (§2.3).

**"Create a headline which will hail those people only."** (Ch. 5, Headlines)

**TRANSFERS WITH MODIFICATION.** SMS has no headline, but it has a selection problem, and the selection now happens in the notification preview (§2.1). More importantly, in SMS the "hailing" job has largely moved *out of the copy and into the segment*. You do not need to write "Attention coffee drinkers" if you only sent it to people who bought coffee. This is a genuine structural advantage of the channel over 1923 print, and it frees characters. The assistant should exploit segmentation to avoid spending characters on qualification.

**"Almost any question can be answered, cheaply, quickly and finally, by a test campaign... Go to the court of last resort, the buyer of your product."** and **"A project you will laugh at may make a great success. A project you are sure of may fall down."**

**TRANSFERS as an operating philosophy for the product, not as a copy rule.** It is the reason the assistant should propose variants rather than one blessed draft.

**DOES NOT TRANSFER: "Tell your full story."** (Ch. 8) Hopkins argued that having got a reader's attention you should tell them everything, because the cost of the reader is sunk. This is correct in print and mail order and false in SMS, where the message is not the sales environment. The message is a door. The landing page tells the full story.

**DOES NOT TRANSFER: "Offer service"** as a headline strategy. Hopkins's reframe of "buy this" into "here is something useful for you" is philosophically right but in practice usually costs 30 to 50 characters of framing. In SMS the service framing has to be carried by relevance (you knew what they bought, you knew when they would run out) rather than by words.

### 1.2 John Caples, *Tested Advertising Methods*

Caples ran split tests with coupon key codes across decades. ([full text, Internet Archive](https://archive.org/stream/pdfy-hHdovzQ-RvFny9Cy/Tested%20Advertising%20Methods_djvu.txt))

**"I have seen one advertisement sell 19-1/2 times as much merchandise as another ad for the same product."** The difference was the headline.

**TRANSFERS as a magnitude claim about the opening.** SMS has no headline, but the first clause does the headline's job, and this is the empirical basis for weighting the opening heavily in the rubric (§5).

**The four qualities of a working headline: self-interest, news, curiosity, quick-and-easy-way.** With the caveat that curiosity alone "is seldom enough" and that headlines merely provoking curiosity should be avoided.

**TRANSFERS, with the curiosity caveat becoming a hard rule.** Curiosity-only openers in SMS ("You won't believe what we just did...") are the exact syntax of smishing and of engagement-bait. In a channel where the recipient's threat model includes fraud, unresolved curiosity reads as a trap. Self-interest and news transfer cleanly and are the two openers the assistant should default to. "News" is particularly cheap in characters: "Your size is back" is news, self-interest, and specific in 20 characters.

**The "Do you make *these* mistakes in English?" case.** The winning variant beat "Are you afraid of making mistakes in English?" The operative change was the word *these*, which converts abstract curiosity into a specific, closed set the reader wants to check themselves against.

**TRANSFERS as a technique: the specific determiner.** "Your order" beats "an order". "The Kenyan Peaberry" beats "your favourite coffee". "These three" beats "some". Deictic and possessive words are the cheapest specificity available, usually costing 2 to 5 characters.

**"Avoid headlines that paint the gloomy or negative side."**

**TRANSFERS, and matters more in SMS,** because a negative-framed message arriving in a thread next to family messages carries a disproportionate emotional cost.

### 1.3 Eugene Schwartz, *Breakthrough Advertising* (1966)

Two frameworks, and they behave very differently in SMS.

**Copy cannot create desire; it channels existing desire.** Schwartz's central claim is that the copywriter takes the hopes, fears, and desires already present in the market and focuses them onto a product.

**TRANSFERS, and is arguably the founding principle of order-history-driven SMS.** The entire premise of writing from purchase history is that you are not creating desire, you are detecting a desire that has already demonstrated itself with money, and arriving at the moment it recurs. The assistant's job is closer to timing than to persuasion.

**The five stages of awareness: Unaware, Problem Aware, Solution Aware, Product Aware, Most Aware.** Each demands a different opening. ([overview](https://betweenthelinescopy.com/blog/stages-of-awareness/), [framework summary](https://www.selfstorming.com/tools/libraries/frameworks/customer-awareness-stages))

**TRANSFERS, but collapses.** Here is the important structural point: **an opted-in SMS list is almost entirely Product Aware and Most Aware.** They gave you their mobile number. They know who you are and, in the order-history case, they have paid you. Schwartz's guidance for those two stages is: lead with the offer and the identification, not with the problem or the mechanism.

This has a hard consequence the assistant must encode. **Problem-agitation openers are a category error in SMS.** "Tired of running out of coffee?" is Problem Aware copy sent to a Most Aware audience. It insults the reader, wastes 30 characters re-establishing a premise they already accept, and reads as generic because it could have been sent to anyone. The correct move for Most Aware is Schwartz's own: name the thing and name the terms.

The exception is genuine cross-sell into an adjacent category the customer has never bought, where they may be Solution Aware at best. That is the one case where a mechanism or benefit clause earns its characters.

**The five levels of market sophistication: plain claim, bigger claim, mechanism, better mechanism, identity.** ([detailed treatment](https://www.motiveinmotion.com/market-sophistication/))

**TRANSFERS ONLY AS A CONSTRAINT, NOT AS A STRATEGY.** Sophistication levels 3 and 4 (new mechanism, better mechanism) require room to explain a mechanism, and SMS does not have it. What does transfer is the *diagnostic*: if your market is at level 4 or 5, a plain claim ("20% off") is invisible, and the SMS cannot fix that on its own. In a saturated market the differentiator available to SMS is not a better claim, it is level-5 identity plus level-0 relevance: this brand, which you know, noticed something true about you specifically. Personalisation from order history is, in Schwartz's terms, how a sophisticated market gets re-entered without a mechanism.

### 1.4 Gary Halbert

**The A-pile / B-pile.** Halbert's model of the reader standing over a trash can, sorting mail into personal correspondence (A-pile, opened) and obvious commercial matter (B-pile, binned unopened). ([Boron Letters summary](https://www.dropdeadcopy.com/the-boron-letters/), [overview](https://bagerbach.com/books/boron-letters/))

**TRANSFERS, and is the most useful single mental model for SMS.** SMS *is* the A-pile. That is the whole reason the channel is valuable and the whole reason it is fragile. The message arrives in the same list as messages from the recipient's mother. Every formatting decision should be evaluated by: does this look like it came from a person or from a system? Halbert's answer in direct mail was live stamps, handwriting, and no window envelopes. The SMS equivalents are lower case, no promotional glyph decoration, no marketing register, and a first clause that could plausibly have been typed by a human who knows the recipient.

**The starving crowd.** It is easier to sell an average hamburger to a starving crowd than the best hamburger to a fed one. Audience selection dominates message quality.

**TRANSFERS, and should be encoded as a refusal.** The assistant has order history. It should be willing to say "this segment is wrong for this offer" rather than write better copy for a bad segment. A campaign-writing assistant that never pushes back on the brief is a worse product than one that does.

**Write to one person, in the register in which you speak.** ([Boron Letters notes](https://www.enchantingmarketing.com/gary-halbert-boron-letters/))

**TRANSFERS completely.** "Hey everyone" and "our customers" are disqualifying in a 1:1 channel.

### 1.5 David Ogilvy

**"On the average, five times as many people read the headline as the body copy. When you have written your headline, you have spent eighty cents out of your dollar."** ([Ogilvy on Advertising](https://www.goodreads.com/author/quotes/25181.David_Ogilvy))

**TRANSFERS with a channel-specific rewrite.** In SMS the ratio is likely more extreme, because the notification preview is free to read and opening the message is a deliberate act. The first 40 to 50 characters carry the great majority of the decision weight (§2.1).

**"Specifics work better than generalities."** Ogilvy's Sears example: research showed shoppers believed Sears made a 37% profit, so he headlined "Sears makes a profit of 5%", which beat "less than you might suppose".

**TRANSFERS, and converges with Hopkins and with the academic price-precision literature (§3.4).** Three independent traditions arriving at the same rule is about as strong as evidence gets in this field.

**"Include the brand name in your headline. If you don't, 80% of readers will never know what product you are advertising."**

**TRANSFERS, and is separately mandated.** In SMS the brand name at the start is simultaneously an Ogilvy persuasion rule, a CTIA compliance expectation, and a carrier anti-filtering signal (§6.2). Rarely does one instruction satisfy three masters.

**"Headlines which contain news are sure-fire. On the average, ads with news are recalled by 22% more people than ads without news."**

**TRANSFERS.** Restock, new arrival, price change, and "your thing is ready" are all news and all cheap in characters.

**DOES NOT TRANSFER: "On the average, long headlines sell more merchandise than short ones."** and Ogilvy's general defence of long copy. Correct in print, where a long headline still occupies a fraction of the page and the interested reader has the rest of the ad. In SMS, length is the budget, and the second segment costs real money (§4).

### 1.6 Joe Sugarman, *The Adweek Copywriting Handbook*

**The slippery slide.** The sole purpose of the headline is to get the first sentence read; the sole purpose of the first sentence is to get the second read, and so on. The first sentence should be almost trivially short and easy. ([full text](https://archive.org/stream/the-adweek-copywriting-handbook/The%20Adweek%20Copywriting%20handbook_djvu.txt))

**TRANSFERS, but the slide is only three or four steps long, and it does not end at a purchase.** The SMS slide is: notification preview → open → read to the link → tap. That is it. Sugarman's insight that each unit exists only to earn the next unit is exactly right; his implied structure of dozens of sentences building momentum is not available. Practical consequence: the *last* thing before the link matters more in SMS than in long copy, because the tap decision happens there, and there is no recovery if it fails.

**Seeds of curiosity.** Short bridging sentences that create a reason to continue.

**MOSTLY DOES NOT TRANSFER.** These are momentum devices for long copy. In SMS they cost characters and, as with Caples's curiosity caveat, unresolved curiosity in a fraud-adjacent channel reads as bait.

### 1.7 Dan Kennedy

The ten rules of *No B.S. Direct Marketing*: there will always be an offer; a reason to respond right now; clear instructions on how to respond; tracking and measurement; brand building is a by-product, not a purchase; there will be follow-up; strong copy, not vague hyperbole; it will look like mail-order advertising; results rule; stay on the discipline for six months. ([summary](https://www.mybizniche.com/dan-kennedy-the-godfather-of-direct-response-marketing/), [notes](https://hooshmand.net/no-bs-direct-marketing-dan-kennedy-summary/))

**TRANSFERS: the offer, the reason to act now, the clear instruction, and measurement.** These four are effectively the skeleton of a competent SMS and map directly onto rubric dimensions in §5. Kennedy's "every offer needs a deadline, and every deadline needs to be real" is the correct formulation of urgency and is echoed by both the reactance literature and the FTC (§3.3, §6.1).

**TRANSFERS AS A WARNING: "it will look like mail-order advertising."** Kennedy meant: look like something that wants a response, not like a brand ad. In SMS the visual grammar of mail-order response advertising (caps, exclamation, urgency, arrows, dingbats) is the exact grammar of spam. **Kennedy's intent transfers, his aesthetic does not.** The SMS way to look like you want a response is to make responding trivially easy and singular, not to shout.

**DOES NOT TRANSFER: "there will be follow-up"** at the per-message level. In direct mail more touches were usually better. In SMS, frequency is the number-one reported cause of opt-out (§3.6) and, unlike mail, each unwanted touch destroys the channel permanently for that recipient. Follow-up in SMS is a scarce budget, not an accelerator.

### 1.8 Robert Collier

**"Always enter the conversation already taking place in the customer's mind."** ([attribution](https://www.activecampaign.com/blog/robert-collier-quotes))

**TRANSFERS, and is the cleanest one-line brief for an order-history assistant.** Order history is a literal record of the conversation already taking place. The customer who bought a 30-day supply 28 days ago is already, right now, having a thought about running out. The assistant's job is to arrive inside that thought rather than to start a new one.

### 1.9 Summary: the transfer table

| Principle | Source | Verdict in SMS |
| --- | --- | --- |
| Specificity beats generality | Hopkins, Ogilvy | **Transfers. Highest leverage.** |
| Superlatives get discounted | Hopkins | **Transfers, amplified.** Also a spam signal. |
| Salesmanship not entertainment | Hopkins | **Transfers.** Kill cleverness. |
| Self-interest and news openers | Caples, Ogilvy | **Transfers.** Default openers. |
| Curiosity-only openers | Caples | **Inverts.** Actively harmful; reads as smishing. |
| The specific determiner ("these", "your") | Caples | **Transfers.** Cheapest specificity. |
| Channel desire, don't create it | Schwartz | **Transfers.** Foundational for order history. |
| Five stages of awareness | Schwartz | **Transfers but collapses** to Product/Most Aware. Kills problem-agitation. |
| Market sophistication ladder | Schwartz | **Diagnostic only.** No room for mechanism. |
| A-pile / B-pile | Halbert | **Transfers. Best mental model for the channel.** |
| Starving crowd | Halbert | **Transfers** as a right to refuse the brief. |
| Write to one person | Halbert | **Transfers.** |
| Brand name early | Ogilvy | **Transfers,** and is also compliance and deliverability. |
| Long copy / long headlines | Ogilvy, Hopkins | **Does not transfer.** Length is the budget. |
| Tell your full story | Hopkins | **Does not transfer.** The landing page does that. |
| Slippery slide | Sugarman | **Transfers, truncated** to 3 steps. Pre-link clause is critical. |
| Seeds of curiosity | Sugarman | **Does not transfer.** |
| Offer / reason now / clear instruction | Kennedy | **Transfers.** The skeleton. |
| Real deadlines only | Kennedy | **Transfers,** corroborated by FTC and reactance research. |
| Look like mail order | Kennedy | **Intent transfers, aesthetic inverts.** |
| Relentless follow-up | Kennedy | **Does not transfer.** Frequency is the top opt-out driver. |
| Enter the existing conversation | Collier | **Transfers.** The brief in one line. |

---

## 2. The 160-character problem

### 2.1 There is no headline, so the notification preview becomes one

You cannot write a headline, a subject line, a subhead, a lead, or a P.S. What you have instead is a truncation point you do not control, at a position that varies by device, OS version, lock-screen setting, and whether the recipient is looking at a banner, the lock screen, or the Messages list.

Reported preview capacities vary by surface. Messaging apps show roughly 4 lines in a banner and up to about 6 on the lock screen; the commonly cited "guaranteed visible" figure is the **first ~50 characters** on a banner, with iOS lock-screen/notification-centre capacity around 110 characters and Android bodies up to about 240. ([Gravitec](https://gravitec.net/blog/push-notification-character-limit-for-ios-android-and-web/), [CleverTap](https://clevertap.com/blog/what-are-push-notification-character-limits/), [DontSendYet](https://www.dontsendyet.com/blog/ios-notification-character-limit)) These are `[VENDOR]` figures from push-notification tooling companies and are approximations of a moving target, but the direction is unambiguous.

**Operational rule: treat the first 40 characters as the headline, and assume everything after character 110 may never be seen by a non-opener.** The message must therefore contain its own value proposition inside the first clause, not build to it. This is the opposite of the long-form structure in which a lead builds tension before the promise.

A useful test: **truncate the draft at 40 characters. If what remains does not say who is texting and why the reader should care, the draft has failed regardless of how good the rest is.**

### 2.2 The other things you lose

- **No images.** All demonstration must be verbal. This is a real loss for apparel, food, and anything aesthetic, and it is the strongest legitimate argument for MMS despite the higher per-message cost.
- **No formatting.** No bold, no italics, no hierarchy, no bullets that render reliably. Emphasis can only be achieved through word order and sentence length. This is why writers reach for caps and emoji, and why both are traps (§6).
- **No sender identity that the reader recognises.** Email shows a from-name. SMS shows a ten-digit number the recipient has probably not saved. **This is why brand identification in the first clause is load-bearing rather than decorative:** without it, the reader is looking at an unknown number, which is the single most fraud-suspicious configuration in the channel.
- **No unsubscribe footer that costs nothing.** In email the compliance footer is below the fold and free. In SMS, "Reply STOP to end" is 18 characters out of 160, roughly 11% of the budget, and it is competing with the copy.
- **No lead, and therefore no room to handle objections.** Every objection must be pre-empted structurally (by targeting) or deferred to the landing page.

### 2.3 SMS is read in a personal channel, and this is the whole ballgame

The message arrives in the same inbox, in the same visual grammar, in the same notification sound, as messages from the recipient's partner, children, doctor, and bank. This is not a metaphor; it is literally the same thread list.

The empirical support is solid. The mobile-marketing attitudes literature `[ACADEMIC]` consistently finds that consumers perceive mobile marketing as more irritating, more privacy-invading, and more intrusive than the same content in other channels, because the handset is regarded as personal space; that explicit permission measurably reduces the privacy-concern-driven negative attitude; and that **frequency is the moderator that converts personalisation from a positive into a negative**, with over-personalisation at high frequency reading as surveillance rather than service. ([consumer attitudes to mobile marketing in the smartphone era](https://www.sciencedirect.com/science/article/abs/pii/S0268401213000868), [affective variables in mobile advertising](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5206691/)) A `[VENDOR]` consumer survey found 96% of respondents report being annoyed at least occasionally by brand texts. ([Validity, State of SMS Marketing 2023](https://www.validity.com/wp-content/uploads/2023/02/The-State-of-SMS-Marketing-in-2023.pdf))

**Five consequences for tone, all of which should be hard rules in the system prompt:**

1. **Write in the register of a competent human colleague, not a brand.** Not chummy, not a friend pretending. A brand pretending to be the reader's friend in the friend channel is worse than a brand being straightforwardly a brand. The target register is the shop owner who knows your name: warm, brief, transactional, unembarrassed about selling.

2. **Lower case by default.** Sentence case is the native typography of the channel. Title Case and ALL CAPS are the typography of advertising, and in a channel where everything else is lower case, they are a visual siren announcing "this is not a person". `[VENDOR]` guidance is unanimous on this ([Voxie](https://www.voxie.com/blog/craft-the-perfect-marketing-sms/), [Mailchimp](https://mailchimp.com/resources/writing-sms-messages/)) and it is consistent with the A-pile model.

3. **One idea per message.** Multi-offer messages are a broadcast form. Nobody texts you two unrelated propositions.

4. **The trust cost is per-message, not per-campaign.** In email, a bad send costs you one open. In SMS a bad send costs you the recipient permanently, because opting out is one word and socially frictionless. Frequency discipline is therefore a copywriting constraint, not just a scheduling one: **the assistant should be willing to conclude that the best message is no message.**

5. **Never simulate intimacy you have not earned.** "Hey!! 😍 it's been AGES" from a brand is uncanny-valley. The permitted warmth is warmth about a *fact you actually know* from the order history.

### 2.4 What the constraint gives you back

Two things, and both should be exploited deliberately.

- **Targeting replaces qualification.** Hopkins had to spend headline characters hailing the right reader. You spent them at segment-definition time. Every character not spent on "attention runners" is a character available for specificity.
- **Brevity is a credibility signal here, uniquely.** In most channels, short copy reads as thin. In SMS, short copy reads as *considerate*, because the reader knows the sender chose not to take more of their attention. A 300-character three-segment SMS does not read as thorough, it reads as a violation.

---

## 3. Copy patterns, with honest provenance

### 3.1 The rigorous SMS research is about timing and context, not words

This deserves emphasis because it should shape product priorities.

- **Luo, Andrews, Fang & Phang, "Mobile Targeting," *Management Science* 60(7), 2014, 1738–1756.** `[ACADEMIC]` Randomized field experiment, SMS to 12,265 mobile users. Temporal and geographic proximity to a purchase opportunity each independently raise purchase probability, but the interaction is not additive; construal-level effects mediate, and excessive proximity can reduce involvement. ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2341865), [Management Science](https://pubsonline.informs.org/doi/10.1287/mnsc.2013.1836))
- **Andrews, Luo, Fang & Ghose, "Mobile Ad Effectiveness: Hyper-Contextual Targeting with Crowdedness," *Marketing Science*, 2015.** `[ACADEMIC]` n = 14,972, randomized. Purchase rate roughly **doubled** from 2.1% in uncrowded conditions to 4.3% in crowded subway conditions. Physical context at moment of receipt moved response more than most copy changes plausibly could. ([Marketing Science](https://pubsonline.informs.org/doi/10.1287/mksc.2015.0905))
- **Danaher, Smith, Ranasinghe & Danaher, "Where, When, and How Long," *JMR* 52(5), 2015, 710–725.** `[ACADEMIC]` Two-year field test, ~8,500-panelist mobile coupon programme. **Location and timing of delivery drove redemption more than message content did.** ([SAGE](https://journals.sagepub.com/doi/10.1509/jmr.13.0341))
- **Fong, Fang & Luo, "Geo-Conquesting," *JMR* 52(5), 2015, 726–735.** `[ACADEMIC]` Discount depth shows increasing returns when targeting competitor locations, decreasing returns at own locations. Relevant to *how deep the offer should be*, which is a copy input. ([JMR](https://journals.sagepub.com/doi/10.1509/jmr.14.0229))

**Implication for the assistant:** the highest-value thing it can do with order history is probably not word choice. It is computing the right moment (predicted depletion date, individual reorder interval) and the right segment. The copy should be graded on whether it *makes the timing legible to the reader*, because a well-timed message whose copy does not reveal why now is indistinguishable from a lucky broadcast.

### 3.2 Personalisation: genuinely contested, and the honest position matters

**The strongest positive evidence is from email, not SMS.** Sahni, Wheeler & Chintagunta, "Personalization in Email Marketing," *Marketing Science* 37(2), 2018 `[ACADEMIC]`: randomized field experiments across three companies, millions of recipients. Adding the recipient's first name to the subject line raised open probability by **20%** (9.05% → 10.80%), sales leads by **31%** (0.39% → 0.51%), and *reduced* unsubscribes by **17%** (1.2% → 1.0%). ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2725251))

**But it does not replicate cleanly.** Multiple subsequent studies find null or negative effects for first-name subject-line personalisation, including a reproduction study finding "no indication that using the first name of the recipient in the subject line has a positive effect on opening rates or click-through rates". ([Personalisation (in)effectiveness in email marketing](https://www.sciencedirect.com/science/article/pii/S2666954423000066))

**The SMS-adjacent RCT evidence is also mixed** `[ACADEMIC]`, from health-services trials that used SMS reminders:
- PROMPTS trial (n = 618): personalised vs standard SMS, 60% vs 52% initial questionnaire return, an 8 point absolute difference. ([PMC8320189](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8320189/))
- Telephone follow-up trial: 78% vs 68%, adjusted absolute risk difference 7.1%, **95% CI −10.2% to 24.4%**, i.e. not significant. ([PMC10848401](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10848401/))
- OTIS trial (n = 283): 97.8% vs 98.6%, adjusted OR 0.64, p = 0.63. **"Personalised texts were not superior to standard texts in any outcome assessed."** ([PMC7194505](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7194505/))
- Orthopaedic retention trial: 89.1% vs 88.1%, absolute difference 0.9%, CI −2.3% to 4.2%. ([PMC9091807](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9091807/))

**The defensible synthesis, and the one to encode:** *name* personalisation is a weak and unreliable lever. *Knowledge* personalisation, meaning demonstrable reference to a specific past purchase, an individual reorder interval, or a saved item, is a different mechanism entirely and is the one the order-history feature actually justifies. The name is cosmetic; the product name is evidence. When character budget is tight, **cut the first name before you cut the product name.** No study I found tests exactly this contrast in SMS, so mark the specific ranking as `[UNVERIFIED]` and instrument it as the assistant's first A/B test.

The largest SMS-specific dataset on this is `[VENDOR]`: Attentive's analysis of 25 billion sends and 850,000 unique messages, notable because it uses propensity score matching to pair near-identical messages differing on one feature, which is a genuine quasi-causal design rather than raw correlation. No peer review, no replication, and the publisher sells SMS software. ([Attentive](https://www.attentive.com/blog/high-performing-sms-campaign-insights))

### 3.3 Urgency and scarcity: credible versus cheap

The mechanism by which urgency fails is well established, even though the SMS-specific effect size is not.

- **Friestad & Wright, "The Persuasion Knowledge Model," *JCR* 21(1), 1994, 1–31.** `[ACADEMIC]` Consumers hold learned knowledge of persuasion tactics and deploy it to detect manipulation; once a tactic is recognised as manipulative, a "change of meaning" and detachment occurs and persuasiveness collapses. ([JCR](https://academic.oup.com/jcr/article-abstract/21/1/1/1853712))
- **Psychological reactance.** Brehm's theory, repeatedly confirmed in marketing contexts: perceived restriction of choice freedom produces hostility toward the source, which manifests as brand-switching intent, not merely non-purchase. Recent scarcity work distinguishes **product-based scarcity** ("only 3 left", true stock constraint), which reads as credible, from **social and temporal scarcity** ("14 people are viewing this", countdown timers), which reads as system-generated and is far more prone to backfire. ([Stevens, "Beyond the Shelf," *Psychology & Marketing*, 2026](https://onlinelibrary.wiley.com/doi/10.1002/mar.70232); [Biraglia et al., "The downside of scarcity," *Psychology & Marketing*, 2021](https://onlinelibrary.wiley.com/doi/full/10.1002/mar.21489))
- **Regulatory backstop.** The FTC's 2022 staff report *Bringing Dark Patterns to Light* explicitly names "baseless countdown timer" and "false high demand message" as deceptive practices under Section 5. ([FTC report PDF](https://www.ftc.gov/system/files/ftc_gov/pdf/P214800+Dark+Patterns+Report+9.14.2022+-+FINAL.pdf), [FTC press release](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers))

**The operational distinction the assistant must make:**

| Credible urgency | Cheap urgency |
| --- | --- |
| Tied to a real external fact | Tied to nothing verifiable |
| "ends Sunday" where it genuinely ends Sunday | "limited time only" (which time?) |
| "3 left in your size" from real inventory | "selling fast!!" |
| "your 15% expires with this code on the 14th" | "act now before it's too late" |
| Individual timing: "you usually reorder around now" | Recurring weekly "24-hour sale" |
| Stated once, plainly | Repeated, with exclamation marks |

The strongest form of urgency available to an order-history assistant is not a deadline at all. It is **depletion**: "you're about 3 days from running out." This is urgency that is true, individual, non-manipulable, verifiable by the reader against their own bathroom cabinet, and impossible to read as a tactic. **An assistant with order history should reach for depletion timing before it reaches for a deadline.**

### 3.4 Specificity of numbers: the best-supported copy rule in this document

Two independent peer-reviewed mechanisms converge.

- **Thomas, Simon & Kadiyali, "The Price Precision Effect," *Marketing Science* 29(1), 2010, 175–190.** `[ACADEMIC]` Five studies, lab plus real real-estate market data. Precise numbers signal that the communicator is informed about true value, though they are simultaneously judged smaller in magnitude than comparable round numbers. ([Marketing Science](https://pubsonline.informs.org/doi/10.1287/mksc.1090.0512))
- **Janiszewski & Uy, "Precision of the Anchor Influences the Amount of Adjustment," *Psychological Science* 19(2), 2008, 121–127.** `[ACADEMIC]` Precise anchors are represented on a finer mental scale, so adjustment away from them is smaller. Precise numbers stick harder. ([SAGE](https://journals.sagepub.com/doi/10.1111/j.1467-9280.2008.02057.x), [PubMed](https://pubmed.ncbi.nlm.nih.gov/18271859/))

Combined with Hopkins and Ogilvy arriving at the same rule from measured response, this is as close to settled as this field gets. **"$18 off" beats "save big". "3 days" beats "soon". "32 days" beats "a while ago".** Note the one genuine tension: precision makes a number feel *smaller*, so for a discount you want to advertise as large, a round number may serve better, while for credibility signals (dates, quantities, intervals) precision always wins.

### 3.5 Question openers versus statement openers: conditional, not absolute

**Hagtvedt, "The Impact of Question Versus Statement Framing," *Journal of Consumer Psychology*, 2015.** `[ACADEMIC]` Three studies, 400+ participants. Question framing ("The Pen For You?") outperforms statement framing ("The Pen For You.") **when the audience is in a low-arousal state**. Under high arousal (excited, time-pressured, competitive), statements outperform, because aroused consumers want unambiguous, low-cognitive-load information. ([ScienceDaily summary](https://www.sciencedaily.com/releases/2015/03/150309083024.htm))

**The direct implication is a rule the assistant should follow:** do not combine a question opener with urgency copy. They work against each other psychologically. Given that most revenue-driving SMS carries some time pressure, and that SMS is read in a distracted, glancing state, **statements should be the default and questions the exception**, reserved for low-urgency re-engagement and genuine reply-solicitation messages.

There is a second reason to prefer statements in SMS specifically: a question invites a reply, and if the number cannot handle replies, an unanswered question is a small betrayal in a channel whose whole affordance is two-way.

### 3.6 Emoji: a real tradeoff, in two dimensions at once

**Dimension 1, human response.** `[ACADEMIC]`

- The **warmth/competence tradeoff** is well replicated: emoji use raises perceived warmth and lowers perceived competence, moderated by context formality. Communal-oriented customers respond positively; exchange-oriented, transactional customers respond negatively. ([Shuqair et al., *Journal of Consumer Behaviour*, 2024](https://onlinelibrary.wiley.com/doi/full/10.1002/cb.2310))
- **Das, Wiener & Kareklas, "To Emoji or Not to Emoji?", *Journal of Business Research* 96, 2019, 147–156.** Emoji presence raises positive affect and purchase intention **for hedonic products**, with no reliable benefit for **utilitarian** products. ([listing](https://ideas.repec.org/a/eee/jbrese/v96y2019icp147-156.html))
- **Quantity matters and cuts against you.** Koch et al., 2023: heavier emoji use lowers perceived message credibility and source trustworthiness, and emoji use itself can activate persuasion knowledge. ([SAGE](https://journals.sagepub.com/doi/10.1177/20563051231194584))

**Dimension 2, machines.** Emoji are outside GSM-7. A single emoji flips the entire message to UCS-2, cutting single-segment capacity from 160 characters to 70, and most modern emoji cost 2 or more UTF-16 code units each (§4). Separately, "excessive emoji" appears in Twilio's own description of content patterns associated with filtered messages `[PRIMARY-INDUSTRY, soft]` (§6.2).

**The synthesis, which is unusually clean:** emoji cost money and capacity with certainty, and buy warmth only conditionally (hedonic product, informal brand, low-arousal message, communal customer). **Default to zero emoji. Permit at most one, never decoratively, only when it replaces words rather than accompanying them, and never in the first 40 characters** where it competes with brand identification for the preview.

### 3.7 Structural conventions

These are `[VENDOR]` consensus rather than tested findings, but they are consistent across every major platform and are cheap to comply with. ([Klaviyo](https://help.klaviyo.com/hc/en-us/articles/13288640663579), [Attentive](https://www.attentive.com/blog/sms-marketing-copy-tips), [Omnisend](https://www.omnisend.com/blog/the-best-way-to-send-links-in-text-messages/), [Textline](https://www.textline.com/blog/how-to-use-links-in-business-sms-to-increase-conversions))

- **Brand name in the first clause.** Triple-justified: Ogilvy's recall rule, CTIA sender-identification expectation, and carrier anti-filtering. Non-negotiable.
- **Link at the end, never at the start, always preceded by a CTA clause.** A bare link is the syntax of smishing. "tap to reorder: link" is a request; "link" is a threat.
- **One link only.** Two links is a broadcast form and dilutes measurement.
- **Sentence case. Never ALL CAPS.** See §2.3 and §6.
- **"Reply STOP to end"** costs 18 characters and is not optional (§6.2).

### 3.8 Benchmarks: use with tongs

| Metric | Reported | Provenance |
| --- | --- | --- |
| Open rate | 98% | `[UNVERIFIED]` and unmeasurable. Do not use. |
| CTR | 19–35% | `[VENDOR]` aggregates, no independent audit ([Omnisend](https://www.omnisend.com/blog/sms-marketing-benchmarks/), [Klaviyo](https://www.klaviyo.com/products/sms-marketing/benchmarks)) |
| Conversion | 21–40% | `[VENDOR]`, no audit |
| ROI | "$71 per $1" | `[VENDOR]` marketing claim, no methodology |
| Opt-out, campaigns | 0.3–0.6% | `[VENDOR]` (Attentive), most internally consistent figure in the set |
| Opt-out drivers | frequency ~53%, spammy tone ~21%, irrelevance ~10% | `[VENDOR]`, but consistent with the academic frequency finding in §2.3 |
| Optimal length | 80–120 chars | `[VENDOR]`, uncorroborated, blogs citing blogs |
| Best send windows | 9am–12pm, 5–9pm | `[VENDOR]` pattern-mining. The only rigorous timing evidence is about purchase-proximity, not clock time (§3.1) |

One specific claim encountered during research and worth recording as a warning: a source asserted "a landmark MMA study tracking 2.3 billion sends across 47 countries found AI-personalized SMS achieves 99.2% open rate". No such study could be located. It has the signature of a fabricated or LLM-generated statistic. `[FOLKLORE]` **The assistant must never cite statistics in its own output**, partly for this reason.

---

## 4. Message length and segment economics

This section is the one place in this document where the numbers are hard. Get them wrong and the unit economics are wrong at every scale.

### 4.1 GSM-7

The GSM 03.38 default alphabet is a 128-character, 7-bit table. The SMS payload is fixed at **140 octets = 1,120 bits**. Packed at 7 bits per character: 1,120 ÷ 7 = **160 characters exactly**. ([Wikipedia, GSM 03.38](https://en.wikipedia.org/wiki/GSM_03.38), [Twilio](https://www.twilio.com/docs/glossary/what-is-gsm-7-character-encoding))

It covers basic Latin letters and digits, standard punctuation, a set of Western European accented characters (è é ù ì ò Ç Ø ø Å å Æ æ ß Ñ ñ Ü ü Ä ä Ö ö), and some Greek capitals used as symbols.

### 4.2 The extension table: characters that silently cost double

Not in the base table. Each requires an ESC prefix and therefore consumes **two septets**:

`^` `{` `}` `[` `]` `~` `|` `\` `€` (plus form feed)

A message using several of these quietly loses one character of budget per instance.

### 4.3 UCS-2

Fixed-width 16-bit. 140 bytes ÷ 2 = **70 characters** in a single segment.

**Any single character outside GSM-7 re-encodes the entire message.** Not just the character. The whole message. Capacity drops from 160 to 70 in one step.

### 4.4 Concatenation

Multipart messages carry a 6-byte User Data Header so the handset can reassemble them. That overhead comes out of the payload:

- **GSM-7:** (140 − 6) × 8 ÷ 7 = **153 characters per segment**
- **UCS-2:** (140 − 6) ÷ 2 = **67 characters per segment**

| Segments | GSM-7 capacity | UCS-2 capacity |
| --- | --- | --- |
| 1 | 160 | 70 |
| 2 | 306 | 134 |
| 3 | 459 | 201 |
| 4 | 612 | 268 |
| 5 | 765 | 335 |

Sources: [Twilio, SMS character limit](https://www.twilio.com/docs/glossary/what-sms-character-limit), [Twilio, concatenated SMS](https://support.twilio.com/hc/en-us/articles/223181508-Does-Twilio-support-concatenated-SMS-messages-or-messages-over-160-characters), [Twilio engineering blog](https://www.twilio.com/en-us/blog/developers/best-practices/getting-most-money-using-automated-sms)

Note the discontinuity that catches people: going from 160 to 161 GSM-7 characters costs you a second segment *and* retroactively reduces the first segment to 153, so the 161st character actually costs 8 characters of headroom.

### 4.5 Emoji and smart punctuation: the exact costs

Emoji are outside GSM-7, so the first one forces UCS-2. Beyond that, emoji themselves are often multiple UTF-16 code units, because anything above U+FFFF requires a surrogate pair, and ZWJ sequences and skin-tone modifiers append further code points.

| Emoji | Code points | UTF-16 code units |
| --- | --- | --- |
| 😀 | U+1F600 | **2** |
| ❤️ | U+2764 + U+FE0F | **2** |
| 👍🏽 | U+1F44D + U+1F3FD | **4** |
| 👨‍👩‍👧 | U+1F468 + ZWJ + U+1F469 + ZWJ + U+1F467 | **8** |

(Twilio's own RCS character-count article states 7 for the family emoji; its own component breakdown sums to 8, and 8 is arithmetically correct. ([Twilio](https://www.twilio.com/en-us/blog/developers/rcs-character-count)) Use 8.)

**Smart punctuation is the silent killer,** because it arrives via copy-paste from Word, Google Docs, or iOS autocorrect rather than deliberate typing. None of the following is in GSM-7, and each one alone forces the entire message to UCS-2:

- curly quotes `'` U+2018, `'` U+2019, `"` U+201C, `"` U+201D
- em dash `—` U+2014 and en dash `–` U+2013
- the single-glyph ellipsis `…` U+2026 (three separate periods `...` are fine)
- non-breaking space U+00A0 and other exotic space variants

Telnyx ships a "Smart Encoding" feature that substitutes 200+ such lookalikes back to GSM-7-safe ASCII precisely because this is so common. ([Telnyx docs](https://developers.telnyx.com/docs/messaging/messages/smart-encoding/index), [Twilio, UCS-2](https://www.twilio.com/docs/glossary/what-is-ucs-2-character-encoding))

**Worked illustrations, computed:**

| Message | Encoding | Visible chars | Billable units | Segments |
| --- | --- | --- | --- | --- |
| Plain 160-char message | GSM-7 | 160 | 160 | **1** |
| Same message + one 😀 | UCS-2 | 161 | 162 | **3** |
| Same 160 chars, one `'` swapped for `'` | UCS-2 | 160 | 160 | **3** |
| Same 160 chars, one `-` swapped for `—` | UCS-2 | 160 | 160 | **3** |
| 70 plain chars + 👍🏽 | UCS-2 | 72 | 74 | **2** |

**A single curly apostrophe triples the cost of a message with no visible change whatsoever.** At a million sends, that is a 2 million segment error caused by one invisible character. This is the strongest possible argument for a deterministic pre-send encoder check rather than trusting either the human or the model. It is also, incidentally, an independent technical justification for the house style rule against em dashes.

### 4.6 Carrier pass-through fees

`[PRIMARY-INDUSTRY, but volatile and contested across sources]`

Twilio's published US long-code carrier fee table gives per-outbound-SMS-segment pass-through of approximately: AT&T $0.0035, T-Mobile $0.0045, Verizon $0.0045, US Cellular $0.005, others ~$0.004, on top of a base send fee starting around $0.0083 per segment. MMS is roughly $0.009–$0.01. ([Twilio US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us))

**These figures are in active flux and sources disagree by 2–4x depending on publication date.** T-Mobile announced 2026 A2P pass-through changes effective mid-to-late January 2026, with secondary sources giving inconsistent dates and one social claim of an 80% increase. ([Telgorithm](https://www.telgorithm.com/news/t-mobile-announces-new-2026-a2p-sms-pass-through-fees), [Twilio help article, which could not be retrieved during research](https://help.twilio.com/articles/44609260499995)) **Do not hardcode these. Pull live from the provider console before quoting any per-message price.** Mark as `[UNVERIFIED]` for August 2026.

What *is* stable and safe to build on: **segment count is the billing unit**, it is fully deterministic from the message bytes, and it is entirely within the copywriter's control. A model that reliably keeps campaigns to one segment is worth roughly 2x to 3x on the messaging line item versus one that does not.

### 4.7 URLs

URLs are counted character-for-character like any other text; there is no special handling in the SMS PDU. Standard URL characters are all within GSM-7, so a plain URL does not force UCS-2. Shorteners save characters, not encoding. But see §6.2: **public shorteners are a deliverability disaster**, so the correct configuration is a branded short domain, which saves characters *and* protects reputation.

---

## 5. A scoring rubric

Designed to be implemented directly: hard gates first (binary, zero the score), then weighted dimensions out of 100.

### 5.1 Hard gates (any failure returns score 0 with a blocking reason)

| Gate | Test |
| --- | --- |
| G1 Brand identification | Brand name appears within the first 40 characters. |
| G2 Opt-out | Contains a valid opt-out instruction where required by campaign type. |
| G3 Single link, correct position | Exactly 0 or 1 URL; if present it is last and preceded by a CTA clause. |
| G4 No public shortener | Link domain is the brand's dedicated short domain, not bit.ly / tinyurl / t.co / goo.gl. |
| G5 Prohibited categories | No SHAFT or cannabis/CBD content (§6.2). |
| G6 Campaign-type match | Content matches the registered 10DLC campaign use case. Promotional content on a "customer care" campaign fails. |
| G7 Factual grounding | Every claim about the recipient (product, date, interval, price) traces to a field in the order-history payload. No invented facts. |
| G8 No fabricated urgency | Any deadline or scarcity claim maps to a real, supplied constraint. |
| G9 Encoding sanity | Message contains no smart quotes, em/en dashes, single-glyph ellipsis, or non-breaking spaces. |

G7 and G8 exist because an LLM with access to order history will hallucinate a plausible product name or a plausible deadline, and both are worse than a weak message. G9 is deterministic and should be enforced in code, not by the model.

### 5.2 Weighted dimensions (100 points)

| # | Dimension | Weight | 0 | 5 | 10 |
| --- | --- | --- | --- | --- | --- |
| D1 | **Opening 40 characters** | 20 | First 40 chars identify neither sender nor reason to care | Sender identified, reason generic | Sender identified and a specific, individual reason present within 40 chars |
| D2 | **Evidence of knowing this customer** | 20 | Could have been sent to the whole list | Category-level relevance ("your skincare order") | Names a specific past purchase, individual interval, or saved item |
| D3 | **Specificity and concreteness** | 15 | Superlatives and vague benefit | One concrete element | Concrete numbers/nouns throughout, zero superlatives |
| D4 | **Single unambiguous action** | 15 | No clear action, or two competing ones | One action, weakly phrased | One action, phrased as a trivially easy next step, immediately before the link |
| D5 | **Channel-native tone** | 15 | Broadcast register: caps, exclamation, ad-speak | Neutral but corporate | Reads as a competent human who knows the recipient; sentence case; no marketing register |
| D6 | **Credibility of urgency** | 10 | Fabricated or generic urgency | Real deadline, blandly stated | Urgency derived from the customer's own facts (depletion, individual interval), or no urgency where none is warranted |
| D7 | **Segment economy** | 10 | 3+ segments | 2 segments | 1 segment (or the minimum the content genuinely requires, justified) |

Score each dimension 0, 5, or 10, multiply by weight/10, sum.

**Bands.** 85+ ship. 70–84 revise. Below 70 rewrite. Any hard-gate failure blocks regardless of score.

**Deliberate design notes.**
- D1 + D2 = 40% of the score, because the preview problem (§2.1) and the relevance requirement (§2.3, §3.2) are the two things this channel actually punishes.
- D7 is only 10 points because a genuinely excellent two-segment message beats a mediocre one-segment message; it is a cost dimension, not a quality dimension. But hard gate G9 makes *accidental* multi-segmenting impossible.
- There is no "creativity" dimension. This is intentional (§1.1).

### 5.3 Worked example

**Brief.** Halcyon Coffee. Customer Nora Bennett. Order history: has bought the Kenyan Peaberry 500g four times; mean interval between orders 32 days; last order placed 29 days ago; predicted depletion in ~3 days; no active promotion; brand short domain `hlcy.co`; campaign type is marketing/promotional; replies are monitored.

---

**Draft A**

> 🔥🔥 HUGE SALE!!! Get 25% OFF EVERYTHING today only!!! Don't miss out on the BEST deals of the year — shop now before it's gone!!! https://bit.ly/3xKz9Qw Reply STOP to opt out

*Computed:* UCS-2 (forced by the two 🔥 and the em dash), 173 visible characters, **175 billable units, 3 segments.**

**Hard gates:** G1 **FAIL** (no brand name anywhere, let alone in the first 40 characters). G4 **FAIL** (bit.ly). G8 **FAIL** ("today only" is not grounded in any supplied constraint). G9 **FAIL** (em dash).

**Score: 0. Blocked.**

Had it not been blocked, the dimension scores would have been: D1 0, D2 0, D3 0, D4 5, D5 0, D6 0, D7 0 → **7.5/100**. Every failure is independent, which is what makes this draft instructive: it is not badly written in one way, it is the accumulation of every default an untuned model reaches for. Note also that the three-segment cost is invisible to the writer and would triple the campaign's carrier spend.

---

**Draft B**

> Nora, it's Halcyon Coffee. You're ~3 days from running out of the Kenyan Peaberry. Same grind, one tap: hlcy.co/r/8f2 Reply STOP to end

*Computed:* GSM-7, 135 visible characters, **136 billable units, 1 segment.**

**Hard gates:** all pass. Brand name at characters 7–21, inside the 40-character window. One link, last, preceded by a CTA. Branded domain. Opt-out present. Every fact (name, product, interval-derived depletion estimate, saved grind preference) traces to the order-history payload. The urgency is a real derived prediction, not a manufactured deadline. No non-GSM-7 characters.

**Dimensions:**

| Dim | Score | Weighted | Reasoning |
| --- | --- | --- | --- |
| D1 Opening 40 chars | 10 | 20 | "Nora, it's Halcyon Coffee. You're ~3 days" identifies sender and previews a specific, individual reason inside the truncation window |
| D2 Knows this customer | 10 | 20 | Names the actual SKU, uses the individual reorder interval, remembers the grind |
| D3 Specificity | 10 | 15 | "~3 days", "Kenyan Peaberry", "same grind". No superlatives, no adjectives at all |
| D4 Single action | 10 | 15 | Exactly one action, framed as "one tap", immediately before the link |
| D5 Channel-native tone | 10 | 15 | Sentence case, contraction, no exclamation, reads as the roaster who knows her |
| D6 Credible urgency | 10 | 10 | Depletion-based; verifiable by the reader against her own kitchen; unmanipulable |
| D7 Segment economy | 10 | 10 | 1 segment with 25 characters of headroom |

**Total: 100/100. Ship.**

---

**Cost delta.** Draft A costs 3 segments, Draft B costs 1. At 100,000 recipients and a blended ~$0.012 all-in per segment, that is roughly $3,600 versus $1,200 for the same send. The better copy is also two thirds cheaper, which is the argument for putting D7 and G9 in the rubric at all.

**A note on realism.** A 100/100 is uncommon; this draft is constructed to demonstrate each dimension. A more typical good draft lands 80–90, usually losing points on D1 (brand name pushed past character 40 by a long first name or a long product name) or D6 (a real but generic deadline).

### 5.4 What the rubric should also output

Scores alone are not useful to a marketer. The critique should return, per draft: the computed encoding, character count, billable units and segment count; the exact first-40-character truncation rendered as the reader would see it; each hard gate with pass/fail; each dimension with score and one sentence of reasoning; and a single highest-leverage suggested edit. Showing the 40-character truncation verbatim is the most persuasive single piece of feedback the tool can give.

---

## 6. Anti-patterns: two separate lists

These lists are different, they are judged by different entities, and confusing them is the most common error in SMS guidance. A message can sail past every carrier filter and still make a human despise the brand. A message can be warm, honest, and well-crafted and still never be delivered.

### 6.1 What makes an SMS feel like spam to a human

Judged by: a distracted person holding a phone, in under one second, against a threat model that includes fraud, in a thread list containing their family.

1. **No identifiable sender in the preview.** An unknown ten-digit number with no brand name is the fraud configuration. This is the single fastest way to be deleted.
2. **A bare link, or a link before the reason.** The syntax of smishing.
3. **ALL CAPS or Title Case.** Nobody the reader knows texts in caps. It marks the message as machine-originated before a single word is parsed.
4. **Exclamation marks, especially multiple.** Reads as a shout in a quiet room.
5. **Emoji as decoration rather than meaning.** Fire, siren, megaphone, and pointing-hand glyphs are the visual vocabulary of bulk promotion. Also incurs a real credibility cost (§3.6).
6. **Superlatives.** "Huge", "best ever", "unbeatable", "incredible". Hopkins was right in 1923 and the effect is stronger now.
7. **Manufactured urgency, especially recurring.** A "24-hour sale" that arrives every Thursday teaches the reader that the brand lies about small things. Triggers reactance and, per §3.3, brand-switching intent rather than mere non-response.
8. **Generic salutation to a personal channel.** "Hey everyone", "Dear valued customer", "our customers".
9. **Evidence you do not know them, in a channel where you demonstrably could.** Offering 20% off a product they bought last week is worse than sending nothing, because it proves the personalisation is theatre.
10. **Over-personalisation without a reason.** Referencing browsing behaviour or location without an obvious service justification crosses from "you remembered" to "you are watching me". The academic frequency-moderation finding (§2.3) applies here.
11. **Too many messages.** The largest reported single opt-out driver (~53%, `[VENDOR]`) and consistent with the academic literature. Note that this is not a property of any individual message, which is why a message-level rubric cannot catch it and campaign-level frequency capping must exist separately.
12. **Multiple offers in one message.** A broadcast form; nobody texts two propositions.
13. **Asking a question on a number that cannot receive replies.** A small betrayal of the channel's core affordance.
14. **Wordplay and puns.** Signals a marketing department, costs characters, and adds nothing (§1.1).
15. **Problem-agitation openers.** "Tired of X?" to a customer who has already bought the solution from you four times (§1.3).
16. **Sending at 11pm.** Not a copy issue, but it converts a good message into a hostile one.

### 6.2 What makes an SMS look like spam to a carrier filter

Judged by: machine-learning classifiers at carriers and aggregators, weighing sender reputation, traffic pattern, campaign registration, and content, with user 7726 spam reports feeding back into training. Carriers do not publish feature weights, and any source claiming exact filtering probabilities is not credible.

**Verified, hard, and worth enforcing in code:**

1. **Public URL shorteners.** This is real, documented, machine-level enforcement, not folklore. Twilio has a dedicated rejection code, [Error 30525 "Public URL shorteners not allowed"](https://www.twilio.com/docs/api/errors/30525), and states US carrier policies "strongly discourage their use due to frequent use by spammers, scammers and other bad actors" ([Twilio help](https://help.twilio.com/articles/1260804572090-How-can-I-send-shortened-URLs-links-in-my-messages-)). Bandwidth documents the technical rationale: carriers flag multi-hop redirects and "URL cycling" across shortener domains as a spam-evasion signature ([Bandwidth](https://www.bandwidth.com/blog/sending-text-messages-with-shortened-urls-might-not-get-deliveredheres-why/)). Fix: a dedicated branded short domain the business owns.
2. **SHAFT plus cannabis/CBD.** Sex, Hate, Alcohol, Firearms, Tobacco/vape, plus cannabis and CBD. Confirmed on [Twilio's messaging policy](https://www.twilio.com/en-us/legal/messaging-policy) and in dedicated error codes ([30456 alcohol](https://www.twilio.com/docs/api/errors/30456), [30457 firearms](https://www.twilio.com/docs/api/errors/30457)). Alcohol is permitted on some channels with age-gating; firearms are banned outright with no exception. Cannabis/CBD is prohibited regardless of state legality, because carriers will not adjudicate licence status ([Bandwidth T-Mobile 10DLC docs](https://www.bandwidth.com/support/en/articles/12823101-t-mobile-10dlc)).
3. **Content that does not match the registered 10DLC campaign use case.** A campaign registered as "customer care" sending promotional blasts is a documented filtering trigger and a carrier-audit finding, per [Telnyx's own compliance documentation](https://telnyx.com/resources/sms-compliance). This is arguably the most underrated item on the list.
4. **Missing sender identification.** Per the [CTIA Messaging Security Best Practices, October 2025](https://api.ctia.org/wp-content/uploads/2025/10/Messaging-Security-Best-Practices-_October-2025.pdf), unbranded and anonymous business messages are explicitly a spam indicator and filtering trigger, not merely a best-practice miss.
5. **Missing opt-out handling.** STOP and its recognised equivalents (STOPALL, UNSUBSCRIBE, OPTOUT, CANCEL, END, REVOKE, QUIT) must work, opt-out must be single-step, and plain-language opt-outs must also be honoured. HELP must return program name and customer-care contact. The opt-in confirmation message specifically must carry brand/program name, customer care contact, message frequency, "Msg&data rates may apply", and STOP instructions. ([Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy); [CTIA Short Code Monitoring Handbook v1.9](https://api.ctia.org/wp-content/uploads/2024/01/CTIA-Short-Code-Monitoring-Handbook-v1.9-FINAL.pdf))
6. **Snowshoeing.** Spreading identical or near-identical content across many numbers or campaigns to evade per-number rate limits. T-Mobile names it explicitly and fines it **$1,000** as "10DLC Long Code Messaging Program Evasion".
7. **Velocity from a low-trust sender.** The Campaign Registry assigns each brand a Trust Score of 0–100 at registration, and throughput in messages per second is gated directly by it. Unregistered or low-trust traffic is throttled hard, which is itself the anti-snowshoeing mechanism. ([Telnyx on trust scores and throughput](https://support.telnyx.com/en/articles/6325747-10dlc-messaging-throughput-trust-scores-campaign-use-cases-and-vetting), [Bandwidth campaign vetting](https://support.bandwidth.com/hc/en-us/articles/29839201098647-10DLC-campaign-vetting-tips-and-tricks))

**T-Mobile's fine schedule**, effective 1 Jan 2024, for Severity-0 violations, corroborated consistently across secondary sources citing the T-Mobile Code of Conduct (the primary PDF resisted text extraction during research, so treat exact wording as secondary):

| Tier | Fine | Trigger |
| --- | --- | --- |
| 1 | $2,000 | Phishing, smishing, social engineering |
| 2 | $1,000 | Illegal content |
| 3 | $500 | All other violations, including SHAFT |

Plus $10,000 for sending from a text-enabled number without verified ownership, $1,000 for program evasion/snowshoeing, and $10,000 for a third or subsequent content violation by the same content provider, with permanent network suspension reserved for repeat offenders. ([ACA International](https://www.acainternational.org/news/t-mobile-implements-fines-for-non-compliant-text-messages/), [Vonage support summary](https://api.support.vonage.com/hc/en-us/articles/11779934925084-10DLC-T-Mobile-Traffic-Violation-Fines-Jan-1st-2024))

**Real but soft, and probabilistic rather than deterministic:**

8. **ALL CAPS and excessive emoji.** Twilio's own Error 30007 "Message filtered" documentation lists ALL CAPS, excessive emoji, and promotional language among content patterns associated with filtered messages. This is a primary-industry statement, but it describes *features an ML classifier weighs*, not a hard rule. Twilio itself frames modern carrier filtering as machine learning that "constantly adapts" and says "no one can predict filtering". `[PRIMARY-INDUSTRY, soft]` Worth avoiding, but avoid it for the human reasons in §6.1, which are better evidenced.

**Largely folklore, and worth saying so plainly:**

9. **The "banned words list."** "Free", "cash", "winner", "urgent", "guaranteed", "act now", "click here". No CTIA document, no carrier document, and no CPaaS primary policy page states an actual trigger-word list. Twilio's error documentation mentions "free" and prize/loan/crypto/gambling terms as *examples of spam-correlated language*, framed as examples rather than a canonical list. Notably, [Telnyx's own SMS compliance resource](https://telnyx.com/resources/sms-compliance) omits the trigger-word framing entirely, centring instead on campaign mismatch and registration status. The word lists circulating in vendor blogs trace to other vendor blogs. `[FOLKLORE]`

**Do not build a word blocklist.** It will produce false confidence, mangle legitimate copy ("free shipping" is a real and valuable offer), and will not meaningfully change delivery. Spend the effort on items 1 through 7, which are documented and enforceable.

### 6.3 Why the distinction matters operationally

The two lists imply different mitigations. The human list is a **copy** problem, addressed by the model and graded by the rubric's D-dimensions. The carrier list is mostly an **infrastructure and configuration** problem: branded domain, correct campaign registration, trust score, frequency architecture, opt-out plumbing. Only items 4, 5, and 8 overlap with copy at all.

A product that conflates them will spend its energy having the LLM avoid the word "free" while leaving a bit.ly link in the template. That is exactly backwards.

---

## 7. Encoding this into a system prompt

### 7.1 Design principles

**1. Put the deterministic checks in code, not in the prompt.** Character counting, encoding detection, segment computation, smart-punctuation detection, shortener-domain detection, and link-position checks are all exactly computable. Models are bad at counting characters and will confidently claim a 187-character message is 154 characters. Compute it, then feed the computed values back to the model and let it revise. **The single biggest quality win available is a deterministic post-generation validator in a revision loop, not a better prompt.**

**2. Give the model facts, not permission to invent them.** Pass order history as structured data and instruct that every recipient-specific claim must cite a field. This is what hard gate G7 enforces. The failure mode of a creative model with a customer record is a plausible hallucinated product name, which is worse than a generic message because it is confidently wrong to someone who knows better.

**3. Encode the transfer table, not the canon.** Do not tell the model to "write like Ogilvy". It will produce pastiche and long headlines. Tell it the specific rules that survive the constraint, and tell it explicitly which famous rules to ignore. **Negative instructions about well-known principles are unusually valuable here**, because the model has absorbed the full canon and will otherwise apply the parts that do not transfer.

**4. Separate generation from critique.** A model grading its own fresh output is a poor critic. Run the rubric as a distinct call, with the computed metrics in context, and preferably without the generation reasoning. Have it produce numbers and one-line justifications, not prose.

**5. Make variants the default output.** The entire canon (Hopkins, Caples, Kennedy) rests on testing. Produce 3 drafts spanning distinct strategic approaches, not 3 rewordings of one approach.

**6. Give it a way to refuse.** Halbert's starving crowd, applied: the assistant should be able to return "this segment is wrong for this offer" or "this customer was messaged 2 days ago, recommend skipping". A tool that always produces a message will produce bad messages.

**7. Ban statistics in output.** Given §0 and §3.8, the model should never assert a percentage or benchmark in campaign copy or in its rationale.

### 7.2 First-draft system prompt

```
You are an SMS campaign copywriter for a direct-to-consumer brand. You have
access to individual customer order history. Your job is to write text messages
that produce revenue without damaging the brand's standing in a channel the
recipient regards as personal space.

## What this channel actually is

The message lands in the same thread list as messages from the recipient's
family and their doctor. It arrives from a ten-digit number they have not
saved. They will judge it in under a second, from a notification preview, with
a threat model that includes fraud.

Two consequences govern everything you write:

1. The first 40 characters are the entire headline. Assume a non-opener never
   sees past character 110. If the truncation at 40 characters does not say who
   is texting and give a specific reason to care, the message has failed.
2. Every message spends trust that cannot be recovered. Opting out is one word.
   A message that is not worth sending is worse than silence.

## Who you are writing to

Everyone on this list opted in and most have paid this brand money. They know
who the brand is and what it sells. They are, in Eugene Schwartz's terms,
Product Aware or Most Aware.

Therefore: never open with problem agitation. "Tired of running out?" insults a
customer who has solved that problem with you four times. Lead with the fact
and the offer.

## The rules that matter

SPECIFICITY. Generalities are worth nothing and cost the same characters as
facts. Never use: huge, best, amazing, incredible, unbeatable, don't miss out,
limited time, act now, great deals. Superlatives make a reader discount
everything else in the message. Use nouns, numbers, and dates. "$18 off" not
"save big". "3 days" not "soon". "the Kenyan Peaberry" not "your favourite".

EVIDENCE OF KNOWING THEM. Naming a specific past purchase or an individual
reorder interval is the point of this product. A first name is cosmetic; the
product name is evidence. If you must cut one, cut the first name.

ONE IDEA, ONE ACTION. One offer, one link, one thing to do. Multiple offers is
a broadcast form and nobody texts two propositions.

URGENCY MUST BE TRUE. Only state a deadline or a scarcity fact that is present
in the data you were given. Manufactured urgency is detected, resented, and
causes brand-switching, not just non-response. It is also an FTC deceptive
practice.

The strongest urgency available to you is not a deadline. It is depletion:
"you're about 3 days from running out". It is true, individual, and impossible
to read as a tactic. Reach for it first.

STATEMENTS, NOT QUESTIONS, by default. Questions outperform statements only for
calm, unhurried readers. SMS readers are neither. Never combine a question
opener with urgency; they cancel each other. Only ask a question if the number
accepts replies and you genuinely want one.

TONE. Sentence case. Contractions. No exclamation marks. No wordplay, no puns,
no cleverness. Write as a competent shop owner who knows this customer would
text: warm, brief, unembarrassed about selling, not pretending to be their
friend.

STRUCTURE. Brand name inside the first 40 characters, always. Link last, never
first, always preceded by a short clause telling them what tapping does. Opt-out
instruction where required.

EMOJI. Default to none. One is permitted only if the product is hedonic, the
brand voice is informal, and the emoji replaces words rather than decorating
them. Never in the first 40 characters. Emoji raise perceived warmth and lower
perceived competence and credibility, and they triple the technical cost of the
message.

CHARACTERS. Never use curly quotes, em dashes, en dashes, the single-character
ellipsis, or non-breaking spaces. Use straight quotes, hyphens, and three
periods. A single curly apostrophe silently converts a one-segment message into
a three-segment message and triples its cost. Write plain ASCII.

LENGTH. Target one segment: 160 characters of plain ASCII. Going to 161
characters costs a second segment and retroactively shrinks the first. Brevity
in this channel reads as consideration, not thinness.

## Grounding

Every claim you make about the recipient must come from a field in the order
history you were given. Never invent a product name, a date, an interval, a
price, or a preference. If the data does not support the message the brief asks
for, say so instead of writing it.

Never state a statistic, percentage, or industry benchmark.

## What NOT to import from the copywriting canon

You know the direct-response literature. Most of it was written for long copy
and the following do not transfer. Do not use them:

- Long headlines and long copy. Length is the budget here.
- "Tell your full story." The landing page does that; this message is a door.
- Curiosity-only openers. In a channel where fraud is a live concern,
  unresolved curiosity reads as bait.
- Seeds of curiosity and momentum devices. There is no momentum to build.
- Problem-agitation leads. Wrong awareness stage.
- The visual grammar of mail-order response advertising: caps, exclamation
  marks, arrows, dingbats. The intent (make it easy to respond) transfers; the
  aesthetic is now the aesthetic of spam.
- Aggressive follow-up cadence. Frequency is the leading cause of opt-out and
  each unwanted message costs a subscriber permanently.

## Output

Produce three drafts taking genuinely different strategic approaches, not three
rewordings of one. Label the approach for each in a few words, for example:
depletion timing, restock news, category cross-sell.

For each draft, output only the message text. Do not add commentary, do not
explain, do not add a preamble.

If the brief is wrong for this segment, or if this customer was messaged too
recently, or if the data does not support a specific message, say so plainly
and recommend not sending. That is a valid and valuable answer.
```

### 7.3 The critique prompt (separate call)

Run after the deterministic validator has computed encoding, character count, billable units, segment count, the 40-character truncation, and hard-gate results. Feed those in as facts. Then:

```
You are grading a draft SMS against a fixed rubric. You have been given
deterministic measurements; treat them as ground truth and do not recompute
them.

Hard gates have already been evaluated. If any failed, report the failures and
stop.

Otherwise score these seven dimensions at 0, 5, or 10 and multiply by the stated
weight:

D1 Opening 40 characters (weight 20)
D2 Evidence of knowing this customer (weight 20)
D3 Specificity and concreteness (weight 15)
D4 Single unambiguous action (weight 15)
D5 Channel-native tone (weight 15)
D6 Credibility of urgency (weight 10)
D7 Segment economy (weight 10)

Score conservatively. A 10 requires the dimension to be exemplary, not merely
acceptable. Most competent drafts score 5 on most dimensions.

Output: the seven scores with one sentence of reasoning each, the total out of
100, a band (85+ ship / 70-84 revise / under 70 rewrite), and exactly one
highest-leverage edit stated as a concrete rewrite of a specific clause.

Show the reader-visible 40-character truncation verbatim at the top of your
output.

Do not rewrite the whole message. Do not praise. Do not cite statistics.
```

### 7.4 Implementation notes

- **The revision loop is the product.** Generate → validate deterministically → if gates fail or score < 70, feed the failures back and regenerate once. Cap at two attempts and surface the best attempt with its critique rather than looping indefinitely.
- **Pass order history as structured JSON with explicit field names**, and instruct the model to reference fields. This makes G7 checkable: extract claims and match them against supplied field values.
- **Compute the 40-character truncation and show it in the UI.** It is the single most persuasive piece of feedback available and it teaches the marketer the constraint faster than any documentation.
- **Frequency capping belongs outside the model.** No message-level rubric can catch over-messaging, and it is the leading opt-out cause. Enforce a per-recipient cooldown in the sending layer.
- **Log which of the three variants was chosen and how it performed.** The entire canon this document draws on rests on measured response. A tool that generates variants and never closes the loop is a worse tool than Hopkins had in 1923.

---

## 8. Known gaps and what to verify before shipping

1. **Carrier pass-through fees (§4.6) are stale and contested.** Pull live from the provider console. `[UNVERIFIED]` for August 2026.
2. **The CTIA Messaging Principles and Best Practices PDF (May 2023) and the T-Mobile Code of Conduct PDF could not be text-extracted** during research. Content claims attributed to them here come from secondary sources that quote them. Read the primaries manually before making compliance-critical decisions. ([CTIA May 2023](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf))
3. **No study directly tests name-personalisation versus product-personalisation in SMS.** This is the assistant's most valuable first experiment and the rubric's D2 weighting depends on it. `[UNVERIFIED]`
4. **Optimal length (80–120 characters) has no academic support**, only vendor blogs citing each other. The one-segment constraint is a cost argument, not a proven response argument.
5. **Send-time-of-day guidance is vendor pattern-mining.** The rigorous timing evidence is about proximity to a purchase decision, not clock time. An order-history assistant is better placed to exploit individual reorder intervals than generic time-of-day windows, and that is where timing effort should go.
6. **Exact ML classifier features at carriers are unpublished and will remain so.** Treat any source claiming precise filtering probabilities as unreliable.
7. **The rubric weights are reasoned, not fitted.** They encode the argument of this document. Once there is outcome data, refit D1 through D7 against actual conversion and opt-out rather than against this document's priors.

---

## Source index

**Direct response canon**
Hopkins, *Scientific Advertising* (1923) [LoC](https://www.loc.gov/item/23009362/) · [Archive](https://archive.org/details/scientificadvert0000hopk) · [quotes](https://chiandhuang.medium.com/quotes-from-great-marketing-books-scientific-advertising-by-claude-hopkins-13c7cc1ef2cb) | Caples, *Tested Advertising Methods* [full text](https://archive.org/stream/pdfy-hHdovzQ-RvFny9Cy/Tested%20Advertising%20Methods_djvu.txt) | Schwartz, *Breakthrough Advertising* [awareness](https://betweenthelinescopy.com/blog/stages-of-awareness/) · [sophistication](https://www.motiveinmotion.com/market-sophistication/) | Halbert, *Boron Letters* [summary](https://www.dropdeadcopy.com/the-boron-letters/) · [notes](https://bagerbach.com/books/boron-letters/) | Ogilvy [quotes](https://www.goodreads.com/author/quotes/25181.David_Ogilvy) | Sugarman, *Adweek Copywriting Handbook* [full text](https://archive.org/stream/the-adweek-copywriting-handbook/The%20Adweek%20Copywriting%20handbook_djvu.txt) | Kennedy [10 rules](https://www.mybizniche.com/dan-kennedy-the-godfather-of-direct-response-marketing/) | Collier [attribution](https://www.activecampaign.com/blog/robert-collier-quotes)

**Academic**
[Luo et al., Mobile Targeting, Mgmt Sci 2014](https://pubsonline.informs.org/doi/10.1287/mnsc.2013.1836) · [Andrews et al., Crowdedness, Mktg Sci 2015](https://pubsonline.informs.org/doi/10.1287/mksc.2015.0905) · [Danaher et al., JMR 2015](https://journals.sagepub.com/doi/10.1509/jmr.13.0341) · [Fong et al., Geo-Conquesting, JMR 2015](https://journals.sagepub.com/doi/10.1509/jmr.14.0229) · [Sahni et al., Personalization, Mktg Sci 2018](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2725251) · [Personalisation (in)effectiveness](https://www.sciencedirect.com/science/article/pii/S2666954423000066) · [Friestad & Wright, PKM, JCR 1994](https://academic.oup.com/jcr/article-abstract/21/1/1/1853712) · [Stevens, Psych & Mktg 2026](https://onlinelibrary.wiley.com/doi/10.1002/mar.70232) · [Biraglia et al., Psych & Mktg 2021](https://onlinelibrary.wiley.com/doi/full/10.1002/mar.21489) · [Thomas et al., Price Precision, Mktg Sci 2010](https://pubsonline.informs.org/doi/10.1287/mksc.1090.0512) · [Janiszewski & Uy, Psych Sci 2008](https://journals.sagepub.com/doi/10.1111/j.1467-9280.2008.02057.x) · [Hagtvedt, question framing](https://www.sciencedaily.com/releases/2015/03/150309083024.htm) · [Shuqair, emoji warmth/competence, JCB 2024](https://onlinelibrary.wiley.com/doi/full/10.1002/cb.2310) · [Das et al., JBR 2019](https://ideas.repec.org/a/eee/jbrese/v96y2019icp147-156.html) · [Koch et al., emoji credibility 2023](https://journals.sagepub.com/doi/10.1177/20563051231194584) · [mobile marketing attitudes](https://www.sciencedirect.com/science/article/abs/pii/S0268401213000868) · [affective variables, mobile advertising](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5206691/) · SMS personalisation RCTs: [PROMPTS](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8320189/) · [telephone follow-up](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10848401/) · [OTIS](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7194505/) · [orthopaedic](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9091807/)

**Technical and regulatory**
[GSM 03.38](https://en.wikipedia.org/wiki/GSM_03.38) · [Twilio GSM-7](https://www.twilio.com/docs/glossary/what-is-gsm-7-character-encoding) · [Twilio UCS-2](https://www.twilio.com/docs/glossary/what-is-ucs-2-character-encoding) · [Twilio character limit](https://www.twilio.com/docs/glossary/what-sms-character-limit) · [Twilio concatenation](https://support.twilio.com/hc/en-us/articles/223181508-Does-Twilio-support-concatenated-SMS-messages-or-messages-over-160-characters) · [Twilio RCS char count](https://www.twilio.com/en-us/blog/developers/rcs-character-count) · [Telnyx Smart Encoding](https://developers.telnyx.com/docs/messaging/messages/smart-encoding/index) · [Twilio US pricing](https://www.twilio.com/en-us/sms/pricing/us) · [Twilio messaging policy](https://www.twilio.com/en-us/legal/messaging-policy) · [Twilio error 30525](https://www.twilio.com/docs/api/errors/30525) · [Bandwidth on shorteners](https://www.bandwidth.com/blog/sending-text-messages-with-shortened-urls-might-not-get-deliveredheres-why/) · [Telnyx SMS compliance](https://telnyx.com/resources/sms-compliance) · [CTIA Messaging Principles May 2023](https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf) · [CTIA Messaging Security Oct 2025](https://api.ctia.org/wp-content/uploads/2025/10/Messaging-Security-Best-Practices-_October-2025.pdf) · [CTIA Short Code Handbook v1.9](https://api.ctia.org/wp-content/uploads/2024/01/CTIA-Short-Code-Monitoring-Handbook-v1.9-FINAL.pdf) · [T-Mobile fines](https://www.acainternational.org/news/t-mobile-implements-fines-for-non-compliant-text-messages/) · [10DLC trust scores](https://support.telnyx.com/en/articles/6325747-10dlc-messaging-throughput-trust-scores-campaign-use-cases-and-vetting) · [FTC Dark Patterns report](https://www.ftc.gov/system/files/ftc_gov/pdf/P214800+Dark+Patterns+Report+9.14.2022+-+FINAL.pdf)

**Vendor (treat as self-serving)**
[Attentive 25B-message analysis](https://www.attentive.com/blog/high-performing-sms-campaign-insights) · [Klaviyo benchmarks](https://www.klaviyo.com/products/sms-marketing/benchmarks) · [Klaviyo SMS basics](https://help.klaviyo.com/hc/en-us/articles/13288640663579) · [Omnisend benchmarks](https://www.omnisend.com/blog/sms-marketing-benchmarks/) · [Validity, State of SMS 2023](https://www.validity.com/wp-content/uploads/2023/02/The-State-of-SMS-Marketing-in-2023.pdf) · [Rally Corp on the 98% myth](https://www.rallycorp.com/blog/90-sms-open-rates-are-a-myth) · [notification limits](https://gravitec.net/blog/push-notification-character-limit-for-ios-android-and-web/)
