import SwiftUI

/// Changing the password of the account that is already signed in.
///
/// This closes a gap that had real consequences. The app had no
/// change-password screen at all, so an account flagged `must_change_password`
/// could sign in successfully and then be refused by every endpoint except
/// `GET /api/users/me` and `POST /api/users/me/password`
/// (`PASSWORD_CHANGE_EXEMPT` in `lib/route-policy.js`). The operator saw an app
/// where nothing loaded and nothing said why. `AcceptInvitationView` used to
/// send those people to the website to get unstuck; it no longer has to.
///
/// Two modes, one form:
///
///   * `.voluntary`  pushed from the account menu. Anybody signed in with a
///     named account can change their password whenever they like, which is
///     what somebody does the moment they suspect their password is known.
///   * `.forced`     rendered by `RootView` in place of the tab bar while the
///     server insists on a rotation. It is the only thing on screen because it
///     is the only thing the server will answer.
///
/// WHAT THIS SCREEN NEVER DOES: sign anybody out. `SessionModel.signOut()` has
/// exactly one call site in this app, on the account menu, because it wipes the
/// Keychain that the VoIP answer path reads and that is the only thing which
/// can stop this phone ringing. The forced mode therefore offers the account
/// menu itself rather than a second sign-out button.
struct ChangePasswordView: View {
    enum Mode { case voluntary, forced }

    let mode: Mode

    init(mode: Mode = .voluntary) {
        self.mode = mode
    }

    @EnvironmentObject private var session: SessionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var revealPasswords = false
    @State private var isWorking = false
    @State private var failure: PasswordChangeError?
    @State private var didChange = false
    @State private var showingAccountMenu = false
    @FocusState private var focused: Field?

    private enum Field: Hashable { case current, next, confirmation }

    /// The shared team login has no personal password, so
    /// `POST /api/users/me/password` refuses it with
    /// `LEGACY_SESSION_NO_PASSWORD` every time. Say so here rather than after a
    /// round trip that cannot succeed. A nil account is the shared login too:
    /// it is the one identity the server does not name.
    private var isSharedTeamLogin: Bool {
        guard let user = session.currentUser else { return true }
        return user.isSharedTeamLogin
    }

    var body: some View {
        Group {
            switch mode {
            case .voluntary: voluntaryBody
            case .forced:    forcedBody
            }
        }
        .assistantDraftOwner(
            source: .account,
            isDirty: !currentPassword.isEmpty || !newPassword.isEmpty || !confirmation.isEmpty,
            onDiscard: {
                focused = nil
                currentPassword = ""
                newPassword = ""
                confirmation = ""
                if case .voluntary = mode { dismiss() }
            }
        )
    }

    // MARK: - Voluntary, pushed from the account menu

