# PROFILES-PLAN.md — Client Profiles + Context-Aware Check-Ins

## PROJECT OVERVIEW

A durable per-contact profile, built mostly from order data and only partly from an LLM, that any campaign can read; and a 21-day check-in that varies per person instead of sending one identical sentence to everyone. Success is: every contact with an order has a queryable profile, nobody receives check-in wording they have already received, and the LLM is only spent where there is genuinely something to summarise.

## THE MEASURED FACT THAT RESHAPES THE BRIEF

809 contacts have any SMS at all. **559 of them (69%) have never sent a single inbound message.** 102 have said exactly one thing. Only 148 have said two or more, and only 59 have said five or more. Total corpus is 3,547 rows, both directions, across 994 contacts.

Order data is the opposite: 843 buyers, ~1,500-2,000 orders with line items, SKUs, dates and statuses. 289 people have two or more orders, which is enough to measure a reorder interval.

Two conclusions, stated plainly:

1. **A per-contact LLM conversation summary does not earn its cost for ~82% of contacts.** For someone with zero inbound messages the model would be summarising our own outbound template sends. It would produce a paraphrase of facts a SQL query already returns, and then that paraphrase would be trusted downstream as if it were evidence. That is worse than not having it. **Threshold: build a narrative only when `inbound_message_count >= 3`.** At 1-2 inbounds the content is almost always "yes", "thanks", "how much", which the deterministic fields already capture as `has_replied_ever` and `engagement_tier`.

2. **A per-person LLM-written check-in for someone with no conversation history gains nothing.** Its only inputs would be first name, last product, order count and days elapsed — all of which are already merge fields in the existing template. The model would restate the template in different words, at the cost of one call, one compliance risk, and one message a human has to read. **Recommendation: do not generate copy for those people. Rotate them through a bank of pre-approved, hand-written variants selected from their profile.** That fixes "generic" and "repeated" for 100% of contacts at zero marginal cost, and it ships before any LLM work.

So the plan is: **deterministic profile for everyone first; generated copy only for the minority with material to work with.** The owner's instinct — "we've already got that context behind every single person" — is right about *orders*. It is not true about *conversation*, and building as if it were would produce an expensive layer of confident-sounding fiction.

## WHAT THE CODEBASE ALREADY GIVES US

- `sms_customer_profiles` **already exists** (`intelligence.js:75`): `contact_phone`, `inferred_interests`, `order_signals`, `restock_interests`, `campaign_recommendations`, `sentiment`, `raw_summary`, `last_analysed`. Written by `analyseConversation()` as a full-rewrite LLM call over the last 50 messages, on demand. This is a weak first version of the thing being asked for. **Extend it; do not create a second profile table.** Two tables answering "who is this person" is the same fault as two components answering one question.
- `lib/campaigns/check-in.js` — the check-in is a **weekly batch of ~40 people** going through the ordinary campaign approval, not a per-order timer. This is the single most important fact for feasibility: 40 is not 376.
- `lib/campaigns/render-recipients.js:80` — per-person `validateCopy()` already runs and already records per-person outcomes. The generation seam is a substitution inside this loop.
- `sms_scheduled` + `processScheduledQueue()` on a 5-minute `setInterval` (`server.js:346`) — an existing background heartbeat. Not a job queue, but enough.
- `proposal-writer.js:276 similarity()` — Jaccard overlap, already used to reject near-duplicate copy. This is the no-repeat mechanism.
- `gatherFacts()` (`personalise.js:359`) already reads every order row per phone and then discards all but the latest.
- `privateCompletion()` — the privacy boundary. Thin, single fetch, 10s timeout, no retry, no rate limit, no budget.

## PROFILE SHAPE

### Deterministic (computed, never generated) — for all 843

From `sms_orders`: `order_count`, `first_order_at`, `last_order_at`, `days_since_last_order`, `total_spend_cents`, `avg_order_value_cents`, `distinct_skus[]`, `top_skus[]` (sku + count), `last_order_skus[]`, `last_product_name`, `last_product_sku`, `reorder_interval_days_median` (null below 2 qualifying orders), `reorder_due_at`, `cadence_confidence` (`none` | `weak` | `measured`), `has_only_failed_or_cancelled` (252 cancelled + 83 failed rows make this a real guard).

