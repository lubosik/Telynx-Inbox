import Foundation

/// A closed vocabulary for the read permissions used by Assistant evidence.
/// The server remains authoritative. This value is only used to recheck a
/// destination before the app opens it.
enum AssistantBusinessPermission: String, Codable, Hashable, Sendable {
    case analyticsRead = "analytics.read"
    case auditRead = "audit.read"
    case automationRead = "automation.read"
    case campaignsRead = "campaigns.read"
    case referralRead = "referral.read"
}

/// Scalar-only navigation metadata retained outside the model transcript.
/// Customer phone numbers are required by two existing destinations, so they
/// live here in the private evidence registry and never in a tool payload.
enum AssistantEvidenceDestination: Hashable, Sendable {
    case analyticsAttributions(period: String,
                               start: String?,
                               end: String?,
                               scope: String,
                               category: String?)
    case activity(category: String)
    case automations
    case opportunities
    case campaigns
    case campaign(id: String)
    case campaignAttributions(id: String)
    case segments
    case segment(id: String, name: String?)
    case segmentMember(segmentID: String, phone: String)
    case referrals
    case referral(id: String, phone: String)
}

enum AssistantEvidenceSource: String, Codable, Hashable, Sendable {
    case analytics
    case attribution
    case activity
    case automation
    case segment
    case campaign
    case opportunity
    case referral
}

/// Only aggregate references may supply headline transcript claims. Record
/// references still power drill-down navigation, but their values cannot be
/// mistaken for a list total when several reads share a generation.
enum AssistantEvidenceScope: String, Codable, Hashable, Sendable {
    case aggregate
    case record
}

enum AssistantAnalyticsClaimFamily: String, Hashable, Sendable {
    case revenue
    case messaging
    case calls
}

/// Pure policy used before any analytics headline claim is registered. The
/// backend currently does not associate a warning with one metric family, so
/// an incomplete total suppresses all three rather than inviting a guess.
enum AssistantAnalyticsClaimPolicy {
    static func allowedFamilies(revenueAvailable: Bool,
                                messagingAvailable: Bool,
                                callsAvailable: Bool,
                                warningCodes: [String]) -> Set<AssistantAnalyticsClaimFamily> {
        guard !warningCodes.contains(where: isIncomplete) else { return [] }
        var result: Set<AssistantAnalyticsClaimFamily> = []
        if revenueAvailable { result.insert(.revenue) }
        if messagingAvailable { result.insert(.messaging) }
        if callsAvailable { result.insert(.calls) }
        return result
    }

    private static func isIncomplete(_ raw: String) -> Bool {
        let code = raw.uppercased()
        return code.contains("TRUNCATED")
            || code.contains("PARTIAL")
            || code.contains("INCOMPLETE")
            || code.contains("UNKNOWN")
    }
}

/// Server-derived values retained beside evidence for deterministic rendering.
/// The grounded coordinator reads these from the private registry after Tool
/// execution and never treats model prose as the source of a business fact.
enum AssistantGroundedClaim: Hashable, Sendable {
    case integer(metric: String, value: Int)
    case decimal(metric: String, value: Decimal, currency: String?)
    case measurement(metric: String, value: Double, unit: String)
    case timestamp(metric: String, value: String)
    case code(metric: String, value: String)
}

struct AssistantEvidenceToken: Codable, Hashable, Sendable {
    let value: String
}

/// Reviewed, figure-specific transcript affordance. Labels are chosen by the
/// deterministic renderer, never copied from server or model prose.
struct AssistantEvidenceCitation: Codable, Hashable, Sendable {
    let label: String
    let token: AssistantEvidenceToken
}

enum AssistantBusinessFailureKind: String, Codable, Hashable, Sendable {
    case sessionExpired
    case permissionDenied
    case notFound
    case notReady
    case unavailable

    var safeMessage: String {
        switch self {
        case .sessionExpired:
            return "Your session expired. Sign in again."
        case .permissionDenied:
            return "I don't have permission to read that."
        case .notFound:
            return "I couldn't find that record."
        case .notReady:
            return "That Vici data source is not available yet."
        case .unavailable:
            return "I couldn't verify that from Vici right now."
        }
    }
}

struct AssistantBusinessFailure: Error, Codable, Hashable, Sendable {
    let kind: AssistantBusinessFailureKind
    var safeMessage: String { kind.safeMessage }
}

/// A successful response is authoritative even when it contains no rows.
/// Failure is a separate enum case and can therefore never be rendered as 0.
struct AssistantVerifiedBusinessData<Value> {
    let value: Value
    let verifiedAt: String
    let isAuthoritativeEmpty: Bool
}

enum AssistantBusinessOutcome<Value> {
    case available(AssistantVerifiedBusinessData<Value>)
    case unavailable(AssistantBusinessFailure)
}

