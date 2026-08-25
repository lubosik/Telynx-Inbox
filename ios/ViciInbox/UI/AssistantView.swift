import SwiftUI
import UIKit

/// The assistant pilot, with push-to-talk capture and a spoken reply.
///
/// WHAT RUNS WHERE, BECAUSE THE LABELS ON THIS SCREEN MUST BE TRUE
///   What you say is captured and recognised on this iPhone and the audio never
///   leaves it. The question text goes to Vici, which reasons through the
///   backend's existing privacy boundary and returns a sentence, and the spoken
///   audio is synthesised in the cloud. Saying "on this iPhone" about either of
///   those last two would be false, and a person deciding what to say out loud
///   is relying on these words.
/// output. Phase 7 adds only fixed, permission-checked read tools. Business
/// figures are rendered from private verified evidence, never model prose.
struct AssistantView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    // The assistant is presented as a sheet, so a move has to close it or the
    // destination opens underneath and nobody sees it.
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var speech: AssistantSpeechCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AssistantModel()
    @ObservedObject private var navigation = AssistantNavigationCoordinator.shared
    @ObservedObject private var preferences = AssistantPreferences.shared
    @ObservedObject private var drafts = AssistantUnsavedDraftRegistry.shared
    @State private var draftToken: AssistantDraftToken?
    /// Which row is being renamed, if any. Renaming happens in the row itself
    /// rather than in a sheet, because the thing being named is right there and
    /// a modal to change four words reads as heavier than the change is.
    @State private var renamingThreadID: String?
    @State private var renameDraft = ""
    /// Chamber sheets. Held here rather than inside the chamber because the
    /// chamber is presentational and owns no policy, including the policy of
    /// what a first run is.
    @State private var isShowingTranscript = false
    @State private var isShowingVoiceSettings = false
    @State private var isChoosingVoiceForFirstTime = false
    @FocusState private var inputIsFocused: Bool

    private var callIsActive: Bool {
        guard let call = session.activeCall else { return false }
        return call.phase != .idle
    }

    private var hasClientAccess: Bool {
        AssistantAccess.isPermitted(for: session.currentUser)
    }

    private var assistantIdentityKey: String {
        guard let user = session.currentUser else { return "signed-out" }
        return AssistantIdentitySnapshot(user: user).stableKey
    }

    /// The account sheet sits above the selected tab, so the app router keeps
    /// the only trusted description of what remains underneath it. Phase 7
    /// supports a segment route only. A customer phone is never inferred from
    /// text or borrowed from another tab.
    private var assistantBusinessContext: AssistantBusinessContext {
        guard router.selectedTab == .growth else { return .empty }
        switch router.growthPath.last {
        case .segment(let id, _), .segmentPeople(let id, _):
            return AssistantBusinessContext(segmentID: id, memberPhone: nil)
        default:
            return .empty
        }
    }

    var body: some View {
        ZStack {
            AssistantBackdrop()

            // The list, or the conversation that was opened from it. Two
            // screens rather than a list stacked above a chat, because the
            // composer and the orb belong to one conversation and putting them
            // over a list of all of them makes it ambiguous which one a
            // question is about.
            if !model.isConversationOpen {
                threadList
            } else {
                conversation
            }

            if scenePhase != .active {
                Color(.systemBackground).ignoresSafeArea()
            }
        }
        .toolbar { assistantToolbar }
        // Hidden over the chamber. The chamber is a full-bleed black screen and
        // a navigation bar above it puts a grey strip and a title over an orb
        // that is meant to be floating in nothing.
        .toolbar(model.isConversationOpen ? .hidden : .visible, for: .navigationBar)
        // Performed here rather than in the model, because moving the app is
        // the view layer's job and the router is an environment object. Cleared
        // as it is consumed so one instruction produces one move.
        .onChange(of: model.pendingNavigation) { move in
            guard let move else { return }
            model.pendingNavigation = nil
            guard performAssistantNavigation(move) else { return }
            dismiss()
        }
        .navigationTitle(model.isConversationOpen ? openThreadTitle : "Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .privacySensitive()
        .task {
            registerDraftOwnerIfNeeded()
            guard hasClientAccess else {
                model.obscureAndPurge()
                return
            }
            await model.refreshCapability(callIsActive: callIsActive)
            await model.loadThreads()
        }

        .onChange(of: scenePhase) { phase in
            if phase == .active {
                guard hasClientAccess else {
                    model.obscureAndPurge()
                    return
                }
                Task { await model.refreshCapability(callIsActive: callIsActive) }
            } else {
                inputIsFocused = false
                speech.stopAll()
                model.obscureAndPurge()
            }
        }
        .onChange(of: callIsActive) { active in
            speech.noteCallActivity(active)
            model.noteCallActivity(active)
            if active {
                inputIsFocused = false
                router.dismissAccount()
            } else {
                Task { await model.refreshCapability(callIsActive: false) }
            }
        }
        .onChange(of: speech.dictationSequence) { _ in
            guard let dictated = speech.consumeFinalizedDictation(),
                  model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return
            }
            model.applyDictation(dictated.text)
            submitQuestion(source: .assistantVoice,
                           speechCompletionUptime: dictated.completionUptime)
        }
        .onChange(of: model.draft) { value in
            guard let draftToken else { return }
            drafts.setDirty(
                !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                for: draftToken
            )
        }
        .onChange(of: drafts.discardRequest?.id) { _ in
            discardAssistantDraftIfRequested()
        }
        .onChange(of: hasClientAccess) { permitted in
            guard !permitted else { return }
            speech.stopAll()
            model.obscureAndPurge()
            router.dismissAccount()
        }
        .onChange(of: assistantIdentityKey) { _ in
            // Even an Owner-to-Owner switch is a privacy boundary. Boolean
            // access alone cannot distinguish two permitted people.
            inputIsFocused = false
            speech.stopAll()
            model.obscureAndPurge()
            router.dismissAccount()
        }
        .onDisappear {
            inputIsFocused = false
            if navigation.hasNavigationInFlight {
                speech.stopCaptureKeepingVoiceOutput()
            } else {
                speech.stopAll()
            }
            model.obscureAndPurge()
            if let draftToken {
                drafts.unregister(draftToken)
                self.draftToken = nil
            }
        }
    }

    /// The saved conversations for this account.
    private var threadList: some View {
        Group {
            if model.threads.isEmpty {
                AssistantEmptyThreadList(isLoading: model.isLoadingThreads) {
                    Task { await model.startNewThread() }
                }
            } else {
                List {
                    ForEach(model.threads) { thread in
                        AssistantThreadRow(
                            thread: thread,
                            isRenaming: renamingThreadID == thread.id,
                            renameDraft: $renameDraft,
                            open: {
                                guard hasClientAccess, !callIsActive else { return }
                                Task { await model.openThread(id: thread.id) }
                            },
                            beginRename: {
                                renameDraft = thread.title ?? thread.displayTitle
                                renamingThreadID = thread.id
                            },
                            commitRename: {
                                let name = renameDraft
                                let id = thread.id
                                renamingThreadID = nil
                                Task { await model.renameThread(id: id, title: name) }
                            },
                            cancelRename: { renamingThreadID = nil },
                            delete: { Task { await model.deleteThread(id: thread.id) } }
                        )
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .refreshable { await model.loadThreads() }
            }
        }
    }

    private var openThreadTitle: String {
        guard let openThreadID = model.openThreadID,
              let thread = model.threads.first(where: { $0.id == openThreadID }) else {
            // An unsaved conversation has no stored title to show.
            return model.isUnsavedConversationOpen ? "Chat (not saved)" : "Chat"
        }
        return thread.displayTitle
    }

    @ToolbarContentBuilder
    private var assistantToolbar: some ToolbarContent {
        if !model.isConversationOpen {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    guard hasClientAccess, !callIsActive else { return }
                    Task { await model.startNewThread() }
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                .disabled(!hasClientAccess || callIsActive)
            }
        } else {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    inputIsFocused = false
                    speech.stopAll()
                    model.closeThread()
                    Task { await model.loadThreads() }
                } label: {
                    Label("Chats", systemImage: "chevron.left")
                }
            }
        }
    }

    /// THE CHAMBER IS THE CONVERSATION NOW.
    ///
    /// What this replaced put an orb, a heading, an explanation, a permission
    /// card, the whole transcript, a text field and a send button on one
    /// screen, all at once, while the person was trying to talk. The transcript
    /// is not gone: it is one tap away at the top left, in `transcriptBody`
    /// below, unchanged. It is just no longer pushed at somebody mid-sentence.
    private var conversation: some View {
        AssistantVoiceChamberView(
            phase: model.phase,
            speechPhase: speech.phase,
            tint: preferences.orbTint,
            isBlockedByCall: callIsActive,
            failureMessage: model.failureMessage,
            draft: $model.draft,
            onOrbTap: handleChamberOrbTap,
            onSubmit: { submitQuestion(source: .assistantTyped, speechCompletionUptime: nil) },
            onShowTranscript: { isShowingTranscript = true },
            onShowVoiceSettings: { isShowingVoiceSettings = true },
            onEnd: {
                speech.stopAll()
                dismiss()
            }
        )
        .sheet(isPresented: $isShowingTranscript) {
            NavigationStack {
                transcriptBody
                    .navigationTitle(openThreadTitle)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { isShowingTranscript = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $isShowingVoiceSettings) {
            AssistantVoicePickerView(isFirstRun: false)
        }
        // Shown once, on the way in. `hasChosenVoice` is what makes it once.
        .sheet(isPresented: $isChoosingVoiceForFirstTime) {
            AssistantVoicePickerView(isFirstRun: true)
        }
        // The send prompt the assistant asked for. Presented here because this
        // is where the person is standing when they ask, and a prompt that
        // opened behind a dismissed screen would be a send nobody ever saw.
        .sheet(item: $model.pendingSendConfirmation) { confirmation in
            AssistantSendConfirmationView(confirmation: confirmation)
        }
        .onAppear {
            if !preferences.hasChosenVoice { isChoosingVoiceForFirstTime = true }
        }
    }

    /// One gesture, three meanings, and interruption is the one that matters.
    ///
    /// Cutting the answer off before opening the microphone is not politeness:
    /// capturing over the top of the assistant's own voice feeds it back in,
    /// and the transcript then contains what the assistant said as though the
    /// person had said it.
    private func handleChamberOrbTap() {
        guard !callIsActive else { return }
        if model.phase == .speaking {
            speech.stopAll()
            model.noteSpeechFinished()
            speech.beginPushToTalk(callIsActive: callIsActive)
            return
        }
        if speech.phase == .listening || speech.phase == .finalizing {
            speech.endPushToTalk()
            return
        }
        guard speech.canBeginPushToTalk else { return }
        speech.beginPushToTalk(callIsActive: callIsActive)
    }

    /// What was said, for reading. Reached from the chamber's top left.
    ///
    /// The orb, the status copy and the microphone button used to live at the
    /// top of this and now live in the chamber. A second orb inside a sheet
    /// presented over the first one would be two things claiming to be the same
    /// assistant, and the one in the sheet would be the one that was wrong.
    private var transcriptBody: some View {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 22) {
                            Color.clear.frame(height: 4)

                            if model.phase == .idle || speech.phase == .interruptedByCall {
                                AssistantSpeechStatusCard(
                                    phase: speech.phase,
                                    liveTranscript: speech.liveTranscript,
                                    voiceDisclosure: speech.voiceDisclosure
                                )
                            }

                            if model.phase == .failed {
                                Button {
                                    guard hasClientAccess else { return }
                                    Task { await model.refreshCapability(callIsActive: callIsActive) }
                                } label: {
                                    Label("Retry access check", systemImage: "arrow.clockwise")
                                        .font(.subheadline.weight(.semibold))
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 10)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(ViciTheme.tint)
                                .disabled(callIsActive)
                            }

                            // THE WHOLE CONVERSATION, BECAUSE IT IS A THREAD NOW.
                            //
                            // This used to show only the newest answer, on the
                            // argument that a voice interface should not read
                            // back what you just said. That argument holds for
                            // a conversation that lasts one screen and then
                            // ceases to exist. It does not hold for one you can
                            // put down and come back to a week later: the
                            // question the operator has then is "what had I
                            // asked it?", and the answer used to be nowhere.
                            //
                            // It is also what the model is reasoning over, so
                            // showing it is the only way the operator can tell
                            // whether the context is what they think it is.
                            // What the earlier half of a long conversation was
                            // folded into. Shown above the turns it replaced,
                            // where it sits in the same order the conversation
                            // actually happened.
                            if let summary = model.openThreadSummary,
                               !summary.trimmingCharacters(in: .whitespaces).isEmpty {
                                AssistantCompactedHistory(
                                    summary: summary,
                                    messageCount: model.openThreadSummarisedCount
                                )
                            }

                            if model.transcript.isEmpty {
                                AssistantPrivacyCard()
                            } else {
                                ForEach(model.transcript) { entry in
                                    AssistantTranscriptBubble(entry: entry) { token in
                                        openEvidence(token)
                                    }
                                    .id(entry.id)
                                }
                            }

                            if !model.lastAnswerWasSaved {
                                AssistantUnsavedNotice()
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.bottom, 18)
                    }
                    .onChange(of: model.transcript.count) { _ in
                        guard let last = model.transcript.last else { return }
                        withAnimation(.easeOut(duration: 0.25)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }

                // NO COMPOSER HERE ANY MORE.
                //
                // Asking and reading are separate acts now. The chamber owns
                // the microphone and the text field; a second set inside a
                // sheet presented over it would leave two microphone buttons on
                // screen at once, both claiming to be the way to speak, with
                // only one of them attached to the orb the person is watching.
            }
    }


    private func submitQuestion(source: AssistantNavigationSource,
                                speechCompletionUptime: TimeInterval?) {
        guard hasClientAccess else { return }
        let submissionWasNavigation: Bool
        if case .command = AssistantNavigationParser.parse(model.draft) {
            submissionWasNavigation = true
        } else {
            submissionWasNavigation = false
        }
        let priorAnnouncementID = navigation.announcement?.id
        inputIsFocused = false
        speech.stopAll()
        // Armed, not spoken. It only says anything if the answer is still not
        // back after a beat, so a fast reply never gets "one moment" bolted on
        // the front. See armThinkingFiller.
        //
        // Not armed for navigation: those resolve locally in well under a
        // second, and covering them would make the fastest thing the assistant
        // does sound like the slowest.
        if case .command = AssistantNavigationParser.parse(model.draft) {
            // Navigation resolves locally, so there is no wait to cover.
        } else {
            speech.armThinkingFiller()
        }
        Task {
            guard let response = await model.submit(
                callIsActive: callIsActive,
                user: session.currentUser,
                businessContext: assistantBusinessContext,
                navigationCoordinator: navigation,
                navigationSource: source,
                speechCompletionUptime: speechCompletionUptime,
                onDraftConsumed: {
                    // Update the opaque registry in the exact synchronous
                    // operation that consumes the accepted draft. A failed
                    // capability check leaves both text and dirty state intact.
                    if let draftToken { drafts.setDirty(false, for: draftToken) }
                }
            ) else { return }
            // The answer is here, so nothing should still be queued to say
            // "one moment" over the top of it.
            speech.cancelThinkingFiller()
            guard hasClientAccess, !callIsActive, scenePhase == .active else {
                speech.stopAll()
                model.noteSpeechFinished()
                return
            }
            // Successful navigation confirmations are spoken by Root only
            // after the exact destination reports itself visible. A failed
            // navigation remains on this sheet and must still say why.
            if submissionWasNavigation,
               navigation.announcement?.id != priorAnnouncementID { return }
            let started = speech.speak(response) { model.noteSpeechFinished() }
            if started { model.noteSpeechStarted() }
            else { model.noteSpeechFinished() }
        }
    }

    /// Maps what the assistant asked for onto a real route.
    ///
    /// Returns false for anything unrecognised rather than guessing a nearby
    /// screen. Being taken somewhere you did not ask for is worse than not
    /// being taken anywhere, and the spoken answer already said where it
    /// intended to go, so a silent non-move is visible rather than confusing.
    private func performAssistantNavigation(_ move: AssistantNavigationInstruction) -> Bool {
        let target = move.targetId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasTarget = !(target ?? "").isEmpty

        switch move.screen {
        case "inbox":
            if hasTarget, let target { router.open(.conversation(phone: target)) } else { router.open(.inbox) }
        case "contacts":
            if hasTarget, let target { router.open(.contact(phone: target)) } else { router.open(.contacts) }
        case "calls": router.open(.calls)
        case "analytics": router.open(.analytics)
        case "growth", "automations": router.open(.growth(.automations))
        case "campaigns":
            if hasTarget, let target { router.open(.campaign(id: target)) } else { router.open(.growth(.campaigns)) }
        case "campaignProposals": router.open(.campaignProposals)
        case "audiences":
            if hasTarget, let target { router.open(.segment(id: target, name: nil)) } else { router.open(.growth(.audiences)) }
        case "opportunities": router.open(.opportunities)
        case "referrals": router.open(.referrals)
        // `activity` carries a required category; automations is the one the
        // assistant can speak about, so an unqualified request lands there.
        case "activity": router.open(.activity(category: "automations"))
        default: return false
        }
        return true
    }

    private func registerDraftOwnerIfNeeded() {
        guard draftToken == nil else { return }
        let token = drafts.register(source: .assistant)
        draftToken = token
        drafts.setDirty(
            !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            for: token
        )
        discardAssistantDraftIfRequested()
    }

    private func discardAssistantDraftIfRequested() {
        guard let draftToken,
              let request = drafts.discardRequest,
              request.tokenIDs.contains(draftToken.id) else { return }
        let requestID = request.id
        guard drafts.discardRequest?.id == requestID else { return }
        inputIsFocused = false
        speech.stopAll()
        model.draft = ""
        guard drafts.discardRequest?.id == requestID else { return }
        drafts.acknowledgeDiscard(for: draftToken, requestID: requestID)
    }

    private func openEvidence(_ token: AssistantEvidenceToken) {
        guard let user = session.currentUser else { return }
        let initiatingIdentity = assistantIdentityKey
        Task {
            guard let route = await model.evidenceRoute(for: token, user: user) else { return }
            guard assistantIdentityKey == initiatingIdentity,
                  let currentUser = session.currentUser,
                  currentUser.id == user.id,
                  AssistantAccess.isPermitted(for: currentUser) else { return }
            let permissions = currentUser.permissionSet
            let access = AppNavigationAccess(
                analytics: permissions.contains(Permission.analyticsRead),
                campaigns: permissions.contains(Permission.campaignsRead),
                campaignsManage: permissions.contains(Permission.campaignsManage),
                activity: permissions.contains(Permission.auditRead),
                team: permissions.contains(Permission.userManage),
                referrals: permissions.contains(Permission.referralRead),
                assistant: AssistantAccess.isPermitted(for: currentUser)
            )
            router.dismissAccount()
            _ = router.open(route, access: access)
        }
    }
}

