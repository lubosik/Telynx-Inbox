import Foundation

/// The wire contract between `POST /api/campaigns/:id/preview` and the app.
///
/// This exists because the two halves are written in different languages and
/// nothing else checks that they agree. The decoder is a plain JSONDecoder
/// with no key strategy, so a server field named `rendered_count` and a Swift
/// property named `renderedCount` fail silently at runtime rather than loudly
/// at build time. The fixture below is copied from a real response for the
/// staged win-back.
@main
struct CampaignPreviewModelsSmoke {
    static func main() throws {
        let preview = try JSONDecoder().decode(CampaignPreview.self, from: fixture)

        precondition(preview.personalised)
        precondition(preview.audienceCount == 221)
        precondition(preview.renderedCount == 221)
        precondition(preview.excludedCount == 0)
        precondition(preview.discountPercent == 15)
        precondition(preview.rendersForEveryone, "a campaign with nobody excluded must read as complete")
        precondition(preview.samples.count == 2)
        precondition(preview.fields?.contains("last_order_date") == true)

        // The single-segment boundary decides whether a send bills once or
        // twice, so it is checked at the exact edge rather than near it.
        let short = CampaignPreviewSample(phone: "+15550000001", message: String(repeating: "a", count: 160))
        let long = CampaignPreviewSample(phone: "+15550000002", message: String(repeating: "a", count: 161))
        precondition(short.isSingleSegment)
        precondition(!long.isSingleSegment)

        // An exclusion has to say something a person can act on. "No
        // last_product" tells the reviewer to drop that recipient or change
        // the copy; the raw reason code tells them nothing.
        let partial = try JSONDecoder().decode(CampaignPreview.self, from: partialFixture)
        precondition(!partial.rendersForEveryone)
        precondition(partial.excludedCount == 155)
        precondition(partial.excluded.count == 1)
        precondition(partial.excluded[0].readableReason == "No last_product")

        // A non-compliant render carries `failedChecks` instead of `missing`,
        // and the model must survive the difference rather than fail to decode.
        let refused = try JSONDecoder().decode(CampaignPreview.self, from: refusedFixture)
        precondition(refused.excluded[0].missing == nil)
        precondition(refused.excluded[0].readableReason == "The finished message breaks a copy rule")

        // A campaign with no merge fields reports personalised:false and omits
        // the optional keys entirely. Decoding must not require them.
        let plain = try JSONDecoder().decode(CampaignPreview.self, from: plainFixture)
        precondition(!plain.personalised)
        precondition(plain.fields == nil && plain.discountPercent == nil)
        precondition(plain.rendersForEveryone)

        print("CampaignPreviewModelsSmoke passed")
    }

    static let fixture = Data("""
    {
      "personalised": true,
      "template": "Vin from Vici. Hi {{first_name}}, you took {{last_product}} back in {{last_order_date}}. Here is {{code}} for 15% off your next order. Reply STOP to opt out.",
      "fields": ["first_name", "last_product", "last_order_date", "code"],
      "discountPercent": 15,
      "audienceCount": 221,
      "renderedCount": 221,
      "excludedCount": 0,
      "reasons": {},
      "samples": [
        { "phone": "+15550000001", "message": "Vin from Vici. Hi Jessica, you took RT back in July. Here is vin-preview0000 for 15% off your next order. Reply STOP to opt out." },
        { "phone": "+15550000002", "message": "Vin from Vici. Hi Adrienne, you took RT back in July. Here is vin-preview0000 for 15% off your next order. Reply STOP to opt out." }
      ],
      "excluded": []
    }
    """.utf8)

    static let partialFixture = Data("""
    {
      "personalised": true,
      "template": "Vin from Vici. Hi {{first_name}}, you took {{last_product}}. Reply STOP to opt out.",
      "fields": ["first_name", "last_product"],
      "discountPercent": 15,
      "audienceCount": 376,
      "renderedCount": 221,
      "excludedCount": 155,
      "reasons": { "personalisation_unavailable": 155 },
      "samples": [],
      "excluded": [
        { "phone": "+15550000009", "reason": "personalisation_unavailable", "missing": ["last_product"] }
      ]
    }
    """.utf8)

    static let refusedFixture = Data("""
    {
      "personalised": true,
      "template": "Vin from Vici. Hi {{first_name}}. Reply STOP to opt out.",
      "fields": ["first_name"],
      "discountPercent": 15,
      "audienceCount": 1,
      "renderedCount": 0,
      "excludedCount": 1,
      "reasons": { "rendered_message_not_compliant": 1 },
      "samples": [],
      "excluded": [
        { "phone": "+15550000010", "reason": "rendered_message_not_compliant", "failedChecks": ["length_within_one_segment"] }
      ]
    }
    """.utf8)

    static let plainFixture = Data("""
    {
      "personalised": false,
      "template": "Vici: we are back in stock. Reply STOP to opt out.",
      "audienceCount": 40,
      "renderedCount": 40,
      "excludedCount": 0,
      "reasons": {},
      "samples": [
        { "phone": "+15550000011", "message": "Vici: we are back in stock. Reply STOP to opt out." }
      ],
      "excluded": []
    }
    """.utf8)
}
