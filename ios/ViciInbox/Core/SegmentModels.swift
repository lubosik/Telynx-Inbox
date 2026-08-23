import Foundation

/// Saved campaign segments, as the backend actually returns them.
///
/// The engine in `lib/campaigns/reorder-cadence.js` and
/// `lib/campaigns/winback.js` has always known who is due a reorder and who has
/// lapsed. `routes/segments.js` made that visible over HTTP. This file is the
/// client half of that contract, and the place where stored evidence is turned
/// into something a person can read.
///
/// EVERY FIELD BELOW IS camelCase ON THE WIRE. `shapeSegment`, `shapeMember`
/// and `shapeOverride` in `lib/campaigns/segment-service.js` rename every
/// database column before it leaves the server, so nothing here needs a
/// `CodingKeys` map. Campaign models do, because `routes/campaigns.js` returns
/// raw rows. Do not copy the campaign pattern into this file.
///
/// This is a Foundation-only file on purpose: it is covered by the
/// `swiftc -typecheck` command in AGENTS.md, and it is where all of the
/// interpretation lives, so the interpretation is the part that gets checked.

// MARK: - Vocabulary

/// Who decides membership. A stored column, not a display choice: a database
/// trigger refuses to change it after insert, so a segment can never move
/// between the two and a member row's meaning is permanent.
enum SegmentKind: String, Codable, Hashable {
    case automatic
    case manual
    /// A kind this build has never heard of. Decoding falls back here rather
    /// than throwing, because one unrecognised row must not blank the list.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SegmentKind(rawValue: raw) ?? .unknown
    }

    /// The origin label. The research asks for origin to be stated on the row
    /// itself rather than hidden behind a filter or a separate screen.
    var originLabel: String {
        switch self {
        case .automatic: return "Automatic"
        case .manual:    return "Manual"
        case .unknown:   return "Unrecognised"
        }
    }

    var originDetail: String {
        switch self {
        case .automatic:
            return "The engine works out who belongs here. You can force one person in or out, and that override survives every update."
        case .manual:
            return "Someone chose these people by hand. Add or remove them directly."
        case .unknown:
            return "This app does not recognise how this segment decides membership. Update the app before changing it."
        }
    }

    var symbolName: String {
        switch self {
        case .automatic: return "gearshape.2.fill"
        case .manual:    return "hand.point.up.left.fill"
        case .unknown:   return "questionmark.circle.fill"
        }
    }
}

/// How one person came to be in one segment.
enum SegmentMembershipSource: String, Codable, Hashable {
    /// The engine matched them on this run.
    case computed
    /// A person forced them in. They stay whether or not the engine agrees.
    case forcedInclude = "forced_include"
    /// A member of a manual segment.
    case manual
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SegmentMembershipSource(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .computed:      return "Matched by the engine"
        case .forcedInclude: return "Kept in by a person"
        case .manual:        return "Chosen by a person"
        case .unknown:       return "Origin not recorded"
        }
    }
}

enum SegmentOverrideType: String, Codable, Hashable {
    case include
    case exclude
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SegmentOverrideType(rawValue: raw) ?? .unknown
    }

    var verb: String {
        switch self {
        case .include: return "Force included"
        case .exclude: return "Excluded"
        case .unknown: return "Overridden"
        }
    }

    var symbolName: String {
        switch self {
        case .include: return "pin.fill"
        case .exclude: return "nosign"
        case .unknown: return "questionmark.circle"
        }
    }
}

// MARK: - Records

/// `shapeSegment()` in lib/campaigns/segment-service.js.
///
/// `definition` is deliberately not decoded. For an automatic segment the
/// stored `definitionKey` is the same string as `key`, and nothing in this
/// client needs the free-form object.
struct SegmentRecord: Codable, Identifiable, Hashable {
    let id: String
    let key: String
    let name: String
    let description: String?
    let kind: SegmentKind
    let ruleVersion: String?
    let memberCount: Int
    let lastComputedAt: String?
    /// Why this manual segment exists. Written once, by the person who created
    /// it, and shown as the explanation for everybody in it.
    ///
    /// Always nil on an automatic segment: its detector definition IS its
    /// purpose, and the database refuses a second one. Nil on a manual segment
    /// only where the row predates the requirement.
    ///
    /// THIS IS NOT THE PER-PERSON REASON. `SegmentOverride.reason` and the
    /// `reason` inside a member's inclusion evidence answer a different
    /// question, about one named human rather than about the group, and both
    /// still exist. Do not merge them into this.
    let purpose: String?
    let archivedAt: String?
    let archivedByUserId: FlexibleID?
    let archiveReason: String?
    let createdAt: String
    let updatedAt: String