private struct AssistantBackdrop: View {
    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
            RadialGradient(
                colors: [ViciTheme.tint.opacity(0.16), Color.clear],
                center: .top,
                startRadius: 20,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }
}

/// Internal rather than file-private: the chamber in
/// AssistantVoiceChamberView.swift draws the same orb, and two copies of this
/// would drift into two different assistants.
struct AssistantOrb: View {
    let phase: AssistantPhase
    /// The operator's chosen accent. Only ever applied to the RESTING colours;
    /// see `orbColor`.
    var tint: AssistantOrbTint = .brand
    var size: AssistantOrbSize = .standard
    /// Capture is a separate state machine from reasoning, so listening cannot
    /// be read off `phase`. Passed in rather than inferred, because the orb
    /// showing "hearing you" while the microphone is closed would be a lie the
    /// user acts on.
    var isListening: Bool = false

    /// Every circle and the glyph scale from one diameter, so the three sizes
    /// stay in proportion rather than needing three sets of hand-picked numbers.
    private var outer: CGFloat { size.diameter }
    private var middle: CGFloat { outer * 0.81 }
    private var core: CGFloat { outer * 0.61 }
    private var glyph: CGFloat { outer * 0.195 }

    /// Drives the motion. One value, so the three states cannot animate out of
    /// step with each other.
    @State private var animating = false

