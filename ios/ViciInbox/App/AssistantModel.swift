import Foundation
import Combine

/// Main-actor owner for the private on-device Assistant.
///
/// Submission performs a fresh server check before the narrow Phase 6 scope
/// gate may call Apple's on-device model. No prompt reaches the backend.
/// Transcript, draft, model session, and generation task are purged whenever
/// this screen is obscured, dismissed, or interrupted by a call.
@MainActor
final class AssistantModel: ObservableObject {
    typealias CapabilityLoader = () async throws -> AssistantCapabilityStatus

    @Published private(set) var phase: AssistantPhase = .checkingCapability
    @Published private(set) var transcript: [AssistantTranscriptEntry] = []
    @Published var draft = "" {
        didSet {
            if draft.count > AssistantInputPolicy.maximumCharacters {
                draft = String(draft.prefix(AssistantInputPolicy.maximumCharacters))
            }
        }
    }
    @Published private(set) var failureMessage: String?

    private var machine = AssistantStateMachine()
    private var capabilityGeneration = 0
    private var responseGeneration = 0
    private var callIsActive = false
    private let loadCapability: CapabilityLoader
    private let reasoning: AssistantReasoningOperations
    private let businessReasoning: AssistantBusinessReasoningOperations
    private var responseTask: Task<AssistantGroundedResponse, Error>?

    init(loadCapability: @escaping CapabilityLoader = {
        try await APIClient.shared.fetchAssistantStatus()
    }, reasoning: AssistantReasoningOperations? = nil,
       businessReasoning: AssistantBusinessReasoningOperations? = nil) {
        self.loadCapability = loadCapability
        self.reasoning = reasoning ?? .systemDefault()
        self.businessReasoning = businessReasoning ?? .systemDefault()
    }

    func refreshCapability(
        callIsActive: Bool,
        currentOSMajor: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
        prewarmIfReady: Bool = true
    ) async {
        self.callIsActive = callIsActive
        capabilityGeneration += 1
        let generation = capabilityGeneration

        failureMessage = nil
        machine.beginCapabilityCheck(callIsActive: callIsActive)
        publishPhase()
        guard !callIsActive else { return }

        do {
            let status = try await loadCapability()
            guard generation == capabilityGeneration, !self.callIsActive else { return }
            if !status.enabled || status.mode != AssistantCapabilityStatus.supportedMode {
                AssistantNavigationCoordinator.shared.reset(reason: .capabilityDisabled)
            }
            _ = machine.resolveCapability(status, currentOSMajor: currentOSMajor)
            if machine.phase == .idle {
                _ = machine.resolveReasoningAvailability(
                    reasoning.availability(),
                    currentOSMajor: currentOSMajor
                )
            }
            publishPhase()

            if prewarmIfReady, machine.phase == .idle {
                reasoning.prewarm()
            } else if machine.phase != .idle {
                cancelResponse(resetSession: true)
            }
        } catch {
            guard generation == capabilityGeneration, !self.callIsActive else { return }
            failureMessage = "Assistant access could not be verified. Nothing was sent. Try again."
            cancelResponse(resetSession: true)
            _ = machine.fail()
            publishPhase()
        }
    }

