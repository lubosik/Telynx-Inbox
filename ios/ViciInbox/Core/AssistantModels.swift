import Foundation

/// The complete response from the assistant capability endpoint.
///
/// It deliberately contains no account, conversation, analytics, or customer
/// data. Phase 4 uses this document only to decide whether the local shell may
/// be shown as available.
struct AssistantCapabilityStatus: Decodable, Equatable {
    let enabled: Bool
    let mode: String
    let minimumOSMajor: Int
    let reason: String?

    static let supportedMode = "on_device_read_only"
}

/// Client-side visibility is only an affordance. The server independently
/// requires the same permission and a named Owner or Admin actor.
///
/// This check intentionally does not use `SessionModel.can`, whose legacy
/// compatibility behavior is permissive when an identity or permission list
/// is absent. The assistant pilot fails closed instead.
enum AssistantAccess {
    static func isPermitted(for user: AuthUser?) -> Bool {
        guard let user,
              !user.isSharedTeamLogin,
              user.permissions != nil,
              let role = user.role?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              role == "owner" || role == "admin" else {
            return false
        }
        return user.permissionSet.contains(Permission.assistantUse)
    }
}

enum AssistantInputPolicy {
    /// Bounds the only private text the Assistant holds in memory. Later model work
    /// must revisit token budgeting independently rather than silently raising
    /// this user-interface limit.
    static let maximumCharacters = 500
}

enum AssistantTranscriptPolicy {
    /// With at most eight citations per assistant response, twenty visible
    /// exchanges retain at most 160 references inside the 200-reference
    /// registry. Before another read begins, one old exchange and its evidence
    /// are released. The largest supported read can then register at most 26
    /// provisional references (25 explicit attribution rows plus its page
    /// aggregate), keeping visible citations below the registry boundary.
    static let maximumVisibleExchanges = 20
}

enum AssistantOutputPolicy {
    /// Keeps an accidental long-form response bounded for the compact UI and
    /// optional local speech playback. The model prompt still asks for a much
    /// shorter answer; this is the deterministic final boundary.
    static let maximumCharacters = 1_500

    static func sanitise(_ text: String) -> String? {
        let cleaned = text
            .replacingOccurrences(of: "\u{2014}", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(maximumCharacters))
    }
}

/// Phase 6 sends only greetings to the model. A generated greeting is accepted
/// only when its form is equally narrow; everything else becomes reviewed
/// fixed copy before it can reach the transcript or speech output.
enum AssistantGreetingOutputPolicy {
    static let fallback = "Hello."

    private static let allowedNormalisedGreetings: Set<String> = [
        "good afternoon",
        "good evening",
        "good morning",
        "hello",
        "hello how can i help",
        "hello how can i help you",
        "hello how can i help you today",
        "hello how may i help",
        "hello nice to meet you",
        "hello there",
        "hello what can i help you with",
        "hey",
        "hey how can i help",
        "hey how can i help you",
        "hey there",
        "hi",
        "hi how can i help",
        "hi how can i help you",
        "hi nice to meet you",
        "hi there"
    ]

    static func validatedGreeting(_ text: String) -> String {
        guard let cleaned = AssistantOutputPolicy.sanitise(text), cleaned.count <= 160 else {
            return fallback
        }
        guard cleaned.rangeOfCharacter(from: .decimalDigits) == nil,
              cleaned.rangeOfCharacter(from: CharacterSet(charactersIn: "$£€¥")) == nil else {
            return fallback
        }

        let normalised = cleaned
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard allowedNormalisedGreetings.contains(normalised) else {
            return fallback
        }
        return cleaned
    }
}

struct AssistantScopedResponse: Equatable {
    let text: String
    let wasGenerated: Bool
}

/// Phase 6 has no tools, so arbitrary open prompts would invite fabricated
/// business answers. Default-deny and allow only a small, versioned set of
/// harmless shell questions. Later read-only tools may deliberately expand
/// this policy with grounded answer types.
enum AssistantReasoningScope {
    static let unavailableDataMessage = "I could not verify that from Vici right now."

    private static let generatedGreetingRequests: Set<String> = [
        "hello",
        "hello assistant",
        "hey",
        "hey assistant",
        "hi",
        "hi assistant"
    ]

