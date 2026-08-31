import Foundation

enum CampaignStatus: String, Codable, Hashable {
    case draft
    case reviewRequired = "review_required"
    case approvalPending = "approval_pending"
    case approved
    case scheduled
    case sending
    case completed
    case rejected
    case cancelled
    case failed

    var title: String {
        switch self {
        case .draft: return "Draft"
        case .reviewRequired: return "Review Required"
        case .approvalPending: return "Approval Pending"
        case .approved: return "Approved"
        case .scheduled: return "Scheduled"
        case .sending: return "Sending"
        case .completed: return "Completed"
        case .rejected: return "Rejected"
        case .cancelled: return "Cancelled"
        case .failed: return "Failed"
        }
    }

    var needsReview: Bool { self == .reviewRequired || self == .approvalPending }
    var isEditable: Bool { self == .draft || self == .rejected }
    var isTerminal: Bool { self == .completed || self == .cancelled || self == .failed }
}

struct CampaignRecord: Codable, Identifiable, Hashable {
    let id: String
    let campaignType: String
    let workflowCategory: String
    let title: String
    let status: CampaignStatus
    let audienceDefinition: JSONValue?
    let proposedMessage: String
    let finalMessage: String?
    let revision: Int
    let submittedForReviewAt: String?
    let approvedAt: String?
    let rejectedAt: String?
    let rejectionReason: String?
    let scheduledFor: String?
    let cancelledAt: String?
    let cancellationReason: String?
    let completedAt: String?
    let createdAt: String
    let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, title, status, revision
        case campaignType = "campaign_type"
        case workflowCategory = "workflow_category"
        case audienceDefinition = "audience_definition"
        case proposedMessage = "proposed_message"
        case finalMessage = "final_message"
        case submittedForReviewAt = "submitted_for_review_at"
        case approvedAt = "approved_at"
        case rejectedAt = "rejected_at"
        case rejectionReason = "rejection_reason"
        case scheduledFor = "scheduled_for"
        case cancelledAt = "cancelled_at"
        case cancellationReason = "cancellation_reason"
        case completedAt = "completed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var message: String {
        status.isEditable ? proposedMessage : (finalMessage ?? proposedMessage)
    }

    var requestedRecipientCount: Int? {
        guard case .number(let value)? = audienceDefinition?.child("requested_count") else { return nil }
        return Int(value)
    }
}

struct CampaignPage: Codable, Hashable {
    let items: [CampaignRecord]
    let page: Int
    let pageSize: Int
    let total: Int
}

struct CampaignApprovalRecord: Codable, Hashable {
    let id: FlexibleID
    let campaignID: String
    let revision: Int
    let actorUserID: FlexibleID?
    let decision: String
    let decisionReason: String?
    let recipientCount: Int
    let decidedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, revision, decision
        case campaignID = "campaign_id"
        case actorUserID = "actor_user_id"
        case decisionReason = "decision_reason"
        case recipientCount = "recipient_count"
        case decidedAt = "decided_at"
    }
}

struct CampaignDetailResponse: Codable, Hashable {
    let campaign: CampaignRecord
    let latestApproval: CampaignApprovalRecord?
}

struct CampaignRecipient: Codable, Identifiable, Hashable {
    let id: String
    let contactID: FlexibleID?
    let contactPhone: String
    let contactName: String?
    let selected: Bool
    let inclusionReason: JSONValue
    let state: String
    let suppressionReason: String?
    let plannedSendAt: String?
    let providerStatus: String?
    let sentAt: String?
    let deliveredAt: String?
    let failedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, selected, state
        case contactID = "contact_id"
        case contactPhone = "contact_phone"
        case contactName = "contact_name_snapshot"
        case inclusionReason = "inclusion_reason"
        case suppressionReason = "suppression_reason"
        case plannedSendAt = "planned_send_at"
        case providerStatus = "provider_status"
        case sentAt = "sent_at"
        case deliveredAt = "delivered_at"
        case failedAt = "failed_at"
    }

    var inclusionSummary: String {
        if case .string(let source)? = inclusionReason.child("source"), source == "manual" {
            return "Added manually"
        }
        return inclusionReason.displayText
    }

    var inclusionSource: String {
        guard case .string(let source)? = inclusionReason.child("source"),
              !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "manual"
        }
        return source
    }
}

struct CampaignRecipientPage: Codable, Hashable {
    let items: [CampaignRecipient]
    let page: Int
    let pageSize: Int
    let total: Int
}

