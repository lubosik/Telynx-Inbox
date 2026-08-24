import Foundation

/// A small, closed vocabulary for Assistant-owned navigation.
///
/// Navigation is intentionally not inferred by a language model. The parser
/// below accepts only a complete, explicitly listed movement phrase. Business
/// questions such as "show segments" therefore stay questions.
enum AssistantNavigationCommand: Equatable {
    case lastCreatedSegment
    case currentSegmentPeople
    case offers
    case fixed(AssistantFixedNavigationDestination)
}

enum AssistantFixedNavigationDestination: String, Equatable, CaseIterable {
    case inbox
    case contacts
    case automations
    case campaigns
    case audiences
    case calls
    case analytics
    case referrals
    case settings
}

enum AssistantNavigationParseResult: Equatable {
    case command(AssistantNavigationCommand)
    case notNavigation
}

/// Pure complete-string routing. There is no fuzzy matching, substring
/// matching, entity extraction or fallback to a nearby destination.
enum AssistantNavigationParser {
    static func parse(_ input: String) -> AssistantNavigationParseResult {
        guard let phrase = canonicalCompletePhrase(input),
              let command = exactPhrases[phrase] else {
            return .notNavigation
        }
        return .command(command)
    }

    private static let exactPhrases: [String: AssistantNavigationCommand] = {
        var values: [String: AssistantNavigationCommand] = [
            "take me to the segment you just created": .lastCreatedSegment,
            "open the segment you just created": .lastCreatedSegment,
            "go to the segment you just created": .lastCreatedSegment,
            "open the people and show me why they are in it": .currentSegmentPeople,
            "go to the offers": .offers,
            "open the offers": .offers,
            "take me to the offers": .offers
        ]

        let aliases: [(AssistantFixedNavigationDestination, [String])] = [
            (.inbox, ["go to the inbox", "open the inbox", "take me to the inbox"]),
            (.contacts, ["go to contacts", "open contacts", "take me to contacts"]),
            (.automations, ["go to automations", "open automations", "take me to automations"]),
            (.campaigns, ["go to campaigns", "open campaigns", "take me to campaigns"]),
            (.audiences, ["go to audiences", "open audiences", "take me to audiences"]),
            (.calls, ["go to calls", "open calls", "take me to calls"]),
            (.analytics, ["go to analytics", "open analytics", "take me to analytics"]),
            (.referrals, ["go to referrals", "open referrals", "take me to referrals"]),
            (.settings, ["go to settings", "open settings", "take me to settings"])
        ]
        for (destination, phrases) in aliases {
            for phrase in phrases {
                values[phrase] = .fixed(destination)
            }
        }
        return values
    }()

    /// Whitespace and one terminal sentence mark are presentation details.
    /// All other characters remain part of the phrase, which means quoted,
    /// embedded, negated and compound instructions cannot become a command by
    /// sanitisation.
    private static func canonicalCompletePhrase(_ input: String) -> String? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if let final = value.last, final == "." || final == "?" || final == "!" {
            value.removeLast()
        }
        let words = value.split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { return nil }
        return words.map(String.init).joined(separator: " ").lowercased()
    }
}

struct AssistantVerifiedSegment: Equatable {
    let id: String
    let name: String?
}

/// A fresh, fail-closed server authorization snapshot. The fingerprint is the
/// complete named-account identity boundary captured by Root; the coordinator
/// never tries to reconstruct identity from a subset of route permissions.
struct AssistantNavigationAuthorization: Equatable {
    let userID: String
    let identityFingerprint: String
    let access: AppNavigationAccess
}

enum AssistantNavigationAuthorizationResult: Equatable {
    case authorized(AssistantNavigationAuthorization)
    case capabilityDisabled
    case identityOrPermissionChanged
    case unverifiable
}

enum AssistantNavigationSource: Equatable {
    case assistantTyped
    case assistantVoice
    case appIntent
}

enum AssistantNavigationRuntimeState: Equatable {
    case active
    case inactive
    case background

    func permits(_ source: AssistantNavigationSource) -> Bool {
        switch (self, source) {
        case (.active, _), (.inactive, .appIntent): return true
        default: return false
        }
    }
}

struct AssistantNavigationAnnouncement: Equatable, Identifiable {
    let id: UUID
    let message: String
    let source: AssistantNavigationSource
}

struct AssistantCreatedSegmentContext: Equatable {
    let id: String
    let name: String?
    let createdAt: Date
    let sessionID: UUID
    let userID: String
}

/// Opaque proof that a create request began in the currently bound session.
/// It contains no customer or segment data and is invalid after any lifecycle,
/// identity, permission or capability reset.
struct AssistantSegmentCreationCapture: Equatable {
    let sessionID: UUID
}

enum AssistantDraftSource: String, CaseIterable, Hashable {
    case message
    case attachment
    case campaign
    case segment
    case referral
    case contact
    case account
    case assistant
    case other

    var label: String {
        switch self {
        case .message: return "message"
        case .attachment: return "attachment"
        case .campaign: return "campaign"
        case .segment: return "segment"
        case .referral: return "referral"
        case .contact: return "contact"
        case .account: return "account"
        case .assistant: return "Assistant question"
        case .other: return "form"
        }
    }
}

struct AssistantDraftToken: Hashable {
    let id: UUID

    init(id: UUID = UUID()) {
        self.id = id
    }
}

struct AssistantDraftSnapshot: Equatable {
    let revision: UInt64
    let dirtyTokenIDs: Set<UUID>
    let dirtySources: [AssistantDraftSource]

    var hasUnsavedChanges: Bool { !dirtyTokenIDs.isEmpty }
}

struct AssistantNavigationConfirmation: Equatable {
    let id: UUID
    let message: String
    let dirtySources: [AssistantDraftSource]
}

struct AssistantDraftDiscardRequest: Equatable {
    let id: UUID
    let confirmationID: UUID
    let tokenIDs: Set<UUID>
    let sources: [AssistantDraftSource]
}

enum AssistantNavigationOutcome: Equatable {
    case notNavigation
    case opened(route: AppRoute, confirmation: String)
    case confirmationRequired(AssistantNavigationConfirmation)
    case discardRequested(AssistantDraftDiscardRequest)
    case clarification(String)
    case unavailable(String)
    case permissionDenied(String)
    case cancelled
}

/// Reviewed speech/transcript copy for deterministic navigation. No route
/// identity is interpolated, and no model is asked to describe the outcome.
enum AssistantNavigationResponseCopy {
    static func text(for outcome: AssistantNavigationOutcome) -> String? {
        switch outcome {
        case .opened(_, let confirmation):
            return confirmation
        case .confirmationRequired:
            return "Review the unsaved changes prompt on screen before navigating."
        case .discardRequested:
            return "Finish the on-screen discard step before navigating."
        case .clarification(let message), .unavailable(let message),
             .permissionDenied(let message):
            return message
        case .cancelled:
            return nil
        case .notNavigation:
            return nil
        }
    }
}