    /// Revalidates the server gate immediately before accepting any input.
    /// The strict local scope gate runs before the model operation, so a no-tool
    /// model never sees a business-data or action request.
    func submit(
        callIsActive: Bool,
        user: AuthUser? = nil,
        businessContext: AssistantBusinessContext = .empty,
        navigationCoordinator: AssistantNavigationCoordinator? = nil,
        navigationSource: AssistantNavigationSource = .assistantTyped,
        speechCompletionUptime: TimeInterval? = nil,
        onDraftConsumed: (() -> Void)? = nil,
        currentOSMajor: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    ) async -> String? {
        let submittedText = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !submittedText.isEmpty else { return nil }
        let submissionUptime = AssistantMonotonicClock.now
        let navigationParse = AssistantNavigationParser.parse(submittedText)

        if case .notNavigation = navigationParse {
            await refreshCapability(
                callIsActive: callIsActive,
                currentOSMajor: currentOSMajor,
                prewarmIfReady: false
            )
            guard phase == .idle, !self.callIsActive else { return nil }
        } else {
            // The coordinator owns the fresh capability + identity + route
            // checks for deterministic navigation. Avoid a duplicate serial
            // status fetch before its bounded latency path.
            self.callIsActive = callIsActive
            guard phase == .idle, !callIsActive else { return nil }
        }

        if draft.trimmingCharacters(in: .whitespacesAndNewlines) == submittedText {
            onDraftConsumed?()
            draft = ""
        }
        await makeRoomForNextExchange()
        transcript.append(AssistantTranscriptEntry(role: .user, text: submittedText))
        guard machine.beginThinking() else { return nil }
        publishPhase()

        responseGeneration += 1
        let generation = responseGeneration
        let reasoning = self.reasoning
        let businessReasoning = self.businessReasoning
        let intent = AssistantBusinessIntent.parse(submittedText, context: businessContext)
        let permissions = user?.permissionSet ?? []
        let mayUseBusinessTools = AssistantAccess.isPermitted(for: user)
        let task = Task { () throws -> AssistantGroundedResponse in
            try Task.checkCancellation()
            // Deterministic navigation is resolved before business intent
            // parsing or any model session. A recognized movement phrase can
            // never fall through to a language model, even if app integration
            // is temporarily unavailable.
            if case .command = navigationParse {
                guard let navigationCoordinator else {
                    return AssistantGroundedResponse(
                        text: "Assistant navigation is not available in this build.",
                        citations: []
                    )
                }
                let outcome = await navigationCoordinator.requestNavigation(
                    for: submittedText,
                    source: navigationSource,
                    speechCompletionUptime: speechCompletionUptime
                )
                try Task.checkCancellation()
                guard let text = AssistantNavigationResponseCopy.text(for: outcome) else {
                    throw CancellationError()
                }
                return AssistantGroundedResponse(text: text, citations: [])
            }
            if let intent {
                guard mayUseBusinessTools else { return .unverified }
                do {
                    let grounded = try await businessReasoning.respond(intent, submittedText, permissions)
                    try Task.checkCancellation()
                    return grounded
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    return .unverified
                }
            }
            let scoped = try await AssistantReasoningScope.answer(to: submittedText) { input in
                try Task.checkCancellation()
                let generated = try await reasoning.respond(input)
                try Task.checkCancellation()
                return generated
            }
            try Task.checkCancellation()
            return AssistantGroundedResponse(text: scoped.text, citations: [])
        }
        responseTask = task

        do {
            let response = try await task.value
            guard generation == responseGeneration,
                  !self.callIsActive,
                  phase == .thinking else { return nil }
            responseTask = nil
            if intent != nil, !response.citations.isEmpty {
                AssistantLatencyRecorder.shared.record(
                    .toolBackedAnswer,
                    startUptime: submissionUptime,
                    endUptime: AssistantMonotonicClock.now
                )
            }
            transcript.append(AssistantTranscriptEntry(role: .assistant,
                                                        text: response.text,
                                                        citations: response.citations))
            return response.text
        } catch is CancellationError {
            guard generation == responseGeneration else { return nil }
            responseTask = nil
            return nil
        } catch let error as AssistantReasoningError {
            guard generation == responseGeneration,
                  !self.callIsActive,
                  phase == .thinking else { return nil }
            responseTask = nil
            failureMessage = error.safeMessage
            _ = machine.fail()
            publishPhase()
            return nil
        } catch {
            guard generation == responseGeneration,
                  !self.callIsActive,
                  phase == .thinking else { return nil }
            responseTask = nil
            failureMessage = AssistantReasoningError.failed.safeMessage
            _ = machine.fail()
            publishPhase()
            return nil
        }
    }

    func noteSpeechStarted() {
        _ = machine.beginSpeaking()
        publishPhase()
    }

    func noteSpeechFinished() {
        _ = machine.finishResponse()
        publishPhase()
    }

    func applyDictation(_ text: String) {
        guard phase == .idle, !callIsActive else { return }
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let combined = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? cleaned
            : draft + " " + cleaned
        draft = String(combined.prefix(AssistantInputPolicy.maximumCharacters))
    }

    func evidenceRoute(for token: AssistantEvidenceToken, user: AuthUser?) async -> AppRoute? {
        guard !callIsActive else { return nil }
        guard AssistantAccess.isPermitted(for: user), let user else {
            obscureAndPurge()
            return nil
        }
        guard let status = try? await loadCapability(),
              status.enabled,
              status.mode == AssistantCapabilityStatus.supportedMode else {
            obscureAndPurge()
            return nil
        }
        let route = await businessReasoning.evidenceRoute(
            token,
            AssistantIdentitySnapshot(user: user)
        )
        guard let route else {
            // A stale or no-longer-authorised citation is a privacy boundary,
            // not merely a disabled button. Remove the figures and all private
            // evidence immediately.
            obscureAndPurge()
            return nil
        }
        return route
    }

