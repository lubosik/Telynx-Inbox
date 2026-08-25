import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

@MainActor
extension AssistantReasoningOperations {
    static func systemDefault() -> AssistantReasoningOperations {
#if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let reasoner = OnDeviceAssistantReasoner()
            return AssistantReasoningOperations(
                availability: { reasoner.availability },
                prewarm: { reasoner.prewarm() },
                respond: { try await reasoner.respond(to: $0) },
                reset: { reasoner.reset() }
            )
        }
#endif
        return AssistantReasoningOperations(
            availability: { .requiresIOS26 },
            prewarm: {},
            respond: { _ in throw AssistantReasoningError.unavailable(.requiresIOS26) },
            reset: {}
        )
    }
}

#if canImport(FoundationModels)
/// The one Phase 6 model implementation. It uses Apple's on-device base model,
/// an empty tool list, and a transcript that lives only for this view lifetime.
/// It is not a generic model provider and performs no network or business-data
/// operation.
@available(iOS 26.0, *)
@MainActor
final class OnDeviceAssistantReasoner {
    private let model: SystemLanguageModel
    private var session: LanguageModelSession

    init(model: SystemLanguageModel = .default) {
        self.model = model
        self.session = Self.makeSession(model: model)
    }

    var availability: AssistantReasoningAvailability {
        switch model.availability {
        case .available:
            return .available
        case .unavailable(let reason):
            switch reason {
            case .appleIntelligenceNotEnabled:
                return .appleIntelligenceNotEnabled
            case .deviceNotEligible:
                return .deviceNotEligible
            case .modelNotReady:
                return .modelNotReady
            @unknown default:
                return .unknown
            }
        }
    }

    /// Call only after the server and identity gates pass and there is a strong
    /// signal the person will ask a question. The caller never prewarms in the
    /// background or immediately before a response merely for appearance.
    func prewarm() {
        guard availability == .available, !session.isResponding else { return }
        session.prewarm()
    }

    func respond(to userText: String) async throws -> String {
        guard availability == .available else {
            throw AssistantReasoningError.unavailable(availability)
        }
        guard !session.isResponding else {
            throw AssistantReasoningError.concurrentRequest
        }

        try Task.checkCancellation()
        let prompt = Prompt {
            "Answer the following request within your read-only limits."
            "The person's request is: \(userText)"
        }

        do {
            let response = try await session.respond(to: prompt)
            try Task.checkCancellation()
            guard let clean = AssistantOutputPolicy.sanitise(response.content) else {
                throw AssistantReasoningError.emptyResponse
            }
            return clean
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as AssistantReasoningError {
            throw error
        } catch let error as LanguageModelSession.GenerationError {
            if Task.isCancelled { throw CancellationError() }
            throw map(error)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw AssistantReasoningError.failed
        }
    }

    /// Dropping the old session also drops its private Foundation Models
    /// transcript. A reset is mandatory whenever the visible text is purged.
    func reset() {
        session = Self.makeSession(model: model)
    }

    private static func makeSession(model: SystemLanguageModel) -> LanguageModelSession {
        LanguageModelSession(model: model, tools: []) {
            AssistantPromptCatalog.current.instructions
        }
    }

    private func map(_ error: LanguageModelSession.GenerationError) -> AssistantReasoningError {
        switch error {
        case .assetsUnavailable:
            return .unavailable(.modelNotReady)
        case .decodingFailure:
            return .failed
        case .exceededContextWindowSize:
            reset()
            return .contextWindowExceeded
        case .guardrailViolation, .refusal:
            return .refused
        case .rateLimited:
            return .rateLimited
        case .concurrentRequests:
            return .concurrentRequest
        case .unsupportedGuide:
            return .failed
        case .unsupportedLanguageOrLocale:
            return .unsupportedLanguage
        @unknown default:
            return .failed
        }
    }
}
#endif

// MARK: - Server-backed reasoning

/// Reasoning through Vici's own backend rather than the on-device model.
///
/// WHY THIS REPLACED THE ON-DEVICE REASONER
///   The on-device model is built for narrow structured tasks. What this
///   product needs is fluid tool calling: hear a sentence phrased any way at
///   all, choose the right verified lookup, and say the result like a person.
///   The previous build approximated that with thirteen exact phrases, so
///   "revenue today" worked and "how's revenue today?" did not.
///
/// WHAT THIS CHANGES ABOUT PRIVACY, SAID PLAINLY
///   The question text now leaves the device. It goes to Vici, which forwards
///   it through the one privacy boundary the backend already had: approved
///   models only, Zero Data Retention required, data collection denied, and
///   sensitive values tokenised before they leave. It is not the same claim as
///   "nothing leaves this iPhone" and the in-app copy must not pretend it is.
///
/// WHAT IT BUYS BACK
///   Availability stops depending on iOS 26, Apple Intelligence being switched
///   on, or the device being eligible. Any phone that can reach the server can
///   use the assistant.
///
/// CONVERSATION MEMORY LIVES HERE
///   `respond` is `(String) async throws -> String` and that signature is not
///   worth changing. The history is held in this object instead, which is the
///   right home for it anyway: `reset()` already exists and is already called
///   when the conversation should be forgotten, so clearing memory and clearing
///   the transcript stay one action rather than two that can disagree.
@MainActor
final class ServerAssistantReasoner {
    /// Six turns, three exchanges. Enough that "out of those, which is the
    /// biggest?" resolves, short enough that the request does not grow with the
    /// conversation. Latency is the thing people notice on a voice interface,
    /// and an unbounded transcript makes every question slower than the last.
    private static let maxRememberedTurns = 6

    private var history: [AssistantConversationTurn] = []

    func respond(to text: String) async throws -> String {
        let answer = try await APIClient.shared.assistantConverse(
            question: text,
            history: history,
            thorough: AssistantPreferences.shared.thoroughAnswers
        )
        history.append(AssistantConversationTurn(role: "user", content: text))
        history.append(AssistantConversationTurn(role: "assistant", content: answer.reply))
        if history.count > Self.maxRememberedTurns {
            history.removeFirst(history.count - Self.maxRememberedTurns)
        }
        return answer.reply
    }

    func reset() {
        history.removeAll()
    }
}

extension AssistantReasoningOperations {
    /// The server-backed reasoner, as the shell already expects to consume it.
    static func serverBacked() -> AssistantReasoningOperations {
        let reasoner = ServerAssistantReasoner()
        return AssistantReasoningOperations(
            // Reasoning is no longer on this device, so there is no model to be
            // ineligible for. Reachability is decided by the request itself,
            // and a failed request surfaces as an error the person can act on
            // rather than as a capability that was never offered.
            availability: { .available },
            prewarm: {},
            respond: { text in try await reasoner.respond(to: text) },
            reset: { reasoner.reset() }
        )
    }
}
