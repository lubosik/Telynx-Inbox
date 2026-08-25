import SwiftUI

/// The conversation chamber: the orb, and nothing that is not the orb.
///
/// WHY THIS SCREEN IS ALMOST EMPTY
///   What it replaces showed, at once: a nav bar carrying two back buttons, an
///   orb, a heading, a paragraph explaining the assistant, a microphone
///   permission card, the entire running transcript, a text field and a send
///   button. All of it was true and none of it was what the person was doing,
///   which was talking. Reading is a different activity from speaking, and a
///   wall of text under an orb invites somebody to read it instead of saying
///   the thing they came to say.
///
///   Nothing is lost. The transcript is still written, still saved, still
///   readable, one tap away at the top left, where somebody goes on purpose
///   when they want to read rather than having it pushed at them while they
///   are trying to speak.
///
/// PRESENTATIONAL ON PURPOSE
///   Every action is a closure supplied by `AssistantView`. Dictation
///   consumption, latency recording, navigation parsing and thread bookkeeping
///   are genuinely intricate and already live in one place; a second copy in
///   here would drift within a release. This view owns how the chamber LOOKS
///   and what a tap MEANS, and nothing else. It is also what makes the screen
///   testable without an audio session.
///
/// INTERRUPTION IS THE POINT
///   Tapping the orb while it speaks cuts it off and opens the microphone in
///   the same gesture. Waiting politely for an assistant to finish a paragraph
///   you already have the answer to is the single thing that makes a voice
///   product feel like a machine rather than a colleague.
struct AssistantVoiceChamberView: View {
    let phase: AssistantPhase
    let speechPhase: AssistantSpeechPhase
    let tint: AssistantOrbTint
    /// Disabled while a call is up. The orb still draws, so the screen does not
    /// appear to have broken, but it cannot take the microphone from a call.
    let isBlockedByCall: Bool
    let failureMessage: String?

    @Binding var draft: String

    let onOrbTap: () -> Void
    let onSubmit: () -> Void
    let onShowTranscript: () -> Void
    let onShowVoiceSettings: () -> Void
    let onEnd: () -> Void

    @State private var isTyping = false
    @FocusState private var typingIsFocused: Bool

    private var isListening: Bool {
        speechPhase == .listening || speechPhase == .finalizing
    }

    var body: some View {
        ZStack {
            // Black rather than the system background. The orb is the only lit
            // thing here, and a grey ground draws a visible rectangle around a
            // shape that is meant to be floating in nothing.
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                controls
                Spacer(minLength: 0)
                orb
                // One short line, and only when there is something true to say.
                // Not a status readout: a person can see the orb moving. This
                // exists for the cases the orb cannot express, which are a
                // failure and a call holding the microphone.
                interruptionNotice
                Spacer(minLength: 0)
                if isTyping { typingRow } else { voiceRow }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - The edges

    private var controls: some View {
        HStack {
            chamberButton(systemName: "text.alignleft",
                          label: "Read the transcript",
                          action: onShowTranscript)
            Spacer()
            chamberButton(systemName: "slider.horizontal.3",
                          label: "Voice and orb",
                          action: onShowVoiceSettings)
        }
        .padding(.top, 8)
    }

    private func chamberButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 44, height: 44)
                .background(Circle().fill(Color.white.opacity(0.12)))
        }
        .accessibilityLabel(label)
    }

    // MARK: - The orb

    private var orb: some View {
        Button(action: onOrbTap) {
            AssistantOrb(phase: phase,
                         tint: tint,
                         size: .large,
                         isListening: isListening)
        }
        .buttonStyle(.plain)
        .disabled(isBlockedByCall)
        // Spoken, because the orb is the only thing on this screen carrying the
        // state. Somebody who cannot see it moving has no other way to know the
        // phone is listening to them.
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityLabel: String {
        if isBlockedByCall { return "Assistant paused during the call" }
        if isListening { return "Listening" }
        switch phase {
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        default: return "Assistant ready"
        }
    }

    private var accessibilityHint: String {
        if isBlockedByCall { return "" }
        if phase == .speaking { return "Double tap to interrupt and speak" }
        if isListening { return "Double tap to stop listening" }
        return "Double tap to speak"
    }

    @ViewBuilder
    private var interruptionNotice: some View {
        if isBlockedByCall {
            noticeText("Paused while you are on a call")
        } else if let failureMessage, !failureMessage.isEmpty {
            noticeText(failureMessage)
        }
    }

    private func noticeText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.white.opacity(0.55))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .padding(.top, 28)
    }

    // MARK: - The bottom row

    private var voiceRow: some View {
        HStack(spacing: 12) {
            Button {
                isTyping = true
                typingIsFocused = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "keyboard")
                    Text("Type instead")
                }
                .font(.callout)
                .foregroundStyle(.white.opacity(0.75))
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(Capsule().fill(Color.white.opacity(0.10)))
            }
            .accessibilityLabel("Type instead of speaking")

            Spacer()

            // Ending the conversation, which is a different act from closing
            // the screen. White and solid, because it is the one control here
            // that stops everything.
            Button(action: onEnd) {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(Color.white))
            }
            .accessibilityLabel("End the conversation")
        }
        .padding(.bottom, 8)
    }

    private var typingRow: some View {
        HStack(spacing: 10) {
            TextField("Ask anything", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .foregroundStyle(.white)
                .tint(.white)
                .lineLimit(1...4)
                .focused($typingIsFocused)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Capsule().fill(Color.white.opacity(0.12)))
                .submitLabel(.send)
                .onSubmit(sendTyped)

            Button(action: sendTyped) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white))
            }
            .disabled(trimmedDraftIsEmpty)
            .opacity(trimmedDraftIsEmpty ? 0.4 : 1)
            .accessibilityLabel("Send")

            Button {
                isTyping = false
                typingIsFocused = false
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white.opacity(0.12)))
            }
            .accessibilityLabel("Back to speaking")
        }
        .padding(.bottom, 8)
    }

    private var trimmedDraftIsEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendTyped() {
        guard !trimmedDraftIsEmpty else { return }
        typingIsFocused = false
        isTyping = false
        onSubmit()
    }
}
