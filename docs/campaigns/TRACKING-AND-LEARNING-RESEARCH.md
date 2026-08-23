# Tracking and learning

What this system can measure, what it cannot, and what can honestly be learned
from 926 contacts. Researched 2026-08-23.

Companion to `SMS-COPY-RESEARCH.md` (copy craft and compliance) and
`SEGMENTATION-METHODOLOGY.md` (how segments are computed). This document is
authoritative on measurement.

Confidence labels are used throughout and are not decoration. `[VERIFIED]` was
fetched from a primary or near-primary source. `[COMPUTED]` is arithmetic done
here from a stated formula. `[UNVERIFIED]` is plausible and widely repeated but
unconfirmed. `[JUDGEMENT]` is reasoning, not a sourced fact.

## The decision, agreed with the owner 2026-08-23

No open rates. Ever. The metric set is:

| Metric | What it is |
|---|---|
| Delivered | Carrier confirmed handset delivery |
| Not delivered | Failed, filtered or unconfirmed, reported separately by cause |
| Clicks | De-botted unique clicks on a per-recipient link |
| Replies | Inbound, excluding STOP |
| Opt-outs | The guardrail metric |
| Attributed revenue | Orders inside the attribution window, split by evidence tier |

Everything on the dashboard must serve one of those. Anything that does not is
noise dressed as insight.

## Rules to implement literally

### Measurement

1. **Never build, display or report an "SMS open rate."** There is no open
   signal in SMS. A field called that would be delivery rate wearing a costume
   or an invented constant. The column is `delivered_rate` and the label is
   "Delivered (carrier-confirmed)".
2. Persist every Telnyx `message.sent` and `message.finalized` webhook in full,
   including `to[].status`, `to[].carrier`, `to[].line_type` and `errors[]`.
   Keep the raw JSON alongside the parsed columns.
3. **Never collapse these three:** `delivered` (carrier asserted handset
   delivery), `sent` (handed to the carrier, no confirmation), and
   `delivery_unconfirmed` (no receipt came back). Rolling the last two into
   "delivered" is the single most common way this number gets faked.
4. `delivery_rate = delivered / (delivered + sent + delivery_unconfirmed +
   delivery_failed + sending_failed + expired)`. Report `dlr_coverage =
   (delivered + delivery_failed) / total_sent` separately as a data-quality
   metric. Below about 90% coverage on a carrier, that carrier's delivery
   numbers are not trustworthy. `[JUDGEMENT on the threshold]`
5. Allow **72 hours** for a terminal receipt before calling a message
   unconfirmed. Do not finalise campaign stats an hour after the send.
   `[VERIFIED]`
6. Primary engagement metric: **de-botted unique click rate on delivered
   messages.** Primary outcome metric: **attributed revenue per delivered
   message.** Reply rate and opt-out rate are guardrails. Nothing else belongs
   on the main dashboard.

### Click tracking

7. A **brand-owned short domain** used for nothing else. Never bit.ly, tinyurl,
   t.co, rebrand.ly, is.gd or ow.ly. Telnyx's forbidden-use-cases page
   (2026-07-23) names public shorteners as a major source of blocking, and
   Bandwidth reported AT&T blocking them outright. `[VERIFIED; the AT&T claim
   is from 2020 and UNVERIFIED for 2026]`
8. **Exactly one redirect.** Token URL, 302, final destination. T-Mobile's Code
   of Conduct treats multi-redirect URLs as a filtering signal, because they
   hide the real destination. `[VERIFIED]`
   This is where teams break it by accident: a `www` to apex redirect, an http
   to https upgrade, a Shopify trailing-slash redirect or a consent interstitial
   each add a hop. The redirect target must already be the final canonical
   HTTPS URL. Add a build-time check asserting every destination returns 200,
   not 3xx.
9. HTTPS with a valid certificate, resolving to our own infrastructure, with a
   real page at the domain root. Not a 404, not a parked page.
10. **Every link is per-recipient unique.** Eight to ten URL-safe base62
    characters from a CSPRNG. No PII, no sequential ids, no encoded phone
    number. A sequential token space lets anyone walk the entire campaign.
11. **No cookies.** The token is the identity. Third-party pixels are
    unreliable in Safari, which is most of an iPhone audience, and add privacy
    exposure for no gain.
12. **Bot filtering is mandatory, not optional.** Flag a click as suspected bot
    if any of: the user agent matches a known crawler, preview or scanner
    (GoogleBot, GoogleMessages, python-requests, Barracuda Sentinel,
    facebookexternalhit, curl, wget, headless browsers); it arrives under three
    seconds after the delivery receipt; or it is the only click on that token
    with no subsequent page view. Store `is_suspected_bot` and `bot_reason[]`
    and **never delete the row.** All headline numbers use the de-botted count.
    `[VERIFIED for the user-agent approach via Braze; thresholds are JUDGEMENT]`
