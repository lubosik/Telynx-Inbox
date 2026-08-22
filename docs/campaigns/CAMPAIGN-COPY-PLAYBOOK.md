# Campaign copy playbook

Status: human-review playbook for drafts. These examples are not provider-approved, legal approval, medical advice, or permission to send.

## Non-negotiable review

Every campaign message must be reviewed together with the exact brand, use case, audience, offer, destination, consent evidence, provider campaign/profile, and send timing. A reusable template does not make a recipient eligible.

Before submitting a draft for approval, an Admin should confirm:

- positive promotional consent covers this brand and use case;
- the product/use case and representative copy have explicit provider/carrier approval;
- the recipient is not opted out, DND, internal/test, in a support/refund problem, or already converted;
- every product, availability, price, discount, deadline, and link is current and accurate;
- wording makes no medical, treatment, safety, efficacy, or outcome claim;
- the sender identity is clear and `Reply STOP to opt out` is present;
- there are no unsupported merge fields, shortened/redirecting URLs, hidden conditions, or invented urgency;
- a final test render contains no placeholder or wrong product/customer data.

The draft generator in `lib/campaigns/draft-copy.js` is deliberately plain and deterministic. It never calls a language model.

## Back in stock

Use only after the exact product or variation passed the signed-event, five-minute debounce, and authoritative Woo refetch rule.

Starter draft:

```text
Good news — [verified product name] is back in stock. Reply if you'd like help. Reply STOP to opt out.
```

Do not say “selling fast,” “last chance,” “guaranteed,” or quote a quantity unless an authoritative source supports it and the statement will remain true through the send window. Do not substitute a parent product for a variation.

## Reorder check-in

Use only for an exact product with a supported personal/product cadence. Phrase cadence as a check-in, not as knowledge that the customer medically needs a product.

Starter draft:

```text
Hi, it may be time to reorder [verified product name]. Reply if you'd like help. Reply STOP to opt out.
```

Avoid “you are due,” dosage schedules, treatment continuity, health outcomes, or a claim that purchase history proves a medical need.

## Win-back

Use only after cadence-relative lapse, repeat-purchase minimum, cooldown, and customer-experience gates pass.

Starter draft:

```text
Hi, this is [verified brand]. We're here if you need any help. Reply STOP to opt out.
```

Do not mention how much the customer spent, expose private purchase history, imply surveillance, or use a complaint/refund as sales leverage. A recent complaint, refund, negative support issue, or prior rejection suppresses the opportunity.

## Links, offers, and personalization

Add a link or offer only during human review. Use a verified first-party HTTPS destination tied to the approved brand; do not use URL shorteners. State material terms in the message or on the linked page. A promotion with a deadline needs an authoritative end time and an opportunity expiry no later than that time.

The current campaign foundation stores one reviewed message per campaign. Do not add `{{first_name}}` or another merge field until rendering is implemented, previewed per recipient, frozen in the approval fingerprint, and rechecked by tests. Plain copy is safer than a placeholder reaching a customer.

## Replies and suppression

STOP and equivalent revocations must be processed immediately through the existing opt-out sentinel. A reply, order, product availability change, support case, or payment-recovery interaction may make an approved opportunity irrelevant. The durable recipient claim must skip it with the exact suppression reason; it must not silently substitute different copy or a different opportunity.

## Approval record

The approval evidence should identify the exact copy revision, audience hash, reviewer, timestamp, intended timing, workflow, provider approval reference, consent coverage result, offer/product source, and known suppressions. Editing message, audience, timing, or workflow after review invalidates the approval and returns the campaign to draft/review.