struct CampaignLiveEligibility: Codable, Hashable {
    let allowed: Bool
    let reasons: [String]
}

struct CampaignEligibilityResult: Codable, Hashable, Identifiable {
    let phone: String?
    let eligible: Bool
    let reason: String
    let consentSource: String?
    let consentAt: String?

    var id: String { phone ?? "missing-\(reason)" }
}

struct CampaignDryRun: Codable, Hashable {
    let campaignID: String
    let revision: Int
    let total: Int
    let eligible: Int
    let suppressed: Int
    let reasons: [String: Int]
    let liveEligibility: CampaignLiveEligibility
    let recipients: [CampaignEligibilityResult]
    let recipientsTruncated: Bool

    private enum CodingKeys: String, CodingKey {
        case revision, total, eligible, suppressed, reasons, liveEligibility, recipients, recipientsTruncated
        case campaignID = "campaignId"
    }
}

/// What each customer would actually read, before anything is approved.
///
/// Distinct from `CampaignDryRun`, which answers "who would this reach" from
/// consent, quiet hours and suppression. This answers "what would they read",
/// which nothing answered before: a campaign whose copy contains
/// `{{first_name}}` looked identical on screen whether it rendered for
/// everybody or for two thirds of the list.
///
/// `renderedCount` and `excludedCount` are the numbers that matter. `samples`
/// is capped by the server and is there to be read, not counted.
struct CampaignPreview: Codable, Hashable {
    let personalised: Bool
    /// True when this rendered copy the writer has not saved. Optional so an
    /// older backend that does not send it still decodes.
    let unsaved: Bool?
    let template: String
    let fields: [String]?
    let discountPercent: Int?
    let audienceCount: Int
    let renderedCount: Int
    let excludedCount: Int
    let reasons: [String: Int]
    let samples: [CampaignPreviewSample]
    let excluded: [CampaignPreviewExclusion]

    /// Everyone in the audience can be sent something.
    var rendersForEveryone: Bool { excludedCount == 0 }
}

struct CampaignPreviewSample: Codable, Hashable, Identifiable {
    let phone: String
    let message: String
    var id: String { phone }

    /// GSM-7 single segment. Over this the message bills as two and can arrive
    /// split, so it is worth showing rather than discovering on the invoice.
    var isSingleSegment: Bool { message.count <= 160 }
}

struct CampaignPreviewExclusion: Codable, Hashable, Identifiable {
    let phone: String
    let reason: String
    let missing: [String]?
    var id: String { phone }

    var readableReason: String {
        switch reason {
        case "personalisation_unavailable":
            let names = (missing ?? []).joined(separator: ", ")
            return names.isEmpty ? "Nothing to fill the message with" : "No \(names)"
        case "rendered_message_not_compliant":
            return "The finished message breaks a copy rule"
        default:
            return reason.replacingOccurrences(of: "_", with: " ")
        }
    }
}

/// A campaign this app can build by itself.
///
/// Each one already knows who is in the audience, what the message says, what
/// it offers, and how long before the same person may receive it again. That
/// last number is the one that matters: cohorts do not know who has been
/// messaged, so without it a second run sends the same personal offer to the
/// same person.
struct CampaignRecipeSummary: Codable, Hashable, Identifiable {
    let key: String
    let name: String
    let description: String
    let workflowCategory: String
    let discountPercent: Int?
    let dedupeDays: Int
    let segments: [String]?
    let audience: String
    var id: String { key }

    var offerLabel: String {
        guard let percent = discountPercent else { return "No offer" }
        return "\(percent)% code"
    }

    var dedupeLabel: String {
        dedupeDays % 30 == 0 && dedupeDays >= 30
            ? "Not again for \(dedupeDays / 30) months"
            : "Not again for \(dedupeDays) days"
    }
}

/// What building this recipe would do, or did.
///
/// `suppressedAsDuplicate` is the number worth reading first. A build that
/// comes back with a small audience has to explain itself, and "364 of them
/// already had this one" is the explanation.
struct CampaignBuildResult: Codable, Hashable {
    let recipe: String
    let name: String
    let candidates: Int
    let suppressedAsDuplicate: Int
    let dedupeDays: Int
    let priorCampaigns: Int
    let audience: Int
    let created: [CampaignBuildCreated]
    let note: String?
    let dryRun: Bool?

    var builtAnything: Bool { !created.isEmpty && dryRun != true }
}