    var isArchived: Bool { archivedAt?.isEmpty == false }
    var lastComputedDate: Date? { ServerDate.parse(lastComputedAt) }
    var archivedDate: Date? { ServerDate.parse(archivedAt) }

    /// The purpose, if there is one worth showing.
    var statedPurpose: String? {
        guard let purpose else { return nil }
        let trimmed = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// What the row says under the name. Never a raw key: "reorder_due" is a
    /// database value and the person reading this screen did not choose it.
    var membershipSummary: String {
        let people = memberCount == 1 ? "1 person" : "\(memberCount.formatted()) people"
        switch kind {
        case .automatic:
            guard let updated = lastComputedDate else {
                return "\(people). Not worked out yet."
            }
            return "\(people). Updated \(SegmentDateText.relative(updated))."
        case .manual, .unknown:
            return people
        }
    }
}

/// An automatic segment the workspace has not saved yet.
/// `GET /api/segments` returns these as `available` so the client can offer
/// every unsaved definition without a second request.
struct SegmentCatalogueEntry: Codable, Identifiable, Hashable {
    let key: String
    let detector: String
    let name: String
    let description: String
    let ruleVersion: String?

    var id: String { key }
}

struct SegmentListPage: Codable, Hashable {
    let items: [SegmentRecord]
    let page: Int
    let pageSize: Int
    let total: Int
    let ruleVersion: String?
    let available: [SegmentCatalogueEntry]?

    var catalogue: [SegmentCatalogueEntry] { available ?? [] }
}

/// `shapeMember()`. `inclusionEvidence` is the whole point of this screen.
struct SegmentMember: Codable, Identifiable, Hashable {
    let contactPhone: String
    let contactId: FlexibleID?
    let contactName: String?
    let membershipSource: SegmentMembershipSource
    let inclusionEvidence: JSONValue?
    let evidenceRuleVersion: String?
    let engineMatched: Bool?
    let engineEvidence: JSONValue?
    let firstSeenAt: String?
    let lastSeenAt: String?

    var id: String { contactPhone }

    var displayName: String {
        guard let contactName, !contactName.trimmingCharacters(in: .whitespaces).isEmpty else {
            return PhoneFormatter.pretty(contactPhone)
        }
        return contactName
    }

    /// True only for a person a human kept in after the engine stopped
    /// matching them. `reconcileSegmentMembership()` sets `engineMatched` false
    /// in exactly that case, which is the "kept by a person, the engine no
    /// longer agrees" state SEGMENTS.md describes.
    var isKeptAgainstTheEngine: Bool {
        membershipSource == .forcedInclude && engineMatched == false
    }

    var evidence: SegmentInclusionEvidence {
        SegmentInclusionEvidence(raw: inclusionEvidence,
                                 membershipSource: membershipSource,
                                 engineMatched: engineMatched)
    }
}

struct SegmentMemberPage: Codable, Hashable {
    let items: [SegmentMember]
    let page: Int
    let pageSize: Int
    let total: Int
}

/// `shapeOverride()`. The actor id travels with the row so the interface can
/// say who did this and when, rather than showing an invisible flag.
struct SegmentOverride: Codable, Identifiable, Hashable {
    let id: String
    let contactPhone: String
    let overrideType: SegmentOverrideType
    let reason: String?
    let createdAt: String
    let createdByUserId: FlexibleID?
    let revokedAt: String?
    let revokedByUserId: FlexibleID?
    let revokeReason: String?

    var isActive: Bool { revokedAt?.isEmpty != false }
    var createdDate: Date? { ServerDate.parse(createdAt) }
    var revokedDate: Date? { ServerDate.parse(revokedAt) }