    /// Calls always win. No Telnyx or audio object is touched here.
    func noteCallActivity(_ active: Bool) {
        callIsActive = active
        capabilityGeneration += 1
        if active {
            cancelResponse(resetSession: true)
            clearPrivateText()
            machine.interruptForCall()
            publishPhase()
        } else if machine.finishCallInterruption() {
            publishPhase()
        }
    }

    /// Clears any text before the app switcher can retain the Assistant page,
    /// and whenever navigation destroys the screen.
    func obscureAndPurge() {
        capabilityGeneration += 1
        cancelResponse(resetSession: true)
        clearPrivateText()
        failureMessage = nil
        _ = machine.beginCapabilityCheck(callIsActive: callIsActive)
        publishPhase()
    }

    private func clearPrivateText() {
        draft = ""
        transcript.removeAll(keepingCapacity: false)
    }

    private func makeRoomForNextExchange() async {
        while transcript.lazy.filter({ $0.role == .assistant }).count
                >= AssistantTranscriptPolicy.maximumVisibleExchanges,
              let firstAssistant = transcript.firstIndex(where: { $0.role == .assistant }) {
            let removed = Array(transcript[...firstAssistant])
            transcript.removeFirst(firstAssistant + 1)
            await businessReasoning.releaseEvidence(
                removed.flatMap(\.citations).map(\.token)
            )
        }
    }

    private func cancelResponse(resetSession: Bool) {
        responseGeneration += 1
        responseTask?.cancel()
        responseTask = nil
        if resetSession {
            reasoning.reset()
            businessReasoning.reset()
        }
    }

    private func publishPhase() {
        phase = machine.phase
    }
}

// MARK: - Assistant preferences

/// What the operator chose about the assistant on THIS device.
///
/// Device-local on purpose, and not a server preference like notifications.
/// Every value here is about this phone: which voices are installed differs per
/// device, and the orb is presentation. A per-account row would promise these
/// follow you to a new phone, and the voice half of that promise cannot be kept
/// because the chosen voice may not exist there.
///
/// `isEnabled` layers UNDER the server flag, it does not override it. The
/// server's `ASSISTANT_ENABLED` is the admin kill switch for the whole pilot;
/// this is one person saying "not for me". Off in either place means off, which
/// is why the view asks the server first and this second.
@MainActor
final class AssistantPreferences: ObservableObject {
    static let shared = AssistantPreferences()

    @Published var isEnabled: Bool { didSet { defaults.set(isEnabled, forKey: Keys.enabled) } }
    @Published var speakingRate: AssistantSpeakingRate {
        didSet { defaults.set(speakingRate.rawValue, forKey: Keys.rate) }
    }
    @Published var orbTint: AssistantOrbTint {
        didSet { defaults.set(orbTint.rawValue, forKey: Keys.tint) }
    }
    @Published var orbSize: AssistantOrbSize {
        didSet { defaults.set(orbSize.rawValue, forKey: Keys.size) }
    }
    /// nil means automatic. A stored identifier means the operator picked it.
    @Published var pinnedVoiceIdentifier: String? {
        didSet {
            if let pinnedVoiceIdentifier {
                defaults.set(pinnedVoiceIdentifier, forKey: Keys.pinnedVoice)
            } else {
                defaults.removeObject(forKey: Keys.pinnedVoice)
            }
        }
    }

    private enum Keys {
        static let enabled = "assistant_preference_enabled"
        static let rate = "assistant_preference_speaking_rate"
        static let tint = "assistant_preference_orb_tint"
        static let size = "assistant_preference_orb_size"
        static let pinnedVoice = "assistant_preference_pinned_voice"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Absent means on. Somebody who has never opened this screen should get
        // the feature, not an empty page they have to go and switch on.
        isEnabled = defaults.object(forKey: Keys.enabled) as? Bool ?? true
        speakingRate = AssistantSpeakingRate(rawValue: defaults.string(forKey: Keys.rate) ?? "")
            ?? .normal
        orbTint = AssistantOrbTint(rawValue: defaults.string(forKey: Keys.tint) ?? "") ?? .brand
        orbSize = AssistantOrbSize(rawValue: defaults.string(forKey: Keys.size) ?? "") ?? .standard
        pinnedVoiceIdentifier = defaults.string(forKey: Keys.pinnedVoice)
    }

    var voicePreference: AssistantVoicePreference {
        pinnedVoiceIdentifier.map { .pinned(identifier: $0) } ?? .automatic
    }
}
