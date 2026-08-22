import SwiftUI

/// One-time login. The email is optional: leaving it blank signs in with the
/// shared inbox password the web app has always used, which is still how two
/// people sign in today and is not going away. Filling it in uses the named
/// account instead.
///
/// After this the credentials live in the Keychain so a push-woken cold launch
/// can re-authenticate without any user interaction.
///
/// The backdrop is the brand treatment: two or three very soft mint blooms
/// drifting slowly over a near-white ground ("light through frosted glass").
/// It is purely decorative — it never intercepts touches, and it renders a
/// still frame when Reduce Motion is on.
struct LoginView: View {
    @EnvironmentObject private var session: SessionModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var email: String
    @State private var password = ""
    @State private var isWorking = false
    @State private var error: String?
    @State private var showingForgotPassword = false
    @FocusState private var focused: Field?

    private enum Field: Hashable { case email, password }

    /// `prefilledEmail` is supplied by the Accept Invitation screen, which has
    /// just been told by the server which address the invitation belonged to.
    /// It is empty everywhere else, in which case the previously used address
    /// from the Keychain is offered exactly as before. The password is never
    /// prefilled: the server deliberately does not sign an invitee in, because
    /// the inviting Admin sometimes holds the link.
    init(prefilledEmail: String = "") {
        let trimmed = prefilledEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        _email = State(initialValue: trimmed.isEmpty
                       ? (CredentialStore.get(.inboxEmail) ?? "")
                       : trimmed)
    }

    var body: some View {
        ZStack {
            MintDriftBackground(isStatic: reduceMotion)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: 24) {
                Spacer()

                wordmark

                VStack(spacing: 12) {
                    TextField("Email (optional)", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .focused($focused, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focused = .password }

                    SecureField("Inbox password", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused, equals: .password)
                        .submitLabel(.go)
                        .onSubmit(submit)

                    Text(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                         ? "Leave the email blank to use the shared inbox password."
                         : "Signing in as \(email.trimmingCharacters(in: .whitespacesAndNewlines)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)

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

                    // The way back in for a named account. Before this the only
                    // recovery was asking an admin to reset the password, and
                    // /reset-password was a claimed universal link with nothing
                    // in the app behind it.
                    Button("Forgot password") { showingForgotPassword = true }
                        .font(.footnote)
                        .tint(ViciTheme.tint)
                        .disabled(isWorking)
                        .padding(.top, 2)
                }
                .padding(.horizontal, 32)

                Spacer()
                Spacer()
            }
        }
        .onAppear { focused = email.isEmpty ? .email : .password }
        .sheet(isPresented: $showingForgotPassword) {
            ForgotPasswordView(prefilledEmail: email)
        }
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
                // An empty email is the legacy shared-password path, which the
                // session model routes to `login(password:)` unchanged.
                try await session.signIn(email: email, password: password)
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
/// Internal rather than file-private: `AcceptInvitationView` is the other
/// screen that renders before the sign-in gate, and it has to sit on the same
/// backdrop or the invitation flow looks like a different app.
struct MintDriftBackground: View {
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