struct CampaignBuildCreated: Codable, Hashable, Identifiable {
    /// Absent on a dry run, which reports what WOULD be built without
    /// creating anything, so the variant name carries the identity instead.
    let campaignID: String?
    let title: String?
    let variant: String
    let recipients: Int

    var id: String { campaignID ?? variant }

    private enum CodingKeys: String, CodingKey {
        case campaignID = "id"
        case title, variant, recipients
    }
}

/// A variable the message may use.
///
/// Served from the renderer's own field table, so the app can never offer one
/// the renderer would then refuse. A template naming an unknown variable is
/// rejected outright rather than sent with the braces showing.
struct CampaignMergeField: Codable, Hashable, Identifiable {
    let name: String
    let description: String
    var id: String { name }
    var token: String { "{{\(name)}}" }

    /// What to show on a chip: `first_name` reads better than `{{first_name}}`
    /// at chip size, and the braces are what gets inserted anyway.
    var label: String { name.replacingOccurrences(of: "_", with: " ") }
}

/// The recipe catalogue plus what the editor needs to know about drafting.
/// The automatic 21-day post-purchase check-in.
///
/// The check-in used to be a recipe somebody pressed a button on. It now runs
/// itself: a sweep every few hours builds, approves and schedules it with no
/// human step. The one thing a person controls is `enabled`, which is a
/// standing authorisation rather than a preference, so the screen that shows
/// it says as much.
struct CheckInAutomation: Codable, Hashable {
    let enabled: Bool
    /// The business time zone the send hour is measured in, so the app can
    /// show "noon in New York" rather than converting to the phone's zone and
    /// quietly showing a different hour to somebody travelling.
    let timeZone: String?
    let sweepWindowDays: Int?
    let lastCampaign: CheckInAutomationCampaign?
    /// Null when this window has already been swept: there is no next send
    /// until the window rolls over.
    ///
    /// A String, not a Date, because APIClient's decoder has no ISO8601 date
    /// strategy — every other model in this file does the same. Typing it as
    /// Date compiles cleanly and then throws .decoding at runtime, so the
    /// section would have shown "Could not load" forever.
    let nextSendAt: String?

    var nextSendDate: Date? { AssistantThreadSummary.parse(nextSendAt) }
}

struct CheckInAutomationCampaign: Codable, Hashable {
    let id: String
    let title: String?
    let status: String?
    let createdAt: String?
}

/// The answer to switching it on or off.
///
/// `note` is the server's own sentence, shown verbatim. Switching off does not
/// recall a campaign that is already scheduled, and that is exactly the thing
/// somebody will assume unless told.
struct CheckInAutomationChange: Codable, Hashable {
    let enabled: Bool
    let note: String?
}

struct CampaignRecipeCatalogue: Codable, Hashable {
    let recipes: [CampaignRecipeSummary]
    /// False when CAMPAIGN_AI_COPY_ENABLED is not set on the server. The
    /// editor hides the drafting button rather than offering one that fails.
    let aiCopyEnabled: Bool?
    let mergeFields: [CampaignMergeField]?
}

/// Candidate copy from the drafting model.
///
/// Rejected drafts come back as rule ids with NO text, deliberately: a
/// reviewer must not be able to lift a draft that failed validation out of a
/// response and paste it into a campaign.
struct CampaignCopySuggestions: Codable, Hashable {
    let workflowType: String?
    let brandName: String?
    let requested: Int?
    let returned: Int
    let candidates: [CampaignCopyCandidate]
    let model: String?
    let copyStatus: String?
}

struct CampaignCopyCandidate: Codable, Hashable, Identifiable {
    let text: String
    let septets: Int
    var id: String { text }

    /// Over one segment the message bills twice and can arrive split.
    var isSingleSegment: Bool { septets <= 160 }
}

/// A campaign proposed from one sentence.
///
/// Everything needed for an arbitrary campaign already existed on three
/// different screens. This is the single answer: who, what it offers, what it
/// says, and whether it may actually be sent.
///
/// It proposes only. Nothing is saved until Create is tapped.
struct CampaignPlan: Codable, Hashable {
    let brief: String
    let shape: String
    let workflowCategory: String
    let discountPercent: Int?
    let audience: CampaignPlanAudience?
    let audienceError: CampaignPlanError?
    let copy: [CampaignCopyCandidate]
    let copyError: CampaignPlanError?
    let warnings: [CampaignPlanWarning]
    let ready: Bool

