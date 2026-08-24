import Foundation

/// A bounded, review-only projection of `GET /api/campaign-proposals`.
///
/// The server response also contains persistence and model provenance fields.
/// They are deliberately not represented here because the iOS review screen
/// does not need them. Recipient/customer/order keys are rejected rather than
/// ignored if a future backend accidentally adds them to anything we decode.
struct CampaignProposalPage: Codable, Hashable, Sendable {
    let items: [CampaignProposal]
    let page: Int
    let pageSize: Int
    let total: Int
    let withheld: Int

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([CampaignProposal].self, forKey: .items)
        page = try values.decode(Int.self, forKey: .page)
        pageSize = try values.decode(Int.self, forKey: .pageSize)
        total = try values.decode(Int.self, forKey: .total)
        withheld = try values.decode(Int.self, forKey: .withheld)
        guard page >= 1, (1...50).contains(pageSize), total >= 0,
              total <= CampaignProposalPagingPolicy.maximumReportedRows,
              withheld >= 0, items.count <= pageSize, total >= items.count,
              let maximumPage = CampaignProposalPagingPolicy.maximumPage(
                total: total, pageSize: pageSize
              ),
              page <= maximumPage else {
            throw CampaignProposalDecoding.invalid(decoder, "Malformed proposal page bounds.")
        }
    }

    var hasMore: Bool {
        CampaignProposalPagingPolicy.hasPage(after: page, pageSize: pageSize, total: total)
    }
}

/// Pure bounded paging policy for a queue whose server count is calculated
/// before unsafe rows are withheld from each page.
enum CampaignProposalPagingPolicy {
    /// A defensive client ceiling, far above the current queue, prevents one
    /// malformed count from causing an effectively unbounded sequence of GETs.
    static let maximumReportedRows = 10_000

    static func maximumPage(total: Int, pageSize: Int) -> Int? {
        guard total >= 0, total <= maximumReportedRows,
              (1...50).contains(pageSize) else { return nil }
        guard total > 0 else { return 1 }
        let completePages = total / pageSize
        return completePages + (total % pageSize == 0 ? 0 : 1)
    }

    static func hasPage(after page: Int, pageSize: Int, total: Int) -> Bool {
        guard page >= 1,
              let maximumPage = maximumPage(total: total, pageSize: pageSize) else { return false }
        return page < maximumPage
    }

    static func nextPage(after page: Int,
                         pageSize: Int,
                         total: Int,
                         visibleCount: Int) -> Int? {
        guard page >= 1, (1...50).contains(pageSize), total >= 0,
              visibleCount >= 0, visibleCount <= pageSize else { return nil }
        guard visibleCount == 0 else { return nil }
        guard let maximumPage = maximumPage(total: total, pageSize: pageSize),
              page < maximumPage else { return nil }
        return page + 1
    }
}

struct CampaignProposal: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let opportunityKind: String
    let opportunityTitle: String
    let mechanism: String
    let mechanismLabel: String
    let distinctnessClass: String
    let title: String
    let audience: CampaignProposalAudience
    let offer: CampaignProposalOffer
    let copy: CampaignProposalCopy
    let costs: [CampaignProposalCost]
    let risks: [CampaignProposalRisk]
    let status: String
    let createdAt: String
    let updatedAt: String

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try CampaignProposalDecoding.identifier(values.decode(String.self, forKey: .id),
                                                     decoder: decoder)
        opportunityKind = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .opportunityKind), decoder: decoder
        )
        opportunityTitle = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .opportunityTitle), maximum: 300, decoder: decoder
        )
        mechanism = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .mechanism), decoder: decoder
        )
        mechanismLabel = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .mechanismLabel), maximum: 160, decoder: decoder
        )
        distinctnessClass = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .distinctnessClass), decoder: decoder
        )
        title = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .title), maximum: 300, decoder: decoder
        )
        audience = try values.decode(CampaignProposalAudience.self, forKey: .audience)
        offer = try values.decode(CampaignProposalOffer.self, forKey: .offer)
        copy = try values.decode(CampaignProposalCopy.self, forKey: .copy)
        costs = try CampaignProposalDecoding.bounded(
            values.decode([CampaignProposalCost].self, forKey: .costs), maximum: 12, decoder: decoder
        )
        risks = try CampaignProposalDecoding.bounded(
            values.decode([CampaignProposalRisk].self, forKey: .risks), maximum: 12, decoder: decoder
        )
        status = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .status), decoder: decoder
        )
        createdAt = try CampaignProposalDecoding.timestamp(
            values.decode(String.self, forKey: .createdAt), decoder: decoder
        )
        updatedAt = try CampaignProposalDecoding.timestamp(
            values.decode(String.self, forKey: .updatedAt), decoder: decoder
        )
        guard status == "proposed" else {
            throw CampaignProposalDecoding.invalid(decoder, "Only proposed items are reviewable here.")
        }
    }
}

