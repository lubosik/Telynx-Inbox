import SwiftUI

/// Choosing a voice and an orb, once, on the way into the first conversation.
///
/// WHY ONCE
///   A chooser that reappears every time stops being a choice and becomes a
///   toll on the way to the thing you actually wanted. It is shown until it is
///   answered, and after that it lives in Settings, where a setting belongs.
///   The same view serves both, with `isFirstRun` deciding only the words on
///   the button and whether dismissing counts as having chosen.
///
/// WHY A CAROUSEL RATHER THAN A LIST
///   A voice is not a row of text. Swiping puts one voice on the screen at a
///   time, at the size it will actually be, which is the only honest preview of
///   a choice about how something looks and sounds. The searchable library
///   still exists in Settings for somebody who wants to go hunting; this is the
///   short, curated way through, and it has to be short or the first thing the
///   product ever asks of somebody is to audition forty voices.
///
/// IT MUST WORK WITH NO NETWORK
///   The shortlist is fetched, and if the fetch fails the built-in voice is
///   offered on its own rather than an error being shown. Somebody opening the
///   assistant for the first time on a bad connection should reach the
///   conversation, not a dead end with a retry button.
struct AssistantVoicePickerView: View {
    /// True on the way into the first conversation, false when opened from the
    /// chamber or from Settings later.
    let isFirstRun: Bool

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var preferences = AssistantPreferences.shared

    @State private var voices: [AssistantVoiceOption] = []
    @State private var selection = 0

    init(isFirstRun: Bool) {
        self.isFirstRun = isFirstRun
    }

    /// The voice that is always available, whatever the network did. Named, so
    /// the first page of the carousel is never blank while the fetch is in
    /// flight. The identifier is nil deliberately: nil means "the server's
    /// default", which keeps the choice correct even if the default changes.
    private static let builtIn = AssistantVoiceOption(
        id: "", name: "Elise", accent: nil, gender: "female", age: nil,
        descriptive: "Warm and unhurried", usedBy: nil, previewUrl: nil
    )

    private var current: AssistantVoiceOption {
        guard voices.indices.contains(selection) else { return Self.builtIn }
        return voices[selection]
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer(minLength: 0)
                carousel
                Spacer(minLength: 0)
                tintRow
                startButton
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(isFirstRun)
        .task { await loadVoices() }
    }

    private var header: some View {
        ZStack {
            Text(isFirstRun ? "Choose your voice" : "Voice and orb")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            HStack {
                Spacer()
                // Absent on first run. Not to trap anybody, but because there
                // is no sensible destination behind it yet: dismissing would
                // land in a chamber whose voice had not been picked, and the
                // picker would open again immediately, which reads as a bug.
                if !isFirstRun {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.9))
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.white.opacity(0.12)))
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .padding(.top, 20)
    }

    private var carousel: some View {
        VStack(spacing: 28) {
            TabView(selection: $selection) {
                ForEach(Array(displayVoices.enumerated()), id: \.offset) { index, voice in
                    AssistantOrb(phase: .idle, tint: preferences.orbTint, size: .large)
                        .frame(maxWidth: .infinity)
                        .tag(index)
                        .accessibilityLabel(voice.name)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            .frame(height: 300)

            VStack(spacing: 6) {
                Text(current.name)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                Text(describe(current))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
            }
            .frame(minHeight: 52)
            // The name changes under a static orb, so it is announced. Without
            // this a VoiceOver user swipes and hears nothing change.
            .accessibilityElement(children: .combine)
        }
    }

    private var displayVoices: [AssistantVoiceOption] {
        voices.isEmpty ? [Self.builtIn] : voices
    }

    /// One short line about the voice, never an empty one. The library gives
    /// accent, gender and a clone count in varying combinations, and a blank
    /// caption under a name looks like a loading failure.
    private func describe(_ voice: AssistantVoiceOption) -> String {
        if let descriptive = voice.descriptive, !descriptive.isEmpty {
            return descriptive.capitalizedFirst
        }
        let subtitle = voice.subtitle
        return subtitle.isEmpty ? "Built in" : subtitle
    }

    private var tintRow: some View {
        VStack(spacing: 10) {
            Text("Orb")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.5))
            HStack(spacing: 14) {
                ForEach(AssistantOrbTint.allCases) { tint in
                    Button {
                        preferences.orbTint = tint
                    } label: {
                        Circle()
                            .fill(AssistantOrb.accent(for: tint))
                            .frame(width: 30, height: 30)
                            .overlay(
                                Circle()
                                    .stroke(.white, lineWidth: preferences.orbTint == tint ? 2 : 0)
                            )
                    }
                    .accessibilityLabel(tint.label)
                    .accessibilityAddTraits(preferences.orbTint == tint ? [.isSelected] : [])
                }
            }
        }
        .padding(.bottom, 26)
    }

    private var startButton: some View {
        Button {
            commitChoice()
            dismiss()
        } label: {
            Text(isFirstRun ? "Start Voice" : "Done")
                .font(.headline)
                .foregroundStyle(.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Capsule().fill(Color.white))
        }
    }

    private func commitChoice() {
        let voice = current
        // An empty id is the built-in, and nil is how "use the server default"
        // is spelled everywhere else. Storing "" would pin a voice that does
        // not exist and every reply would fall back to the robotic one.
        preferences.pinnedVoiceIdentifier = voice.id.isEmpty ? nil : voice.id
        preferences.pinnedVoiceName = voice.name
        preferences.hasChosenVoice = true
    }

    private func loadVoices() async {
        // A short, human shortlist rather than the whole library. The library
        // is ranked by how many products shipped a voice, which is the best
        // available proxy for whether it survives contact with real listeners.
        guard let response = try? await APIClient.shared.assistantVoices(
            query: nil, gender: nil, accent: nil
        ) else { return }
        let shortlist = Array(response.voices.prefix(9))
        guard !shortlist.isEmpty else { return }
        await MainActor.run {
            voices = shortlist
            // Land on the voice already in use, if it is in the shortlist, so
            // reopening this from Settings shows what is currently set rather
            // than resetting the person to the first page.
            if let pinned = preferences.pinnedVoiceIdentifier,
               let index = shortlist.firstIndex(where: { $0.id == pinned }) {
                selection = index
            }
        }
    }
}

private extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return String(first).uppercased() + dropFirst()
    }
}
