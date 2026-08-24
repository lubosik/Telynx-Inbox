import Foundation

/// Per-account notification preferences, as the server owns them.
///
/// FOUNDATION ONLY, deliberately, so that `swiftc -typecheck` can actually
/// verify it on the Ventura machine that cannot compile SwiftUI. Everything
/// here is decoding, interpretation and copy; nothing is a view. The same split
/// as `SegmentModels.swift`, and for the same reason: a wrong `Codable`
/// conformance is invisible to `-parse` and has reached CI before.
///
/// THE SERVER IS THE SOURCE OF TRUTH AND THE PLACE SUPPRESSION HAPPENS.
///   There is no client-side filter for an alert push. If the backend sends
///   one, iOS displays it, whatever a switch in this app says. So these toggles
///   are a request to the server, the server records them, and
///   `lib/apns-notify.js` consults them immediately before handing a device
///   list to Apple. Nothing in this file may ever be used to hide a
///   notification locally and call that "off".
///
/// COPY RULE: no em dashes anywhere a person can read. Two short sentences
/// instead. `test/ios-notification-settings.test.js` asserts it against this
/// source, because a rule that lives only in a comment lasts one release.

// MARK: - Categories

/// The closed set the server accepts. Mirrors `CATEGORY_KEYS` in
/// `lib/notifications/preferences.js`; a Node test asserts the two lists match,
/// because a key present here and not there answers 400, and one present there
/// and not here is a switch nobody can reach.
enum NotificationCategory: String, CaseIterable, Identifiable, Codable, Hashable {
    case newCustomerMessages = "new_customer_messages"
    case missedCalls = "missed_calls"
    case dailyDigest = "daily_digest"
    case campaignProposals = "campaign_proposals"
    case referrals = "referrals"
    case newReleases = "new_releases"

    var id: String { rawValue }

    /// The fallback label. The server sends its own, which wins; this exists so
    /// a build running against an older backend still renders words rather than
    /// raw keys.
    var fallbackTitle: String {
        switch self {
        case .newCustomerMessages: return "New customer messages"
        case .missedCalls: return "Missed calls"
        case .dailyDigest: return "Daily summary"
        case .campaignProposals: return "Campaigns ready to review"
        case .referrals: return "Conversation referrals"
        case .newReleases: return "New releases"
        }
    }

    var fallbackDetail: String {
        switch self {
        case .newCustomerMessages:
            return "A banner when somebody texts the business number."
        case .missedCalls:
            return "Count missed calls towards the app badge. Calls still ring through the iPhone calling system."
        case .dailyDigest:
            return "Once a day, only when a segment moved enough to matter."
        case .campaignProposals:
            return "When a draft or a proposal is waiting for a decision."
        case .referrals:
            return "When a teammate hands you a customer conversation."
        case .newReleases:
            return "When a new build of this app is available."
        }
    }

    var symbol: String {
        switch self {
        case .newCustomerMessages: return "message.fill"
        case .missedCalls: return "phone.arrow.down.left.fill"
        case .dailyDigest: return "chart.line.uptrend.xyaxis"
        case .campaignProposals: return "megaphone.fill"
        case .referrals: return "person.2.fill"
        case .newReleases: return "sparkles"
        }
    }
}

/// One row on the screen, as described by the server.
struct NotificationCategoryDescriptor: Decodable, Identifiable, Hashable {
    let key: String
    let label: String
    let detail: String

    var id: String { key }
    var category: NotificationCategory? { NotificationCategory(rawValue: key) }
}

// MARK: - The stored answer

/// Every category's current value.
///
/// Decoded permissively. An absent key means "no preference expressed", which
/// the server resolves to true, so this defaults to true rather than to false.
/// Defaulting to false would make an older backend look like a person who had
/// switched everything off.
struct NotificationPreferences: Codable, Hashable {
    var newCustomerMessages: Bool
    var missedCalls: Bool
    var dailyDigest: Bool
    var campaignProposals: Bool
    var referrals: Bool
    var newReleases: Bool

    static let allOn = NotificationPreferences(newCustomerMessages: true,
                                               missedCalls: true,
                                               dailyDigest: true,
                                               campaignProposals: true,
                                               referrals: true,
                                               newReleases: true)