From `sms_messages`: `inbound_message_count`, `outbound_message_count`, `last_inbound_at`, `last_outbound_at`, `has_replied_ever`, `engagement_tier` (`never_replied` | `replied_once` | `conversational`).

From campaign history: `campaigns_received_count`, `last_campaign_at`, `last_checkin_at`, `last_checkin_variant`.

Not stored: name, email, opt-out state. Those live in `sms_contacts` and the `sms_sent_log` sentinel and must have one home.

### Narrative (LLM, `inbound_message_count >= 3` only) — ~150 contacts

`narrative_summary` (≤400 chars, prose), `topics[]` (**constrained to catalogue product names, not free text**), `tone` (fixed enum), `open_question` (something they asked that was never answered), `narrative_confidence`.

**The rule that keeps this from being waste: the narrative may contain nothing a query could return.** No order counts, no dates, no spend, no product list. It exists for the three things only prose captures — what they asked, what was left hanging, how they talk.

## STORAGE

Extend `sms_customer_profiles`. Add the deterministic columns above plus: `profile_version` (int, bumped when builder logic changes), `orders_fingerprint` (`count:max(created_at):max(id)`), `messages_fingerprint` (`inbound_count:max(created_at)`), `deterministic_built_at`, `narrative_built_at`, `narrative_source_fingerprint`.

Indexes: `contact_phone` (existing PK), `reorder_due_at`, `engagement_tier`, `last_checkin_at`, partial index on `inbound_message_count >= 3`.

**Sole-writer rule.** The new profile service owns the deterministic columns. `analyseConversation()` keeps writing only its legacy columns until Phase 3 folds it in. No column is ever written by two code paths.

**Staleness.** A refresh is due when a fingerprint differs or `profile_version` is behind. Deterministic refresh costs two indexed reads and no LLM, so it can run freely — on the WooCommerce order webhook and on inbound SMS, plus a nightly sweep for drift. Narrative refresh costs one LLM call and fires only when the message fingerprint changed **and** `inbound_message_count >= 3` **and** the last narrative is older than `PROFILE_NARRATIVE_COOLDOWN_DAYS` (default 7). That cooldown is the cost ceiling.

**Backfill.** One idempotent admin script under `/admin`, paged at 1000 (the `.range()` pattern already in `check-in.js:184` — unpaged reads silently cap at 1000 in this codebase and have caused a production outage before). Deterministic backfill for 843 contacts is pure SQL-plus-JS, runs in seconds, and is safely re-runnable. Narrative backfill is a separate, budgeted, resumable pass over ~150 contacts.

## CHECK-IN: HOW IT PLUGS IN

Today the weekly sweep picks one of two constants (`TEMPLATE`, `TEMPLATE_NO_PRODUCT`) and every one of ~40 people gets the identical sentence.

**New selection step, before any LLM is involved:** a bank of 5-6 hand-written, pre-approved variants, each already passing `validateCopy` at worst-case merge lengths. The profile picks one: first-time buyer vs repeat, product-with-approved-code vs without, replied-before vs never, and — critically — **not the variant recorded in `last_checkin_variant`**.

**Generation, where it applies,** substitutes into the same loop at `render-recipients.js:80`. Same per-person validation, same options, same output shape. Nothing downstream changes. `rendered_message` is still frozen at approval and the delivery worker still refuses to construct text.

## DON'T-REPEAT-PREVIOUS-WORDING

Three layers, cheapest first:

1. `last_checkin_variant` on the profile — the selector cannot reissue it.
2. Similarity gate: read outbound `sms_messages` to this phone from the last 180 days, run `similarity()` from `proposal-writer.js:276` against the candidate, reject above 0.6. Zero new storage, existing function, works for both template variants and generated copy.
3. For generated copy only: on rejection, one retry at higher temperature, then fall through to the next unused template variant.

## THE ASYNC / APPROVAL ANSWER

**Generation moves to draft time, not approval time.** This is the structural move and it solves three problems at once.

The weekly sweep creates the draft campaign and inserts recipients. A background pass — a new tick alongside `processScheduledQueue()` on the same 5-minute heartbeat — claims pending recipient rows in bounded batches and writes `generated_message` + `copy_source` onto them. When the human opens the campaign for review, the text is already there. `POST /:id/approve` stays exactly as fast as it is today, because it freezes text that already exists rather than producing it.