    private static let localShellAnswers: [String: String] = [
        "help": "You can ask for a verified executive brief, analytics, activity, automation, segment, campaign, opportunity, or referral summary. I cannot perform actions.",
        "what can you do": "I can read a small set of permission-checked Vici summaries and link each figure to its source. I cannot send, edit, approve, assign, or otherwise perform an action.",
        "how do you work": "Apple's on-device model can select one fixed read tool for a supported question. Vici data is fetched through the app's authenticated API, and reviewed app code builds the answer from verified evidence.",
        "are you on device": "Yes. Reasoning in this build uses Apple's on-device language model and has no cloud-model fallback.",
        "is this private": "Your question and on-device model response stay in memory and are cleared when you leave, switch apps, lose access, or receive a call. Supported business reads fetch only bounded data your account may already access.",
        "does this use the internet": "The language model runs on this iPhone. Supported business questions use authenticated network requests to Vici's existing API, but your prompt and the model response are not sent with those requests.",
        "where is my question processed": "The language model processes the question on this iPhone. Permission checks and supported business reads use Vici's server, then the app builds the answer from verified evidence."
    ]

    static func permitsOnDeviceGeneration(for input: String) -> Bool {
        generatedGreetingRequests.contains(normalise(input))
    }

    static func answer(
        to input: String,
        generate: (String) async throws -> String
    ) async throws -> AssistantScopedResponse {
        let normalised = normalise(input)
        if let local = localShellAnswers[normalised] {
            return AssistantScopedResponse(text: local, wasGenerated: false)
        }
        guard generatedGreetingRequests.contains(normalised) else {
            return AssistantScopedResponse(text: unavailableDataMessage, wasGenerated: false)
        }
        let generated = try await generate(input)
        return AssistantScopedResponse(
            text: AssistantGreetingOutputPolicy.validatedGreeting(generated),
            wasGenerated: true
        )
    }

