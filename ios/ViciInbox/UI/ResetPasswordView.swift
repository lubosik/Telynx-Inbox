import SwiftUI

/// The screen behind a `/reset-password?token=...` universal link.
///
/// `lib/apple-site-association.js` claims that path, so on an iPhone with the
/// app installed iOS opens this instead of Safari. Before this screen existed
/// the path was claimed and nothing answered it, which is worse than not
/// claiming it: iOS caches the association document, opens the app, and the app
/// does nothing at all.
///
/// It renders BEFORE the sign-in gate, alongside `AcceptInvitationView` in
/// `RootView`, and for a sharper reason than the invitation does. Somebody
/// resetting a password has forgotten the only credential they had. Asking them
/// to sign in first would be a closed loop.
///
/// IT DOES NOT SIGN ANYBODY IN. `POST /auth/password-reset/confirm` sets the
/// password, ends every existing session and stops there, deliberately: a reset
/// link forwarded to the wrong person must be a dead end rather than a session.
/// So the last step here hands over to the sign-in form and lets the person
/// type the password they just chose.
///
/// The token is never displayed, never logged and never stored.
struct ResetPasswordView: View {
    let link: InviteLinkRouter.PendingLink
    /// Leaves this screen. The string is an email to prefill on the sign-in
    /// form. The confirm endpoint deliberately does not echo the address back,
    /// so it is empty unless the person typed one into the request form below.
    let onFinish: (String) -> Void

    @EnvironmentObject private var session: SessionModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var password = ""
    @State private var confirmation = ""
    @State private var revealPassword = false
    @State private var isWorking = false
    @State private var failure: PasswordResetConfirmError?
    @State private var didChangePassword = false
    /// Held so a request made from this screen can prefill the sign-in form.
    @State private var requestEmail = ""
    @FocusState private var focused: Field?

    private enum Field: Hashable { case password, confirmation }

    /// True when the link in hand can no longer work, either because it never
    /// could or because the server has just refused it. The password form is
    /// replaced by the "send me a new link" form, never by nothing.
    private var linkIsSpent: Bool {
        if link.problem != nil { return true }
        return failure?.linkIsSpent ?? false
    }

    /// The one refusal a fresh link cannot fix.
    private var needsAnAdmin: Bool { failure?.needsAnAdmin ?? false }

