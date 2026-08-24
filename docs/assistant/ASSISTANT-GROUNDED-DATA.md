# Assistant grounded data boundary

Phase 7 reads existing Vici APIs. It adds no model endpoint, mutation, send
path, database table or migration.

## Source of truth

`AssistantBusinessDataSource` is the only business-data facade intended for
the on-device Tool layer. Each method calls an existing authenticated GET and
keeps that endpoint's existing route-policy permission:

| Facade method | Existing GET | Permission |
| --- | --- | --- |
| `analytics` | `/api/analytics/overview` | `analytics.read` |
| `attributions` | `/api/analytics/attributions` | `analytics.read` |
| `activitySummary` | `/api/audit/summary` | `audit.read` |
| `automationStatus` | `/api/activity/stats` | `automation.read` |
| `segments` | `/api/segments` | `campaigns.read` |
| `segmentDetail` | `/api/segments/:id` | `campaigns.read` |
| `segmentMember` | `/api/segments/:id/members/:phone` | `campaigns.read` |
| `segmentMemberships` | `/api/segments/members/:phone` | `campaigns.read` |
| `campaigns` | `/api/campaigns` and `/review-count` | `campaigns.read` |
| `campaignPerformance` | `/api/campaigns/:id/performance` | `campaigns.read` |
| `opportunities` | `/api/campaigns/opportunities?refresh=false` | `campaigns.read` |
| `referrals` | `/api/referrals` | `referral.read` |

The facade does not accept a workspace, URL, table name or arbitrary query.
The current backend remains the single Vici workspace. This phase does not
change tenancy.

## Model-visible allowlist

The facade emits only controlled status codes, confidence classifications,
counts, currency amounts, dates, numeric segment evidence and opaque evidence
tokens. It excludes all human-authored or customer-originated prose, names,
phone numbers, message content, referral context, campaign wording, segment
labels and reasons, audit summaries, state snapshots and metadata.

Automatic segment evidence is projected into a closed set of numeric and date
facts. Manual membership and human overrides are identified as such, but their
written reasons are not copied into model context.

Opportunity results keep detector keys, populations, actionability facts and
refusal reason codes. The detector's prose is not copied into model context.
The Tool layer must render reviewed wording for each supported code and decline
unknown codes.

## Empty, unavailable and stale

A successful response is represented as `available` and separately records
whether it is authoritatively empty. A failed, denied or unavailable response
is `unavailable`; it must never be converted into a zero.

Opportunity reads always request `refresh=false`. A stale snapshot remains
labelled with its computation time, age and refresh failure code. It must not
be described as current.

Analytics warning prose is not passed through. Warning codes are mapped to a
small set of reviewed data-quality notices. An unavailable or truncated
metric must not be quoted as complete.

## Evidence lifecycle

Every fact that can open a screen carries an opaque `AssistantEvidenceToken`.
The corresponding record is held only in `AssistantEvidenceRegistry`, an
in-memory actor. Private route identifiers, including a phone number required
by an existing conversation destination, remain inside that registry.

The registry has a generation fence. A read captures the active generation
when the coordinator begins a grounded request, and every facade read requires
that token explicitly. The token is checked before and after its network
request. Cancellation or clearing rotates the generation, so a late response
cannot repopulate evidence after the Assistant has been purged. References are
capped at 200 and fact identifiers at 100 per reference.

Each reference also stores a bounded, typed snapshot of its verified scalar
claims. After generation, the coordinator must render business facts from
those claims rather than trusting or parsing model prose. A generation mismatch
or an empty registry must produce a fixed no-data refusal.

The Assistant owner must call `clearEvidence()` on dismissal, backgrounding,
an active call, sign out, identity change, permission change and capability
disablement. Evidence is never persisted or logged. A later navigation layer
must recheck the stored permission before opening the typed destination.

## Tool integration contract

The Xcode 26 Tool layer depends on this facade rather than reading business
endpoints directly. Each fixed Tool returns only `Verified data captured.` to
the model. DTO values, evidence tokens, identifiers, claims and destinations
remain in the app's private in-memory registry. After the Tool completes, a
deterministic renderer selects exact allowlisted registry claims and attaches
reviewed, figure-specific citations. Model prose is never parsed or displayed
as a business fact.

Tools are fixed for an Xcode 26 `LanguageModelSession` lifetime. Server RBAC is
still authoritative even when a static tool remains visible after a permission
change. A 403 becomes a permission refusal, not an empty result. Dynamic
Profiles remain deferred to the Xcode 27 lane and are not an authorization
boundary.

List-summary Tools retain only aggregate citations. They do not register each
campaign, segment, referral or opportunity row unless a supported question
actually exposes that exact record. Successful generations discard every
uncited provisional reference. Failed and cancelled generations discard only
their own provisional references, while citations still visible in the
bounded transcript stay resolvable. The transcript retains at most 20
user/assistant exchanges and releases their citations before making room.

Stored segment evidence is selected only from trusted router context. The
current Phase 7 screen can resolve the selected segment and show its aggregate
stored-evidence breakdown. Exact member and cross-segment membership reads are
implemented and executable-tested, but no customer phone is inferred from
question text or either Phase 8 segment route. Passing a trusted member phone
from a future person-specific route remains deliberately deferred.