    /// "Excluded by Lubosi on 12 August 2026." The author is resolved by the
    /// caller, because a Support Agent holds `campaigns.read` and not
    /// `user.read` and therefore cannot look a colleague's name up at all.
    func attributionSentence(author: String) -> String {
        let when = createdDate.map { " on \(SegmentDateText.day($0))" } ?? ""
        return "\(overrideType.verb) by \(author)\(when)."
    }

    func revocationSentence(author: String) -> String? {
        guard let revokedDate else { return nil }
        return "Revoked by \(author) on \(SegmentDateText.day(revokedDate))."
    }
}

struct SegmentOverrideSet: Codable, Hashable {
    let active: [SegmentOverride]
    let revoked: [SegmentOverride]

    var all: [SegmentOverride] { active + revoked }
}

struct SegmentDetailResponse: Codable, Hashable {
    let segment: SegmentRecord
    let members: SegmentMemberPage
    let overrides: SegmentOverrideSet
}

/// `GET /api/segments/:id/members/:phone`.
///
/// `member` is genuinely nullable: somebody with an active exclude override and
/// no member row is a valid answer here, and it is the answer to "why is this
/// person NOT in this segment".
struct SegmentMemberDetail: Codable, Hashable {
    let segment: SegmentRecord
    let member: SegmentMember?
    let activeOverride: SegmentOverride?
    let overrideHistory: [SegmentOverride]
}

/// `POST /api/segments`. One shape covers both kinds: `created` is present only
/// for the automatic path (false when the segment already existed, because
/// saving a catalogue entry is idempotent by key) and `memberCount` only for
/// the manual one. `notification` is deliberately not decoded; whether an Admin
/// got a push is not this screen's business.
struct SegmentCreationResponse: Codable, Hashable {
    let segment: SegmentRecord
    let created: Bool?
    let memberCount: Int?

    var didCreate: Bool { created ?? true }
}

/// `POST /api/segments/:id/recompute`.
struct SegmentRecomputeRun: Codable, Hashable {
    let id: String
    let runKey: String
    let digest: String
    let replayed: Bool
    let completedAt: String?
    let memberCount: Int
    let joinedCount: Int
    let leftCount: Int
    let refreshedCount: Int
    let forcedIncludeCount: Int
    let excludedCount: Int
}

struct SegmentRecomputeResponse: Codable, Hashable {
    let segment: SegmentRecord
    let run: SegmentRecomputeRun
    let blockedByExclusion: [String]?
    let keptByOverride: [String]?
    let material: Bool?

    /// What to tell the person who pressed the button. A replayed run is the
    /// common case and must not look like a failure.
    var outcomeSentence: String {
        if run.replayed {
            return "Nothing had changed. \(peopleText(run.memberCount)) still in this segment."
        }
        var parts: [String] = []
        if run.joinedCount > 0 {
            parts.append("\(run.joinedCount.formatted()) joined")
        }
        if run.leftCount > 0 {
            parts.append("\(run.leftCount.formatted()) left")
        }
        if parts.isEmpty {
            return "Membership was rechecked. \(peopleText(run.memberCount)) in this segment."
        }
        return "\(parts.joined(separator: " and ")). \(peopleText(run.memberCount)) in this segment now."
    }

    private func peopleText(_ count: Int) -> String {
        count == 1 ? "1 person is" : "\(count.formatted()) people are"
    }
}

struct SegmentMemberResponse: Codable, Hashable {
    let member: SegmentMember
}

struct SegmentOverrideResponse: Codable, Hashable {
    let override: SegmentOverride
}

struct SegmentMemberRemoval: Codable, Hashable {
    let removed: Int
    let contactPhone: String
}

/// One line of the "why are they here" checklist.
struct SegmentFact: Identifiable, Hashable {
    let label: String
    let value: String
    var id: String { label }
}

// MARK: - Dates

/// Date text for evidence copy.
///
/// A `DateFormatter` rather than `Date.FormatStyle`, so this file compiles the
/// same way under the Command Line Tools type-check as it does against the iOS
/// SDK. Nothing here is worth a build difference between the two.
enum SegmentDateText {
    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale.autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("d MMMM y")
        return formatter
    }()