Claiming must be a status transition (`UPDATE ... WHERE status='pending' RETURNING`), not a read-then-write. `server.js` uses in-process `setInterval`, so today there is one worker, but a second Railway replica would double-generate silently.

**Hard cap: generated copy is only permitted when the eligible count is ≤ `CHECKIN_GENERATED_MAX_RECIPIENTS` (default 25).** Above that, templates. Per-person generation for a 376-person campaign is not on the roadmap and should not be built until there is a real job queue, and probably not then — see Risks.

## HUMAN REVIEW OF N DIFFERENT MESSAGES

Because generation happens at draft time, the reviewer reads finished text. The review screen groups by `copy_source`:

- "18 people, variant B" — one message, read once, count shown.
- "9 people, variant D" — same.
- "6 generated" — read individually. That is the realistic weekly volume.

Rejecting one generated message drops that person to the template. It does not invalidate the campaign or require re-approval of the rest. Editing one writes to that recipient row only. Approval continues to freeze `rendered_message` for everybody, unchanged.

## PII DECISION — RECOMMENDATION

**Recommend: allow per-person conversation and order context to reach the model, through the tokeniser, in new modules only.**

Precedent already exists — `intelligence.js`, `converse.js` and the shipped flow all send real customer data through `privateCompletion` with explicit `sensitiveValues`. What must not happen is reusing `copy-writer.js`, whose entire stated design is "a tokeniser that never has to fire". Build `lib/profiles/narrative-writer.js` and `lib/campaigns/checkin-writer.js` as separate modules with their own input contracts. `copy-writer.js` keeps its no-PII invariant intact for template drafting.

Two additional constraints, both enforced by assertion on write:

- The **stored narrative** must contain no identifier shapes. It is persisted and later re-fed into prompts, so a leaked identifier compounds.
- The narrative must contain **no customer-stated health outcome**. Someone saying a product helped them is exactly the sentence that must never be echoed back, and `copy-rules.js` bans it in outbound copy anyway.

## RATE LIMITING, RETRY, BUDGET

New `lib/llm-runner.js` wrapping `privateCompletion`. Do not modify `privateCompletion` — it is the privacy boundary and should stay thin.

Concurrency 2. Two attempts max, backoff 500ms then 1500ms, **retrying only on 429 / 5xx / abort** — never on a validation failure, which is deterministic and would just burn the budget twice. Per-run call cap and per-day call cap from env. Every run writes one audit row with call count, token totals and failure counts. One kill-switch flag.

Cost is not the constraint here. ~150 narrative backfills at ~1.5k input tokens each, plus ~10 calls a week, is single-digit dollars on Haiku. The real constraints are review bandwidth and voice consistency.

## FAILURE BEHAVIOUR

**Template fallback, not exclusion — and this differs deliberately from the existing seam.**

`render-recipients.js` excludes on failure because there is no alternative: a message with a missing merge field has no safe version. Here there is one. A generated message is an *enhancement over an already-approved template*, so timeout, model error, similarity rejection or `validateCopy` failure all fall back to the selected template variant. Excluding someone from a check-in they are genuinely due, because a model was slow, would be a worse outcome than sending them the good template.

Every recipient row records `copy_source` (`generated` | `template_fallback` | `template`) and a fallback reason. Failure counts surface on the review screen. Consistent with `copy-writer.js`, the rejected text is never shown — only the failed check ids.

## PHASES

**Phase 0 — Order history in facts.** Stop `gatherFacts()` discarding all but the latest order. Done: facts carry `orderHistory`; merge fields unchanged; existing tests green.

**Phase 1 — Deterministic profiles. No LLM at all.** Migration, builder, backfill for 843, webhook-driven incremental refresh, read endpoint, visible on the contact in the inbox. Done: every buyer has a row, fingerprints stable, backfill is re-runnable and idempotent, `reorder_due_at` populated for the 289 multi-order buyers. *Standalone value: real segmentation, measured reorder cadence, an honest `never_replied` tier — none of which exists today.*

**Phase 2 — Variant bank + no-repeat. Still no LLM.** 5-6 approved check-in variants, profile-driven selection, similarity gate, `last_checkin_variant` recorded. Done: a weekly sweep where nobody receives wording they received before, all variants validate per person, reviewer reads 5 messages instead of 1. *This delivers most of "not generic, not repeated" — for everyone, at zero marginal cost.*

