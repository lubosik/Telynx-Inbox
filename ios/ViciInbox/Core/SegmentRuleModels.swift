import Foundation

/// Describing a segment in words: the client half of `POST /api/segments/rules`,
/// `/rules/draft` and `/rules/preview`.
///
/// THE SHAPE OF THE FEATURE, BECAUSE IT IS NOT OBVIOUS FROM THE TYPES
///   The model drafts RULES. It does not create a segment and it never returns
///   people. The operator reads the rules in plain English, edits them, sees a
///   real count from real data, and only then saves. Every one of those is a
///   separate request, and the order is enforced on this side by
///   `SegmentRuleBuilderModel`: `canSave` is false until a preview of the
///   CURRENT rules has come back.
///
/// TWO DELIBERATE DEPARTURES FROM SegmentModels.swift
///   1. `CodingKeys`. That file says the segment API renames every column
///      before it leaves the server so nothing needs a key map. True there,
///      not here: the wire key for a comparison is literally `operator`, which
///      is a Swift keyword. One property is mapped, and only one.
///   2. `JSONValue` for a condition's value. A value is a number, a date
///      string, a two-element range, or a list of product keys depending on
///      the dimension, and the server is the authority on which. Decoding it
///      into a closed Swift enum here would mean this file had to be updated
///      in step with a server-side grammar change or it would start dropping
///      conditions on the floor. It carries the value opaquely and edits only
///      the shapes it recognises.
///
/// This is a Foundation-only file on purpose. It is covered by the
/// `swiftc -typecheck` command in AGENTS.md, and the interpretation lives here
/// rather than in a view so that the interpretation is the part that is checked.

// MARK: - The rule set

/// One condition. `dimension` and `comparison` are server vocabulary and are
/// never shown raw: the readable form is `SegmentRulePlainEnglish.lines`, which
/// the server renders from the same validated rules.
struct SegmentRuleCondition: Codable, Hashable, Identifiable {
    var dimension: String
    var comparison: String
    var value: JSONValue
    /// Present only on the dimension that counts orders of one product.
    var product: String?
    /// The resolved human name of a product or segment. SERVER-DERIVED: the
    /// backend overwrites whatever arrives here from the live catalogue, so
    /// editing it locally would change nothing and is not offered.
    var label: JSONValue?

    enum CodingKeys: String, CodingKey {
        case dimension
        case comparison = "operator"
        case value
        case product
        case label
    }

    /// Stable within one rule set, which is all a `ForEach` needs. Conditions
    /// have no server identity; they are positional inside their rule set.
    var id: String { "\(dimension)|\(comparison)|\(product ?? "")|\(value.displayText)" }

    // MARK: What can be edited on a phone

    /// A single number, when this condition holds one.
    var singleNumber: Double? {
        guard case .number(let value) = value else { return nil }
        return value
    }

    /// A two-number range, when this condition holds one.
    var numberRange: (low: Double, high: Double)? {
        guard case .array(let items) = value, items.count == 2,
              case .number(let low) = items[0], case .number(let high) = items[1] else { return nil }
        return (low, high)
    }

    /// A single `YYYY-MM-DD`, when this condition holds one.
    var singleDate: String? {
        guard case .string(let text) = value, SegmentRuleDate.isCalendarDate(text) else { return nil }
        return text
    }

    /// A two-date range, when this condition holds one.
    var dateRange: (from: String, to: String)? {
        guard case .array(let items) = value, items.count == 2,
              case .string(let from) = items[0], case .string(let to) = items[1],
              SegmentRuleDate.isCalendarDate(from), SegmentRuleDate.isCalendarDate(to) else { return nil }
        return (from, to)
    }

    /// Whether this screen can offer an edit at all.
    ///
    /// Numbers and dates cover the corrections that actually happen: an
    /// off-by-one on "more than twice", or the wrong month. A list of products
    /// or a set of confidence levels is not edited here, because choosing a
    /// different product is choosing a different rule and the honest way to do
    /// that is to describe it again.
    var isEditableHere: Bool {
        singleNumber != nil || numberRange != nil || singleDate != nil || dateRange != nil
    }

    var editKind: SegmentRuleEditKind {
        if singleNumber != nil { return .number }
        if numberRange != nil { return .numberRange }
        if singleDate != nil { return .date }
        if dateRange != nil { return .dateRange }
        return .notEditable
    }

    /// Whole numbers stay whole. `order_count` and the two product counts are
    /// integers on the server and a fractional value is refused, so the editor
    /// must not be able to produce one.
    var wantsWholeNumbers: Bool {
        SegmentRuleDimension.wholeNumberDimensions.contains(dimension)
    }

    func settingNumber(_ number: Double) -> SegmentRuleCondition {
        var copy = self
        copy.value = .number(wantsWholeNumbers ? number.rounded() : number)
        return copy
    }