    /// The wire keys are snake case, which is what the database columns are
    /// called. This is the only map in the file.
    enum CodingKeys: String, CodingKey {
        case newCustomerMessages = "new_customer_messages"
        case missedCalls = "missed_calls"
        case dailyDigest = "daily_digest"
        case campaignProposals = "campaign_proposals"
        case referrals = "referrals"
        case newReleases = "new_releases"
    }

    init(newCustomerMessages: Bool,
         missedCalls: Bool,
         dailyDigest: Bool,
         campaignProposals: Bool,
         referrals: Bool,
         newReleases: Bool) {
        self.newCustomerMessages = newCustomerMessages
        self.missedCalls = missedCalls
        self.dailyDigest = dailyDigest
        self.campaignProposals = campaignProposals
        self.referrals = referrals
        self.newReleases = newReleases
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // `try?` collapses a thrown decode error and an absent key into the
        // same nil, and the fallback for both is TRUE. "No preference
        // expressed" is what the server resolves to true, and a decode failure
        // must not look like somebody having switched everything off.
        //
        // `try?` flattens the optional here (SE-0230), so the expression is
        // `Bool?` and not `Bool??`: an absent key and a wrong-typed value both
        // arrive as nil, and both take the same fallback.
        func read(_ key: CodingKeys) -> Bool {
            (try? container.decodeIfPresent(Bool.self, forKey: key)) ?? true
        }
        newCustomerMessages = read(.newCustomerMessages)
        missedCalls = read(.missedCalls)
        dailyDigest = read(.dailyDigest)
        campaignProposals = read(.campaignProposals)
        referrals = read(.referrals)
        newReleases = read(.newReleases)
    }

    subscript(category: NotificationCategory) -> Bool {
        get {
            switch category {
            case .newCustomerMessages: return newCustomerMessages
            case .missedCalls: return missedCalls
            case .dailyDigest: return dailyDigest
            case .campaignProposals: return campaignProposals
            case .referrals: return referrals
            case .newReleases: return newReleases
            }
        }
        set {
            switch category {
            case .newCustomerMessages: newCustomerMessages = newValue
            case .missedCalls: missedCalls = newValue
            case .dailyDigest: dailyDigest = newValue
            case .campaignProposals: campaignProposals = newValue
            case .referrals: referrals = newValue
            case .newReleases: newReleases = newValue
            }
        }
    }
}

// MARK: - The digest health line

/// When the last daily summary ran, and what happened.
///
/// A free health indicator. A scheduler that has silently stopped shows up as a
/// date that stopped moving, in front of the one person who would notice, with
/// no log to read. It also answers "why did I get nothing yesterday", which is
/// the question a deliberately quiet notification always produces.
struct DigestStatus: Decodable, Hashable {
    let lastRunDay: String?
    let lastRunAt: Date?
    let lastStatus: String?
    let lastWasSilent: Bool?
    let lastReason: String?

    /// Why nothing arrived, in words rather than in a machine key. Every reason
    /// here is a designed outcome, and saying so is the difference between
    /// somebody trusting the silence and assuming the feature is broken.
    var silenceExplanation: String? {
        guard lastWasSilent == true else { return nil }
        switch lastReason {
        case "nothing_material":
            return "Nothing moved enough to be worth telling you about."
        case "not_novel":
            return "The same thing changed again, so it was not repeated."
        case "too_diffuse":
            return "Too many segments moved at once to name any of them usefully."
        case "cold_start":
            return "The first run recorded a starting point rather than reporting movement."
        case "bulk_change_detected":
            return "The customer list changed in bulk, which is not customer behaviour."
        case "circuit_breaker":
            return "Almost every segment moved at once, which is a data event rather than news."
        case "no_eligible_recipients":
            return "No account was eligible to receive it."
        default:
            return "Nothing was worth sending."
        }
    }

    /// The line under the toggle. Never claims a run that did not happen.
    func summary(timeZone: TimeZone) -> String {
        guard let lastRunDay, !lastRunDay.isEmpty else {
            return "No daily summary has run yet."
        }
        let when = Self.dayFormatter(timeZone: timeZone).string(from: lastRunAt ?? Date())
        switch lastStatus {
        case "skipped":
            return "Last checked \(lastRunDay). It was too late in the day to be useful, so nothing was sent."
        case "failed":
            return "Last attempt on \(lastRunDay) did not finish."
        default:
            if lastWasSilent == true {
                return "Last checked \(lastRunDay) at \(when). Nothing was sent."
            }
            return "Last sent \(lastRunDay) at \(when)."
        }
    }

