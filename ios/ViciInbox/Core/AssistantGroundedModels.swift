import Foundation

/// A value-only identity fence captured when a question or evidence tap starts.
/// Role, both shared-session flags, and the complete sorted permission set are
/// included so an in-place access change is treated as an identity boundary.
struct AssistantIdentitySnapshot: Equatable, Sendable {
    let userID: String
    let role: String
    let isLegacyShared: Bool
    let viaLegacySession: Bool
    let permissions: [String]

    init(user: AuthUser) {
        userID = user.id
        role = user.role?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        isLegacyShared = user.isLegacyShared ?? false
        viaLegacySession = user.viaLegacySession ?? false
        permissions = Array(user.permissionSet).sorted()
    }

    var permissionSet: Set<String> { Set(permissions) }

    /// Used only as SwiftUI change identity. It is never persisted or logged.
    var stableKey: String {
        [userID, role, isLegacyShared ? "legacy" : "named",
         viaLegacySession ? "legacy-session" : "named-session",
         permissions.joined(separator: ",")].joined(separator: "|")
    }
}

/// The deliberately small Phase 7 question vocabulary. A request outside this
/// list stays behind the Phase 6 default-deny boundary. The on-device model does
/// not choose an intent, identifier, permission, or reporting period.
struct AssistantBusinessContext: Equatable, Sendable {
    let segmentID: String?
    let memberPhone: String?

    static let empty = AssistantBusinessContext(segmentID: nil, memberPhone: nil)

    var segmentEvidenceTarget: AssistantSegmentEvidenceTarget? {
        let segment = segmentID.flatMap(Self.safeIdentifier)
        let phone = memberPhone.flatMap(Self.safePhone)
        if let segment, let phone { return .member(segmentID: segment, phone: phone) }
        if let segment { return .segment(id: segment) }
        if let phone { return .memberships(phone: phone) }
        return nil
    }

    private static func safeIdentifier(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128,
              trimmed.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
        return trimmed
    }

    private static func safePhone(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 32 else { return nil }
        let allowed = CharacterSet.decimalDigits.union(CharacterSet(charactersIn: "+"))
        guard trimmed.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return trimmed
    }
}

enum AssistantSegmentEvidenceTarget: Equatable, Sendable {
    case segment(id: String)
    case member(segmentID: String, phone: String)
    case memberships(phone: String)
}

enum AssistantBusinessIntent: Equatable, Sendable {
    case executiveBrief
    case analytics(AnalyticsPeriod)
    case activity
    case automation
    case segments
    case segmentEvidence(AssistantSegmentEvidenceTarget)
    case campaigns
    case opportunities
    case referrals

    static func parse(_ input: String,
                      context: AssistantBusinessContext = .empty) -> AssistantBusinessIntent? {
        switch normalise(input) {
        case "anything i need to know", "what do i need to know", "give me an executive brief":
            return .executiveBrief
        case "show analytics", "show me analytics", "analytics this month", "revenue this month":
            return .analytics(.month)
        case "analytics today", "revenue today":
            return .analytics(.today)
        case "analytics this week", "revenue this week":
            return .analytics(.week)
        case "analytics this year", "revenue this year":
            return .analytics(.year)
        case "analytics all time", "revenue all time":
            return .analytics(.all)
        case "activity summary", "show activity":
            return .activity
        case "automation status", "show automations":
            return .automation
        case "segment summary", "show segments", "how many segments":
            return .segments
        case "show stored segment evidence", "explain segment membership",
             "show me why they are in it", "why are they in it":
            return context.segmentEvidenceTarget.map(Self.segmentEvidence)
        case "campaign status", "show campaigns", "how many campaigns need review":
            return .campaigns
        case "show opportunities", "what is the biggest opportunity", "what are the opportunities":
            return .opportunities
        case "referral status", "show referrals", "any referrals":
            return .referrals
        default:
            return nil
        }
    }

    var requiredPermissions: Set<String> {
        switch self {
        case .executiveBrief:
            return []
        case .analytics:
            return [Permission.analyticsRead]
        case .activity:
            return [Permission.auditRead]
        case .automation:
            return [Permission.automationRead]
        case .segments, .segmentEvidence, .campaigns, .opportunities:
            return [Permission.campaignsRead]
        case .referrals:
            return [Permission.referralRead]
        }
    }