    /// WHY EACH STATE MOVES THE WAY IT DOES
    ///   Listening breathes slowly and steadily, so a person can see the phone
    ///   is hearing them without being hurried. Thinking pulses faster, which
    ///   reads as work rather than as a hang. Speaking moves in a regular
    ///   rhythm so the orb is visibly the thing producing the sound. Everything
    ///   else is still, because motion with no meaning is just noise and it is
    ///   what makes an idle screen feel unfinished.
    private var pulse: (scale: CGFloat, duration: Double)? {
        if isListening { return (1.06, 1.4) }
        switch phase {
        case .thinking: return (1.10, 0.7)
        case .speaking: return (1.05, 0.5)
        default:        return nil
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(orbColor.opacity(0.12))
                .frame(width: outer, height: outer)
            Circle()
                .stroke(orbColor.opacity(0.24), lineWidth: 1)
                .frame(width: middle, height: middle)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.white.opacity(0.9), orbColor.opacity(0.85), orbColor],
                        center: .topLeading,
                        startRadius: 2,
                        endRadius: core * 0.86
                    )
                )
                .frame(width: core, height: core)
                .shadow(color: orbColor.opacity(0.32), radius: 24, y: 8)
            Image(systemName: symbol)
                .font(.system(size: glyph, weight: .semibold))
                .foregroundStyle(.white)
                .accessibilityHidden(true)
        }
        .scaleEffect(animating && pulse != nil ? (pulse?.scale ?? 1) : 1)
        .animation(
            pulse.map { .easeInOut(duration: $0.duration).repeatForever(autoreverses: true) }
                ?? .easeOut(duration: 0.2),
            value: animating
        )
        // Restarted on every phase change so a new state begins its own rhythm
        // rather than inheriting the tail of the previous one.
        .onChange(of: phase) { _ in restartMotion() }
        .onChange(of: isListening) { _ in restartMotion() }
        .onAppear { animating = pulse != nil }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    /// THE CHOSEN TINT NEVER OVERRIDES A STATE COLOUR.
    ///
    /// Warning and failure keep their own colours whatever the operator picked,
    /// and disabled stays grey. A preference that could repaint the failure
    /// state would let somebody choose a theme in which a broken assistant
    /// looks exactly like a working one. The accent applies to the resting,
    /// listening and speaking states, which is where it is actually seen.
    /// Restarted rather than left running, so a new state begins its own
    /// rhythm instead of inheriting the tail of the previous one.
    private func restartMotion() {
        animating = false
        guard pulse != nil else { return }
        DispatchQueue.main.async { animating = true }
    }

    private var orbColor: Color {
        switch phase {
        case .disabled, .unavailable: return .secondary
        case .interruptedByCall: return ViciTheme.warning
        case .failed: return ViciTheme.destructive
        default: return Self.accent(for: tint)
        }
    }

    static func accent(for tint: AssistantOrbTint) -> Color {
        switch tint {
        case .brand: return ViciTheme.tint
        case .indigo: return Color.indigo
        case .teal: return Color.teal
        case .amber: return Color.orange
        case .rose: return Color.pink
        case .graphite: return Color.gray
        }
    }

    private var symbol: String {
        switch phase {
        case .checkingCapability: return "checkmark.shield.fill"
        case .disabled: return "lock.fill"
        case .unavailable: return "iphone.slash"
        case .idle: return "sparkles"
        case .thinking: return "ellipsis.bubble.fill"
        case .speaking: return "speaker.wave.2.fill"
        case .interruptedByCall: return "phone.fill"
        case .failed: return "wifi.exclamationmark"
        }
    }

    private var accessibilityLabel: String {
        switch phase {
        case .checkingCapability: return "Checking assistant access"
        case .disabled: return "Assistant disabled"
        case .unavailable: return "Assistant unavailable"
        case .idle: return "On-device assistant ready"
        case .thinking: return "Preparing a response"
        case .speaking: return "Speaking"
        case .interruptedByCall: return "Assistant interrupted by a call"
        case .failed: return "Assistant access check failed"
        }
    }
}