    private static let elapsedFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.maximumUnitCount = 1
        formatter.unitsStyle = .full
        return formatter
    }()

    static func day(_ date: Date) -> String {
        dayFormatter.string(from: date)
    }

    static func day(_ raw: String?) -> String? {
        guard let date = ServerDate.parse(raw) else { return nil }
        return dayFormatter.string(from: date)
    }

    /// "2 days ago", "just now". Used for "Updated ..." on a segment row.
    static func relative(_ date: Date, now: Date = Date()) -> String {
        let elapsed = now.timeIntervalSince(date)
        if elapsed < 60 { return "just now" }
        guard let text = elapsedFormatter.string(from: abs(elapsed)) else {
            return "on \(day(date))"
        }
        return elapsed >= 0 ? "\(text) ago" : "in \(text)"
    }

    /// "18 to 24 August 2026", collapsed to one date when both ends match.
    static func range(start: String?, end: String?) -> String? {
        guard let from = ServerDate.parse(start), let to = ServerDate.parse(end) else { return nil }
        let fromText = day(from)
        let toText = day(to)
        return fromText == toText ? fromText : "\(fromText) to \(toText)"
    }
}

/// Number text for evidence copy. Whole numbers stay whole.
enum SegmentNumberText {
    static func days(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded == rounded.rounded() {
            let whole = Int(rounded)
            return whole == 1 ? "1 day" : "\(whole) days"
        }
        return "\(rounded) days"
    }

    static func count(_ value: Double) -> String {
        String(Int(value.rounded()))
    }
}

// MARK: - Inclusion evidence

/// Stored inclusion evidence, read as a sentence and a short checklist.
///
/// This is the thing the research says nobody in the market does well: not "you
/// are in the Reorder segment" but "Alex usually orders every 30 days or so.
/// The last one was on 22 July, which puts the next around 21 August."
///
/// Every string in here is written to be read out loud by somebody who has
/// never seen the arithmetic. No median, no MAD, no confidence score, no em
/// dash. The numbers that survive are the ones a person can picture: days,
/// dates and counts.
///
/// Nothing here recomputes anything. Every value is read from the row the
/// engine wrote at the time, which is also why `ruleVersion` is shown: an old
/// member row is readable as what the rules said then, not what they say now.
struct SegmentInclusionEvidence: Hashable {
    let raw: JSONValue?
    let membershipSource: SegmentMembershipSource
    let engineMatched: Bool?

    init(raw: JSONValue?,
         membershipSource: SegmentMembershipSource = .computed,
         engineMatched: Bool? = nil) {
        self.raw = raw
        self.membershipSource = membershipSource
        self.engineMatched = engineMatched
    }

    // MARK: Typed reads

