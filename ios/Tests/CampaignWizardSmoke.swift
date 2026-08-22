import Foundation

/// Portable contract smoke test for environments without the iOS SDK.
///
/// Compile this with the Foundation-only app model/API/view-model files. It
/// performs no network calls and is deliberately outside the application
/// target generated from `ios/ViciInbox`.
@main
struct CampaignWizardSmoke {
    static func main() throws {
        let decoder = JSONDecoder()
        let page = try decoder.decode(CampaignPage.self, from: Data(#"""
        {
          "items":[{
            "id":"campaign-1","campaign_type":"manual","workflow_category":"manual",
            "title":"August follow-up","status":"draft",
            "audience_definition":{"kind":"manual","requested_count":1},
            "proposed_message":"Hello","final_message":null,"revision":3,
            "submitted_for_review_at":null,"approved_at":null,"rejected_at":null,
            "rejection_reason":null,"scheduled_for":null,"cancelled_at":null,
            "cancellation_reason":null,"completed_at":null,
            "created_at":"2026-08-22T11:00:00.000Z",
            "updated_at":"2026-08-22T12:00:00.000Z"
          }],
          "page":1,"pageSize":25,"total":1
        }
        """#.utf8))
        precondition(page.items.first?.requestedRecipientCount == 1)
        precondition(CampaignWizardStep.allCases.count == 6)
        precondition(CampaignWizardStep.saveAndReview.number == 6)
        precondition(CampaignAudienceMode.allContacts.title == "All Contacts")

        let dryRun = try decoder.decode(CampaignDryRun.self, from: Data(#"""
        {
          "campaignId":"campaign-1","revision":3,"total":2,"eligible":1,"suppressed":1,
          "reasons":{"eligible":1,"consent_not_recorded":1},
          "liveEligibility":{"allowed":false,"reasons":["environment_gate_disabled"]},
          "recipients":[{
            "phone":"+15551234567","eligible":true,"reason":"eligible",
            "consentSource":"checkout","consentAt":"2026-08-01T00:00:00Z"
          }],
          "recipientsTruncated":false
        }
        """#.utf8))
        precondition(dryRun.eligible == 1)
        precondition(!dryRun.liveEligibility.allowed)

        let parsed = CampaignEditorModel.parseRecipients(
            "Pandolfo, Dominic, +15557654321\n+15557654321\ninvalid\n12345"
        )
        precondition(parsed.count == 1)
        precondition(parsed.first?.name == "Pandolfo, Dominic")
        precondition(parsed.first?.phone == "+15557654321")

        let savedRecipient = CampaignRecipient(
            id: "recipient-1",
            contactID: FlexibleID("42"),
            contactPhone: "+15551234567",
            contactName: "Pandolfo, Dominic",
            selected: true,
            inclusionReason: .object(["source": .string("opportunity_review")]),
            state: "draft",
            suppressionReason: nil,
            plannedSendAt: nil,
            providerStatus: nil,
            sentAt: nil,
            deliveredAt: nil,
            failedAt: nil
        )
        guard let campaign = page.items.first else { preconditionFailure("Missing fixture campaign") }
        let editor = CampaignEditorModel(campaign: campaign, recipients: [savedRecipient])
        precondition(editor.recipientsText == "+15551234567")
        precondition(editor.audienceInputs.first?.name == "Pandolfo, Dominic")
        precondition(editor.audienceInputs.first?.contactID == "42")
        precondition(editor.audienceInputs.first?.source == "opportunity_review")

        let selected = CampaignRecipientInput(
            name: "Dominic",
            phone: "+15551234567",
            contactID: "42",
            source: "manual_contact_selection"
        )
        precondition(selected.requestBody["contactId"] as? Int == 42)
        precondition(
            (selected.requestBody["reason"] as? [String: String])?["source"]
                == "manual_contact_selection"
        )

        print("Campaign wizard smoke: OK")
    }
}
