import SwiftUI

/// Change your own name and your own email address.
///
/// Two edits that look similar and are not. A display name is cosmetic and
/// nobody signs in with it, so it saves immediately. An email address is the
/// credential half of a named account, so it is changed by proving control of
/// the new address first: the app asks the server to send a link there, and the
/// account keeps answering to the old address until that link is followed.
///
/// The consequence to preserve is that a typo cannot lock anybody out. Nothing
/// in this screen ever writes the new address onto the session, and nothing
/// here signs anybody out.
///
/// Endpoints and their exact semantics are documented on the `APIClient`
/// methods. Every failure path here shows the server's own sentence rather than
/// a rewritten one, which matters most on the email path: that reply is
/// deliberately identical whether the address was free or already taken, so
/// that it cannot be used to discover whether an account exists.
struct ProfileEditorView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model = ProfileEditorModel()
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case name
        case email
    }

    var body: some View {
        List {
            if session.currentUser == nil {
                sharedLoginNotice
            } else {
                nameSection
                emailSection
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Name & Email")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .task {
            model.prime(with: session.currentUser)
            model.discardExpiredPending()
        }
        // The whole point of the pending state: the person leaves for their
        // mail app, follows the link, and comes back. Re-reading the account on
        // foreground is what turns "check your new address" into "verified"
        // without them having to find a refresh control.
        .onChange(of: scenePhase) { phase in
            guard phase == .active else { return }
            Task {
                await model.refresh(session: session)
                model.discardExpiredPending()
            }
        }
        .onChange(of: session.currentUser?.pendingEmail) { _ in
            model.prime(with: session.currentUser)
        }
        .onChange(of: session.currentUser?.email) { _ in
            model.prime(with: session.currentUser)
        }
        .alert("Could not save", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        .assistantDraftOwner(
            source: .account,
            isDirty: model.hasUnsavedDraftChanges,
            onDiscard: {
                focusedField = nil
                model.name = session.currentUser?.displayName ?? ""
                model.newEmail = ""
            }
        )
    }

    // MARK: - Name

    private var nameSection: some View {
        Section {
            TextField("Your name", text: $model.name)
                .focused($focusedField, equals: .name)
                .textContentType(.name)
                .submitLabel(.done)
                .onSubmit { saveName() }
                .disabled(model.isSavingName)

            Button {
                saveName()
            } label: {
                HStack {
                    Text("Save Name")
                    Spacer()
                    if model.isSavingName { ProgressView() }
                }
            }
            .disabled(!model.canSaveName)

            if let confirmation = model.nameConfirmation {
                Label(confirmation, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.success)
            }
        } header: {
            Text("Name")
        } footer: {
            Text("This is the name your teammates see on activity and campaign decisions. Changing it takes effect immediately and does not affect how you sign in.")
        }
    }

    private func saveName() {
        focusedField = nil
        Task { await model.saveName(session: session) }
    }

    // MARK: - Email

    @ViewBuilder
    private var emailSection: some View {
        if let pending = model.pendingEmail {
            pendingEmailSection(pending)
        } else {
            changeEmailSection
        }
    }

    private var changeEmailSection: some View {
        Section {
            LabeledContent("Current", value: model.currentEmail ?? "Not available")

            TextField("New email address", text: $model.newEmail)
                .focused($focusedField, equals: .email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit { requestEmailChange() }
                .disabled(model.isRequestingEmail)

            Button {
                requestEmailChange()
            } label: {
                HStack {
                    Text("Send Verification Link")
                    Spacer()
                    if model.isRequestingEmail { ProgressView() }
                }
            }
            .disabled(!model.canRequestEmailChange)

            if let confirmation = model.emailConfirmation {
                Label(confirmation, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.success)
            }
        } header: {
            Text("Email")
        } footer: {
            Text("You will stay signed in with your current address until you open the link sent to the new one. If you mistype it, nothing changes and you can start again.")
        }
    }

    private func requestEmailChange() {
        focusedField = nil
        Task { await model.requestEmailChange(session: session) }
    }

    private func pendingEmailSection(_ pending: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Check your new address", systemImage: "envelope.badge.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(ViciTheme.warning)
                Text(pending)
                    .font(.subheadline.weight(.medium))
                    .textSelection(.enabled)
                Text("Open the link in that email to finish the change. Until you do, you stay signed in as \(model.currentEmail ?? "your current address").")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let expiry = model.pendingExpiryText {
                    Text("The link stops working \(expiry).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                // The server's own wording, verbatim. It says "if that address
                // can be used" rather than "sent", and that hedge is load
                // bearing — see `APIClient.requestEmailChange`.
                if let message = model.emailServerMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 4)

            Button {
                Task { await model.resendEmailChange(session: session) }
            } label: {
                HStack {
                    Text("Resend Link")
                    Spacer()
                    if model.isResendingEmail { ProgressView() }
                }
            }
            .disabled(model.isResendingEmail || model.isCancellingEmail)

            // Not destructive-red. Cancelling an unconfirmed change destroys
            // nothing and returns the account to exactly where it already is.
            Button {
                Task { await model.cancelEmailChange(session: session) }
            } label: {
                HStack {
                    Text("Cancel Change")
                    Spacer()
                    if model.isCancellingEmail { ProgressView() }
                }
            }
            .disabled(model.isResendingEmail || model.isCancellingEmail)

            if let confirmation = model.emailConfirmation {
                Label(confirmation, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.success)
            }
        } header: {
            Text("Email Change Pending")
        } footer: {
            Text("This screen updates itself when you come back to the app after opening the link.")
        }
    }

    private var sharedLoginNotice: some View {
        Section {
            Text("Shared team login")
                .font(.body.weight(.semibold))
            Text("The shared password is not a personal account, so it has no name or email to change. Ask an Admin to invite you as a named account.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// The editing state behind `ProfileEditorView`.
///
/// The pending address is held HERE, in `UserDefaults`, and not read back from
/// the server. That is forced by the server's design rather than a shortcut:
/// `POST /api/users/me/email` answers identically whether the address was free
/// or already taken, and `GET /api/users/me` carries no pending address, both
/// so the endpoint cannot be used to discover whether an account exists.
/// Publishing a pending address on the identity would put that oracle back.
///
/// Because there is no server state to reconcile against, the local record is
/// cleared on exactly three events and no others: the signed-in address becomes
/// the pending one (confirmed), the link's lifetime runs out (expired), or the
/// person cancels. In particular it is NOT cleared merely because the identity
/// still shows the old address, which is the normal state for the entire time a
/// change is outstanding.
///
/// It holds one address for one person on their own device, is not a credential
/// and carries no token.
@MainActor
final class ProfileEditorModel: ObservableObject {
    @Published var name = ""
    @Published var newEmail = ""

    @Published private(set) var currentEmail: String?
    @Published private(set) var pendingEmail: String?
    @Published private(set) var pendingExpiresAt: Date?

    @Published private(set) var isSavingName = false
    @Published private(set) var isRequestingEmail = false
    @Published private(set) var isResendingEmail = false
    @Published private(set) var isCancellingEmail = false

    @Published private(set) var nameConfirmation: String?
    @Published private(set) var emailConfirmation: String?
    /// The server's own sentence about the last email request, shown verbatim
    /// because it is deliberately non-committal.
    @Published private(set) var emailServerMessage: String?
    @Published var errorMessage: String?

    private static let pendingEmailKey = "vici.profile.pendingEmail"
    private static let pendingExpiryKey = "vici.profile.pendingEmailExpiresAt"
    private let defaults: UserDefaults
    /// Set once the fields have been seeded, so a later identity refresh cannot
    /// overwrite half-typed text.
    private var hasPrimed = false
    private var primedName = ""

    var hasUnsavedDraftChanges: Bool {
        hasPrimed && (name != primedName || !newEmail.isEmpty)
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var canSaveName: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isSavingName && !trimmed.isEmpty && trimmed.count <= 120
    }

    /// A shape check and nothing cleverer, and specifically NOT a check against
    /// the team directory. The server refuses to reveal whether an address is
    /// already in use; a client-side existence check would hand back the exact
    /// answer the server is withholding.
    var canRequestEmailChange: Bool {
        guard !isRequestingEmail else { return false }
        return Self.looksLikeAnAddress(newEmail)
            && newEmail.trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(currentEmail ?? "") != .orderedSame
    }

    static func looksLikeAnAddress(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3, trimmed.count <= 254, !trimmed.contains(" ") else { return false }
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains(".") else { return false }
        return !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }

    /// Human text for how long the outstanding link has left, or nil when it
    /// has run out.
    var pendingExpiryText: String? {
        guard let pendingExpiresAt else { return nil }
        guard pendingExpiresAt > Date() else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: pendingExpiresAt, relativeTo: Date())
    }

    var pendingHasExpired: Bool {
        guard let pendingExpiresAt else { return false }
        return pendingExpiresAt <= Date()
    }

    func prime(with user: AuthUser?) {
        currentEmail = user?.email

        // The server does not report a pending change, so this is normally nil.
        // Read anyway: if it ever starts reporting one, it outranks the local
        // record.
        if let serverPending = user?.pendingEmail {
            pendingEmail = serverPending
            defaults.set(serverPending, forKey: Self.pendingEmailKey)
        } else if let stored = defaults.string(forKey: Self.pendingEmailKey) {
            if let current = user?.email,
               current.caseInsensitiveCompare(stored) == .orderedSame {
                // The link was opened. This is the only signal the client gets.
                emailConfirmation = "Email verified. You now sign in with \(current)."
                clearPendingRecord()
            } else {
                pendingEmail = stored
                pendingExpiresAt = defaults.object(forKey: Self.pendingExpiryKey) as? Date
            }
        } else {
            pendingEmail = nil
            pendingExpiresAt = nil
        }

        guard !hasPrimed else { return }
        hasPrimed = true
        name = user?.displayName ?? ""
        primedName = name
    }

    func refresh(session: SessionModel) async {
        await session.reloadCurrentUser()
        prime(with: session.currentUser)
    }

    func saveName(session: SessionModel) async {
        guard canSaveName else { return }
        isSavingName = true
        defer { isSavingName = false }
        nameConfirmation = nil
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await APIClient.shared.updateDisplayName(trimmed)
            await session.reloadCurrentUser()
            // Re-read rather than assume. The server trims and may normalise,
            // and showing what it actually stored is the only honest
            // confirmation.
            let stored = session.currentUser?.displayName ?? trimmed
            name = stored
            primedName = stored
            nameConfirmation = "Saved as \(stored)."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestEmailChange(session: SessionModel) async {
        guard canRequestEmailChange else { return }
        let trimmed = newEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        isRequestingEmail = true
        defer { isRequestingEmail = false }
        emailConfirmation = nil
        await submitEmailChange(trimmed, session: session, clearField: true)
    }

    /// Resending is the same call with the same address. There is no separate
    /// resend endpoint, and there should not be: the server cancels the open
    /// request and issues a new link, so exactly one link is ever live.
    func resendEmailChange(session: SessionModel) async {
        guard let pending = pendingEmail, !isResendingEmail else { return }
        isResendingEmail = true
        defer { isResendingEmail = false }
        await submitEmailChange(pending, session: session, clearField: false)
        if errorMessage == nil { emailConfirmation = "Another link is on its way." }
    }

    private func submitEmailChange(_ address: String,
                                   session: SessionModel,
                                   clearField: Bool) async {
        do {
            let result = try await APIClient.shared.requestEmailChange(to: address)
            pendingEmail = address
            defaults.set(address, forKey: Self.pendingEmailKey)
            let hours = result.expiresInHours ?? 24
            let expiry = Date().addingTimeInterval(TimeInterval(hours) * 3600)
            pendingExpiresAt = expiry
            defaults.set(expiry, forKey: Self.pendingExpiryKey)
            emailServerMessage = result.message
            if clearField { newEmail = "" }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancelEmailChange(session: SessionModel) async {
        guard !isCancellingEmail else { return }
        isCancellingEmail = true
        defer { isCancellingEmail = false }
        do {
            try await APIClient.shared.cancelEmailChange()
            clearPendingRecord()
            emailConfirmation = "Change cancelled. Your address is unchanged."
            emailServerMessage = nil
            errorMessage = nil
            await session.reloadCurrentUser()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Called when the link's lifetime has run out. Local only: the server
    /// expires its own record independently, and cancelling here would be a
    /// pointless round trip for something already dead.
    func discardExpiredPending() {
        guard pendingHasExpired else { return }
        clearPendingRecord()
        emailConfirmation = nil
        emailServerMessage = nil
        errorMessage = "That confirmation link expired before it was opened. Request a new one."
    }

    private func clearPendingRecord() {
        pendingEmail = nil
        pendingExpiresAt = nil
        defaults.removeObject(forKey: Self.pendingEmailKey)
        defaults.removeObject(forKey: Self.pendingExpiryKey)
    }
}