    private func text(_ key: String) -> String? {
        guard case .string(let value)? = raw?.child(key) else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func number(_ key: String) -> Double? {
        guard case .number(let value)? = raw?.child(key) else { return nil }
        return value
    }

    /// `reorder` or `winback`, absent on a hand-picked row.
    var detector: String? { text("detector") }
    /// `manual_selection` or `manual_override_include`, absent on a computed row.
    var source: String? { text("source") }
    var state: String? { text("state") }
    var confidence: String? { text("confidence") }
    var cadenceSource: String? { text("cadenceSource") }
    var reason: String? { text("reason") }
    var productName: String? { text("productName") }
    var ruleVersion: String? { text("ruleVersion") }
    var lastOrderAt: String? { text("lastOrderAt") }
    var expectedAt: String? { text("expectedAt") }
    var addedAt: String? { text("addedAt") }

    var medianIntervalDays: Double? { number("medianIntervalDays") }
    var intervalsObserved: Double? { number("intervalsObserved") }
    var madDays: Double? { number("madDays") }
    var purchaseCount: Double? { number("purchaseCount") }
    var lifetimePurchaseCount: Double? { number("lifetimePurchaseCount") }
    var daysSinceLastOrder: Double? { number("daysSinceLastOrder") }
    var additionalMatches: Double? { number("additionalMatches") }

    var expectedRange: String? {
        guard case .object(let range)? = raw?.child("expectedRange") else { return nil }
        var start: String?
        var end: String?
        if case .string(let value)? = range["start"] { start = value }
        if case .string(let value)? = range["end"] { end = value }
        return SegmentDateText.range(start: start, end: end)
    }

    var isEmpty: Bool {
        guard case .object(let fields)? = raw else { return true }
        return fields.isEmpty
    }

    // MARK: The sentence

    /// One short paragraph, written from the reader's side of the screen.
    /// `personName` is used verbatim, so pass a display name rather than a key.
    ///
    /// `segmentPurpose` is the SEGMENT's one reason, passed in by the caller
    /// because it lives on the segment row and not on this member's evidence.
    /// It is deliberately additive: the per-person note, when there is one, is
    /// still said out loud underneath it.
    func headline(personName: String, segmentPurpose: String? = nil) -> String {
        if let source, source.hasPrefix("manual") {
            return manualHeadline(personName: personName,
                                  source: source,
                                  segmentPurpose: segmentPurpose)
        }
        switch detector {
        case "reorder": return reorderHeadline(personName: personName)
        case "winback": return winbackHeadline(personName: personName)
        default:
            if isEmpty {
                return "No evidence was recorded for this membership. That happens when the row predates the current rules."
            }
            return "\(personName) is in this segment, but the engine did not record which rule matched them."
        }
    }

    /// Two reasons, in the order somebody would ask for them.
    ///
    /// The segment's purpose comes first because it is true of everybody here
    /// and it is the common case: one sentence, written once, that explains the
    /// whole group. The per-person note comes second and only when it exists,
    /// because "added at her request on 12 Aug" says something the group
    /// purpose cannot. Collapsing the two would lose the second one.
    ///
    /// On an automatic segment `segmentPurpose` is always nil, so a force
    /// include reads exactly as it did before: the person's own reason, or the
    /// plain statement that nobody recorded one.
    private func manualHeadline(personName: String,
                                source: String,
                                segmentPurpose: String?) -> String {
        var sentences: [String] = [
            source == "manual_override_include"
                ? "\(personName) was forced into this segment by a person."
                : "\(personName) was added to this segment by hand."
        ]
        let purpose = segmentPurpose?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let purpose, !purpose.isEmpty {
            sentences.append("This segment is for: \(purpose)")
        }
        if let reason {
            sentences.append("Note about \(personName): \(reason)")
        } else if purpose == nil || purpose?.isEmpty == true {
            sentences.append("No reason was recorded.")
        }
        return sentences.joined(separator: " ")
    }

    private func reorderHeadline(personName: String) -> String {
        var sentences: [String] = []
        if let median = medianIntervalDays {
            let basis = cadenceSource == "product"
                ? "\(personName) has not ordered often enough for us to read a pattern of their own, so we go by other customers, who buy this again every \(SegmentNumberText.days(median)) or so."
                : "\(personName) usually orders every \(SegmentNumberText.days(median)) or so."
            sentences.append(basis)
        }
        if let last = SegmentDateText.day(lastOrderAt), let expected = SegmentDateText.day(expectedAt) {
            sentences.append("The last one was on \(last), which puts the next around \(expected).")
        } else if let last = SegmentDateText.day(lastOrderAt) {
            sentences.append("The last one was on \(last).")
        }
        switch state {
        case "overdue":
            sentences.append("That date has gone by, so they are past due.")
        case "due":
            sentences.append("That is about now.")
        case "approaching":
            sentences.append("That is close but not here yet, so this is one to get ready for rather than send to.")
        case "not_due":
            sentences.append("That is still a way off.")
        default:
            break
        }
        if sentences.isEmpty {
            return "\(personName) matched the reorder rules, but the numbers behind it were not recorded."
        }
        return sentences.joined(separator: " ")
    }

    private func winbackHeadline(personName: String) -> String {
        var sentences: [String] = []
        if let median = medianIntervalDays {
            sentences.append("\(personName) used to order every \(SegmentNumberText.days(median)) or so.")
        } else {
            sentences.append("\(personName) bought regularly and has stopped.")
        }
        if let days = daysSinceLastOrder, let last = SegmentDateText.day(lastOrderAt) {
            sentences.append("There has been nothing since \(last), which is \(SegmentNumberText.days(days)) ago.")
        } else if let days = daysSinceLastOrder {
            sentences.append("There has been nothing for \(SegmentNumberText.days(days)).")
        } else if let last = SegmentDateText.day(lastOrderAt) {
            sentences.append("The last one was on \(last).")
        }
        sentences.append("That is far enough past their usual gap that they count as gone quiet.")
        sentences.append("Anyone it would be tactless to approach was left out before this list was built.")
        return sentences.joined(separator: " ")
    }

    /// The sentence that has to be said out loud when a person is overruling
    /// the arithmetic, so nobody reads a forced include as an engine match.
    var overruleNotice: String? {
        guard membershipSource == .forcedInclude, engineMatched == false else { return nil }
        return "The engine does not match this person any more. They stay in because of the force include, and they will stay in until it is revoked."
    }

    // MARK: The checklist

    /// The facts behind the sentence, in the order a person would ask for them.
    /// Absent values are dropped rather than shown as "Not available", because
    /// a checklist of blanks teaches nothing.
    var facts: [SegmentFact] {
        var facts: [SegmentFact] = []

        func add(_ label: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            facts.append(SegmentFact(label: label, value: value))
        }

        let isWinback = detector == "winback"
        if isWinback {
            add("Orders in total", lifetimePurchaseCount.map(SegmentNumberText.count))
        } else {
            add("Orders on record", purchaseCount.map(SegmentNumberText.count))
        }
        // A product level pattern is not this person's pattern, and a label that
        // says "usually orders every" over somebody else's number is a lie the
        // reader has no way to catch.
        let borrowed = cadenceSource == "product"
        let gapLabel = isWinback ? "Used to order every"
            : borrowed ? "Other customers order every" : "Usually orders every"
        add(gapLabel, medianIntervalDays.map(SegmentNumberText.days))
        add(borrowed ? "Gaps measured across those customers" : "Gaps we measured",
            intervalsObserved.map(SegmentNumberText.count))
        add("How regular that is", confidenceText)
        add("Worked out from", cadenceSourceText)
        add("How much the gap moves", madDays.flatMap { $0 > 0 ? "about \(SegmentNumberText.days($0)) either way" : nil })
        add("Last order", SegmentDateText.day(lastOrderAt))
        add("Time since then", daysSinceLastOrder.map(SegmentNumberText.days))
        add("Next one expected around", SegmentDateText.day(expectedAt))
        add("Reasonable window", expectedRange)
        add("Where they stand", stateText)
        add("Product", productName)
        add("Counted as gone quiet on", SegmentDateText.day(text("eligibleAt")))
        add("Free to contact again since", SegmentDateText.day(text("cooldownEndsAt")))
        add("Drops off this list on", SegmentDateText.day(text("expiresAt")))
        add("Added", SegmentDateText.day(addedAt))
        if let extra = additionalMatches, extra >= 1 {
            let count = Int(extra.rounded())
            add(isWinback ? "Also gone quiet on" : "Also due on",
                count == 1 ? "1 other product" : "\(count) other products")
        }
        add("Rules used", ruleVersion)
        return facts
    }

    /// A win back row carries no expected date, so the reorder wording that ends
    /// in "the date" would be describing something the reader cannot see.
    private var confidenceText: String? {
        let isWinback = detector == "winback"
        switch confidence {
        case "high":
            return isWinback
                ? "Very. The gaps between their orders barely moved"
                : "Very. The gaps barely change, so the date should be close"
        case "moderate":
            return isWinback
                ? "Fairly. The gaps between their orders moved around a bit"
                : "Fairly. The gaps move around a bit, so treat the date as a rough one"
        case "none":
            return "Not enough orders yet to call it regular"
        default:
            return nil
        }
    }

    private var cadenceSourceText: String? {
        switch cadenceSource {
        case "personal": return "Their own order history"
        case "product":  return "How often other customers reorder this product"
        case "none":     return "No pattern we could use"
        default:         return nil
        }
    }

    /// What would take this person back out again.
    ///
    /// The rule-trace sketch in TRACKING-AND-LEARNING-RESEARCH.md ends its
    /// checklist with an "exits if" line, and it is the half that turns a
    /// membership into something an operator can predict rather than just
    /// audit. These are read off the detector, not off this row: they are the
    /// conditions `calculateReorderCadence` and `qualifyWinback` test, plus the
    /// commercial eligibility gate every candidate passes through first.
    var exitConditions: [String] {
        if source == "manual_selection" {
            return ["Nothing automatic. They stay until somebody removes them."]
        }
        if source == "manual_override_include" {
            return ["Nothing automatic. They stay until the force include is reversed."]
        }
        switch detector {
        case "reorder":
            return [
                "They order again. The clock starts over and the expected date moves with it.",
                "Somebody messages them about this order.",
                "The product goes out of stock.",
                "Their permission to be sent marketing stops being current and clear.",
                "Somebody holds them out of this segment by hand."
            ]
        case "winback":
            var reasons = ["They order again."]
            if let expires = SegmentDateText.day(text("expiresAt")) {
                reasons.append("They drop off this list on \(expires) if nothing changes before then.")
            }
            reasons.append("They are contacted as a win back, which keeps them off this list for the next six months.")
            reasons.append("Their permission to be sent marketing stops being current and clear.")
            reasons.append("Somebody holds them out of this segment by hand.")
            return reasons
        default:
            return []
        }
    }

    private var stateText: String? {
        switch state {
        case "due":         return "Due now"
        case "overdue":     return "Past due"
        case "approaching": return "Nearly due, not there yet"
        case "not_due":     return "Not due yet"
        case "contacted":   return "Already contacted about this order"
        case "suppressed":  return "Held back for now"
        default:            return nil
        }
    }
}

// MARK: - Request bodies

/// One person on their way into a manual segment.
///
/// `POST /api/segments` and `POST /api/segments/:id/members` both reject any
/// key they do not recognise with 400 `SEGMENT_INPUT_REJECTED`, so this builds
/// exactly `phone`, `contactId`, `name` and `reason` and nothing else.
struct SegmentMemberInput: Hashable {
    let phone: String
    let name: String?
    let contactID: String?
    /// The optional note about THIS person, not the segment's purpose. The
    /// wire key is still `reason` because that is what the server reads and
    /// what every existing member row already carries.
    let reason: String?