struct CampaignProposalAudience: Codable, Hashable, Sendable {
    let kind: String
    let cohortLabel: String
    let cohortSize: Int
    let cohortSizeBasis: String
    let plainEnglish: String
    let requiresSegment: Bool
    let narrowedBy: String?
    let narrowingSkipped: String?

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try CampaignProposalDecoding.code(values.decode(String.self, forKey: .kind), decoder: decoder)
        cohortLabel = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .cohortLabel), maximum: 200, decoder: decoder
        )
        cohortSize = try values.decode(Int.self, forKey: .cohortSize)
        cohortSizeBasis = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .cohortSizeBasis), decoder: decoder
        )
        plainEnglish = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .plainEnglish), maximum: 1_000, decoder: decoder
        )
        requiresSegment = try values.decode(Bool.self, forKey: .requiresSegment)
        narrowedBy = try CampaignProposalDecoding.optionalText(
            values.decodeIfPresent(String.self, forKey: .narrowedBy), maximum: 500, decoder: decoder
        )
        narrowingSkipped = try CampaignProposalDecoding.optionalText(
            values.decodeIfPresent(String.self, forKey: .narrowingSkipped), maximum: 700, decoder: decoder
        )
        guard cohortSize >= 0 else {
            throw CampaignProposalDecoding.invalid(decoder, "A cohort size cannot be negative.")
        }
    }
}

struct CampaignProposalOffer: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Hashable, Sendable {
        case none
        case shippingConcession = "shipping_concession"
        case assortmentChange = "assortment_change"
        case monetaryDiscount = "monetary_discount"
    }

    let kind: Kind
    let appliedBy: String?
    let termsRequiredFromHuman: [String]
    let statedInCopy: Bool
    let note: String

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(Kind.self, forKey: .kind)
        appliedBy = try values.decodeIfPresent(String.self, forKey: .appliedBy)
            .map { try CampaignProposalDecoding.code($0, decoder: decoder) }
        termsRequiredFromHuman = try CampaignProposalDecoding.boundedText(
            values.decode([String].self, forKey: .termsRequiredFromHuman),
            count: 12, length: 500, decoder: decoder
        )
        statedInCopy = try values.decode(Bool.self, forKey: .statedInCopy)
        note = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .note), maximum: 1_000, decoder: decoder
        )

        guard statedInCopy == false else {
            throw CampaignProposalDecoding.invalid(decoder, "Structured offer terms must not be stated in draft copy.")
        }
        switch kind {
        case .none:
            guard appliedBy == nil, termsRequiredFromHuman.isEmpty else {
                throw CampaignProposalDecoding.invalid(decoder, "A no-offer control cannot carry offer terms.")
            }
        default:
            guard appliedBy == "human_at_review", !termsRequiredFromHuman.isEmpty else {
                throw CampaignProposalDecoding.invalid(decoder, "An offer requires human-owned terms.")
            }
        }
    }

    var isIntentionalNoOffer: Bool { kind == .none }
}

struct CampaignProposalCopy: Codable, Hashable, Sendable {
    let text: String
    let septets: Int
    let validated: Bool
    let failedChecks: [String]
    let copyRulesVersion: String

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        text = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .text), maximum: 1_000, decoder: decoder,
            permitLineBreaks: true
        )
        septets = try values.decode(Int.self, forKey: .septets)
        validated = try values.decode(Bool.self, forKey: .validated)
        failedChecks = try CampaignProposalDecoding.bounded(
            values.decode([String].self, forKey: .failedChecks), maximum: 20, decoder: decoder
        )
        copyRulesVersion = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .copyRulesVersion), decoder: decoder
        )
        guard septets > 0, septets <= 1_000, validated, failedChecks.isEmpty else {
            throw CampaignProposalDecoding.invalid(decoder, "Unvalidated proposal copy was refused.")
        }
    }
}

