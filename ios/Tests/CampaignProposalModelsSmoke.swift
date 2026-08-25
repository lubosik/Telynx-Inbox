import Foundation

@main
struct CampaignProposalModelsSmoke {
    static func main() throws {
        let original = try JSONSerialization.jsonObject(with: fixture) as! [String: Any]
        let page = try JSONDecoder().decode(CampaignProposalPage.self, from: fixture)

        precondition(page.page == 1 && page.pageSize == 50 && page.total == 2)
        precondition(page.items.count == 2)
        precondition(page.items.filter(\.offer.isIntentionalNoOffer).count == 1)
        precondition(page.items.filter { !$0.offer.isIntentionalNoOffer }.count == 1)
        precondition(page.items.allSatisfy { $0.status == "proposed" && $0.copy.validated })
        _ = try JSONEncoder().encode(page)

        precondition(CampaignProposalPagingPolicy.nextPage(
            after: 1, pageSize: 50, total: 100, visibleCount: 0
        ) == 2, "a fully withheld first page stranded later proposals")
        precondition(CampaignProposalPagingPolicy.nextPage(
            after: 2, pageSize: 50, total: 100, visibleCount: 0
        ) == nil, "paging did not stop at the exact final page")
        precondition(CampaignProposalPagingPolicy.nextPage(
            after: 1, pageSize: 50, total: 100, visibleCount: 1
        ) == nil, "a visible page was skipped")
        precondition(CampaignProposalPagingPolicy.maximumPage(
            total: Int.max, pageSize: 50
        ) == nil, "an untrusted huge total was accepted")
        precondition(!CampaignProposalPagingPolicy.hasPage(
            after: Int.max, pageSize: 50, total: 100
        ), "a huge page could overflow pagination")

        try expectRefused(original) { root in
            var items = root["items"] as! [[String: Any]]
            items[0]["status"] = "accepted"
            root["items"] = items
        }
        try expectRefused(original) { root in
            var items = root["items"] as! [[String: Any]]
            var copy = items[0]["copy"] as! [String: Any]
            copy["validated"] = false
            items[0]["copy"] = copy
            root["items"] = items
        }
        try expectRefused(original) { root in
            var items = root["items"] as! [[String: Any]]
            var copy = items[0]["copy"] as! [String: Any]
            copy["failedChecks"] = ["no_banned_terms"]
            items[0]["copy"] = copy
            root["items"] = items
        }
        try expectRefused(original) { root in
            var items = root["items"] as! [[String: Any]]
            var offer = items[0]["offer"] as! [String: Any]
            offer["termsRequiredFromHuman"] = [String]()
            items[0]["offer"] = offer
            root["items"] = items
        }
        try expectRefused(original) { root in
            var items = root["items"] as! [[String: Any]]
            items[0]["recipientPhone"] = "+15555550123"
            root["items"] = items
        }
        try expectRefused(original) { root in
            root["pageSize"] = 500
        }
        try expectRefused(original) { root in
            root["total"] = 1
        }
        try expectRefused(original) { root in
            root["total"] = Int.max
        }
        try expectRefused(original) { root in
            root["page"] = Int.max
        }

        print("Campaign proposal models smoke: OK")
    }

    private static func expectRefused(
        _ source: [String: Any],
        mutate: (inout [String: Any]) -> Void
    ) throws {
        var changed = source
        mutate(&changed)
        let data = try JSONSerialization.data(withJSONObject: changed)
        do {
            _ = try JSONDecoder().decode(CampaignProposalPage.self, from: data)
            preconditionFailure("Malformed or sensitive proposal data decoded")
        } catch is DecodingError {
            return
        }
    }