    init(phone: String, name: String? = nil, contactID: String? = nil, reason: String? = nil) {
        self.phone = phone
        self.name = name
        self.contactID = contactID
        self.reason = reason
    }

    var requestBody: [String: Any] {
        var body: [String: Any] = ["phone": phone]
        if let name, !name.isEmpty { body["name"] = name }
        if let contactID, let numeric = Int(contactID), numeric > 0 { body["contactId"] = numeric }
        if let reason, !reason.isEmpty { body["reason"] = reason }
        return body
    }
}

// MARK: - Who can be added

/// `GET /api/segments/:id/candidates`.
///
/// WHY THIS ENDPOINT EXISTS AT ALL.
///   The picker used to read `/api/contacts` and show everybody, so people
///   already in the segment were offered again. Subtracting them in the client
///   would only have hidden the ones on the page being looked at: the list is
///   paged and searchable, and a member on page three would still have been
///   offered one scroll later. The server subtracts first and pages second,
///   which is also the only way `total` and `hasMore` can be true statements.
///
/// `campaigns.manage`, not `campaigns.read`. It exists to stage an add or a
/// force include, and a Support Agent can do neither.
struct SegmentCandidate: Codable, Identifiable, Hashable {
    let contactPhone: String
    let contactId: FlexibleID?
    let contactName: String?
    /// `available` today. Decoded as a string rather than an enum so a state
    /// added by a later server cannot blank the whole picker.
    let state: String?