    private static func normalise(_ input: String) -> String {
        input
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

/// A Foundation-only mirror of SystemLanguageModel availability. Keeping the
/// framework type out of the shell preserves the iOS 16 fallback and gives the
/// local smoke tests deterministic inputs.
enum AssistantReasoningAvailability: Equatable {
    case available
    case requiresIOS26
    case appleIntelligenceNotEnabled
    case deviceNotEligible
    case modelNotReady
    case unknown
}

enum AssistantReasoningError: Error, Equatable {
    case unavailable(AssistantReasoningAvailability)
    case refused
    case rateLimited
    case unsupportedLanguage
    case contextWindowExceeded
    case concurrentRequest
    case emptyResponse
    case failed

    var safeMessage: String {
        switch self {
        case .unavailable:
            return "On-device reasoning is not available right now. Nothing was sent elsewhere."
        case .refused:
            return "I cannot help with that request."
        case .rateLimited:
            return "On-device reasoning is busy right now. Please try again in a moment."
        case .unsupportedLanguage:
            return "That language is not supported by on-device reasoning on this iPhone."
        case .contextWindowExceeded:
            return "This private conversation reached its on-device limit and was reset. Please try again."
        case .concurrentRequest:
            return "Another on-device response is still finishing. Please try again in a moment."
        case .emptyResponse, .failed:
            return "On-device reasoning could not finish that response. Please try again."
        }
    }
}

/// Application lifecycle seam around one concrete Apple on-device reasoner.
/// This is deliberately not a language-model provider abstraction.
@MainActor
struct AssistantReasoningOperations {
    let availability: () -> AssistantReasoningAvailability
    let prewarm: () -> Void
    let respond: (String) async throws -> String
    let reset: () -> Void
}

enum AssistantUnavailableReason: Equatable {
    case requiresNewerOS(required: Int, current: Int)
    case unsupportedMode
    case appleIntelligenceNotEnabled
    case deviceNotEligible
    case modelNotReady
    case modelUnavailable
}

/// Every visible and transitional state in the Assistant shell.
///
/// `thinking` remains a truthful placeholder until reasoning is installed.
/// `speaking` represents real local `AVSpeechSynthesizer` output in Phase 5.
enum AssistantPhase: Equatable {
    case checkingCapability
    case disabled
    case unavailable(AssistantUnavailableReason)
    case idle
    case thinking
    case speaking
    case interruptedByCall
    case failed
}

/// A small deterministic state machine kept Foundation-only so it can be
/// compiled and exercised on this repository's non-Xcode development host.
struct AssistantStateMachine: Equatable {
    private(set) var phase: AssistantPhase = .checkingCapability

    @discardableResult
    mutating func beginCapabilityCheck(callIsActive: Bool) -> Bool {
        if callIsActive {
            phase = .interruptedByCall
            return true
        }
        phase = .checkingCapability
        return true
    }

    @discardableResult
    mutating func resolveCapability(_ status: AssistantCapabilityStatus,
                                    currentOSMajor: Int) -> Bool {
        guard phase == .checkingCapability else { return false }
        guard status.enabled else {
            phase = .disabled
            return true
        }
        guard status.mode == AssistantCapabilityStatus.supportedMode else {
            phase = .unavailable(.unsupportedMode)
            return true
        }
        guard currentOSMajor >= status.minimumOSMajor else {
            phase = .unavailable(
                .requiresNewerOS(required: status.minimumOSMajor, current: currentOSMajor)
            )
            return true
        }
        phase = .idle
        return true
    }

    @discardableResult
    mutating func resolveReasoningAvailability(_ availability: AssistantReasoningAvailability,
                                               currentOSMajor: Int) -> Bool {
        guard phase == .idle else { return false }
        switch availability {
        case .available:
            return true
        case .requiresIOS26:
            phase = .unavailable(.requiresNewerOS(required: 26, current: currentOSMajor))
        case .appleIntelligenceNotEnabled:
            phase = .unavailable(.appleIntelligenceNotEnabled)
        case .deviceNotEligible:
            phase = .unavailable(.deviceNotEligible)
        case .modelNotReady:
            phase = .unavailable(.modelNotReady)
        case .unknown:
            phase = .unavailable(.modelUnavailable)
        }
        return true
    }

    @discardableResult
    mutating func beginThinking() -> Bool {
        guard phase == .idle else { return false }
        phase = .thinking
        return true
    }

    @discardableResult
    mutating func beginSpeaking() -> Bool {
        guard phase == .thinking else { return false }
        phase = .speaking
        return true
    }

    @discardableResult
    mutating func finishResponse() -> Bool {
        guard phase == .thinking || phase == .speaking else { return false }
        phase = .idle
        return true
    }

    mutating func interruptForCall() {
        phase = .interruptedByCall
    }

    @discardableResult
    mutating func finishCallInterruption() -> Bool {
        guard phase == .interruptedByCall else { return false }
        phase = .checkingCapability
        return true
    }

    @discardableResult
    mutating func fail() -> Bool {
        guard phase == .checkingCapability || phase == .thinking || phase == .speaking else {
            return false
        }
        phase = .failed
        return true
    }
}

enum AssistantTranscriptRole: Equatable {
    case user
    case assistant
}

/// Transcript entries exist only in the lifetime of `AssistantModel`. They are
/// never written to UserDefaults, files, analytics, logs, or the backend.
struct AssistantTranscriptEntry: Identifiable, Equatable {
    let id: UUID
    let role: AssistantTranscriptRole
    let text: String
    let citations: [AssistantEvidenceCitation]
    let createdAt: Date

    init(id: UUID = UUID(),
         role: AssistantTranscriptRole,
         text: String,
         citations: [AssistantEvidenceCitation] = [],
         createdAt: Date = Date()) {
        self.id = id
        self.role = role
        self.text = text
        self.citations = citations
        self.createdAt = createdAt
    }
}

// MARK: - Server reasoning wire types

/// One remembered turn, sent back so a follow-up resolves against what was
/// already said. "Out of those, which is the biggest?" is not answerable
/// without it, and that is the difference between an assistant and a lookup.
struct AssistantConversationTurn: Codable, Hashable {
    let role: String
    let content: String
}

/// `POST /api/assistant/converse`.
struct AssistantConverseResponse: Codable, Hashable {
    let reply: String
    /// Which verified lookups produced the answer. Empty means the model
    /// answered from the conversation itself, which is legitimate for a
    /// follow-up and is also the fastest path.
    let toolsUsed: [String]?
    /// True when the loop hit its ceiling without settling on an answer.
    let refused: Bool?
    let elapsedMs: Int?
}

/// One entry in the searchable voice library.
struct AssistantVoiceOption: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let accent: String?
    let gender: String?
    let age: String?
    let descriptive: String?
    /// How many builders cloned this voice. The honest proxy for whether it
    /// sounds like a person: a voice thousands of products shipped is one that
    /// survived contact with real listeners.
    let usedBy: Int?
    let previewUrl: String?

    var subtitle: String {
        var parts: [String] = []
        if let accent, !accent.isEmpty { parts.append(accent.capitalized) }
        if let gender, !gender.isEmpty { parts.append(gender.capitalized) }
        if let usedBy, usedBy > 0 { parts.append("used by \(AssistantVoiceOption.compact(usedBy))") }
        return parts.joined(separator: " · ")
    }

    private static func compact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return "\(value / 1_000)k" }
        return "\(value)"
    }
}

struct AssistantVoiceSearchResponse: Codable, Hashable {
    let voices: [AssistantVoiceOption]
    let hasMore: Bool?
}