    private static let fixture = """
    {
      "items": [
        {
          "id": "proposal-1",
          "proposalKey": "opp-1:free_shipping",
          "opportunityId": "opp-1",
          "opportunityKind": "repeat_purchase",
          "opportunityTitle": "One-time buyers",
          "opportunitySource": "detector",
          "mechanism": "free_shipping",
          "mechanismLabel": "Shipping covered on the next order",
          "distinctnessClass": "shipping_economics",
          "title": "Shipping covered for one-time buyers",
          "audience": {
            "kind": "segment",
            "cohortLabel": "One-time buyers",
            "cohortSize": 24,
            "cohortSizeBasis": "1305 paid orders across 792 buyers, counted per person and never per product pair.",
            "plainEnglish": "Everyone in the saved segment behind one-time buyers.",
            "requiresSegment": false,
            "narrowedBy": null,
            "narrowingSkipped": null,
            "segmentKey": "one_time_buyers"
          },
          "segmentKey": "one_time_buyers",
          "offer": {
            "kind": "shipping_concession",
            "appliedBy": "human_at_review",
            "termsRequiredFromHuman": ["the exact shipping concession", "the start and end date"],
            "statedInCopy": false,
            "note": "A human must set and verify all terms before approval."
          },
          "copy": {
            "text": "Vici: we are here if you need anything. Reply STOP to opt out.",
            "septets": 66,
            "validated": true,
            "failedChecks": [],
            "copyRulesVersion": "copy-rules-2026-08-23"
          },
          "costs": [{"id":"fulfilment_margin","statement":"Costs real fulfilment margin."}],
          "risks": [{
            "id":"terms_incomplete_at_send",
            "statement":"Terms must exist before a campaign is approved.",
            "severity":"high",
            "evidence":"assumption",
            "source":"docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md"
          }],
          "projections": [],
          "schemaVersion": "campaign-proposals-2026-08-23",
          "catalogueVersion": "proposal-mechanisms-2026-08-23",
          "contractVersion": "v1",
          "model": "private-model-name-not-decoded",
          "status": "proposed",
          "acceptedAt": null,
          "acceptedBy": null,
          "createdCampaignId": null,
          "dismissedAt": null,
          "dismissedBy": null,
          "dismissedReason": null,
          "createdAt": "2026-08-24T10:00:00.000Z",
          "updatedAt": "2026-08-24T10:00:00.000Z"
        },
        {
          "id": "proposal-2",
          "opportunityKind": "repeat_purchase",
          "opportunityTitle": "One-time buyers",
          "mechanism": "plain_check_in",
          "mechanismLabel": "Plain check-in, no offer",
          "distinctnessClass": "no_incentive",
          "title": "Plain check-in for one-time buyers",
          "audience": {
            "kind": "cohort_only",
            "cohortLabel": "One-time buyers",
            "cohortSize": 24,
            "cohortSizeBasis": "1305 paid orders across 792 buyers, counted per person and never per product pair.",
            "plainEnglish": "Everyone the detector counted in one-time buyers.",
            "requiresSegment": true,
            "narrowedBy": null,
            "narrowingSkipped": null
          },
          "offer": {
            "kind": "none",
            "appliedBy": null,
            "termsRequiredFromHuman": [],
            "statedInCopy": false,
            "note": "This proposal deliberately carries no offer."
          },
          "copy": {
            "text": "Vici: we are here if you need anything. Reply STOP to opt out.",
            "septets": 66,
            "validated": true,
            "failedChecks": [],
            "copyRulesVersion": "copy-rules-2026-08-23"
          },
          "costs": [{"id":"audience_attention","statement":"Uses one cadence contact."}],
          "risks": [{
            "id":"no_reason_to_act",
            "statement":"A no-offer message may not create a reason to act.",
            "severity":"moderate",
            "evidence":"assumption",
            "source":"docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md"
          }],
          "status": "proposed",
          "createdAt": "2026-08-24T09:00:00Z",
          "updatedAt": "2026-08-24T09:00:00Z"
        }
      ],
      "page": 1,
      "pageSize": 50,
      "total": 2,
      "withheld": 0
    }
    """.data(using: .utf8)!
}