    var id: String { contactPhone }

    var displayName: String {
        guard let contactName,
              !contactName.trimmingCharacters(in: .whitespaces).isEmpty else {
            return PhoneFormatter.pretty(contactPhone)
        }
        return contactName
    }

    var memberInput: SegmentMemberInput {
        SegmentMemberInput(phone: contactPhone,
                           name: contactName,
                           contactID: contactId?.rawValue)
    }
}

/// Somebody a person deliberately held out of an automatic segment.
///
/// Not the same state as "not a member", and deliberately not hidden. A
/// standing exclusion outlives every recompute until it is revoked, so the only
/// honest thing to do when their name would otherwise appear in the picker is
/// to show the decision and who made it. Adding them is refused by a database
/// trigger anyway, so hiding them would produce a name that simply is not there
/// and no way to find out why.
struct SegmentHeldCandidate: Codable, Identifiable, Hashable {
    let contactPhone: String
    let contactId: FlexibleID?
    let contactName: String?
    let override: SegmentOverride?

    var id: String { contactPhone }

    var displayName: String {
        guard let contactName,
              !contactName.trimmingCharacters(in: .whitespaces).isEmpty else {
            return PhoneFormatter.pretty(contactPhone)
        }
        return contactName
    }

    /// "Held out by Lubosi on 12 August 2026." The author is resolved by the
    /// caller for the same reason `SegmentOverride` does it: a Support Agent
    /// cannot read the team list at all.
    func heldSentence(author: String) -> String {
        guard let override else { return "Held out of this segment by a person." }
        let when = override.createdDate.map { " on \(SegmentDateText.day($0))" } ?? ""
        return "Held out by \(author)\(when)."
    }