    func settingRange(low: Double, high: Double) -> SegmentRuleCondition {
        var copy = self
        let orderedLow = min(low, high)
        let orderedHigh = max(low, high)
        copy.value = .array([
            .number(wantsWholeNumbers ? orderedLow.rounded() : orderedLow),
            .number(wantsWholeNumbers ? orderedHigh.rounded() : orderedHigh)
        ])
        return copy
    }

    func settingDate(_ date: String) -> SegmentRuleCondition {
        guard SegmentRuleDate.isCalendarDate(date) else { return self }
        var copy = self
        copy.value = .string(date)
        return copy
    }

    func settingDateRange(from: String, to: String) -> SegmentRuleCondition {
        guard SegmentRuleDate.isCalendarDate(from), SegmentRuleDate.isCalendarDate(to) else { return self }
        var copy = self
        copy.value = .array([.string(min(from, to)), .string(max(from, to))])
        return copy
    }
}

enum SegmentRuleEditKind: Hashable {
    case number
    case numberRange
    case date
    case dateRange
    case notEditable
}

/// The dimensions this client knows something extra about.
///
/// It is NOT a copy of the server whitelist and must not become one. The
/// server decides what is legal; this is only the handful of hints the editor
/// needs to avoid producing a value the server will refuse.
enum SegmentRuleDimension {
    static let wholeNumberDimensions: Set<String> = [
        "order_count", "days_since_last_order", "product_order_count"
    ]
}

/// `match: "all" | "any"`, decoded leniently so one unrecognised value cannot
/// blank a whole rule set.
enum SegmentRuleMatch: String, Codable, Hashable {
    case all
    case any

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SegmentRuleMatch(rawValue: raw) ?? .all
    }

    var label: String {
        switch self {
        case .all: return "Everything below has to be true"
        case .any: return "Any one of these is enough"
        }
    }

    var short: String {
        switch self {
        case .all: return "All"
        case .any: return "Any"
        }
    }
}

/// A validated rule set as the server returns it, and as it is posted back.
struct SegmentRuleSet: Codable, Hashable {
    var version: Int?
    var schemaVersion: String?
    var match: SegmentRuleMatch
    var conditions: [SegmentRuleCondition]

    var isEmpty: Bool { conditions.isEmpty }

    func settingMatch(_ match: SegmentRuleMatch) -> SegmentRuleSet {
        var copy = self
        copy.match = match
        return copy
    }

    func replacing(at index: Int, with condition: SegmentRuleCondition) -> SegmentRuleSet {
        guard conditions.indices.contains(index) else { return self }
        var copy = self
        copy.conditions[index] = condition
        return copy
    }

    func removing(at index: Int) -> SegmentRuleSet {
        guard conditions.indices.contains(index), conditions.count > 1 else { return self }
        var copy = self
        copy.conditions.remove(at: index)
        return copy
    }

    /// The body for `/rules/preview` and `/rules`.
    ///
    /// Built through `JSONEncoder` rather than by hand so the wire shape can
    /// only ever be what this type says it is. The routes refuse an
    /// unrecognised key with 400, so an extra field added here by accident
    /// would fail loudly rather than be ignored.
    func requestBody() -> [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["match": match.rawValue, "conditions": [Any]()]
        }
        return object
    }
}

/// A calendar date, checked the same way the server checks it.
enum SegmentRuleDate {
    static func isCalendarDate(_ text: String) -> Bool {
        guard text.count == 10 else { return false }
        let parts = text.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              year >= 1990, year <= 2100, month >= 1, month <= 12, day >= 1, day <= 31 else {
            return false
        }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar.date(from: components) != nil
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func text(from date: Date) -> String { formatter.string(from: date) }

    static func date(from text: String) -> Date? { formatter.date(from: text) }
}

// MARK: - Plain English

/// The rendering the server produced from the validated rules.
///
/// `lines` is index-aligned with `SegmentRuleSet.conditions`: both come from
/// `describeRuleSet()` in lib/campaigns/segment-rule-schema.js walking the same
/// array in order. The builder relies on that alignment and therefore refuses
/// to show a stale rendering: any local edit invalidates the preview and the
/// operator has to look again before saving.
struct SegmentRulePlainEnglish: Codable, Hashable {
    let sentence: String
    let lines: [String]

    func line(at index: Int) -> String? {
        lines.indices.contains(index) ? lines[index] : nil
    }
}

// MARK: - Problems and warnings

/// One reason something was refused, or one thing worth saying out loud.
/// Both shapes are `{ path, code, reason }` on the wire.
struct SegmentRuleProblem: Codable, Hashable, Identifiable {
    let path: String?
    let code: String
    let reason: String

    var id: String { "\(path ?? "")|\(code)" }

    /// Which condition this is about, when it is about one. The server writes
    /// `rules.conditions[2]`.
    var conditionIndex: Int? {
        guard let path, let open = path.firstIndex(of: "["), let close = path.firstIndex(of: "]"),
              open < close else { return nil }
        return Int(path[path.index(after: open)..<close])
    }