    private static func normalise(_ input: String) -> String {
        input
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

struct AssistantGroundedResponse: Equatable, Sendable {
    let text: String
    let citations: [AssistantEvidenceCitation]

    static let unverified = AssistantGroundedResponse(
        text: "I could not verify that from Vici right now.",
        citations: []
    )
}

/// A MainActor seam for the Xcode 26 Foundation Models tool session. Tests can
/// provide deterministic operations without importing the framework.
@MainActor
struct AssistantBusinessReasoningOperations {
    let respond: (AssistantBusinessIntent, String, Set<String>) async throws -> AssistantGroundedResponse
    let evidenceRoute: (AssistantEvidenceToken, AssistantIdentitySnapshot) async -> AppRoute?
    let releaseEvidence: ([AssistantEvidenceToken]) async -> Void
    let reset: () -> Void
}

/// Converts private, registry-validated claims into the only business text that
/// can enter the transcript or TTS. `modelText` exists to make the trust boundary
/// explicit and testable. It is intentionally never read.
enum AssistantGroundedRenderer {
    static func render(intent: AssistantBusinessIntent,
                       references: [AssistantEvidenceReference],
                       modelText: String?) -> AssistantGroundedResponse {
        _ = modelText
        let text: String?
        var citations: [AssistantEvidenceCitation] = []

        func cite(_ label: String, _ reference: AssistantEvidenceReference) {
            let citation = AssistantEvidenceCitation(label: label, token: reference.token)
            if !citations.contains(citation) { citations.append(citation) }
        }

        switch intent {
        case .executiveBrief:
            var parts: [String] = []
            if let recovered = decimal("recovered_revenue", in: references) {
                parts.append("Recovered revenue this month is \(money(recovered.value, currency: recovered.currency)).")
                cite("Recovered revenue", recovered.reference)
            }
            if let review = integer("campaign_review_count", in: references) {
                parts.append("\(review.value) campaign\(review.value == 1 ? "" : "s") need review.")
                cite("Campaign review count", review.reference)
            }
            if let opportunities = integer("opportunity_count", in: references),
               let stale = booleanCode("opportunity_stale", in: references) {
                parts.append(stale.value
                    ? "The latest stored opportunity review is stale and contains \(opportunities.value) finding\(opportunities.value == 1 ? "" : "s")."
                    : "The current opportunity review contains \(opportunities.value) finding\(opportunities.value == 1 ? "" : "s").")
                cite("Opportunity finding count", opportunities.reference)
                cite("Opportunity freshness", stale.reference)
            }
            if let attention = integer("referral_attention_count", in: references),
               let exhaustive = booleanCode("referral_exhaustive", in: references) {
                parts.append(exhaustive.value
                    ? "\(attention.value) referral\(attention.value == 1 ? " is" : "s are") marked for attention."
                    : "Among the visible referrals, \(attention.value) \(attention.value == 1 ? "is" : "are") marked for attention; the list may be incomplete.")
                cite("Referrals needing attention", attention.reference)
                cite("Referral list completeness", exhaustive.reference)
            }
            text = parts.isEmpty ? nil : parts.prefix(4).joined(separator: " ")

        case .analytics(let period):
            var parts: [String] = []
            if let recovered = decimal("recovered_revenue", in: references) {
                parts.append("Recovered revenue for \(periodLabel(period)) is \(money(recovered.value, currency: recovered.currency)).")
                cite("Recovered revenue", recovered.reference)
            }
            if let influenced = decimal("influenced_revenue", in: references) {
                parts.append("Influenced revenue is \(money(influenced.value, currency: influenced.currency)).")
                cite("Influenced revenue", influenced.reference)
            }
            text = parts.isEmpty ? nil : parts.prefix(4).joined(separator: " ")

        case .activity:
            guard let total = integer("activity_total", in: references),
                  let warnings = integer("activity_warnings", in: references) else { text = nil; break }
            text = "The verified activity summary contains \(total.value) event\(total.value == 1 ? "" : "s") and \(warnings.value) warning\(warnings.value == 1 ? "" : "s")."
            cite("Activity event count", total.reference)
            cite("Activity warning count", warnings.reference)

        case .automation:
            guard let pending = integer("automation_pending", in: references) else { text = nil; break }
            text = "There \(pending.value == 1 ? "is" : "are") \(pending.value) pending automation\(pending.value == 1 ? "" : "s")."
            cite("Pending automations", pending.reference)

        case .segments:
            guard let total = integer("segment_total", in: references) else { text = nil; break }
            text = "There \(total.value == 1 ? "is" : "are") \(total.value) saved segment\(total.value == 1 ? "" : "s"). Open the evidence to review membership details."
            cite("Saved segment count", total.reference)

        case .segmentEvidence(let target):
            text = segmentEvidenceText(target: target,
                                       references: references,
                                       cite: cite)

        case .campaigns:
            guard let total = integer("campaign_total", in: references) else { text = nil; break }
            cite("Campaign count", total.reference)
            if let review = integer("campaign_review_count", in: references) {
                text = "There \(total.value == 1 ? "is" : "are") \(total.value) campaign\(total.value == 1 ? "" : "s"), with \(review.value) waiting for review."
                cite("Campaign review count", review.reference)
            } else {
                text = "There \(total.value == 1 ? "is" : "are") \(total.value) verified campaign\(total.value == 1 ? "" : "s"). The review count could not be verified."
            }

        case .opportunities:
            guard let total = integer("opportunity_count", in: references),
                  let actionable = integer("opportunity_actionable_count", in: references),
                  let stale = booleanCode("opportunity_stale", in: references) else { text = nil; break }
            text = stale.value
                ? "The latest stored opportunity review is stale and contains \(total.value) finding\(total.value == 1 ? "" : "s"). \(actionable.value) meet the actionability floor. Open it before acting."
                : "The current opportunity review contains \(total.value) finding\(total.value == 1 ? "" : "s"). \(actionable.value) meet the actionability floor."
            cite("Opportunity finding count", total.reference)
            cite("Actionable finding count", actionable.reference)
            cite("Opportunity freshness", stale.reference)

        case .referrals:
            guard let total = integer("referral_count", in: references),
                  let attention = integer("referral_attention_count", in: references),
                  let exhaustive = booleanCode("referral_exhaustive", in: references) else { text = nil; break }
            text = exhaustive.value
                ? "There \(total.value == 1 ? "is" : "are") \(total.value) unresolved referral\(total.value == 1 ? "" : "s") in the received list. \(attention.value) are marked for attention."
                : "At least \(total.value) unresolved referral\(total.value == 1 ? " is" : "s are") visible. Among the visible referrals, \(attention.value) \(attention.value == 1 ? "is" : "are") marked for attention. The server did not confirm that the list is complete."
            cite("Unresolved referral count", total.reference)
            cite("Referrals needing attention", attention.reference)
            cite("Referral list completeness", exhaustive.reference)
        }

        guard let text, let clean = AssistantOutputPolicy.sanitise(text) else {
            return .unverified
        }
        guard !citations.isEmpty else { return .unverified }
        return AssistantGroundedResponse(text: clean, citations: Array(citations.prefix(8)))
    }

    private static func integer(_ metric: String,
                                in references: [AssistantEvidenceReference],
                                scope: AssistantEvidenceScope = .aggregate)
        -> (value: Int, reference: AssistantEvidenceReference)? {
        var matches: [(Int, AssistantEvidenceReference)] = []
        for reference in references where reference.scope == scope {
            for claim in reference.claims {
                if case .integer(let name, let value) = claim, name == metric, value >= 0 {
                    matches.append((value, reference))
                }
            }
        }
        guard matches.count == 1, let match = matches.first else { return nil }
        return (match.0, match.1)
    }

    private static func decimal(_ metric: String,
                                in references: [AssistantEvidenceReference])
        -> (value: Decimal, currency: String?, reference: AssistantEvidenceReference)? {
        var matches: [(Decimal, String?, AssistantEvidenceReference)] = []
        for reference in references where reference.scope == .aggregate {
            for claim in reference.claims {
                if case .decimal(let name, let value, let currency) = claim,
                   name == metric, value >= 0 {
                    matches.append((value, currency, reference))
                }
            }
        }
        guard matches.count == 1, let match = matches.first else { return nil }
        return (match.0, match.1, match.2)
    }

    private static func code(_ metric: String,
                             in references: [AssistantEvidenceReference],
                             scope: AssistantEvidenceScope = .aggregate)
        -> (value: String, reference: AssistantEvidenceReference)? {
        var matches: [(String, AssistantEvidenceReference)] = []
        for reference in references where reference.scope == scope {
            for claim in reference.claims {
                if case .code(let name, let value) = claim, name == metric {
                    matches.append((value, reference))
                }
            }
        }
        guard matches.count == 1, let match = matches.first else { return nil }
        return (match.0, match.1)
    }

    private static func booleanCode(_ metric: String,
                                    in references: [AssistantEvidenceReference])
        -> (value: Bool, reference: AssistantEvidenceReference)? {
        guard let result = code(metric, in: references),
              result.value == "true" || result.value == "false" else { return nil }
        return (result.value == "true", result.reference)
    }

    private static func measurement(_ metric: String,
                                    in references: [AssistantEvidenceReference])
        -> (value: Double, unit: String, reference: AssistantEvidenceReference)? {
        var matches: [(Double, String, AssistantEvidenceReference)] = []
        for reference in references where reference.scope == .record {
            for claim in reference.claims {
                if case .measurement(let name, let value, let unit) = claim,
                   name == metric, value.isFinite, value >= 0 {
                    matches.append((value, unit, reference))
                }
            }
        }
        guard matches.count == 1, let match = matches.first else { return nil }
        return (match.0, match.1, match.2)
    }

    private static func segmentEvidenceText(
        target: AssistantSegmentEvidenceTarget,
        references: [AssistantEvidenceReference],
        cite: (String, AssistantEvidenceReference) -> Void
    ) -> String? {
        switch target {
        case .segment:
            guard let total = integer("segment_evidence_member_total", in: references),
                  let reviewed = integer("segment_evidence_reviewed_count", in: references),
                  let automatic = integer("segment_evidence_automatic_count", in: references),
                  let hasMore = booleanCode("segment_evidence_has_more", in: references) else { return nil }
            cite("Segment member count", total.reference)
            cite("Evidence records reviewed", reviewed.reference)
            cite("Automatic evidence count", automatic.reference)
            cite("Evidence result completeness", hasMore.reference)
            return hasMore.value
                ? "This segment has \(total.value) members. In the first \(reviewed.value) stored evidence records, \(automatic.value) use allowlisted automatic evidence. Open the segment to review each member."
                : "This segment has \(total.value) members. Across \(reviewed.value) stored evidence records, \(automatic.value) use allowlisted automatic evidence. Open the segment to review each member."

        case .memberships:
            guard let total = integer("membership_total", in: references),
                  let reviewed = integer("membership_reviewed_count", in: references),
                  let automatic = integer("membership_automatic_count", in: references) else { return nil }
            cite("Stored membership count", total.reference)
            cite("Memberships reviewed", reviewed.reference)
            cite("Automatic membership evidence", automatic.reference)
            return "This customer has \(total.value) stored segment membership\(total.value == 1 ? "" : "s"). The bounded review checked \(reviewed.value), and \(automatic.value) use allowlisted automatic evidence."

        case .member:
            guard let status = code("evidence_status", in: references, scope: .record) else { return nil }
            cite("Membership evidence classification", status.reference)
            switch status.value {
            case AssistantSegmentEvidenceStatus.automatic.rawValue:
                var facts: [String] = []
                if let purchases = measurement("purchase_count", in: references) {
                    facts.append("\(number(purchases.value)) purchase\(purchases.value == 1 ? "" : "s")")
                    cite("Stored purchase count", purchases.reference)
                }
                if let days = measurement("days_since_last_order", in: references) {
                    facts.append("\(number(days.value)) days since the last order")
                    cite("Days since last order", days.reference)
                }
                if let cadence = measurement("median_interval_days", in: references) {
                    facts.append("a \(number(cadence.value))-day median interval")
                    cite("Stored median interval", cadence.reference)
                }
                if facts.isEmpty {
                    return "This membership has allowlisted automatic evidence, but no supported numeric reason was available to state. Open the evidence for the stored classification."
                }
                return "The stored automatic evidence records \(facts.prefix(3).joined(separator: ", "))."
            case AssistantSegmentEvidenceStatus.manualSelection.rawValue:
                return "This is recorded as a manual selection. Human-entered prose is not exposed to the Assistant."
            case AssistantSegmentEvidenceStatus.humanOverride.rawValue:
                return "This is recorded as a human override. Human-entered prose is not exposed to the Assistant."
            default:
                return "The stored membership exists, but an allowlisted automatic reason is not available."
            }
        }
    }

    private static func number(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.1f", value)
    }

    private static func money(_ value: Decimal, currency: String?) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        formatter.currencyCode = currency ?? "USD"
        formatter.maximumFractionDigits = 2
        return formatter.string(from: value as NSDecimalNumber)
            ?? "\(currency ?? "USD") \(NSDecimalNumber(decimal: value).stringValue)"
    }

    private static func periodLabel(_ period: AnalyticsPeriod) -> String {
        switch period {
        case .today: return "today"
        case .week: return "this week"
        case .month: return "this month"
        case .year: return "this year"
        case .all: return "all time"
        case .custom: return "the selected period"
        }
    }
}

enum AssistantEvidenceRouteResolver {
    static func route(for reference: AssistantEvidenceReference,
                      permissions: Set<String>) -> AppRoute? {
        guard permissions.contains(reference.requiredPermission.rawValue) else { return nil }
        switch reference.destination {
        case .analyticsAttributions(let period, let start, let end, let scope, let category):
            return .analyticsAttributions(period: period, start: start, end: end,
                                          scope: scope, category: category)
        case .activity(let category):
            return .activity(category: category)
        case .automations:
            return .growth(.automations)
        case .opportunities:
            return .opportunities
        case .campaigns:
            return .growth(.campaigns)
        case .campaign(let id):
            return .campaign(id: id)
        case .campaignAttributions(let id):
            return .campaignAttributions(campaignID: id)
        case .segments:
            return .growth(.audiences)
        case .segment(let id, let name):
            return .segment(id: id, name: name)
        case .segmentMember(let segmentID, _):
            return .segment(id: segmentID, name: nil)
        case .referrals:
            return .referrals
        case .referral(let id, let phone):
            return .referral(id: id, phone: phone)
        }
    }
}