    var reason: String? {
        guard let reason = override?.reason,
              !reason.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return reason
    }
}

struct SegmentCandidatePage: Codable, Hashable {
    let items: [SegmentCandidate]
    let page: Int
    let pageSize: Int
    let total: Int
    let hasMore: Bool?
}

struct SegmentCandidateResponse: Codable, Hashable {
    let segment: SegmentRecord
    let candidates: SegmentCandidatePage
    let held: [SegmentHeldCandidate]?
    let heldTotal: Int?
    /// How many people matching this search were taken off the list because
    /// they are already in the segment. Shown, rather than left as a silent
    /// difference between what was searched for and what came back.
    let alreadyInCount: Int?
    let memberCount: Int?
    let search: String?

    var heldPeople: [SegmentHeldCandidate] { held ?? [] }

    var alreadyInSentence: String? {
        guard let alreadyInCount, alreadyInCount > 0 else { return nil }
        return alreadyInCount == 1
            ? "1 person matching this search is already in this segment and is not listed."
            : "\(alreadyInCount.formatted()) people matching this search are already in this segment and are not listed."
    }
}

// MARK: - Removing a segment

/// `DELETE /api/segments/:id`.
///
/// THE CLIENT DOES NOT DECIDE WHICH OF THE TWO HAPPENS.
///   It may ask for `mode: "archive"`. It may not ask for a deletion.
///   `delete_sms_campaign_segment` has no force path and repeats every blocker
///   inside its own transaction, so a segment that gains an override or a
///   campaign between the tap and the statement ends up archived rather than
///   gone. The outcome in the response is the answer, not the request.
struct SegmentRemovalResponse: Codable, Hashable {
    let outcome: String
    let segmentId: String?
    let blockers: [String]?
    let name: String?
    let kind: SegmentKind?
    let membersRemoved: Int?

    var wasDeleted: Bool { outcome == "deleted" }
    var blockerList: [String] { blockers ?? [] }

    /// What to tell the person who pressed the button. An archive is not a
    /// failure and must not read like one.
    func outcomeSentence(segmentName: String) -> String {
        if wasDeleted { return "\(segmentName) was deleted." }
        return "\(segmentName) was archived. It has left the list and nothing about it was destroyed."
    }

    /// Why it was archived rather than deleted, in the operator's language and
    /// with the duplicate engine blockers collapsed into one line.
    var explanations: [String] {
        var seen = Set<String>()
        var lines: [String] = []
        for blocker in blockerList {
            let sentence = SegmentBlockerText.sentence(blocker)
            if seen.insert(sentence).inserted { lines.append(sentence) }
        }
        return lines
    }
}

/// The blocker tokens `delete_sms_campaign_segment` returns, as sentences.
///
/// Each one names a thing that is part of the answer to "who did we message and
/// why". None of them is a rule about size or tidiness.
enum SegmentBlockerText {
    static func sentence(_ blocker: String) -> String {
        switch blocker {
        case "already_archived":
            return "It was already archived, so it was left that way."
        case "campaign_reference":
            return "A campaign was built against it, which makes it the record of who that campaign was aimed at."
        case "engine_has_run", "recompute_history":
            return "The engine has worked out who belongs in it at least once, and those runs are its record of what it decided."
        case "override_history":
            return "Somebody forced a person in, or held one out. That decision and any reversal of it stay readable."
        case "member_reasons":
            return "Somebody wrote down why a named person is in it."
        default:
            return "It holds a record of a decision somebody made."
        }
    }
}

/// `POST /api/segments/:id/restore`.
struct SegmentRestoreResponse: Codable, Hashable {
    let segment: SegmentRecord
}
