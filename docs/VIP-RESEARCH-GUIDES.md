# VIP research guides: draft-only foundation

This feature is not customer-facing yet. Dominic's guide template, approved
product language, and review process are still needed. No guide is generated
or sent automatically, and there is no live Guides page in the app at this
checkpoint.

`lib/vip-guide-evidence.js` creates one internal evidence packet from the same
paid-order facts used by Growth segmentation. It keeps product identities,
frequency, last paid order, spend and cadence distinct from any proposed copy.
Failed/unpaid orders are excluded. A product that is not currently available
can appear in order history but must not become a live cross-sell offer.

The next stage after the template arrives:

1. Register a versioned, business-approved guide template and an approved
   product catalogue. Do not infer medical goals or product effects from orders.
2. Create a guide draft for one VIP from the evidence packet. Store source
   order IDs, snapshot timestamp, template version and draft revision for audit.
3. Present the draft in a VIP Guides area with edit, approve and discard. Show
   which facts came from which paid orders and what is unknown.
4. Separately prepare an optional cross-sell message through the existing
   campaign/consent/STOP/approval pipeline. A guide approval is not permission
   to send an SMS. Sending must remain an explicit operator action.
5. Record guide version and customer delivery, if enabled later, without
   duplicating contacts or conversations.

Marketing review is essential for US peptide products. FDA guidance and
warning letters identify risks in unapproved-product marketing claims, even
when products are described as for research use. The guide generator must not
invent dosing, treatment, efficacy, safety, or personal medical advice.

Sources:

- https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/warning-letters/peptide-partners-llc-735063-08242026
- https://www.fda.gov/drugs/human-drug-compounding/fda-telehealth-companies-what-know-when-promoting-compounded-drugs