    /// Warnings that deserve to look like a stop sign rather than a note.
    var isSevere: Bool {
        code == "SEGMENT_MATCHES_ALMOST_EVERYBODY"
    }
}

// MARK: - Responses

/// `POST /api/segments/rules/draft`.
///
/// Four outcomes, and three of them are not rules. An ambiguous sentence comes
/// back as `question`; something this system does not record comes back as
/// `unanswerable`; a model that wrote something outside the grammar comes back
/// as `rejected` with the validator's reasons. None of those is an error, and
/// none of them may be presented as one.
struct SegmentRuleDraftResponse: Codable, Hashable {
    let status: String
    let description: String?
    let ruleSet: SegmentRuleSet?
    let plainEnglish: SegmentRulePlainEnglish?
    let questions: [String]?
    let because: String?
    let errors: [SegmentRuleProblem]?
    let warnings: [SegmentRuleProblem]?

    var outcome: SegmentRuleDraftOutcome {
        switch status {
        case "drafted":
            guard let ruleSet, let plainEnglish else { return .rejected([]) }
            return .drafted(ruleSet, plainEnglish)
        case "question": return .question(questions ?? [])
        case "unanswerable": return .unanswerable(because ?? SegmentRuleCopy.unanswerableFallback)
        default: return .rejected(errors ?? [])
        }
    }
}

enum SegmentRuleDraftOutcome {
    case drafted(SegmentRuleSet, SegmentRulePlainEnglish)
    case question([String])
    case unanswerable(String)
    case rejected([SegmentRuleProblem])
}

/// `POST /api/segments/rules/preview`. The dry run. Saves nothing, which is
/// why `saved` is on the wire at all: it is a claim the server makes and the
/// interface repeats.
struct SegmentRulePreviewResponse: Codable, Hashable {
    let saved: Bool?
    let ruleSet: SegmentRuleSet
    let plainEnglish: SegmentRulePlainEnglish
    let matchedCount: Int
    let consideredCount: Int
    let sample: [SegmentRuleSampleMember]
    let warnings: [SegmentRuleProblem]?
    let computedAt: String?

    var didSaveAnything: Bool { saved == true }

    /// "41 people, out of 386 known customers."
    var countSentence: String {
        let people = matchedCount == 1 ? "1 person" : "\(matchedCount.formatted()) people"
        if consideredCount <= 0 { return "\(people) match these rules." }
        let known = consideredCount == 1 ? "1 known customer" : "\(consideredCount.formatted()) known customers"
        return "\(people) match these rules, out of \(known)."
    }

    var sampleSentence: String {
        if matchedCount == 0 { return "Nobody matches yet." }
        if sample.count >= matchedCount { return sample.count == 1 ? "That is this person:" : "That is these people:" }
        return "Here are the first \(sample.count):"
    }
}

/// One matched person in a dry run, with the reason they matched.
struct SegmentRuleSampleMember: Codable, Hashable, Identifiable {
    let contactPhone: String
    let contactName: String?
    let trace: [SegmentRuleTraceLine]?

    var id: String { contactPhone }

    var displayName: String {
        guard let contactName, !contactName.trimmingCharacters(in: .whitespaces).isEmpty else {
            return PhoneFormatter.pretty(contactPhone)
        }
        return contactName
    }
}

/// One line of the per-person rule trace: the rule, whether it held, and what
/// this person's own value was.
struct SegmentRuleTraceLine: Codable, Hashable, Identifiable {
    let dimension: String
    let held: Bool
    let rule: String
    let observed: String

    var id: String { "\(dimension)|\(rule)" }

    /// "they have ordered BPC-157 at least 3 times: 3 orders contained it"
    var sentence: String { "\(rule): \(observed)" }
}

/// `POST /api/segments/rules`. The only one of the three that writes.
struct SegmentRuleCreationResponse: Codable, Hashable {
    let segment: SegmentRecord
    let created: Bool?
    let ruleSet: SegmentRuleSet?
    let plainEnglish: SegmentRulePlainEnglish?
}

// MARK: - Copy

/// Sentences that have to be said the same way in more than one place.
enum SegmentRuleCopy {
    static let unanswerableFallback =
        "That is not something this system records. A segment can be built from orders, products, spend, timing, how regularly somebody orders, other segments, and whether they are clear for commercial contact."

    static let disabled =
        "Describing a segment in words is turned off for this workspace. You can still turn on one of the automatic patterns, or build a segment by hand."

    static let notPermissionToSend =
        "A segment is a list of people, not permission to text them. Consent, provider approval and the sending switches are all separate and all checked later."

    static let previewIsRequired =
        "Nothing is saved until you press Save. Look at who matches first."

    static let editedSincePreview =
        "You have changed a rule since the last look. Check who matches again before saving."

    static let placeholder = "customers who bought BPC-157 more than twice and have not ordered since June"

    /// What to say when the operator's sentence had more than one reading.
    /// Asking is a correct answer, so it must not look like a failure.
    static func questionHeadline(_ count: Int) -> String {
        count == 1
            ? "One thing needs clearing up before this can be turned into rules."
            : "A few things need clearing up before this can be turned into rules."
    }
}