    var offerLabel: String {
        guard let percent = discountPercent else { return "No offer" }
        return "\(percent)% code"
    }
}

struct CampaignPlanAudience: Codable, Hashable {
    let description: String
    let matchedCount: Int
    let consideredCount: Int
    let ruleSet: JSONValue?
    let sample: [CampaignPlanSample]?
}

struct CampaignPlanSample: Codable, Hashable, Identifiable {
    let contactPhone: String?
    let contactName: String?
    var id: String { contactPhone ?? UUID().uuidString }
}

struct CampaignPlanError: Codable, Hashable {
    let code: String?
    let message: String
}

struct CampaignPlanWarning: Codable, Hashable, Identifiable {
    let code: String?
    let message: String
    var id: String { (code ?? "") + message }

    /// A warning that stops the campaign rather than merely colouring it.
    var isBlocking: Bool { code == "below_floor" }
}

struct CampaignActionResponse: Codable, Hashable {
    let campaign: CampaignRecord
    let recipientCount: Int?
}

struct CampaignReviewCount: Codable, Hashable {
    let count: Int
}

struct CampaignPerformance: Codable, Hashable {
    let operational: CampaignOperationalMetrics
    let availability: CampaignPerformanceAvailability
    let warnings: [CampaignPerformanceWarning]
    /// Optional so a campaign screen still decodes against a backend that
    /// predates coupon attribution. Absent means unavailable, never zero.
    let coupons: CampaignCouponRevenue?
}

/// Money this campaign made, measured rather than modelled.
///
/// Every figure traces to a specific single-use code on a specific paid order,
/// which is why `attribution-policy.js` ranks it above a clicked link. A
/// campaign that offered nothing reports `issued == 0` rather than a revenue
/// figure it has no basis for.
struct CampaignCouponRevenue: Codable, Hashable {
    let available: Bool
    let reason: String?
    let issued: Int?
    let redeemed: Int?
    let revenue: Double?
    let redemptionRate: Double?
    let anomalies: [CampaignCouponAnomaly]?

    /// Worth showing at all. A campaign with no codes has nothing to say here.
    var hasCodes: Bool { available && (issued ?? 0) > 0 }

    var formattedRevenue: String {
        let value = revenue ?? 0
        return "$" + String(format: "%.2f", value)
    }

    var formattedRate: String {
        let rate = redemptionRate ?? 0
        return String(format: "%.1f%%", rate * 100)
    }
}

struct CampaignCouponAnomaly: Codable, Hashable, Identifiable {
    let code: String
    let wooOrderID: Int?
    let reason: String
    var id: String { "\(code)-\(wooOrderID ?? 0)-\(reason)" }

    var readableReason: String {
        switch reason {
        case "code_used_more_than_once": return "Used more than once"
        case "order_refunded": return "Order refunded"
        case "order_cancelled": return "Order cancelled"
        case "order_failed": return "Payment failed"
        default: return reason.replacingOccurrences(of: "order_", with: "Order ")
        }
    }
}

struct CampaignOperationalMetrics: Codable, Hashable {
    let recipients: Int
    let providerAccepted: Int
    let delivered: Int
    let queued: Int
    let failed: Int
    let skipped: Int
    let cancelled: Int
    let replies: Int
    let optOuts: Int
    let deliveryDefinition: String
    let providerAcceptanceIsDelivery: Bool
}

struct CampaignPerformanceAvailability: Codable, Hashable {
    let operational: Bool
    let financial: Bool
}

struct CampaignPerformanceWarning: Codable, Hashable, Identifiable {
    let code: String
    let message: String
    var id: String { code }
}

struct CampaignFinancialOverview: Codable, Hashable {
    let generatedAt: String
    let currency: String
    let operational: CampaignOperationalMetrics
    let orders: CampaignFinancialOrders
    let conversion: CampaignConversionMetrics
    let revenue: CampaignFinancialRevenue
    let availability: CampaignFinancialAvailability
    let warnings: [AnalyticsWarning]
}

struct CampaignFinancialOrders: Codable, Hashable {
    let revenueImpact: Int
    let attributed: Int
    let influenced: Int
    let byConfidence: CampaignOrdersByConfidence
}

struct CampaignOrdersByConfidence: Codable, Hashable {
    let direct: Int
    let strong: Int
    let influenced: Int
}

struct CampaignConversionMetrics: Codable, Hashable {
    let recipients: Int
    let rate: Double?
    let basis: String
}

