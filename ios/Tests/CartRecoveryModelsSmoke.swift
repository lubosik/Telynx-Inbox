import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

@main
struct CartRecoveryModelsSmoke {
    static func main() throws {
        let pageJSON = Data(#"""
        {
          "journeys": [{
            "id": "journey-1",
            "status": "REPLIED",
            "customer_name": "Jamie Example",
            "firstName": "Jamie",
            "phone": "+15555550100",
            "phoneAvailable": true,
            "smsConsent": false,
            "pushPermission": true,
            "identityResolutionAmbiguous": true,
            "cart_items": [{"product_id": 42, "name": "RT", "quantity": 2}],
            "cartValue": "195.00",
            "currency": "USD",
            "last_activity_at": "2026-09-15T08:53:08Z",
            "smsStatus": "DELIVERED",
            "push_status": "BLOCKED",
            "push_blocked_reason": "customer_push_channel_unavailable",
            "primary_category": "PAYMENT_PROBLEM"
          }],
          "next_cursor": "next-page"
        }
        """#.utf8)

        let page = try JSONDecoder().decode(CartRecoveryJourneyPage.self, from: pageJSON)
        require(page.journeys.count == 1, "journey page should decode")
        require(page.journeys[0].products.first?.productID == "42", "numeric product ids should decode")
        require(page.journeys[0].category == "PAYMENT_PROBLEM", "snake-case category should decode")
        require(page.journeys[0].phoneAvailable, "phone availability should decode separately")
        require(!page.journeys[0].smsConsent, "phone must not imply SMS consent")
        require(page.journeys[0].pushPermission, "push permission should decode separately")
        require(page.journeys[0].identityResolutionAmbiguous, "ambiguous customer identity should remain visible")
        require(page.journeys[0].pushBlockedReason == "customer_push_channel_unavailable",
                "blocked push reason should remain visible")
        require(page.nextCursor == "next-page", "snake-case cursor should decode")

        let detailJSON = Data(#"""
        {
          "journey": {"id":"journey-1","status":"REPLIED"},
          "timeline": [{"id":"event-1","event_type":"sms_delivered","title":"Delivered"}],
          "replies": [{
            "id":"reply-1",
            "customerMessage":"My card did not work",
            "category":"PAYMENT_PROBLEM",
            "confidence":0.92,
            "draft":"Sorry about that. What error did you see?",
            "draftStatus":"DRAFT",
            "medicalEscalation":false
          }]
        }
        """#.utf8)
        let detail = try JSONDecoder().decode(CartRecoveryJourneyDetail.self, from: detailJSON)
        require(detail.timeline.first?.type == "sms_delivered", "timeline type should decode")
        require(detail.replies.first?.draftStatus == "DRAFT", "human-review draft should decode")

        let settingsJSON = Data(#"""
        {"settings": {
          "enabled":true,
          "firstSmsDelayMinutes":45,
          "firstSmsTemplate":"Locked copy",
          "pushEnabled":false,
          "pushDelayHours":48,
          "discountPercent":15,
          "discountCode":"Vici15",
          "automaticAiSending":true
        }}
        """#.utf8)
        let settings = try JSONDecoder().decode(CartRecoverySettingsEnvelope.self,
                                                from: settingsJSON).settings
        require(settings.discountCode == "Vici15", "customer-facing coupon code should decode exactly")
        require(settings.automaticAiSending, "client should accurately show an unsafe server state")
        require(settings.requestBody["automaticAiSending"] as? Bool == false,
                "client must never request automatic AI sending")

        print("cart recovery model smoke passed")
    }
}