struct AssistantDataNotice: Codable, Hashable, Sendable {
    let code: String
    let message: String

    static func safe(code rawCode: String) -> AssistantDataNotice {
        let code = rawCode.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "_" }
        let message: String
        if code.contains("TRUNCATED") {
            message = "This source reached its safety limit, so its totals may be incomplete."
        } else if code == "HISTORICAL_BACKFILL_INCOMPLETE" {
            message = "Historical review is incomplete, so live tracking may be more complete than older periods."
        } else if code.hasPrefix("NO_") || code.hasPrefix("PARTIAL_") || code.hasPrefix("UNKNOWN_") {
            message = "Part of the requested history is unavailable, so affected totals may be incomplete."
        } else {
            message = "This source reported a data quality warning."
        }
        return AssistantDataNotice(code: code.isEmpty ? "DATA_QUALITY_WARNING" : code,
                                   message: message)
    }
}

struct AssistantAnalyticsRevenue: Codable, Hashable, Sendable {
    let recovered: Decimal
    let attributed: Decimal
    let influenced: Decimal
    let totalImpact: Decimal
    let unattributed: Decimal
    let refundedAttributed: Decimal
    let direct: Decimal
    let strong: Decimal
}

struct AssistantAnalyticsActivity: Codable, Hashable, Sendable {
    let outboundMessages: Int
    let inboundMessages: Int
    let conversations: Int
    let replies: Int
    let failedMessages: Int
    let completedCalls: Int
    let missedCalls: Int
    let totalTalkSeconds: Double
    let medianFirstResponseSeconds: Double?
    let unansweredConversations: Int
}

struct AssistantAnalyticsSnapshot: Codable, Hashable, Sendable {
    let generatedAt: String
    let currency: String
    let period: String
    let start: String
    let end: String
    let timeZone: String
    let revenueAvailable: Bool
    let messagingAvailable: Bool
    let callsAvailable: Bool
    let revenue: AssistantAnalyticsRevenue
    let activity: AssistantAnalyticsActivity
    let sentimentCode: String?
    let sentimentMessagesAnalysed: Int
    let notices: [AssistantDataNotice]
    let evidence: AssistantEvidenceToken
}

struct AssistantAttributionItem: Codable, Hashable, Sendable {
    let category: String?
    let workflow: String?
    let netAmount: Decimal
    let refundedAmount: Decimal
    let confidence: String
    let confidenceScore: Decimal
    let explanation: String
    let evidenceCodes: [String]
    let actionAt: String?
    let conversionAt: String?
    let invalidated: Bool
    let evidence: AssistantEvidenceToken
}

struct AssistantAttributionSnapshot: Codable, Hashable, Sendable {
    let generatedAt: String
    let currency: String
    let period: String
    let scope: String
    let items: [AssistantAttributionItem]
    let total: Int
    let hasMore: Bool
    let notices: [AssistantDataNotice]
    let evidence: AssistantEvidenceToken
}

struct AssistantAuditSummary: Decodable, Hashable, Sendable {
    let total: Int
    let warnings: Int
    let byCategory: [String: Int]
    let from: String?
    let to: String?

    private enum CodingKeys: String, CodingKey {
        case total, warnings, from, to
        case byCategory = "by_category"
    }
}

struct AssistantActivitySnapshot: Codable, Hashable, Sendable {
    let total: Int
    let warnings: Int
    let byCategory: [String: Int]
    let evidence: AssistantEvidenceToken
}

struct AssistantAutomationSnapshot: Codable, Hashable, Sendable {
    let pending: Int
    let updatedAt: String?
    let evidence: AssistantEvidenceToken
}

struct AssistantSegmentSummary: Codable, Hashable, Sendable {
    let kind: String
    let memberCount: Int
    let lastComputedAt: String?
    let archived: Bool
    let evidence: AssistantEvidenceToken?
}

struct AssistantSegmentListSnapshot: Codable, Hashable, Sendable {
    let items: [AssistantSegmentSummary]
    let total: Int
    let hasMore: Bool
}

enum AssistantSegmentEvidenceStatus: String, Codable, Hashable, Sendable {
    case automatic
    case manualSelection
    case humanOverride
    case unavailable
}

struct AssistantSegmentFact: Codable, Hashable, Sendable {
    let kind: String
    let number: Double?
    let date: String?
    let code: String?
}

struct AssistantSegmentMemberEvidence: Codable, Hashable, Sendable {
    let membershipSource: String
    let status: AssistantSegmentEvidenceStatus
    let detector: String?
    let state: String?
    let confidence: String?
    let cadenceSource: String?
    let ruleVersion: String?
    let engineMatched: Bool?
    let facts: [AssistantSegmentFact]
    let evidence: AssistantEvidenceToken?
}