struct CampaignProposalCost: Codable, Hashable, Sendable {
    let id: String
    let statement: String

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try CampaignProposalDecoding.code(values.decode(String.self, forKey: .id), decoder: decoder)
        statement = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .statement), maximum: 1_000, decoder: decoder
        )
    }
}

struct CampaignProposalRisk: Codable, Hashable, Sendable {
    let id: String
    let statement: String
    let severity: String
    let evidence: String
    let source: String

    init(from decoder: Decoder) throws {
        try CampaignProposalDecoding.rejectSensitiveKeys(in: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try CampaignProposalDecoding.code(values.decode(String.self, forKey: .id), decoder: decoder)
        statement = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .statement), maximum: 1_500, decoder: decoder
        )
        severity = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .severity), decoder: decoder
        )
        evidence = try CampaignProposalDecoding.code(
            values.decode(String.self, forKey: .evidence), decoder: decoder
        )
        source = try CampaignProposalDecoding.text(
            values.decode(String.self, forKey: .source), maximum: 300, decoder: decoder
        )
        guard ["moderate", "high"].contains(severity),
              ["assumption", "research_backed"].contains(evidence) else {
            throw CampaignProposalDecoding.invalid(decoder, "Unknown proposal risk classification.")
        }
    }
}

private enum CampaignProposalDecoding {
    private static let forbiddenKeyFragments = [
        "recipient", "phone", "contact", "customer", "order", "email",
        "password", "secret", "token", "credential", "authorization", "cookie"
    ]

    static func rejectSensitiveKeys(in decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CampaignProposalDynamicKey.self)
        let hasSensitiveKey = container.allKeys.contains { key in
            let normalised = key.stringValue
                .lowercased()
                .filter { $0.isLetter || $0.isNumber }
            return forbiddenKeyFragments.contains { normalised.contains($0) }
        }
        guard !hasSensitiveKey else {
            throw invalid(decoder, "A proposal response contained an unsupported sensitive field.")
        }
    }

    static func identifier(_ value: String, decoder: Decoder) throws -> String {
        try text(value, maximum: 128, decoder: decoder)
    }

    static func code(_ value: String, decoder: Decoder) throws -> String {
        let result = try text(value, maximum: 128, decoder: decoder)
        let allowed = CharacterSet.lowercaseLetters
            .union(.decimalDigits)
            .union(CharacterSet(charactersIn: "_-./"))
        guard result.unicodeScalars.allSatisfy(allowed.contains) else {
            throw invalid(decoder, "Malformed proposal code.")
        }
        return result
    }

    static func text(_ value: String,
                     maximum: Int,
                     decoder: Decoder,
                     permitLineBreaks: Bool = false) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowedWhitespace = permitLineBreaks
            ? CharacterSet(charactersIn: "\n\r\t")
            : CharacterSet()
        let forbiddenControls = CharacterSet.controlCharacters.subtracting(allowedWhitespace)
        guard !trimmed.isEmpty, trimmed.count <= maximum,
              !trimmed.unicodeScalars.contains(where: forbiddenControls.contains) else {
            throw invalid(decoder, "Malformed proposal text.")
        }
        return trimmed
    }

    static func optionalText(_ value: String?, maximum: Int, decoder: Decoder) throws -> String? {
        guard let value else { return nil }
        return try text(value, maximum: maximum, decoder: decoder)
    }

    static func timestamp(_ value: String, decoder: Decoder) throws -> String {
        guard value.count <= 40, ServerDate.parse(value) != nil else {
            throw invalid(decoder, "Malformed proposal timestamp.")
        }
        return value
    }

    static func bounded<Value>(_ values: [Value], maximum: Int, decoder: Decoder) throws -> [Value] {
        guard values.count <= maximum else { throw invalid(decoder, "Proposal list exceeded its bound.") }
        return values
    }

    static func boundedText(_ values: [String],
                            count: Int,
                            length: Int,
                            decoder: Decoder) throws -> [String] {
        try bounded(values, maximum: count, decoder: decoder).map {
            try text($0, maximum: length, decoder: decoder)
        }
    }

    static func invalid(_ decoder: Decoder, _ description: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: description))
    }
}

private struct CampaignProposalDynamicKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}
