import SwiftUI

/// The assistant, still there, after it has taken you somewhere.
///
/// WHAT IT REPLACES
///   Asking to be shown an opportunity used to move the app, close the
///   assistant, and leave the settings screen it lived behind on top. Two more
///   taps later you were in the right place with the conversation gone. This
///   keeps the conversation reachable: it sits over whatever you were taken to,
///   and one tap puts you back in it.
///
/// IT IS SMALL AND IT GETS OUT OF THE WAY
///   Above the tab bar and on the trailing edge, which is where a thumb rests
///   and where nothing else in this app draws. It never covers a list row it
///   would be tapped instead of, and it is a button rather than a bare shape so
///   VoiceOver and Switch Control reach it like anything else.
struct AssistantFloatingOrb: View {
    let phase: AssistantPhase
    let isListening: Bool
    let tint: AssistantOrbTint
    /// Named once, briefly, so somebody who looks up mid-sentence knows which
    /// screen they are now on without deducing it from the contents.
    let destination: String?
    let onTap: () -> Void
    let onDismiss: () -> Void

    @State private var showDestination = true

    var body: some View {
        HStack(spacing: 8) {
            if showDestination, let destination, !destination.isEmpty {
                Text(destination)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.black.opacity(0.72)))
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            }

            Button(action: onTap) {
                ZStack {
                    Circle()
                        .fill(AssistantOrb.accent(for: tint))
                        .frame(width: 56, height: 56)
                        .shadow(color: .black.opacity(0.28), radius: 10, y: 4)
                    Image(systemName: symbol)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                }
                // Only the two states that mean "it is doing something and you
                // should wait" move. A permanently pulsing circle over every
                // screen in the app would be unbearable within a minute.
                .scaleEffect(isBusy ? 1.06 : 1)
                .animation(
                    isBusy
                        ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                        : .default,
                    value: isBusy
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint("Double tap to go back to the conversation")
            // Ending it from here, without going back in first. Somebody who
            // has been taken where they wanted to go is often finished, and
            // making them reopen the conversation to close it is a nuisance.
            .accessibilityAction(named: "End the conversation", onDismiss)
            .contextMenu {
                Button("Back to the conversation", action: onTap)
                Button("End the conversation", role: .destructive, action: onDismiss)
            }
        }
        .task {
            // The label is a courtesy, not a status. It says where you are and
            // then stops taking up the screen.
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            withAnimation(.easeOut(duration: 0.25)) { showDestination = false }
        }
    }

    private var isBusy: Bool {
        isListening || phase == .thinking || phase == .speaking
    }

    private var symbol: String {
        if isListening { return "waveform" }
        switch phase {
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        default: return "sparkles"
        }
    }

    private var accessibilityLabel: String {
        if isListening { return "Assistant, listening" }
        switch phase {
        case .thinking: return "Assistant, thinking"
        case .speaking: return "Assistant, speaking"
        default: return "Assistant, waiting"
        }
    }
}
