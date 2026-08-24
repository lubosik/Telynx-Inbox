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
