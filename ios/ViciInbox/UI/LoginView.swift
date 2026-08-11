import SwiftUI

/// One-time login using the same shared inbox password the web app uses.
/// After this the password lives in the Keychain so a push-woken cold launch
/// can re-authenticate without any user interaction.
///
/// The backdrop is the brand treatment: two or three very soft mint blooms
/// drifting slowly over a near-white ground ("light through frosted glass").
/// It is purely decorative — it never intercepts touches, and it renders a
/// still frame when Reduce Motion is on.
struct LoginView: View {
    @EnvironmentObject private var session: SessionModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var password = ""
    @State private var isWorking = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            MintDriftBackground(isStatic: reduceMotion)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: 24) {
                Spacer()

                wordmark

                VStack(spacing: 12) {
                    SecureField("Inbox password", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(submit)

                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(ViciTheme.destructive)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: submit) {
                        if isWorking {
                            ProgressView().tint(.white).frame(maxWidth: .infinity)
                        } else {
                            Text("Sign in").bold().frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
                    .controlSize(.large)
                    .disabled(password.isEmpty || isWorking)
                }
                .padding(.horizontal, 32)

                Spacer()
                Spacer()
            }
        }
        .onAppear { focused = true }
    }

    /// The Vici Peptides lockup: Didone-style serif wordmark over small
    /// letter-spaced caps, mirroring the site logo. `.tracking` adds a
    /// trailing space after the last glyph, so each line takes matching
    /// leading padding to stay optically centred.
    private var wordmark: some View {
        VStack(spacing: 6) {
            Text("VICI")
                .font(.system(size: 52, weight: .semibold, design: .serif))
                .tracking(8)
                .padding(.leading, 8)
                .foregroundStyle(ViciTheme.ink)
            Text("PEPTIDES")
                .font(.system(size: 13, weight: .medium))
                .tracking(7)
                .padding(.leading, 7)
                .foregroundStyle(ViciTheme.inkSecondary)
            Text("Sign in to receive calls")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
        }
    }

    private func submit() {
        guard !password.isEmpty, !isWorking else { return }
        isWorking = true
        error = nil
        Task { @MainActor in
            do {
                try await session.signIn(password: password)
            } catch {
                self.error = error.localizedDescription
            }
            isWorking = false
        }
    }
}

/// Soft mint light drift: three large radial blooms of the brand mints moving
/// on independent slow paths over the brand ground.
///
/// One `TimelineView(.animation)` drives one `Canvas` — no Timers, no per-view
/// animations, nothing to tear down when the view leaves the hierarchy. With
/// `isStatic` (Reduce Motion) the TimelineView is skipped entirely and a
/// single still frame is drawn.
private struct MintDriftBackground: View {
    let isStatic: Bool
    @Environment(\.colorScheme) private var colorScheme

    /// One drifting bloom. Positions are unit coordinates; the radius is a
    /// fraction of the longer screen edge. Periods are 45–75 s and mutually
    /// irrational-ish so the composition never visibly loops.
    private struct Bloom {
        let color: Color
        let baseX: Double, baseY: Double
        let radius: Double
        let lightOpacity: Double, darkOpacity: Double
        let speedX: Double, speedY: Double
        let phaseX: Double, phaseY: Double
    }

    private static let blooms: [Bloom] = [
        Bloom(color: ViciTheme.bloomMint,
              baseX: 0.22, baseY: 0.24, radius: 0.55,
              lightOpacity: 0.34, darkOpacity: 0.13,
              speedX: 2 * .pi / 61, speedY: 2 * .pi / 47,
              phaseX: 0.0, phaseY: 1.7),
        Bloom(color: ViciTheme.bloomMintMid,
              baseX: 0.82, baseY: 0.62, radius: 0.60,
              lightOpacity: 0.26, darkOpacity: 0.10,
              speedX: 2 * .pi / 53, speedY: 2 * .pi / 71,
              phaseX: 2.4, phaseY: 0.6),
        Bloom(color: ViciTheme.bloomTeal,
              baseX: 0.42, baseY: 0.95, radius: 0.50,
              lightOpacity: 0.10, darkOpacity: 0.07,
              speedX: 2 * .pi / 67, speedY: 2 * .pi / 45,
              phaseX: 4.1, phaseY: 3.2),
    ]

    var body: some View {
        if isStatic {
            frame(at: 0)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                frame(at: context.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func frame(at time: TimeInterval) -> some View {
        Canvas { context, size in
            let ground = Path(CGRect(origin: .zero, size: size))
            context.fill(ground, with: .color(ViciTheme.loginGround))

            let dark = colorScheme == .dark
            let span = max(size.width, size.height)
            // Drift amplitude: a tenth of the screen — perceptible over a
            // minute, imperceptible second to second.
            let amplitude = 0.10 * span

            for bloom in Self.blooms {
                let x = bloom.baseX * size.width
                    + amplitude * sin(time * bloom.speedX + bloom.phaseX)
                let y = bloom.baseY * size.height
                    + amplitude * cos(time * bloom.speedY + bloom.phaseY)
                let opacity = dark ? bloom.darkOpacity : bloom.lightOpacity
                context.fill(
                    ground,
                    with: .radialGradient(
                        Gradient(colors: [bloom.color.opacity(opacity),
                                          bloom.color.opacity(0)]),
                        center: CGPoint(x: x, y: y),
                        startRadius: 0,
                        endRadius: bloom.radius * span
                    )
                )
            }
        }
    }
}