struct CampaignFinancialRevenue: Codable, Hashable {
    let direct: FlexibleDecimal
    let strong: FlexibleDecimal
    let influenced: FlexibleDecimal
    let attributed: FlexibleDecimal
    let totalImpact: FlexibleDecimal
}

struct CampaignFinancialAvailability: Codable, Hashable {
    let operational: Bool
    let revenueAttribution: Bool
}

struct CampaignAttributionPage: Codable, Hashable {
    let generatedAt: String
    let currency: String
    let scope: String
    let items: [AttributionRecord]
    let pagination: AnalyticsPagination
    let warnings: [AnalyticsWarning]
}

struct CampaignRecipientInput: Hashable {
    let name: String?
    let phone: String
    let contactID: String?
    let source: String

    init(name: String?,
         phone: String,
         contactID: String? = nil,
         source: String = "manual") {
        self.name = name
        self.phone = phone
        self.contactID = contactID
        self.source = source
    }

    var requestBody: [String: Any] {
        var value: [String: Any] = [
            "phone": phone,
            "reason": ["source": source]
        ]
        if let name, !name.isEmpty { value["name"] = name }
        if let contactID, let numericID = Int(contactID), numericID > 0 {
            value["contactId"] = numericID
        }
        return value
    }
}

enum CampaignWizardStep: Int, CaseIterable, Identifiable {
    case type
    case audience
    case audienceReview
    case message
    case preview
    case saveAndReview

    var id: Int { rawValue }
    var number: Int { rawValue + 1 }

    var title: String {
        switch self {
        case .type: return "Campaign Type"
        case .audience: return "Choose Audience"
        case .audienceReview: return "Review Audience"
        case .message: return "Message"
        case .preview: return "Safety & Timing"
        case .saveAndReview: return "Save & Review"
        }
    }
}

enum CampaignAudienceMode: String, CaseIterable, Identifiable {
    case selectedContacts
    case allContacts
    case manualNumbers

    var id: String { rawValue }

    var title: String {
        switch self {
        case .selectedContacts: return "Select Contacts"
        case .allContacts: return "All Contacts"
        case .manualNumbers: return "Enter Numbers"
        }
    }

    var detail: String {
        switch self {
        case .selectedContacts:
            return "Search the contact list and choose people explicitly."
        case .allContacts:
            return "Use a bounded snapshot of all contacts. Eligibility is checked after the draft is saved and again before any future send."
        case .manualNumbers:
            return "Enter phone numbers directly, including contacts not yet saved in the app."
        }
    }
}

enum CampaignReasonCopy {
    static func label(_ reason: String) -> String {
        switch reason {
        case "eligible": return "Eligible"
        case "invalid_phone": return "Invalid phone number"
        case "internal_or_test_identity": return "Internal or test identity"
        case "opted_out": return "Opted out"
        case "consent_not_recorded": return "Consent not recorded"
        case "dnd": return "Asked not to be contacted"
        // Not "Dnd Unknown", which fell out of the default case and read like
        // an accusation against the customer. It means OUR copy of their
        // contact preference has gone stale, which is our problem and a
        // temporary one: the six-hourly sync in lib/ghl-dnd-sync.js clears it.
        case "dnd_unknown": return "Contact preference out of date"
        case "campaign_settings_missing": return "Campaign settings unavailable"
        case "eligibility_check_failed": return "Eligibility check unavailable"
        // Both of these name the exact switch, because "disabled on the
        // server" sent somebody looking through the app for a toggle that
        // lives in an environment variable.
        case "environment_gate_disabled":
            return "Live sending is off on the server. Set CAMPAIGNS_LIVE_SEND_ENABLED to true on Railway."
        case "provider_not_approved": return "Provider approval is not recorded"
        case "workspace_live_send_disabled":
            return "Live sending is off for this workspace, in the campaign settings row"
        default:
            return reason.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Whether this reason is about the CUSTOMER or about US.
    ///
    /// Red said the same thing for "opted out" and "contact preference out of
    /// date", and they could not be less alike: one is a person declining, the
    /// other is a timestamp we let expire. Colouring both as refusals made a
    /// screen full of amber-worthy staleness look like an audience that had
    /// rejected the business.
    static func isCustomerRefusal(_ reason: String) -> Bool {
        switch reason {
        case "opted_out", "dnd", "consent_not_recorded",
             "invalid_phone", "internal_or_test_identity":
            return true
        default:
            // Everything else is something on our side, and fixable.
            return false
        }
    }
}