    private var voluntaryBody: some View {
        Form {
            if isSharedTeamLogin {
                Section {
                    Text("You are signed in with the shared team login. It has no personal password to change here.")
                        .font(.footnote)
                    Text("Its password lives in the server configuration rather than on an account. Ask an admin for your own account, and after that this screen can change your password.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if didChange {
                Section {
                    Label("Your password has been changed", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(ViciTheme.success)
                        .font(.subheadline.weight(.semibold))
                    Text("Every other device that was signed in as you has been signed out. This iPhone stays signed in and keeps ringing for calls.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Done") { dismiss() }
                }
            } else {
                Section {
                    Text(PasswordPolicy.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Password rules")
                }

                Section {
                    currentPasswordField
                    newPasswordField
                    confirmationField
                    Toggle("Show passwords", isOn: $revealPasswords)
                        .font(.caption)
                        .tint(ViciTheme.tint)
                } header: {
                    Text("Change your password")
                } footer: {
                    Text("Changing your password signs out every other device that is signed in as you. This iPhone stays signed in.")
                }

                if let failure {
                    Section {
                        Text(failure.message)
                            .font(.footnote)
                            .foregroundStyle(ViciTheme.destructive)
                    }
                }

                Section {
                    Button(action: submit) {
                        HStack {
                            Text("Change password").fontWeight(.semibold)
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
        }
        .navigationTitle("Password")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Forced, in place of the whole app

    private var forcedBody: some View {
        ZStack {
            MintDriftBackground(isStatic: reduceMotion)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            ScrollView {
                VStack(spacing: 18) {
                    wordmark

                    if isSharedTeamLogin {
                        forcedSharedLogin
                    } else {
                        forcedForm
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .sheet(isPresented: $showingAccountMenu) { AccountMenuSheet() }
        .onAppear { if !isSharedTeamLogin { focused = .current } }
    }

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
            Text("Set a new password")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
        }
        .padding(.bottom, 4)
    }

    private var forcedForm: some View {
        VStack(spacing: 14) {
            Text(signedInAs + "Your password has to be changed before you can use the inbox. Until it is, the server refuses every other request from this account, which is why nothing else is on screen.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Text(PasswordPolicy.summary)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)

            currentPasswordField.textFieldStyle(.roundedBorder)
            newPasswordField.textFieldStyle(.roundedBorder)
            confirmationField.textFieldStyle(.roundedBorder)

            Toggle("Show passwords", isOn: $revealPasswords)
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
                    Text("Set password").bold().frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(ViciTheme.tint)
            .controlSize(.large)
            .disabled(!canSubmit)

            // The way out that is not this form. Sign out lives on that menu
            // and has exactly one call site in the app, so this presents the
            // menu rather than adding a second one.
            Button("Account menu") { showingAccountMenu = true }
                .font(.footnote)
                .tint(ViciTheme.tint)
                .padding(.top, 2)

            Text("Signing out is on the account menu.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var forcedSharedLogin: some View {
        VStack(spacing: 16) {
            Text("This is the shared team login, which has no personal password to change.")
                .font(.footnote)
                .foregroundStyle(ViciTheme.destructive)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Text("Ask an admin for your own account, then sign in with your email address. Sign out is on the account menu.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            Button("Account menu") { showingAccountMenu = true }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .controlSize(.large)
        }
    }

    private var signedInAs: String {
        guard let email = session.currentUser?.email, !email.isEmpty else { return "" }
        return "Signed in as \(email). "
    }

    // MARK: - Fields

    private var currentPasswordField: some View {
        Group {
            if revealPasswords {
                TextField("Current password", text: $currentPassword)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("Current password", text: $currentPassword)
                    .textContentType(.password)
            }
        }
        .focused($focused, equals: .current)
        .submitLabel(.next)
        .onSubmit { focused = .next }
    }

    private var newPasswordField: some View {
        Group {
            if revealPasswords {
                TextField("New password", text: $newPassword)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("New password", text: $newPassword)
                    .textContentType(.newPassword)
            }
        }
        .focused($focused, equals: .next)
        .submitLabel(.next)
        .onSubmit { focused = .confirmation }
    }

    private var confirmationField: some View {
        Group {
            if revealPasswords {
                TextField("Confirm new password", text: $confirmation)
                    .textContentType(.newPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                SecureField("Confirm new password", text: $confirmation)
                    .textContentType(.newPassword)
            }
        }
        .focused($focused, equals: .confirmation)
        .submitLabel(.go)
        .onSubmit(submit)
    }

    private var canSubmit: Bool {
        !isWorking && !currentPassword.isEmpty && !newPassword.isEmpty && !confirmation.isEmpty
    }

    // MARK: - Submit

    private func submit() {
        guard canSubmit else { return }
        focused = nil

        // The three mistakes the server would also catch, caught here first so
        // they cost nothing. The server re-runs all of them and wins.
        if let problem = PasswordPolicy.problem(with: newPassword) {
            failure = .passwordTooWeak(problem)
            return
        }
        guard newPassword == confirmation else {
            failure = .passwordTooWeak("Those two passwords do not match.")
            return
        }
        guard newPassword != currentPassword else {
            failure = .unchanged(nil)
            return
        }

        isWorking = true
        failure = nil
        let current = currentPassword
        let next = newPassword

        Task { @MainActor in
            do {
                try await APIClient.shared.changePassword(currentPassword: current, newPassword: next)
                currentPassword = ""
                newPassword = ""
                confirmation = ""
                didChange = true
                // The server clears must_change_password as part of the same
                // write, so the gate is re-read from its answer rather than
                // guessed at here. In forced mode this is what puts the tab bar
                // back. Nothing is signed out and no credential is cleared.
                await session.notePasswordChanged()
            } catch let error as PasswordChangeError {
                failure = error
            } catch {
                failure = .network
            }
            isWorking = false
        }
    }
}
