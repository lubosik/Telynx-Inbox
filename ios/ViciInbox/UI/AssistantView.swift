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
    @EnvironmentObject private var speech: AssistantSpeechCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AssistantModel()
    @ObservedObject private var navigation = AssistantNavigationCoordinator.shared
    @ObservedObject private var preferences = AssistantPreferences.shared
    @ObservedObject private var drafts = AssistantUnsavedDraftRegistry.shared
    @State private var draftToken: AssistantDraftToken?
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

            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 22) {
                            AssistantOrb(phase: model.phase,
                                         tint: preferences.orbTint,
                                         size: preferences.orbSize,
                                         isListening: speech.phase == .listening
                                             || speech.phase == .finalizing)
                                .padding(.top, 24)

                            AssistantStatusCopy(
                                phase: model.phase,
                                failureMessage: model.failureMessage
                            )

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

                            // ONLY THE LAST EXCHANGE, NOT THE WHOLE LOG.
                            //
                            // This is a voice interface. Reading back what you
                            // just said is not something a person does in a
                            // conversation, and a growing wall of bubbles is
                            // what made this feel like a chat app bolted to a
                            // microphone rather than something you talk to.
                            //
                            // The latest answer stays on screen because a
                            // spoken figure is worth being able to check, and
                            // it keeps its evidence tap.
                            if model.transcript.isEmpty {
                                AssistantPrivacyCard()
                            } else if let latest = model.transcript.last(where: { $0.role == .assistant }) {
                                AssistantTranscriptBubble(entry: latest) { token in
                                    openEvidence(token)
                                }
                                .id(latest.id)
                                .transition(.opacity)
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

                AssistantComposer(
                    draft: $model.draft,
                    isFocused: $inputIsFocused,
                    canSubmit: hasClientAccess && model.phase == .idle && !callIsActive,
                    // SPEAKING IS NOT A REASON TO REFUSE THE MICROPHONE.
                    //
                    // Requiring .idle meant the mic went dead for the whole
                    // answer, so cutting in was impossible and the only way to
                    // redirect was to sit through it. People interrupt each
                    // other; an assistant that cannot be interrupted is being
                    // listened to, not talked with.
                    canDictate: hasClientAccess
                        && (model.phase == .idle || model.phase == .speaking)
                        && !callIsActive
                        && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && speech.canBeginPushToTalk,
                    speechPhase: speech.phase,
                    beginDictation: {
                        inputIsFocused = false
                        // Cut the answer off first. Capturing over the top of
                        // the assistant's own voice feeds it back into the
                        // microphone, and the transcript then contains what the
                        // assistant said as though the person had said it.
                        if model.phase == .speaking {
                            speech.stopAll()
                            model.noteSpeechFinished()
                        }
                        speech.beginPushToTalk(callIsActive: callIsActive)
                    },
                    endDictation: {
                        speech.endPushToTalk()
                    }
                ) {
                    submitQuestion(source: .assistantTyped, speechCompletionUptime: nil)
                }
            }

            if scenePhase != .active {
                Color(.systemBackground).ignoresSafeArea()
            }
        }
        .navigationTitle("Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .privacySensitive()
        .task {
            registerDraftOwnerIfNeeded()
            guard hasClientAccess else {
                model.obscureAndPurge()
                return
            }
            await model.refreshCapability(callIsActive: callIsActive)
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

private struct AssistantOrb: View {
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

private struct AssistantStatusCopy: View {
    let phase: AssistantPhase
    let failureMessage: String?

    var body: some View {
        VStack(spacing: 7) {
            Text(title)
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 480)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch phase {
        case .checkingCapability: return "Checking access"
        case .disabled: return "Pilot not enabled"
        case .unavailable: return "Not available on this iPhone"
        case .idle: return "On-device assistant ready"
        case .thinking: return "Working it out"
        case .speaking: return "Speaking"
        case .interruptedByCall: return "Paused for your call"
        case .failed: return "Assistant needs another try"
        }
    }

    private var detail: String {
        switch phase {
        case .checkingCapability:
            return "Confirming this named account and iPhone are eligible."
        case .disabled:
            return "The server-side assistant pilot is off. No question will be accepted or sent."
        case .unavailable(let reason):
            switch reason {
            case .requiresNewerOS(let required, _):
                return "This pilot requires iOS \(required) or later."
            case .unsupportedMode:
                return "The server reported an assistant mode this build does not support."
            case .appleIntelligenceNotEnabled:
                return "Assistant reasoning is unavailable right now. Check your connection and try again."
            case .deviceNotEligible:
                return "This iPhone does not support Apple's on-device language model. Typed app features still work."
            case .modelNotReady:
                return "Apple's on-device model is still preparing. Try again after it finishes downloading."
            case .modelUnavailable:
                return "Apple's on-device model is unavailable right now. Other app features still work."
            }
        case .idle:
            return "Ask for a verified Vici summary, or ask about this assistant and its privacy. Read-only business facts use permission-checked Vici API calls."
        case .thinking:
            return "Apple's on-device model is preparing a private response."
        case .speaking:
            return "The response is playing through an installed Apple voice."
        case .interruptedByCall:
            return "Your draft and transcript were cleared. Calls always take priority."
        case .failed:
            return failureMessage ?? "Nothing was sent. Try the capability check again."
        }
    }
}

private struct AssistantPrivacyCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Private by design", systemImage: "lock.shield.fill")
                .font(.headline)
                .foregroundStyle(ViciTheme.tint)
            Text("Questions and on-device model responses stay in memory and are cleared when you leave this screen, switch apps, or receive a call.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Label("Permission-checked business reads", systemImage: "building.2.crop.circle")
                .font(.footnote.weight(.semibold))
            Label("No write actions", systemImage: "hand.raised.fill")
                .font(.footnote.weight(.semibold))
            Label("On-device reasoning", systemImage: "brain.head.profile")
                .font(.footnote.weight(.semibold))
            Label("On-device speech input and output", systemImage: "waveform")
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

private struct AssistantComposer: View {
    @Binding var draft: String
    let isFocused: FocusState<Bool>.Binding
    let canSubmit: Bool
    let canDictate: Bool
    let speechPhase: AssistantSpeechPhase
    let beginDictation: () -> Void
    let endDictation: () -> Void
    let submit: () -> Void
    @State private var microphoneIsPressed = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(alignment: .bottom, spacing: 10) {
                AssistantPushToTalkButton(
                    isPressed: $microphoneIsPressed,
                    phase: speechPhase,
                    isEnabled: canDictate,
                    begin: beginDictation,
                    end: endDictation
                )

                TextField("Ask for a verified Vici summary", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .focused(isFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        if sendIsEnabled { submit() }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))

                Button(action: submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(sendIsEnabled ? ViciTheme.tealFill : Color.secondary, in: Circle())
                }
                .disabled(!sendIsEnabled)
                .accessibilityLabel("Send question")
                .accessibilityHint("Rechecks access before accepting the question")
            }

            Text("\(draft.count)/\(AssistantInputPolicy.maximumCharacters)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel("\(draft.count) of \(AssistantInputPolicy.maximumCharacters) characters")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    private var sendIsEnabled: Bool {
        canSubmit && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct AssistantPushToTalkButton: View {
    @Binding var isPressed: Bool
    let phase: AssistantSpeechPhase
    let isEnabled: Bool
    let begin: () -> Void
    let end: () -> Void

    var body: some View {
        Image(systemName: phase == .listening ? "waveform" : "mic.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(isEnabled || isPressed ? Color.white : Color.secondary)
            .frame(width: 48, height: 48)
            .background(phase == .listening ? ViciTheme.destructive : ViciTheme.tint, in: Circle())
            .opacity(isEnabled || isPressed ? 1 : 0.45)
            .contentShape(Circle())
            // TAP TO START. Silence ends it.
            //
            // Press and hold made a conversation into a physical act: hold the
            // phone, hold the button, do not let go mid sentence. You cannot
            // put the phone down, and you certainly cannot have a back and
            // forth. Tapping starts listening, the transcript standing still
            // for a moment and a half ends it, and tapping again stops it early.
            .onTapGesture {
                if isPressed {
                    isPressed = false
                    end()
                    return
                }
                guard isEnabled else { return }
                isPressed = true
                begin()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(phase == .listening ? "Listening" : "Start speaking")
            .accessibilityHint("Tap to start speaking. It stops on its own when you finish, or tap again to stop. Typed input is always available.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if isPressed {
                    isPressed = false
                    end()
                } else {
                    guard isEnabled else { return }
                    isPressed = true
                    begin()
                }
            }
            .onChange(of: phase) { newPhase in
                switch newPhase {
                case .readyToRequest, .microphoneDenied, .finalizing,
                     .interruptedByCall, .unavailable, .failed:
                    isPressed = false
                case .requestingMicrophonePermission, .checkingAssets,
                     .downloadingAssets, .ready, .listening:
                    break
                }
            }
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