/// REWRITTEN BECAUSE EVERY LINE OF IT HAD BECOME FALSE.
///
/// It previously said: no write actions, on-device reasoning, on-device speech
/// input and output, and that questions were cleared when you left the screen.
/// By the time this was read, the assistant drafted campaigns and audiences,
/// reasoning had moved to a cloud model, replies were spoken by a cloud voice,
/// and conversations were being saved to the server and compacted.
///
/// Four false privacy claims on a card headed "Private by design" is worse
/// than no card, because somebody decides what to say out loud on the strength
/// of it. What follows is what the code actually does, checked against
/// lib/openrouter-private.js, the thread store and the speech coordinator.
private struct AssistantPrivacyCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("How this handles your data", systemImage: "lock.shield.fill")
                .font(.headline)
                .foregroundStyle(ViciTheme.tint)
            Text("Conversations are saved to your Vici workspace so you can come back to them. Reasoning runs on a cloud model under zero data retention, and customer names and numbers are replaced with placeholders before anything leaves.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Label("Permission-checked business reads", systemImage: "building.2.crop.circle")
                .font(.footnote.weight(.semibold))
            Label("Writes create drafts for review, never a send", systemImage: "hand.raised.fill")
                .font(.footnote.weight(.semibold))
            Label("Sending always asks for your face first", systemImage: "faceid")
                .font(.footnote.weight(.semibold))
            Label("Speech is recognised on this iPhone", systemImage: "waveform")
                .font(.footnote.weight(.semibold))
            Label("Replies are spoken by a cloud voice", systemImage: "speaker.wave.2")
                .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(ViciTheme.tint.opacity(0.16))
        )
    }
}

