import SwiftUI
import UIKit

/// The screen a new teammate lands on after tapping their invitation link.
///
/// It renders before the sign-in gate, alongside `LoginView` in `RootView`,
/// because the invitee has no session and cannot be asked for one: the account
/// they would sign in with does not exist yet.
///
/// It deliberately does not sign anybody in. `POST /auth/invitation/accept`
/// creates the account and stops there, because the inviting Admin often holds
/// the link themselves and signing in automatically would put the new account
/// onto the Admin's phone. The last step here hands the email to the sign-in
/// form and lets the person type their own password again.
///
/// The token is never displayed, never logged, and never stored.
struct AcceptInvitationView: View {
    let invitation: InviteLinkRouter.PendingInvitation
    /// Leaves this screen. The string is an email to prefill on the sign-in
    /// form, or empty for a plain sign-in.
    let onFinish: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var password = ""
    @State private var confirmation = ""
    @State private var revealPassword = false
    @State private var isWorking = false
    @State private var failure: InvitationAcceptError?
    @State private var accepted: InvitationAcceptance?
    @FocusState private var focused: Field?

    private enum Field: Hashable { case password, confirmation }

    var body: some View {
        ZStack {
            MintDriftBackground(isStatic: reduceMotion)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            ScrollView {
                VStack(spacing: 22) {
                    wordmark

                    if let problem = invitation.problem {
                        brokenLink(problem)
                    } else if let accepted {
                        success(accepted)
                    } else {
                        form
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            if invitation.problem == nil { focused = .password }
        }
    }

    // MARK: - Header

    private var wordmark: some View {
        VStack(spacing: 6) {
            Text("VICI")
                .font(.system(size: 44, weight: .semibold, design: .serif))
                .tracking(8)
                .padding(.leading, 8)
                .foregroundStyle(ViciTheme.ink)
            Text("PEPTIDES")
                .font(.system(size: 12, weight: .medium))
                .tracking(7)
                .padding(.leading, 7)
                .foregroundStyle(ViciTheme.inkSecondary)
            Text(headline)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
        }
        .padding(.bottom, 4)
    }

    private var headline: String {
        if invitation.problem != nil { return "Invitation" }
        if accepted != nil { return "Account ready" }
        return "Accept your invitation"
    }

    // MARK: - The password form

    private var form: some View {
        VStack(spacing: 14) {
            Text("Choose a password to finish setting up your account.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            // Stated up front rather than after a rejected attempt.
            Text(PasswordPolicy.summary)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)

            passwordField
            confirmationField

            Toggle("Show passwords", isOn: $revealPassword)
                .font(.caption)
                .tint(ViciTheme.tint)

            if let failure {
                VStack(spacing: 10) {
                    Text(failure.message)
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.destructive)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)

                    // A dead invitation can never succeed on retry, so the only
                    // honest next action is the sign-in form.
                    if !failure.isRetryable {
                        Button("Go to sign in") { onFinish("") }
                            .font(.footnote.weight(.semibold))
                            .tint(ViciTheme.tint)
                    }
                }
            }

            Button(action: submit) {
                if isWorking {
                    ProgressView().tint(.white).frame(maxWidth: .infinity)
                } else {
                    Text("Create account").bold().frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(ViciTheme.tint)
            .controlSize(.large)
            .disabled(!canSubmit)

            // Always available, even before anything has gone wrong. Somebody
            // who already has an account should never be trapped here.
            Button("I already have an account") { onFinish("") }
                .font(.footnote)
                .tint(ViciTheme.tint)
                .padding(.top, 2)
        }
    }

    private var passwordField: some View {
        Group {
            if revealPassword {
                TextField("New password", text: $password)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("New password", text: $password)
                    .textContentType(.newPassword)
            }
        }
        .textFieldStyle(.roundedBorder)
        .focused($focused, equals: .password)
        .submitLabel(.next)
        .onSubmit { focused = .confirmation }
    }

    private var confirmationField: some View {
        Group {
            if revealPassword {
                TextField("Confirm password", text: $confirmation)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("Confirm password", text: $confirmation)
                    .textContentType(.newPassword)
            }
        }
        .textFieldStyle(.roundedBorder)
        .focused($focused, equals: .confirmation)
        .submitLabel(.go)
        .onSubmit(submit)
    }

    private var canSubmit: Bool {
        !isWorking && !password.isEmpty && !confirmation.isEmpty
    }

    // MARK: - A link that cannot work

    private func brokenLink(_ problem: InviteLinkRouter.LinkProblem) -> some View {
        VStack(spacing: 16) {
            Text(problem == .missing
                 ? "This invitation link is missing its token. It was probably shortened or cut off in the message it arrived in. Ask whoever invited you to send the full link again."
                 : "This invitation link is malformed, so it cannot be used. Ask whoever invited you to send the full link again.")
                .font(.footnote)
                .foregroundStyle(ViciTheme.destructive)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Button("Go to sign in") { onFinish("") }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .controlSize(.large)
        }
    }

    // MARK: - Done

    private func success(_ result: InvitationAcceptance) -> some View {
        VStack(spacing: 14) {
            Text("Your account has been created and your password is set.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Text(result.prefillEmail.isEmpty
                 ? "Sign in with your email address and the password you just chose."
                 : "Sign in with \(result.prefillEmail) and the password you just chose.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            // Reported from the row the server actually created. When the flag
            // is set, every endpoint except the account and password-change
            // ones answers 403 PASSWORD_CHANGE_REQUIRED, and this app has no
            // password-change screen. Saying so beats a sign-in that appears to
            // work and then shows an empty inbox.
            if result.requiresPasswordChange {
                VStack(spacing: 10) {
                    Text("One more step. This account is set to change its password on first sign-in, and that screen is on the website rather than in this app. Open the website, sign in there once, set the password, then come back and sign in here.")
                        .font(.caption)
                        .foregroundStyle(ViciTheme.destructive)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)

                    Button("Open the website") { openWebSignIn() }
                        .buttonStyle(.borderedProminent)
                        .tint(ViciTheme.tint)
                        .controlSize(.large)

                    Button("Continue to sign in here") { onFinish(result.prefillEmail) }
                        .font(.footnote)
                        .tint(ViciTheme.tint)
                }
            } else {
                Button("Continue to sign in") { onFinish(result.prefillEmail) }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
                    .controlSize(.large)
            }
        }
    }

    /// The website's sign-in page, which owns the password-change screen this
    /// app does not implement. Nothing from the invitation is attached.
    private func openWebSignIn() {
        UIApplication.shared.open(AppConfig.serverURL)
    }

    // MARK: - Submit

    private func submit() {
        guard canSubmit else { return }
        focused = nil

        // Checked locally first so the two most common mistakes cost nothing.
        // The server re-runs both and its answer always wins.
        if let problem = PasswordPolicy.problem(with: password) {
            failure = .passwordTooWeak(problem)
            return
        }
        guard password == confirmation else {
            failure = .passwordTooWeak("Those two passwords do not match.")
            return
        }

        isWorking = true
        failure = nil
        let token = invitation.token

        Task { @MainActor in
            do {
                let result = try await APIClient.shared.acceptInvitation(token: token,
                                                                         password: password)
                accepted = result
                // Held no longer than it takes to send. Nothing about this
                // account is written to the Keychain here; the sign-in form
                // does that once the person signs in for real.
                password = ""
                confirmation = ""
            } catch let error as InvitationAcceptError {
                failure = error
            } catch {
                failure = .network
            }
            isWorking = false
        }
    }
}
