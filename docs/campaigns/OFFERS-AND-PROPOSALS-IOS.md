# Offers and Proposals on iOS

## What this screen is

`OffersAndProposalsView` is a read-only review of rows returned by:

`GET /api/campaign-proposals?status=proposed`

These rows are ideas, not campaigns. Every item is visibly labelled
unapproved. Opening, expanding, refreshing, or paging the screen does not
accept an idea, create a campaign, approve copy, schedule work, or send a
message.

The server and iOS screen both require `campaigns.manage`. This is stricter
than ordinary campaign reading because the queue contains marketing copy and
offer ideas that no person has approved.

## What appears

The screen separates two different comparisons:

- Structured offer proposals carry an offer kind and a bounded list of terms
  a human must supply during a later review. Offer terms are not present in the
  drafted SMS.
- Intentional no-offer controls deliberately offer nothing. They provide the
  comparison needed to ask whether the cohort needs an incentive at all.

Each expandable row can show the verified audience description and size,
unapproved validated copy, costs, risks, and human-required offer terms. It
does not decode recipients, customer records, phones, orders, model identity,
or persistence/audit fields.

## Fail-closed decoding

`CampaignProposalModels.swift` independently checks the response after the
server's surfaceability guard. It refuses:

- any status other than `proposed`;
- unvalidated copy or any failed copy check;
- negative or unbounded page/count values;
- an unknown offer kind;
- an offer whose terms are not owned by `human_at_review`;
- a no-offer control that carries offer terms;
- an offer that claims its terms are already in the drafted SMS;
- unsupported sensitive keys such as recipient, phone, contact, customer,
  order, email, credential, or token fields;
- oversized arrays, text, identifiers, and malformed timestamps.

A decoding refusal shows a generic verification error and no proposal data.
Permission loss clears already-loaded proposal copy, and an in-flight response
from the prior permission lifecycle cannot repopulate the model.

The backend's `total` includes stored rows before its copy guard withholds
unsafe rows. The client therefore advances automatically across an empty page,
but only up to `ceil(total / pageSize)`. This prevents a fully withheld first
page from hiding valid later proposals without permitting an unbounded read.
The count is capped at 10,000 stored rows client-side, and the division avoids
overflow even for a malicious integer response.

If any later page is malformed, sensitive, or cannot be verified, the client
removes all proposal copy loaded from earlier pages before it shows the error.
It never mixes a trusted first page with an unverified continuation.

The server remains authoritative. Client validation is defense in depth, not a
replacement for route policy or the server's proposal copy guard.

## Assistant boundary

Proposal DTOs and drafted copy are not part of the Assistant business data
source, Tool registry, prompt, or deterministic grounded renderer. Phase 8 may
navigate an authorised person to this screen through a typed route, but the
Assistant must not read, summarize, repeat, or speak proposal content.

## Deliberately absent actions

This workstream adds no accept, dismiss, approve, schedule, launch, or send
method. If proposal decisions are added to iOS later, they require a separate
human-confirmed design and must preserve the existing backend rule: accepting
a proposal creates only an ordinary campaign draft, which still passes through
submission, review, approval, scheduling, and delivery safeguards.