/// One saved conversation in the list.
///
/// No `.animation(_:value:)` anywhere on this row, deliberately. Attaching one
/// to a view that is also a tap target loses the first tap, because SwiftUI hit
/// tests at the animation's final geometry. That was the two tap bug, and a row
/// whose whole purpose is to be tapped is the worst place to reintroduce it.
private struct AssistantThreadRow: View {
    let thread: AssistantThreadSummary
    let isRenaming: Bool
    @Binding var renameDraft: String
    let open: () -> Void
    let beginRename: () -> Void
    let commitRename: () -> Void
    let cancelRename: () -> Void
    let delete: () -> Void

    @FocusState private var renameIsFocused: Bool

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private var when: String? {
        let date = thread.sortDate
        guard date != .distantPast else { return nil }
        return Self.relative.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        Group {
            if isRenaming {
                HStack(spacing: 10) {
                    TextField("Name this chat", text: $renameDraft)
                        .textFieldStyle(.plain)
                        .font(.body.weight(.semibold))
                        .submitLabel(.done)
                        .focused($renameIsFocused)
                        .onSubmit(commitRename)
                    Button("Save", action: commitRename)
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                    Button("Cancel", action: cancelRename)
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.secondary)
                }
                .onAppear { renameIsFocused = true }
            } else {
                Button(action: open) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(thread.displayTitle)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        if let preview = thread.preview, !preview.isEmpty {
                            Text(preview)
                                .font(.footnote)
                                .foregroundStyle(Color.secondary)
                                .lineLimit(1)
                        }
                        if let when {
                            Text(when)
                                .font(.caption)
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: delete) {
                Label("Delete", systemImage: "trash")
            }
            Button(action: beginRename) {
                Label("Rename", systemImage: "pencil")
            }
            .tint(ViciTheme.tint)
        }
    }
}