struct AssistantSegmentDetailSnapshot: Codable, Hashable, Sendable {
    let segment: AssistantSegmentSummary
    let members: [AssistantSegmentMemberEvidence]
    let totalMembers: Int
    let hasMore: Bool
}

struct AssistantSegmentMembershipSnapshot: Codable, Hashable, Sendable {
    let items: [AssistantSegmentMemberEvidence]
    let total: Int
}

struct AssistantCampaignSummary: Codable, Hashable, Sendable {
    let campaignType: String
    let workflowCategory: String
    let status: String
    let revision: Int
    let scheduledFor: String?
    let completedAt: String?
    let updatedAt: String
    let evidence: AssistantEvidenceToken?
}

struct AssistantCampaignListSnapshot: Codable, Hashable, Sendable {
    let items: [AssistantCampaignSummary]
    /// Nil means the count could not be verified. It is never replaced by 0.
    let reviewCount: Int?
    let total: Int
    let hasMore: Bool
}

struct AssistantCampaignPerformanceSnapshot: Codable, Hashable, Sendable {
    let recipients: Int
    let providerAccepted: Int
    let delivered: Int
    let queued: Int
    let failed: Int
    let replies: Int
    let optOuts: Int
    let operationalAvailable: Bool
    let financialAvailable: Bool
    let notices: [AssistantDataNotice]
    let evidence: AssistantEvidenceToken
}

/// An allowlisted projection of one portfolio finding. The detector owns these
/// labels and counts. No customer identity or campaign wording is decoded.
struct AssistantOpportunityFindingWire: Codable, Hashable, Sendable {
    let key: String
    let segmentKey: String?
    let population: Int
    let actionability: AssistantOpportunityActionability
}

struct AssistantOpportunityActionability: Codable, Hashable, Sendable {
    let people: Int
    let floor: Int
    let belowFloor: Bool
}

struct AssistantOpportunityRefusalWire: Codable, Hashable, Sendable {
    let finding: String
    let question: String
    let reason: String
    let population: Int?
}

struct AssistantOpportunityBlockerWire: Codable, Hashable, Sendable {
    let key: String
    let severity: String
}

struct AssistantOpportunityOmissionWire: Codable, Hashable, Sendable {
    let key: String
    let reason: String
}

struct AssistantOpportunityFreshnessWire: Codable, Hashable, Sendable {
    let computedAt: String
    let ageSeconds: Int
    let stale: Bool
    let refreshDebounced: Bool
    let lastRefreshFailure: AssistantOpportunityRefreshFailureWire?
}

struct AssistantOpportunityRefreshFailureWire: Codable, Hashable, Sendable {
    let code: String?
}

struct AssistantOpportunityPortfolioWire: Codable, Hashable, Sendable {
    let detectorVersion: String
    let computedAt: String
    let currency: String
    let findings: [AssistantOpportunityFindingWire]
    let refusals: [AssistantOpportunityRefusalWire]
    let notBuilt: [AssistantOpportunityOmissionWire]
    let blockers: [AssistantOpportunityBlockerWire]
    let freshness: AssistantOpportunityFreshnessWire
}

struct AssistantOpportunityFinding: Codable, Hashable, Sendable {
    let key: String
    let population: Int
    let actionability: AssistantOpportunityActionability
    let evidence: AssistantEvidenceToken?
}

struct AssistantOpportunityRefusal: Codable, Hashable, Sendable {
    let finding: String
    let question: String
    let reason: String
    let population: Int?
}

struct AssistantOpportunityOmission: Codable, Hashable, Sendable {
    let key: String
    let reason: String
}

struct AssistantOpportunityBlocker: Codable, Hashable, Sendable {
    let key: String
    let severity: String
}

struct AssistantOpportunityPortfolioSnapshot: Codable, Hashable, Sendable {
    let detectorVersion: String
    let computedAt: String
    let currency: String
    let stale: Bool
    let ageSeconds: Int
    let refreshFailureCode: String?
    let findings: [AssistantOpportunityFinding]
    let refusals: [AssistantOpportunityRefusal]
    let omissions: [AssistantOpportunityOmission]
    let blockers: [AssistantOpportunityBlocker]
}

struct AssistantReferralSummary: Codable, Hashable, Sendable {
    let targetKind: String
    let state: String
    let createdAt: String
    let updatedAt: String
    let attentionRequired: Bool
    let evidence: AssistantEvidenceToken?
}

struct AssistantReferralListSnapshot: Codable, Hashable, Sendable {
    let items: [AssistantReferralSummary]
    /// The current backend caps this list at 200 and does not report whether
    /// more rows exist. False means callers must not claim this is exhaustive.
    let exhaustive: Bool
}