    var body: some View {
        ZStack {
            MintDriftBackground(isStatic: reduceMotion)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            ScrollView {
                VStack(spacing: 22) {
                    wordmark

                    if didChangePassword {
                        success
                    } else if needsAnAdmin {
                        refused
                    } else if linkIsSpent {
                        deadLink
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
            if link.problem == nil { focused = .password }
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
        if didChangePassword { return "Password changed" }
        if needsAnAdmin { return "Password reset" }
        if linkIsSpent { return "Reset link" }
        return "Choose a new password"
    }

    // MARK: - The password form

    private var form: some View {
        VStack(spacing: 14) {
            Text("Set the password you will use to sign in. This link works once and expires \(PasswordResetCopy.expiryMinutes) minutes after it was sent.")
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
                Text(failure.message)
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.destructive)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }

            Button(action: submit) {
                if isWorking {
                    ProgressView().tint(.white).frame(maxWidth: .infinity)
                } else {
                    Text("Change my password").bold().frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(ViciTheme.tint)
            .controlSize(.large)
            .disabled(!canSubmit)

            Text("Changing your password signs out every device that is currently signed in as you, including any you no longer have.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            // Always available. Somebody who has remembered their password in
            // the meantime should never be trapped on this screen.
            Button("I remember my password") { onFinish(prefillForSignIn) }
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

    /// Never a dead end: the request form is part of this state, so a fresh
    /// link is one step away from wherever the old one failed.
    private var deadLink: some View {
        VStack(spacing: 16) {
            Text(deadLinkExplanation)
                .font(.footnote)
                .foregroundStyle(ViciTheme.destructive)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            PasswordResetRequestSection(
                title: "Send me a new link",
                explanation: "Enter the email address you sign in with and we will send a fresh reset link to it.",
                email: $requestEmail
            )

            Button("Back to sign in") { onFinish(prefillForSignIn) }
                .font(.footnote)
                .tint(ViciTheme.tint)
        }
    }

    private var deadLinkExplanation: String {
        if let failure, failure.linkIsSpent {
            switch failure {
            case .alreadyUsed:
                return failure.message + " If that was you, your password is already changed and you can sign in with it."
            case .superseded:
                return failure.message + " Only the newest link works."
            case .expired:
                return failure.message + " Reset links last \(PasswordResetCopy.expiryMinutes) minutes."
            default:
                return failure.message
            }
        }
        switch link.problem {
        case .missing:
            return "This reset link is missing its token. It was probably shortened or cut off in the message it arrived in."
        case .malformed:
            return "This reset link is damaged, so it cannot be used."
        case nil:
            return "This reset link cannot be used."
        }
    }

    // MARK: - An account this screen cannot reset

    private var refused: some View {
        VStack(spacing: 16) {
            Text(failure?.message ?? "That account cannot be reset here. Ask an admin.")
                .font(.footnote)
                .foregroundStyle(ViciTheme.destructive)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Text("The shared team login is one example. Its password lives in the server configuration rather than on an account, so there is nothing here to change. An admin can give you your own account instead.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Button("Back to sign in") { onFinish(prefillForSignIn) }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .controlSize(.large)
        }
    }

    // MARK: - Done

    private var success: some View {
        VStack(spacing: 14) {
            Text("Your password has been changed. Sign in with the password you just chose.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Text("Every other device that was signed in as you has been signed out, including any you no longer have. Each one will ask for the new password.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            // "Every session" includes this one, when the person opening the
            // link was already signed in here. Said plainly, because otherwise
            // the app appears to work for a few seconds and then shows the
            // "signed out" banner with no explanation. Nothing is cleared from
            // this phone: it keeps its calling credentials and keeps ringing.
            if session.isSignedIn {
                Text("This iPhone was signed in as well, so it will ask you to sign in again shortly. It keeps its calling credentials in the meantime.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }

            // The server does not sign anybody in here, on purpose, so this is
            // a handover to the sign-in form and not a shortcut past it.
            Button("Continue to sign in") { onFinish(prefillForSignIn) }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .controlSize(.large)
        }
    }

    /// The address to offer the sign-in form. Only ever one the person typed
    /// into the request form on this screen; the reset itself never reveals it.
    private var prefillForSignIn: String {
        requestEmail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Submit

    private func submit() {
        guard canSubmit else { return }
        focused = nil

        // Checked locally first so the two most common mistakes cost nothing.
        // The server re-runs both and its answer always wins. It also checks
        // strength BEFORE it touches the token, so a rejected password does not
        // burn the link.
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
        let token = link.token
        let chosen = password

        Task { @MainActor in
            do {
                try await APIClient.shared.confirmPasswordReset(token: token, password: chosen)
                // Held no longer than it took to send. Nothing about this
                // account is written to the Keychain here: the sign-in form
                // does that once the person signs in for real.
                password = ""
                confirmation = ""
                didChangePassword = true
            } catch let error as PasswordResetConfirmError {
                failure = error
            } catch {
                failure = .network
            }
            isWorking = false
        }
    }
}

/// Ask for a reset link. Used inline by `ResetPasswordView` when the link in
/// hand is spent, and on its own by `ForgotPasswordView` from the sign-in
/// screen.
///
/// ONE CONFIRMATION, ALWAYS. `POST /auth/password-reset/request` answers the
/// same generic 202 whatever the address is, and this view must be no more
/// specific than the server is. It never says "no account found", never lays
/// itself out differently for a different outcome, and never branches on
/// anything that could depend on the address. The only two answers it repeats
/// verbatim are the pre-lookup shape rejection and the per-network throttle,
/// both of which are identical for every well-formed address.
struct PasswordResetRequestSection: View {
    let title: String
    let explanation: String
    @Binding var email: String

    @State private var isWorking = false
    @State private var errorText: String?
    @State private var sent = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)

            if sent {
                Text(PasswordResetCopy.genericConfirmation)
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.tint)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text("The link works once and expires after \(PasswordResetCopy.expiryMinutes) minutes. Open it on this iPhone and it will come straight back here.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button("Send it again") { sent = false }
                    .font(.footnote)
                    .tint(ViciTheme.tint)
            } else {
                Text(explanation)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                TextField("Email address", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(send)

                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.destructive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: send) {
                    if isWorking {
                        ProgressView().tint(.white).frame(maxWidth: .infinity)
                    } else {
                        Text("Send a reset link").bold().frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .controlSize(.large)
                .disabled(isWorking || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func send() {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isWorking, !address.isEmpty else { return }
        focused = false
        errorText = nil
        isWorking = true

        Task { @MainActor in
            do {
                try await APIClient.shared.requestPasswordReset(email: address)
                sent = true
            } catch let error as PasswordResetRequestError {
                errorText = error.message
            } catch {
                errorText = PasswordResetRequestError.unreachable.message
            }
            isWorking = false
        }
    }
}

/// "Forgot password" from the sign-in screen. Presented as a sheet by
/// `LoginView`, which is the only place somebody who cannot sign in will look.
struct ForgotPasswordView: View {
    /// Prefilled from whatever was already typed into the sign-in form.
    @State private var email: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(prefilledEmail: String = "") {
        _email = State(initialValue: prefilledEmail.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                MintDriftBackground(isStatic: reduceMotion)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)

                ScrollView {
                    VStack(spacing: 20) {
                        PasswordResetRequestSection(
                            title: "Reset your password",
                            explanation: "Enter the email address you sign in with. We will send a link that lets you set a new password. Opening it on this iPhone brings you straight back into the app.",
                            email: $email
                        )

                        Text("Signing in with the shared team password instead of an email address? That password has no reset link. It lives in the server configuration, so ask an admin for your own account.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 28)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Forgot password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back to sign in") { dismiss() }
                }
            }
        }
    }
}