/// What the list says before there is anything in it.
private struct AssistantEmptyThreadList: View {
    let isLoading: Bool
    let startNew: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            if isLoading {
                ProgressView()
            } else {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Color.secondary)
                Text("No chats yet")
                    .font(.headline)
                Text("Start one and it will be saved here, so you can pick it up later.")
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.center)
                Button(action: startNew) {
                    Label("New chat", systemImage: "square.and.pencil")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
            }
        }
        .padding(.horizontal, 32)
    }
}

/// Shown when the last answer could not be filed.
///
/// The operator has the answer on screen and it is a real one. What they must
/// not be allowed to assume is that it will still be there tomorrow.
private struct AssistantUnsavedNotice: View {
    var body: some View {
        Label("This answer could not be saved to the chat.", systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AssistantTranscriptBubble: View {
    let entry: AssistantTranscriptEntry
    let openEvidence: (AssistantEvidenceToken) -> Void

    var body: some View {
        HStack {
            if entry.role == .user { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: 9) {
                Text(entry.text)
                    .font(.body)
                    .foregroundStyle(entry.role == .user ? Color.white : Color.primary)
                if entry.role == .assistant, !entry.citations.isEmpty {
                    ForEach(entry.citations, id: \.self) { citation in
                        Button {
                            openEvidence(citation.token)
                        } label: {
                            Label(citation.label,
                                  systemImage: "checkmark.seal.fill")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .tint(ViciTheme.tint)
                        .accessibilityHint("Opens the permission-checked source for this verified figure")
                    }
                }
            }
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(
                    entry.role == .user ? ViciTheme.tealFill : Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
            if entry.role == .assistant { Spacer(minLength: 44) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityLabel(entry.role == .user ? "You: \(entry.text)" : "Assistant: \(entry.text)")
    }
}

private struct AssistantSpeechStatusCard: View {
    let phase: AssistantSpeechPhase
    let liveTranscript: String
    let voiceDisclosure: String?
    @Environment(\.openURL) private var openURL

    private var isListening: Bool {
        phase == .listening || phase == .finalizing
    }

    var body: some View {
        // WHILE LISTENING, THE WORDS ARE THE WHOLE CARD.
        //
        // This used to stack a status label, an explanatory line, the
        // transcript and a voice disclosure on top of each other, so the thing
        // the person is actually watching, their own words appearing, was the
        // third item down in small type. Everything else is either obvious from
        // the orb or is a sentence nobody rereads.
        //
        // The supporting text still appears when there is no transcript yet, or
        // when something needs explaining, such as the microphone being denied.
        VStack(alignment: .leading, spacing: 8) {
            if isListening, !liveTranscript.isEmpty {
                Text(liveTranscript)
                    .font(.title3)
                    .foregroundStyle(.primary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .privacySensitive()
                    .accessibilityLabel("Hearing: \(liveTranscript)")
            } else {
                Label(title, systemImage: symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(color)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let voiceDisclosure {
                    Text(voiceDisclosure)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if phase == .microphoneDenied {
                Button {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                } label: {
                    Label("Open microphone settings", systemImage: "gear")
                }
                .font(.footnote.weight(.semibold))
                .accessibilityHint("Opens Vici Inbox settings so microphone access can be enabled")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        switch phase {
        case .readyToRequest, .ready: return "Push to talk ready"
        case .requestingMicrophonePermission: return "Checking microphone permission"
        case .microphoneDenied: return "Microphone access is off"
        case .checkingAssets: return "Checking on-device speech"
        case .downloadingAssets: return "Preparing on-device speech"
        case .listening: return "Listening while you hold"
        case .finalizing: return "Finishing transcription"
        case .interruptedByCall: return "Speech stopped for your call"
        case .unavailable: return "Push to talk unavailable"
        case .failed: return "Push to talk needs another try"
        }
    }

    private var detail: String {
        switch phase {
        case .readyToRequest:
            return "Press and hold the microphone to request access at the moment you need it."
        case .requestingMicrophonePermission:
            return "Audio is not retained or uploaded."
        case .microphoneDenied:
            return "Enable microphone access in iOS Settings, or continue typing."
        case .checkingAssets:
            return "Checking whether Apple speech assets are already installed on this iPhone."
        case .downloadingAssets:
            return "iOS is installing the required Apple speech asset. You can release and type instead."
        case .ready:
            return "Press and hold only while speaking. The Assistant never listens continuously."
        case .listening:
            return "Release to stop. Recognition stays on this iPhone."
        case .finalizing:
            return "The final words are being converted to text on this iPhone."
        case .interruptedByCall:
            return "Calls take priority. Audio and private text were cleared."
        case .unavailable(let reason):
            switch reason {
            case .requiresIOS26: return "Push to talk requires iOS 26. Typed input still works."
            case .hardwareUnsupported: return "Apple on-device transcription is unavailable here. Typed input still works."
            case .localeUnsupported: return "This device language is not supported for on-device transcription. Typed input still works."
            }
        case .failed:
            return "No audio was saved or sent. Press and hold to try again, or type."
        }
    }

    private var symbol: String {
        switch phase {
        case .listening: return "waveform.circle.fill"
        case .microphoneDenied, .unavailable, .failed: return "mic.slash.fill"
        case .interruptedByCall: return "phone.fill"
        default: return "mic.circle.fill"
        }
    }

    private var color: Color {
        switch phase {
        case .microphoneDenied, .unavailable: return .secondary
        case .failed: return ViciTheme.destructive
        case .interruptedByCall: return ViciTheme.warning
        default: return ViciTheme.tint
        }
    }
}

/// What the older half of a long conversation was folded into.
///
/// WHY IT IS ON SCREEN AT ALL
///   Past a threshold, earlier turns stop being sent to the model and this
///   paragraph is sent instead, so the request does not grow without limit as
///   the conversation does. That is a real change to what the assistant knows,
///   and hiding it means somebody is told nothing about what happened to half
///   their conversation and has no way to check that what was kept is right.
///
/// WHY IT DOES NOT LOOK LIKE AN ANSWER
///   It is written by the model about the conversation, not by the assistant to
///   the person, and it is deliberately styled apart from the bubbles so it is
///   never mistaken for something that was said.
private struct AssistantCompactedHistory: View {
    let summary: String
    let messageCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(heading, systemImage: "arrow.down.right.and.arrow.up.left")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(summary)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(heading). \(summary)")
    }

    private var heading: String {
        messageCount > 0 ? "Earlier in this chat, \(messageCount) messages" : "Earlier in this chat"
    }
}
