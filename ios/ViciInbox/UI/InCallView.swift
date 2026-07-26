import SwiftUI

/// In-app call controls. For inbound calls the *system* CallKit screen is what
/// the user sees first; this view is what they get after tapping through into
/// the app, and it stays in sync because every control routes through CallKit.
struct InCallView: View {
    @EnvironmentObject private var session: SessionModel
    let call: ActiveCall

    @State private var tick = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            VStack(spacing: 10) {
                Circle()
                    .fill(Color.green.opacity(0.18))
                    .frame(width: 108, height: 108)
                    .overlay(
                        Text(initials)
                            .font(.system(size: 40, weight: .medium))
                            .foregroundStyle(.green)
                    )

                Text(call.displayTitle)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)

                Text(statusLine)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 32) {
                controlButton(icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                              label: "Mute",
                              active: call.isMuted) {
                    session.toggleMute()
                }
                controlButton(icon: "speaker.wave.2.fill",
                              label: "Speaker",
                              active: call.isOnSpeaker) {
                    session.toggleSpeaker()
                }
                controlButton(icon: "pause.fill",
                              label: "Hold",
                              active: call.isOnHold) {
                    session.toggleHold()
                }
            }

            Button {
                session.endCall()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.white)
                    .frame(width: 76, height: 76)
                    .background(Circle().fill(Color.red))
            }
            .padding(.top, 8)

            Spacer()
        }
        .padding()
        .onReceive(timer) { tick = $0 }
    }

    private var initials: String {
        let name = call.displayTitle.trimmingCharacters(in: .whitespaces)
        guard let first = name.first, first.isLetter else { return "#" }
        let parts = name.split(separator: " ")
        if parts.count >= 2, let a = parts[0].first, let b = parts[1].first {
            return "\(a)\(b)".uppercased()
        }
        return String(first).uppercased()
    }

    private var statusLine: String {
        switch call.phase {
        case .ringing:    return call.isInbound ? "Incoming call" : "Ringing…"
        case .connecting: return "Connecting…"
        case .active:     return formatted(call.durationSeconds)
        case .held:       return "On hold"
        case .ended:      return "Call ended"
        case .idle:       return ""
        }
    }

    private func formatted(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    private func controlButton(icon: String,
                               label: String,
                               active: Bool,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 22))
                    .frame(width: 62, height: 62)
                    .background(Circle().fill(active ? Color.primary.opacity(0.85)
                                                     : Color.secondary.opacity(0.15)))
                    .foregroundStyle(active ? Color(.systemBackground) : .primary)
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
