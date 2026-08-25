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
/// CONVERSATION MEMORY IS A THREAD ID, NOT A TRANSCRIPT
///   This object used to hold the last six turns and post them back with every
///   question. Two things were wrong with that. The conversation died with the
///   screen, so there was nothing to come back to. And the transcript the model
///   reasoned over was whatever this client said it was, which meant grounding
///   rested on the client being honest about what the assistant had previously
///   said.
///
///   Now it holds only the id of the open thread. The server reads the turns it
///   recorded itself, and compacts them once they get long. The one piece of
///   state here is which conversation is open, which is the only piece the
///   client is actually entitled to decide.
///
///   `reset()` keeps its meaning: forget which conversation is open. The thread
///   is not deleted, because closing a screen is not an instruction to destroy
///   anything. Deleting is its own deliberate action with its own button.
@MainActor
final class ServerAssistantReasoner {
    private(set) var threadID: String?

    /// Whether the last answer was filed into the thread.
    ///
    /// The server returns the answer even when it could not store it, because
    /// the operator asked a question and is owed what came back. This carries
    /// that fact up so the screen can say the conversation was not kept,
    /// instead of showing a reply that will not be there tomorrow.
    private(set) var lastAnswerWasSaved = true

    func adopt(threadID: String?) {
        self.threadID = threadID
        lastAnswerWasSaved = true
    }

    /// Where the last answer asked the app to go, if anywhere. Read once and
    /// cleared, so a move is performed exactly once and a later answer that
    /// asks for nothing cannot replay the previous destination.
    private(set) var pendingNavigation: AssistantNavigationInstruction?

    func takePendingNavigation() -> AssistantNavigationInstruction? {
        defer { pendingNavigation = nil }
        return pendingNavigation
    }

    /// The send waiting on the operator's face, read once and cleared. Cleared
    /// on read for the same reason navigation is: a later answer that asks for
    /// nothing must not replay the previous prompt, and a send prompt is the
    /// worst possible thing to replay.
    private(set) var pendingSendConfirmation: AssistantSendConfirmation?

    func takePendingSendConfirmation() -> AssistantSendConfirmation? {
        defer { pendingSendConfirmation = nil }
        return pendingSendConfirmation
    }

    func respond(to text: String) async throws -> String {
        let answer = try await APIClient.shared.assistantConverse(
            question: text,
            // Empty, always. With a thread the server ignores it and reads its
            // own record; without one there is no conversation to carry. This
            // is the parameter that used to smuggle the client's version of
            // events into the reasoning.
            history: [],
            threadID: threadID,
            thorough: AssistantPreferences.shared.thoroughAnswers
        )
        // The server decides which thread the turn landed in. Adopting what it
        // echoes back keeps the two from drifting if it ever answers about a
        // different one than was asked for.
        if let answered = answer.threadId { threadID = answered }
        // THESE TWO LINES WERE MISSING, AND THAT WAS THE OTHER HALF OF IT.
        // `pendingNavigation` was declared here and read by the screen, but
        // nothing ever assigned it, so "take me to the inbox" was broken on the
        // client as well as on the server. Both ends are fixed together; either
        // one alone would have kept it broken and looked correct in review.
        pendingNavigation = answer.navigate
        pendingSendConfirmation = answer.confirmSend
        // Absent means there was no thread to save into, which is not a failure
        // to save. Only an explicit false is.
        lastAnswerWasSaved = answer.saved ?? true
        return answer.reply
    }

    func reset() {
        threadID = nil
        lastAnswerWasSaved = true
    }
}

extension AssistantReasoningOperations {
    /// The server-backed reasoner, as the shell already expects to consume it.
    ///
    /// `adopt` is handed back so the screen can point the reasoner at whichever
    /// thread the operator opened. It is a closure rather than a reference to
    /// the object because `AssistantReasoningOperations` is the seam the tests
    /// inject through, and widening it to expose a concrete class would put the
    /// real networking class back in the middle of every test.
    static func serverBacked() -> (operations: AssistantReasoningOperations,
                                   adopt: @MainActor (String?) -> Void,
                                   lastAnswerWasSaved: @MainActor () -> Bool) {
        let reasoner = ServerAssistantReasoner()
        let operations = AssistantReasoningOperations(
            // Reasoning is no longer on this device, so there is no model to be
            // ineligible for. Reachability is decided by the request itself,
            // and a failed request surfaces as an error the person can act on
            // rather than as a capability that was never offered.
            availability: { .available },
            prewarm: {},
            respond: { text in try await reasoner.respond(to: text) },
            reset: { reasoner.reset() },
            takeNavigation: { reasoner.takePendingNavigation() },
            takeSendConfirmation: { reasoner.takePendingSendConfirmation() }
        )
        // `lastAnswerWasSaved` is read through a closure, not captured as a
        // value. A stored Bool would be the value at the moment this pair was
        // built, which is always true, so the screen would never learn that a
        // save had failed.
        return (operations,
                { threadID in reasoner.adopt(threadID: threadID) },
                { reasoner.lastAnswerWasSaved })
    }
}