13. **An unfiltered SMS click rate is not a measurement, it is a census of what
    phones people own.** iOS and Android fetch every link to draw the preview
    thumbnail, which is a real HTTP GET. Any click numbers recorded before
    filtering must be labelled unreliable, not silently restated. `[VERIFIED]`
14. Attribution window: **5 days, last touch**, matching Klaviyo's default for
    accounts created after 2024-10-09. Store the window on the campaign row so
    history does not silently change when the setting does. `[VERIFIED]`
    Show the 24-hour figure as a secondary column so the owner can see how much
    of the revenue is same-day.
15. Record an `attribution_tier` on every attributed order: `direct_token` (the
    order carries the unique code), `click_window` (clicked, then ordered
    inside the window), `exposure_window` (delivered, then ordered, no click).
    **Never sum them into one "SMS revenue" number without the split visible.**

### What counts as Direct evidence

The bar is: no probabilistic step between the order and the person.

16. **A unique link click does NOT qualify.** It fails twice over. The click may
    not be human, and de-botting is a classifier, so direct evidence would be
    resting on a heuristic. And a click is not a purchase; binding it to an
    order still needs a session join or a time window. `[JUDGEMENT]`
17. **A unique single-use coupon DOES qualify**, if it is generated server-side
    for one recipient, bound to `contact_id` at send time, use-capped, and
    stored on the order. Then every arrow in the chain is a database join:

    ```
    code C was generated for contact X and sent only in message M
    order O redeemed code C
    therefore order O came from the holder of message M, addressed to X
    ```

    The one leak is code sharing. Mitigate with single-use enforcement, and
    flag when the redeeming customer does not match X. Still count it, but
    surface the mismatch rate as data quality. `[JUDGEMENT]`
18. Also qualifying: a token click landing in an authenticated session whose
    customer id matches the token's contact. Identity confirmed at both ends.
19. **Build the coupon before the bandit.** It fills the empty direct-evidence
    allowlist, makes the outcome metric trustworthy, and gives the copy a
    legitimate reason to be specific. It is the highest-value item here.
    Budget 20 to 24 GSM-7 characters for the token and domain, and compute
    `segment_count` on the rendered message before sending.

### Privacy

20. A per-recipient token identifies a person from a URL. Anyone who gets the
    URL, by forward, screenshot, browser history or referrer, gets the
    identifier. Opaque random only, and set `Referrer-Policy: no-referrer` on
    the redirect.
21. Store IP as a salted hash, never raw. Rotate the salt. Enforce token expiry.
22. A deletion request must cascade to tokens and clicks, not just the contact
    row. Build the cascade now, not after the first request.

## What can honestly be learned from 926 contacts

Standard two-proportion sample size, 80% power, alpha 0.05 two-sided.
`n = 7.849 * [p1(1-p1) + p2(1-p2)] / (p2-p1)^2`

**What we can actually detect:** `[COMPUTED]`

| Audience | Split | Baseline | Smallest detectable | Lift required |
|---|---|---|---|---|
| Full list, 926 | 463 / 463 | 10% clicks | 16.2% | +62% |
| Full list, 926 | 463 / 463 | 2% conversion | 5.5% | +175% |
| Full list, 926 | 463 / 463 | 0.5% opt-out | 3.0% | +500% |
| Segment of 200 | 100 / 100 | 10% clicks | 24% | +140% |
| Segment of 40 | 20 / 20 | 10% clicks | 46% | +360% |

Read the last row twice. On a 40-person segment nothing short of quadrupling
the click rate is detectable. No copy change does that. There is no A/B test on
a 40-person segment, only a coin flip with a narrative attached.

At n=20 and an observed 10%, the 95% interval is roughly 0% to 23%. The
interval is wider than the plausible range of true values, so the measurement
contains no information. The normal approximation is also unreliable at that
size, so the real situation is worse than the table says, not better.

**For calibration:** Klaviyo will not call a test significant below 50
recipients per variation, and explicitly labels a result "not statistically
significant" once 1,800 people per variation have failed to separate. That is
3,600 for a two-arm test. We have 926 contacts. `[VERIFIED]`

### So do this instead

23. **Do not gate decisions on per-campaign significance.** No winner badges on
    single campaigns. Never show the drafting model single-campaign win or loss
    as if it were signal; it will pattern-match on noise within three cycles.
