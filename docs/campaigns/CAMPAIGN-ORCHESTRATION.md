# Campaign orchestration rules

Status: pure policy layer implemented for testing. Production detector scheduling and live sending remain disabled.

## Separation of responsibilities

The campaign system has five distinct decisions:

1. **Opportunity detection:** Is there a current commercial reason to consider contact?
2. **Collision resolution:** If several reasons exist, which one is most relevant?
3. **Draft and approval:** Did an Admin review the exact audience, copy, and timing?
4. **Send-time eligibility:** Is this recipient still allowed to receive this exact promotional message now?
5. **Delivery and attribution:** What did the provider and authoritative order system later confirm?

Passing an earlier decision never bypasses a later one. A frozen approved audience is evidence of what the Admin reviewed, not authority to ignore a later STOP, DND, order, stock change, frequency cap, or provider restriction.

## Default-off live-send boundary

`lib/campaigns/cadence-policy.js` requires both live-send switches as explicit true inputs. Their defaults are false. It also requires an active, evidenced provider eligibility record that covers the exact campaign type, explicitly confirms the provider binding, and confirms the reviewed copy scope.

For Vici, live promotional sending must remain off until Telnyx has confirmed the exact products, use case, brand, messaging campaign/profile, number, and representative copy. Admin approval is not provider approval.

Draft detection, audience explanations, dry runs, and previews may continue while this gate is off. They must report why live recipients are ineligible rather than implying a campaign is ready to send.

## Consent and hard gates

Promotional eligibility fails closed unless consent is:

- active;
- explicitly promotional;
- supported by a non-empty source, evidence reference, and collection time;
- for the same brand;
- for the exact use case.

Transactional consent is not upgraded to promotional consent. Unknown historical consent is excluded.

The evaluator also hard-blocks opt-out, DND, pending revocation review, unresolved legal-rule evaluation, quiet hours, and production use of internal/test identities. These inputs must be derived from current authoritative records at send time. A hard block is not represented as a temporary cadence deferral.

## Provisional product cadence

The code's default policy is the moderate dry-run candidate:

- at least 24 hours between promotional provider-accepted contacts;
- at most 2 in a rolling 7-day window;
- at most 4 in a rolling 30-day window.

This is a product guardrail, not a statement of law. It remains provisional until the 2, 4, and 6 per-month historical dry run has been reviewed. Centrally supplied policy values can make it stricter after review.

The ledger counts a promotional message once when the provider accepted it, even if it later failed. That prevents a failed campaign from immediately retrying through another campaign and increasing customer pressure. Delivery and failure remain separate outcomes. Transactional messages do not consume this promotional product cap.

Duplicate ledger records with the same idempotency key or provider message ID count once. One normalized phone shared by duplicate contact rows must use the same ledger identity when wired to storage.

When cadence is the only blocker, the evaluator returns `deferOnly` and `nextEligibleContactAt`. The opportunity may be deferred only if it will still be relevant then. Every hard rule and the frozen approval version must be checked again at that time.

## Deterministic orchestration sequence

For each contact:

1. close converted, unavailable, stale, revoked, or customer-experience-blocked opportunities;
2. keep active payment recovery separate and pause promotion while it is unresolved;
3. order remaining opportunities using the documented collision priority;
4. select at most one current promotional reason;
5. record lower-priority collisions, never silently discard them;
6. group compatible winners into a draft without combining unrelated reasons;
7. freeze the reviewed audience and evidence at approval;
8. enqueue durable recipient jobs only after approval and launch authority;
9. apply live-send, provider, consent, authoritative suppression, quiet-hour, and cadence checks immediately before provider submission; production detector adapters must first project changed opportunity, conversion, stock, support, and copy-version state into a suppression or cancelled/re-reviewed campaign because those adapters are not installed yet;
10. persist provider acceptance before treating a retry as safe;
11. reconcile delivery from verified Telnyx events;
12. close or defer each opportunity with an explicit reason.

## Pure implementation map

| Module | Responsibility |
|---|---|
| `lib/campaigns/back-in-stock.js` | Trusted exact-item unavailable-to-available transition qualification |
| `lib/campaigns/reorder-cadence.js` | Median/MAD personal cadence with conservative product fallback |
| `lib/campaigns/winback.js` | Cadence-relative lapse and cooldown qualification |
| `lib/campaigns/opportunity-policy.js` | Expiry, closure, deterministic collision priority |
| `lib/campaigns/cadence-policy.js` | Consent/provider/legal inputs and rolling promotional frequency evaluation |

These modules are intentionally free of network, database, queue, route, and provider calls. This makes dry-run output and send-time decisions testable from the same rule inputs. Production wiring must record the rule version used for every decision.

## Required next integration tests

Before any detector is enabled against production data:

- verify pagination above 1,000 rows and bounded ID chunking;
- prove exact product/variation matching and guest customer isolation;
- persist unique restock and reorder cycle keys under concurrent retries;
- prove one phone shared by duplicate contacts cannot bypass collision or cadence rules;
- run the 2/4/6 monthly cadence scenarios with internal/test identities and unknown consent excluded;
- manually review private samples of each inclusion and suppression reason;
- prove an opt-out or conversion after approval skips the durable recipient job;
- prove live-send disabled at either switch prevents provider submission;
- verify no detector or dry-run path calls Telnyx;
- keep all promotional output draft-only until the provider gate evidence exists.