**Phase 3 — Narrative layer for the ~150 who qualify.** `llm-runner.js`, narrative writer, threshold + cooldown gating, budgeted resumable backfill, `analyseConversation` folded into the sole-writer service. Done: ~150 narratives stored, identifier and health-claim assertions passing under test, cost logged per run.

**Phase 4 — Generated check-in copy for the eligible minority.** Draft-time generation worker, `copy_source` on recipients, grouped review UI, per-person reject-to-template, cap and kill switch. Done: a live weekly batch shows ~5-15 generated messages, each individually validated, fallbacks counted, and the flag turns the whole thing off without touching the send path.

**Phase 5 — Deferred.** Profile-aware copy for other campaign types. Do not start until Phase 4 has run four to six weeks and the fallback rate is known.

## RISKS AND THINGS I THINK ARE BAD IDEAS

- **Per-person generated copy at 376-person scale: don't.** No queue, no budget guard, no reviewer who can read 376 messages. The cap exists to make this structurally impossible rather than merely discouraged.
- **Summarising conversations that do not exist: don't.** Covered above. The threshold is the whole point.
- **Quoting profile content back at the customer: I think this is the real conflict in the brief.** `check-in.js`'s own header says the message "does not say the customer is due, does not reference a schedule, and does not imply anybody has been watching them", and argues that for this catalogue the line between a shopkeeper who remembers you and a system that tracks you is worth more than the extra conversion. "We've already got that context behind every single person" points the other way. **Recommendation: context informs *selection* and *tone*. It is never quoted.** A message that says "you mentioned last month that..." is both a compliance problem and a trust problem, and it is the most likely way this feature goes wrong.
- **Multi-replica double-generation.** `setInterval` in-process assumes one instance. Claim rows by status transition.
- **Two writers on `sms_customer_profiles`.** The recurring fault in this repo. The sole-writer rule is not optional.
- **Profile drift mid-campaign.** Freeze the profile fingerprint on the recipient row at draft time so review and send agree about who this person was.
- **10DLC.** Classification does not change; variable copy is slightly less predictable to carrier filters. Brand-within-6-chars and the exact "Reply STOP to opt out." ending stay invariant across every variant.

## ENVIRONMENT VARIABLES

`CONTACT_PROFILES_ENABLED`, `PROFILE_NARRATIVE_ENABLED`, `PROFILE_NARRATIVE_MIN_INBOUND` (3), `PROFILE_NARRATIVE_COOLDOWN_DAYS` (7), `CHECKIN_VARIANTS_ENABLED`, `CHECKIN_GENERATED_COPY_ENABLED`, `CHECKIN_GENERATED_MAX_RECIPIENTS` (25), `LLM_MAX_CONCURRENCY` (2), `LLM_MAX_ATTEMPTS` (2), `LLM_RUN_CALL_BUDGET`, `LLM_DAILY_CALL_BUDGET`, `LLM_KILL_SWITCH`. Existing: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_ALLOWED_MODELS`, `OPENROUTER_ALLOWED_PROVIDERS`.

Every new flag follows the existing convention: the exact string `true`, nothing else.

## ROUTING SUMMARY

- Project type: backend feature inside an existing Node/Express + Supabase system
- Architecture required: yes, for Phase 1 (schema + sole-writer contract) and Phase 4 (worker + review UI)
- Backend owner: all of Phases 0-4
- Frontend owner: Phase 1 profile panel, Phase 4 grouped review screen only
- Research owner: none — no new third-party API
- Review owner: mandatory before Phase 3 and Phase 4 ship
- Parallel: Phase 1 backend and its inbox panel; Phase 2 variant copywriting alongside Phase 1 build
- Sequential: 0 → 1 → 2 → 3 → 4, strictly

## COMPLEXITY RATING

**Medium-High.** The engineering is moderate and mostly reuses existing seams. The difficulty is judgement: deciding what not to generate, keeping one writer per column, and holding the line on never quoting a customer's own words back at them.

## ONE CLARIFYING QUESTION

`check-in.js` explicitly commits to never implying we have been watching the customer. Does "context-aware" mean the message should *reference* things they previously said, or only be *shaped* by them — different tone, different variant, nothing quoted? The answer changes Phase 4's prompt contract and its compliance posture, and I would build the second unless told otherwise.