24. **A permanent 10% holdout** that receives no marketing SMS, refreshed no
    more often than every six months. Compare 90-day revenue per contact
    against the treated group. At 92 contacts it is noisy and will take
    quarters. It is still the only number that answers "is this programme worth
    running at all." Say the uncertainty out loud in the UI. `[VERIFIED as a
    method; the sizing is JUDGEMENT]`
25. **Feature-level pooled learning, forever.** Not "did A beat B in campaign
    7," but "across every message we have ever sent, do specific dollar amounts
    outperform percentages." That accumulates power instead of resetting each
    send. Fit with partial pooling so small-n features shrink toward the mean
    rather than producing spurious extremes.
26. **Promotion to house style requires all four:** posterior probability of a
    positive effect at or above 0.95; at least 1,500 cumulative delivered
    messages at each level of the feature; observed across at least five
    distinct campaigns; direction unchanged in the two most recent. Otherwise
    it stays `exploring`. `[JUDGEMENT, deliberately conservative]`
27. **Reply content, not reply rate.** Forty replies is useless as a rate and
    enormously informative as text. One customer asking "what is the difference
    between this and the one I bought last time" is worth more than a two-point
    click wobble.
28. **Big swings only.** If the smallest detectable effect is +62%, only test
    things that could plausibly move that far: offer versus no offer, link
    versus reply-to-buy. Never "Hey" versus "Hi." Those are unmeasurable here
    and testing them wastes the audience.
29. **Opt-out is an alarm, not a test.** At 463 per arm a rise from 0.5% to
    anything under 3% is undetectable. Use an absolute circuit breaker instead:
    auto-pause a variant above 1.5% absolute, or 3x the trailing six-campaign
    median, whichever is lower, with a floor of three opt-outs to trigger.
30. **No peeking-based stopping.** Repeated significance testing inflates false
    positives badly; peeking ten times turns a nominal 1% threshold into roughly
    5%. If sequential monitoring is used at all, use an always-valid or mSPRT
    method. Being Bayesian is not an exemption. `[VERIFIED, Evan Miller 2010;
    Johari et al. KDD 2017]`

### Bandits

31. A bandit does **not** rescue a small sample. In low-traffic regimes the
    variance stays wide, exploration never ends, and it performs no better than
    a uniform split while starving the losing arm of the data needed to compare.
    `[VERIFIED]`
32. **Legitimate for evergreen flows only** — post-purchase, win-back,
    replenishment — which accumulate sends continuously. Never for one-shot
    campaigns, never for a segment under about 500, never on revenue as the
    reward.
33. **Be honest about the timeline.** At roughly 60 orders a month entering
    post-purchase, two arms means about 30 sends per arm per month. Reaching
    the 683 per arm needed to separate 10% from 15% takes **around 23 months**.
    Even at 100 orders a month it is 14. Anyone promising optimised copy this
    quarter is selling something. `[COMPUTED]`
34. If built: at most three arms, one always the reigning champion; weekly
    batched updates, never per-send; a permanent 15% exploration floor per arm;
    a prior centred on the historical programme rate weighted to about 50
    observations; reward is de-botted clicks.

## The loop, if we build one

Karpathy's AutoResearch ratchet — propose, measure, accept or revert, with an
append-only results log and one pre-declared metric — is sound in structure.
What does not transfer is the economics: he ran 700 experiments in two days
with a low-noise metric and no cost to a failed run. Here, 700 campaigns is
seven to fifteen years, the metric is binomial at n=40, and a failed experiment
costs opt-outs, which is permanently destroyed audience.

The more useful reference is **GEPA** (Agrawal et al., arXiv:2507.19457, ICLR
2026), which reflects on execution traces in natural language and keeps a
Pareto frontier of diverse candidates rather than one champion. It reports
beating GRPO by up to 20% using **35x fewer rollouts**. Sample efficiency and a
diverse candidate set are exactly what a 926-contact list needs.

### What the model is shown

The compliance rules verbatim. The brand voice section of the playbook. The
feature-effect table with credible intervals, cumulative n, and a status of
`house_style`, `avoid`, `exploring` or `insufficient_data` — and **anything
marked `insufficient_data` must appear with that label and no point estimate.**
The last 20 messages actually sent, so it does not repeat itself. Clustered
reply themes with PII redacted. Any message that tripped the opt-out breaker,
in full. The reigning champion, labelled as the control.

It is **not** shown raw per-campaign win/loss.

### Guardrails

| Layer | Mechanism | Blocking |
|---|---|---|
| 1 | Deterministic gate: length, encoding, lexicon, domain, consent, quiet hours, frequency | Hard block |
| 2 | Prohibited-claims lexicon: therapeutic, dosing, human-use | Hard block |
| 3 | Adversarial reviewer, separate prompt and model, asked what is wrong with this | Flags |
| 4 | Champion always present in the arm set | Hard block |
| 5 | Human approval queue | Yes |
| 6 | Post-send opt-out circuit breaker | Auto-pause |
| 7 | Monthly drift audit: 20 sampled messages, human-scored, logged as a series | Detective |

The known failure mode of a generative optimisation loop is discovering a
locally-rewarded style and amplifying it until the brand is unrecognisable:
escalating urgency, escalating discounts, escalating claims, because those do
raise short-term clicks. Three counters. Cap discount value at a business rule
the loop cannot exceed. Put opt-out rate in the objective as a penalty, not in
a separate report someone reads later. Keep ten frozen human-written exemplars
in the prompt as style anchors and never let generated output replace them.

**Log the counterfactual.** Store every variant proposed, including rejected
ones, with the reason. Without it you cannot tell whether the loop is improving
or whether the human is doing all the work.

## Segmentation UX: what the good products do

| Question | Consensus across Klaviyo, Postscript, Attentive, Braze |
|---|---|
| What does the operator see | A named segment, a live member count, plain-language rules, a browsable member list |
| What can they change | The rules. Not the membership. |
| Auto versus hand-built | Distinguished by origin label and edit affordance, not a separate menu |
| Why is this person here | **Nobody does this well.** An open gap. |
| Add or remove one person | **You cannot, by design, and that is correct** |

Patterns worth copying. Klaviyo's AI segment builder drafts the **rules** and
shows them for review and editing before publishing, so the operator always
ends up with a definition they can read. Attentive shows a **live member count
while you build**, which is the fastest way to stop someone shipping a segment
matching three people. Braze shows, on every segment, **which campaigns and
flows currently target it** — the answer to "if I edit this, what breaks" — and
**publishes its own uncertainty**, telling the operator the number is sampled
and giving the interval.

**The override pattern that works.** Since membership must stay rule-driven,
give the operator a profile-property escape hatch baked into every definition:

```
Segment "Lapsed 90d" :=
     days_since_last_order >= 90
 AND manual_exclude_lapsed_90d IS NOT SET
 OR  manual_include_lapsed_90d IS SET
