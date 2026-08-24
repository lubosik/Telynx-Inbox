import Foundation

@main
struct ReferralModelsSmoke {
    static func main() throws {
        var referralDraft = ReferralComposerDraft()
        let customerSMSDraft = "Your order is ready"
        referralDraft.recipient = .anyAdmin
        referralDraft.note = "Please handle the pricing question"

        precondition(referralDraft.canSubmit)
        precondition(referralDraft.trimmedNote == "Please handle the pricing question")
        precondition(customerSMSDraft == "Your order is ready",
                     "editing a referral note must not alter the SMS composer")

        let data = Data(#"""
        {
          "id":"11111111-1111-4111-8111-111111111111",
          "contactPhone":"+13055550123",
          "contactName":"Nessa",
          "referredBy":{"id":"7","name":"Gregory","role":"agent"},
          "targetKind":"any_admin",
          "originalTarget":null,
          "owner":null,
          "state":"pending",
          "initialNote":"Pricing question",
          "claimedAt":null,
          "resolvedAt":null,
          "resolvedBy":null,
          "createdAt":"2026-08-24T11:00:00Z",
          "updatedAt":"2026-08-24T11:00:00Z",
          "version":1,
          "attentionRequired":true
        }
        """#.utf8)
        let referral = try JSONDecoder().decode(ReferralRecord.self, from: data)
        precondition(referral.recipientLabel == "Any Admin")
        precondition(referral.attentionRequired)
        print("Referral models smoke: OK")
    }
}
