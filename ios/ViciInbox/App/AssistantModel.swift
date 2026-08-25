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

    @Published private(set) var phase: AssistantPhase = .checkingCapability {
        // Mirrored to AssistantPresence so the floating orb, which is drawn at
        // the app root and cannot see this object, shows what is actually
        // happening rather than a frozen icon.
        didSet { AssistantPresence.shared.note(phase: phase) }
    }
    @Published private(set) var transcript: [AssistantTranscriptEntry] = []
    @Published var draft = "" {
        didSet {
            if draft.count > AssistantInputPolicy.maximumCharacters {
                draft = String(draft.prefix(AssistantInputPolicy.maximumCharacters))
            }
        }
    }
    @Published private(set) var failureMessage: String?

    // MARK: Threads
    //
    // The saved conversations for THIS account. Held here rather than in a
    // separate store because they are purged on exactly the same events as the
    // transcript: a title and a first line are private text about the business,
    // and leaving them on screen behind the app switcher would undo what
    // `obscureAndPurge` is for.

    @Published private(set) var threads: [AssistantThreadSummary] = []
    @Published private(set) var openThreadID: String?

    /// True when a conversation is on screen that is NOT being saved.
    ///
    /// WHY THIS EXISTS
    ///   Threads shipped as a hard dependency: if the store could not be
    ///   reached, New chat failed, `openThreadID` stayed nil, and the person was
    ///   left on the list with no route to the assistant at all. An unapplied
    ///   migration therefore bricked the whole feature, and so would a database
    ///   blip.
    ///
    ///   Talking to the assistant does not require anywhere to put the
    ///   transcript. When the store is unreachable the conversation opens
    ///   anyway and history is kept in memory for the session, which is exactly
    ///   how it worked before threads existed. The screen says it is not being
    ///   saved rather than pretending otherwise.
    @Published private(set) var isUnsavedConversationOpen = false

    /// The compacted-away part of the open thread, when there is one.
    /// Set when the last answer asked the app to move somewhere. The view
    /// performs it and clears it, so a move happens once.
    @Published var pendingNavigation: AssistantNavigationInstruction?
    /// A send the assistant has prepared and is asking to have authorised.
    /// Nothing happens until the screen puts a face in front of it.
    @Published var pendingSendConfirmation: AssistantSendConfirmation?

    @Published private(set) var openThreadSummary: String?
    @Published private(set) var openThreadSummarisedCount = 0

    /// A conversation is on screen either way.
    var isConversationOpen: Bool { openThreadID != nil || isUnsavedConversationOpen }
    @Published private(set) var isLoadingThreads = false
    /// Set when the last answer could not be filed. The operator still received
    /// it, so this is a note rather than an error.
    @Published private(set) var lastAnswerWasSaved = true

    private var machine = AssistantStateMachine()
    private var capabilityGeneration = 0
    private var responseGeneration = 0
    private var threadGeneration = 0
    private var callIsActive = false
    private let loadCapability: CapabilityLoader
    private let reasoning: AssistantReasoningOperations
    /// Points the reasoner at the open thread. A no-op when a test injected its
    /// own reasoning operations, because then there is no thread to point at.
    private let adoptThread: @MainActor (String?) -> Void
    /// Read after every answer. A closure, not a stored Bool: the value has to
    /// be fetched at the moment it is needed, and a stored one would be
    /// whatever it was when this model was constructed.
    private let readAnswerWasSaved: @MainActor () -> Bool
    private let threadAPI: AssistantThreadOperations
    private let businessReasoning: AssistantBusinessReasoningOperations
    private var responseTask: Task<AssistantGroundedResponse, Error>?

    init(loadCapability: @escaping CapabilityLoader = {
        try await APIClient.shared.fetchAssistantStatus()
    }, reasoning: AssistantReasoningOperations? = nil,
       businessReasoning: AssistantBusinessReasoningOperations? = nil,
       threadAPI: AssistantThreadOperations? = nil) {
        self.loadCapability = loadCapability
        // Server backed, not on device. See ServerAssistantReasoner for what
        // that changes about privacy and what it buys back. Tests still inject
        // their own operations, so nothing here reaches the network in a test.
        //
        // Written as an if/else over two stored properties rather than a
        // one-line `??`, because `serverBacked()` now returns a pair and both
        // halves must be assigned before anything on `self` is read.
        if let reasoning {
            self.reasoning = reasoning
            self.adoptThread = { _ in }
            self.readAnswerWasSaved = { true }
        } else {
            let backed = AssistantReasoningOperations.serverBacked()
            self.reasoning = backed.operations
            self.adoptThread = backed.adopt
            self.readAnswerWasSaved = backed.lastAnswerWasSaved
        }
        self.threadAPI = threadAPI ?? .live()
        self.businessReasoning = businessReasoning ?? .systemDefault()
    }

    // MARK: Thread list

    /// Loads the account's conversations. Failure is quiet on purpose: the
    /// assistant still works without the list, and a red banner over a feature
    /// that is merely unavailable would read as the assistant being broken.
    func loadThreads() async {
        guard !callIsActive else { return }
        threadGeneration += 1
        let generation = threadGeneration
        isLoadingThreads = true
        defer { if generation == threadGeneration { isLoadingThreads = false } }
        do {
            let loaded = try await threadAPI.list()
            guard generation == threadGeneration, !callIsActive else { return }
            threads = loaded.sorted { $0.sortDate > $1.sortDate }
        } catch {
            guard generation == threadGeneration else { return }
            threads = []
        }
    }

    /// Opens a saved conversation and shows what is in it.
    ///
    /// The messages are rendered from what the SERVER stored, not from anything
    /// this device remembered, so what the operator reads is what the assistant
    /// will actually be reasoning over.
    func openThread(id: String) async {
        guard !callIsActive else { return }
        threadGeneration += 1
        let generation = threadGeneration
        do {
            let detail = try await threadAPI.detail(id)
            guard generation == threadGeneration, !callIsActive else { return }
            openThreadID = detail.thread.id
            isUnsavedConversationOpen = false
            openThreadSummary = detail.thread.summary
            openThreadSummarisedCount = detail.thread.summarisedMessageCount ?? 0
            adoptThread(detail.thread.id)
            lastAnswerWasSaved = true
            failureMessage = nil
            // Only the most recent exchanges are rendered. The registry that
            // backs citations is bounded by AssistantTranscriptPolicy, and a
            // thread of four hundred turns would blow through it. The rest are
            // still on the server and still reasoned over through the summary.
            let visible = AssistantTranscriptPolicy.maximumVisibleExchanges * 2
            transcript = detail.messages
                .suffix(visible)
                .map { message in
                    AssistantTranscriptEntry(role: message.isAssistant ? .assistant : .user,
                                             text: message.content)
                }
        } catch {
            guard generation == threadGeneration, !callIsActive else { return }
            failureMessage = "That conversation could not be opened."
        }
    }

    /// Starts a new conversation and switches to it.
    func startNewThread() async {
        guard !callIsActive else { return }
        threadGeneration += 1
        let generation = threadGeneration
        do {
            let created = try await threadAPI.create()
            guard generation == threadGeneration, !callIsActive else { return }
            openThreadID = created.id
            isUnsavedConversationOpen = false
            openThreadSummary = nil
            openThreadSummarisedCount = 0
            adoptThread(created.id)
            transcript.removeAll(keepingCapacity: false)
            draft = ""
            failureMessage = nil
            lastAnswerWasSaved = true
            threads.insert(created, at: 0)
        } catch {
            guard generation == threadGeneration, !callIsActive else { return }
            // Open it anyway, unsaved. Being unable to store a conversation is
            // not a reason to refuse to have one.
            openUnsavedConversation()
        }
    }

    /// Opens a conversation with nowhere to persist it.
    func openUnsavedConversation() {
        openThreadID = nil
        isUnsavedConversationOpen = true
        openThreadSummary = nil
        openThreadSummarisedCount = 0
        adoptThread(nil)
        transcript.removeAll(keepingCapacity: false)
        draft = ""
        lastAnswerWasSaved = false
        failureMessage = nil
    }

    func renameThread(id: String, title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !callIsActive else { return }
        do {
            let updated = try await threadAPI.rename(id, cleaned)
            guard !callIsActive else { return }
            if let index = threads.firstIndex(where: { $0.id == id }) { threads[index] = updated }
        } catch {
            failureMessage = "That conversation could not be renamed."
        }
    }

    /// Deletes a conversation. Removed from the list first, so the row does not
    /// sit there looking alive while the request is in flight, and put back if
    /// the server refuses.
    func deleteThread(id: String) async {
        guard !callIsActive else { return }
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        let removed = threads[index]
        threads.remove(at: index)
        if openThreadID == id { closeThread() }
        do {
            try await threadAPI.remove(id)
        } catch {
            guard !callIsActive else { return }
            threads.insert(removed, at: min(index, threads.count))
            failureMessage = "That conversation could not be deleted."
        }
    }

    /// Picks up the name the server gave a thread from its first question.
    ///
    /// Reloading the whole list after every answer would be a request per
    /// question to catch a change that happens exactly once in a thread's life.
    /// A thread is named by its first question, so a row with no title is the
    /// only stale one, and the check is a local comparison.
    private func refreshOpenThreadRow() async {
        guard let openThreadID else { return }
        guard let index = threads.firstIndex(where: { $0.id == openThreadID }) else { return }
        guard threads[index].title == nil else { return }
        await loadThreads()
    }

    /// Back to the list. The thread is not deleted and nothing on the server
    /// changes: closing a screen is not an instruction to destroy anything.
    func closeThread() {
        openThreadID = nil
        isUnsavedConversationOpen = false
        openThreadSummary = nil
        openThreadSummarisedCount = 0
        adoptThread(nil)
        cancelResponse(resetSession: false)
        transcript.removeAll(keepingCapacity: false)
        draft = ""
        lastAnswerWasSaved = true
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
            // An exactly-phrased business question still takes the local
            // grounded path, because that one returns citations the reader can
            // tap through to. It is a narrow fast path over the same data, not
            // a different answer.
            if let intent, mayUseBusinessTools {
                do {
                    let grounded = try await businessReasoning.respond(intent, submittedText, permissions)
                    try Task.checkCancellation()
                    return grounded
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    // Fall through to the server rather than giving up. A
                    // failed fast path should cost accuracy of citation, not
                    // the answer itself.
                }
            }

            // EVERYTHING ELSE GOES TO THE SERVER, AND THAT IS THE WHOLE FIX.
            //
            // What used to be here was a gate that recognised eight canned
            // questions and a handful of greetings, and answered every other
            // sentence with "I could not verify that from Vici right now".
            // Since the parser above only matched thirteen exact phrases, that
            // was almost everything a person actually says out loud.
            //
            // The server reasoner has the real tools, checks permissions per
            // tool, and refuses when no tool can answer. So the gate is not
            // just unnecessary now, it is strictly worse than the thing behind
            // it: it was refusing questions the tools can answer.
            try Task.checkCancellation()
            let generated = try await reasoning.respond(submittedText)
            try Task.checkCancellation()
            let move = reasoning.takeNavigation()
            let send = reasoning.takeSendConfirmation()
            await MainActor.run {
                self.pendingNavigation = move
                self.pendingSendConfirmation = send
            }
            return AssistantGroundedResponse(text: generated, citations: [])
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
            // Read after the answer, never assumed. The server returns a reply
            // it could not file rather than losing it, and the screen has to be
            // able to say so.
            lastAnswerWasSaved = openThreadID == nil ? true : readAnswerWasSaved()
            if openThreadID != nil { await refreshOpenThreadRow() }
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
        // The list goes too. A thread title is the operator's first question
        // and the preview is that question in full, so a list of them is a
        // summary of what this business has been worrying about. Leaving it on
        // screen behind the app switcher would undo the reason this method
        // exists. It is a read away when the screen comes back.
        threads.removeAll(keepingCapacity: false)
        openThreadID = nil
        threadGeneration += 1
        lastAnswerWasSaved = true
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
    /// Thorough answers may chain several lookups before replying, which is
    /// what a question like "anything I should know?" needs. Quick stops after
    /// one lookup and is roughly twice as fast. Named for what the person gets,
    /// not for the round trips underneath.
    @Published var thoroughAnswers: Bool {
        didSet { defaults.set(thoroughAnswers, forKey: Keys.thorough) }
    }

    /// Whether the microphone reopens by itself after each answer.
    ///
    /// On by default, because a conversation where you have to ask permission
    /// to speak after every reply is not a conversation. It is a switch rather
    /// than a fact of the product because a phone that opens its own microphone
    /// is not something to impose on somebody who did not want it, and because
    /// somebody in an open-plan office may genuinely not.
    @Published var continuousConversation: Bool {
        didSet { defaults.set(continuousConversation, forKey: Keys.continuous) }
    }

    @Published var speakingRate: AssistantSpeakingRate {
        didSet { defaults.set(speakingRate.rawValue, forKey: Keys.rate) }
    }
    @Published var orbTint: AssistantOrbTint {
        didSet { defaults.set(orbTint.rawValue, forKey: Keys.tint) }
    }
    @Published var orbSize: AssistantOrbSize {
        didSet { defaults.set(orbSize.rawValue, forKey: Keys.size) }
    }
    /// The chosen voice's display name, remembered alongside its id purely so
    /// the Settings row can say "Elise" instead of an opaque identifier without
    /// a network call every time the screen opens.
    @Published var pinnedVoiceName: String? {
        didSet {
            if let pinnedVoiceName {
                defaults.set(pinnedVoiceName, forKey: Keys.pinnedVoiceName)
            } else {
                defaults.removeObject(forKey: Keys.pinnedVoiceName)
            }
        }
    }

    /// nil means the server default, which is Elise. A stored identifier means
    /// the operator chose one from the library.
    @Published var pinnedVoiceIdentifier: String? {
        didSet {
            if let pinnedVoiceIdentifier {
                defaults.set(pinnedVoiceIdentifier, forKey: Keys.pinnedVoice)
            } else {
                defaults.removeObject(forKey: Keys.pinnedVoice)
            }
        }
    }

    /// Whether the operator has been through the voice and orb picker.
    ///
    /// It is shown once, on the way into the first conversation, and never
    /// again: a chooser that reappears every time stops being a choice and
    /// becomes a toll on the way to the thing you actually wanted. Changing it
    /// afterwards lives in Settings, where a setting belongs.
    @Published var hasChosenVoice: Bool {
        didSet { defaults.set(hasChosenVoice, forKey: Keys.hasChosenVoice) }
    }

    private enum Keys {
        static let hasChosenVoice = "assistant_preference_has_chosen_voice"
        static let enabled = "assistant_preference_enabled"
        static let thorough = "assistant_preference_thorough"
        static let continuous = "assistant_preference_continuous_conversation"
        static let rate = "assistant_preference_speaking_rate"
        static let tint = "assistant_preference_orb_tint"
        static let size = "assistant_preference_orb_size"
        static let pinnedVoice = "assistant_preference_pinned_voice"
        static let pinnedVoiceName = "assistant_preference_pinned_voice_name"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Absent means on. Somebody who has never opened this screen should get
        // the feature, not an empty page they have to go and switch on.
        isEnabled = defaults.object(forKey: Keys.enabled) as? Bool ?? true
        // Defaults on. A wrong answer is worse than a slow one, and somebody
        // who has never opened this screen should get the more capable
        // behaviour.
        thoroughAnswers = defaults.object(forKey: Keys.thorough) as? Bool ?? true
        continuousConversation = defaults.object(forKey: Keys.continuous) as? Bool ?? true
        speakingRate = AssistantSpeakingRate(rawValue: defaults.string(forKey: Keys.rate) ?? "")
            ?? .normal
        orbTint = AssistantOrbTint(rawValue: defaults.string(forKey: Keys.tint) ?? "") ?? .brand
        orbSize = AssistantOrbSize(rawValue: defaults.string(forKey: Keys.size) ?? "") ?? .standard
        pinnedVoiceIdentifier = defaults.string(forKey: Keys.pinnedVoice)
        pinnedVoiceName = defaults.string(forKey: Keys.pinnedVoiceName)
        // Absent means not yet chosen, so the picker appears. Somebody who had
        // already pinned a voice before this screen existed has chosen one, and
        // must not be sent back through a first-run flow they finished months
        // ago by another route.
        hasChosenVoice = defaults.object(forKey: Keys.hasChosenVoice) as? Bool
            ?? (defaults.string(forKey: Keys.pinnedVoice) != nil)
    }

    var voicePreference: AssistantVoicePreference {
        pinnedVoiceIdentifier.map { .pinned(identifier: $0) } ?? .automatic
    }
}