```

"Remove from segment" then sets a property rather than mutating membership. The
automation never breaks, the override survives recomputation, and it is
auditable. Surface it as "Manually excluded by Lubosi on 12 Aug, reason:
customer requested," never as an invisible flag.

**The thing nobody else has**, and which is cheap here because the list is small
and the operator is not technical: a per-person rule trace.

```
Lapsed 90d - QUALIFIES
  yes  days_since_last_order >= 90   127 days, last order 2026-04-18
  yes  total_orders >= 1             3 orders
  yes  sms_consent                   opted in 2025-11-02 via checkout
  yes  manual_exclude not set
  exits if: an order is placed, or consent is revoked
```

That eliminates the entire class of "why did she get that text" conversation.

## Open questions, not to be quietly assumed away

1. Telnyx messaging error codes. Both doc URLs 404'd. Pull the live list before
   building the error taxonomy; specifically the codes separating carrier spam
   filtering from an invalid number. `[UNVERIFIED]`
2. AT&T's current position on public shorteners. The "blocks entirely" claim is
   from 2020. Direction is safe, the specific claim is stale. `[UNVERIFIED]`
3. Current T-Mobile Code of Conduct text. The PDF would not extract; section
   references here come from aggregator summaries of the 2020-09-01 version.
4. Origin of the 98% open-rate figure. No traceable primary study. Folklore.
5. Telnyx RCS availability for this account, which decides whether real read
   receipts are ever possible. `[UNVERIFIED]`
6. Whether a 92-contact holdout is worth the revenue forgone. Statistically
   weak, strategically the only incrementality signal available. A business
   call, not a technical one.
7. **Peptide messaging against Telnyx's prohibited categories.** Their
   forbidden-use-cases page dated 2026-07-23 lists unregulated supplements and
   substances not legally approved for sale. An unconstrained copy loop drifts
   toward exactly the claims that trigger it. Owner and counsel, before the
   loop ships. Highest severity item in this document.

## Sources

Telnyx receiving-webhooks and message detail records; Telnyx forbidden
messaging use cases (2026-07-23); Telnyx URL shortening. Bandwidth DLR FAQs and
its 2020-12-02 analysis of the T-Mobile Code of Conduct. Twilio link shortening
(click versus preview events, 90-day links). Klaviyo: SMS metrics, bot clicks,
message conversion tracking, statistical significance, profiles, segment
updates, AI segment definition, predictive analytics thresholds. Braze: SMS and
RCS bot click filtering, segment data, segment extensions. Postscript: view
subscribers in a segment, create a segment, attribution windows. Attentive:
dynamic segments, attribution model. Evan Miller, How Not To Run an A/B Test
(2010). Johari, Pekelis and Walsh, Always Valid Inference (2015) and Peeking at
A/B Tests (KDD 2017). Agrawal et al., GEPA (arXiv:2507.19457). Karpathy,
AutoResearch (2026-03-07).