    private static func dayFormatter(timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate("jm")
        return formatter
    }
}

// MARK: - The whole payload

/// `GET /api/users/me/notifications` and `PATCH` of the same path.
struct NotificationSettings: Decodable, Hashable {
    let preferences: NotificationPreferences
    let categories: [NotificationCategoryDescriptor]
    /// `false` means the server has the code but not the migration. The screen
    /// shows the defaults and says they cannot be saved yet, rather than
    /// offering controls that answer 503 the moment they are touched.
    let available: Bool
    let digest: DigestStatus?
    /// The account's own IANA identifier, shown read only. It answers the
    /// single most likely support question, which is why a summary arrived at
    /// an unexpected hour, and it makes the London to Miami difference visible
    /// instead of mysterious.
    let timeZone: String?

    enum CodingKeys: String, CodingKey {
        case preferences, categories, available, digest, timeZone
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        preferences = (try? container.decode(NotificationPreferences.self, forKey: .preferences))
            ?? .allOn
        categories = (try? container.decode([NotificationCategoryDescriptor].self, forKey: .categories))
            ?? []
        available = (try? container.decode(Bool.self, forKey: .available)) ?? true
        digest = try? container.decodeIfPresent(DigestStatus.self, forKey: .digest)
        timeZone = try? container.decodeIfPresent(String.self, forKey: .timeZone)
    }

    init(preferences: NotificationPreferences,
         categories: [NotificationCategoryDescriptor],
         available: Bool,
         digest: DigestStatus?,
         timeZone: String?) {
        self.preferences = preferences
        self.categories = categories
        self.available = available
        self.digest = digest
        self.timeZone = timeZone
    }

    static let unavailable = NotificationSettings(preferences: .allOn,
                                                  categories: [],
                                                  available: false,
                                                  digest: nil,
                                                  timeZone: nil)

    /// The rows to render, in server order, falling back to the closed set when
    /// an older backend sends none.
    var rows: [NotificationCategoryDescriptor] {
        let described = categories.compactMap { descriptor -> NotificationCategoryDescriptor? in
            descriptor.category == nil ? nil : descriptor
        }
        if !described.isEmpty { return described }
        return NotificationCategory.allCases.map {
            NotificationCategoryDescriptor(key: $0.rawValue,
                                           label: $0.fallbackTitle,
                                           detail: $0.fallbackDetail)
        }
    }

    var resolvedTimeZone: TimeZone {
        guard let timeZone, let zone = TimeZone(identifier: timeZone) else { return .current }
        return zone
    }
}

// MARK: - Operating system state

/// What iOS itself will do with a notification, independent of any preference
/// stored on the account.
///
/// TWO DIFFERENT QUESTIONS, AND THE SCREEN MUST NOT MERGE THEM.
///   "Has this person asked us not to send this category" is an account
///   setting and is the toggle. "Will iOS show anything at all" is an operating
///   system permission and is not ours to change. An app that shows a toggle
///   reading On while iOS is silently dropping everything is lying, and an app
///   that greys the toggle out throws away a preference that still matters the
///   moment permission is restored. So: show both, and offer a route to the
///   system settings rather than pretending.
enum NotificationAuthorizationState: String, Hashable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
    case unknown

    /// Will iOS deliver anything for this app right now?
    var deliversSomething: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral: return true
        case .notDetermined, .denied, .unknown: return false
        }
    }

    /// Shown at the top of the screen when the answer is not a plain yes.
    /// Nil means there is nothing honest left to say and the toggles speak for
    /// themselves.
    var banner: (title: String, detail: String, action: String)? {
        switch self {
        case .denied:
            return ("Notifications are switched off for this app",
                    "iOS is not showing anything from Vici Inbox, whatever these switches say. Turn them back on in iPhone Settings.",
                    "Open iPhone Settings")
        case .notDetermined:
            return ("Notifications are not enabled yet",
                    "iOS has not been asked for permission. Nothing will arrive until it is.",
                    "Enable notifications")
        case .provisional:
            return ("Notifications are arriving quietly",
                    "They appear in Notification Center with no banner and no sound. Allow them in iPhone Settings to see them as they arrive.",
                    "Open iPhone Settings")
        case .authorized, .ephemeral, .unknown:
            return nil
        }
    }
}
