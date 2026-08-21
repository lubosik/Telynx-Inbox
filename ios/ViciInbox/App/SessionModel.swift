import Foundation
import SwiftUI
import Combine

/// Observable app state for the SwiftUI layer. Wraps the voice manager so views
/// never touch the Telnyx SDK directly.
@MainActor
final class SessionModel: ObservableObject {

    @Published private(set) var isSignedIn = false
    @Published private(set) var isCheckingSession = true
    @Published private(set) var activeCall: ActiveCall?
    @Published private(set) var isVoiceReady = false
    @Published private(set) var voiceStatusText = "Starting…"

    /// The signed-in account, when the backend reports one. Nil means the
    /// legacy shared-password session, which has no named identity.
    @Published private(set) var currentUser: AuthUser?
    @Published private(set) var permissions: Set<String> = []

    /// Set when a request 401'd and a silent re-login also failed. It drives a
    /// "signed out — tap to sign in" banner and nothing else: no credential is
    /// cleared, push stays registered, and the SIP socket is left alone, so an
    /// incoming call still rings and can still be answered.
    @Published private(set) var isAuthenticationLost = false

    var callerNumber: String { CredentialStore.get(.callerNumber) ?? "" }

    private let voice = TelnyxVoiceManager.shared
    private var cancellables: Set<AnyCancellable> = []

    init() {
        voice.observer = self
        let readiness = voice.readiness
        isVoiceReady = readiness.ready
        voiceStatusText = readiness.status
        activeCall = voice.currentCall
        observeAuthenticationSignals()
    }

    // MARK: - Permissions

    /// Whether the current account may perform an action.
    ///
    /// An unknown account (legacy shared password, or a backend that predates
    /// `/api/users/me`) is treated as fully permitted: this gate exists to keep
    /// the interface honest, not to secure anything. The server enforces every
    /// permission independently on the request itself, so a client that guesses
    /// generously cannot grant access it should not have.
    func can(_ permission: String) -> Bool {
        guard let currentUser, currentUser.permissions != nil else { return true }
        return permissions.contains(permission)
    }

    var isAdmin: Bool {
        guard let currentUser else { return true }
        return RoleCatalog.isAdminish(currentUser.role) || can(Permission.userManage)
    }

    func reloadCurrentUser() async {
        let user = await APIClient.shared.loadCurrentUser()
        currentUser = user
        permissions = user?.permissionSet ?? []
    }

    // MARK: - Authentication signals
    //
    // A 401 is reported, never acted on destructively. Rule: no authentication
    // failure may call `signOut()`, because `signOut()` wipes the Keychain the
    // VoIP answer path reads.

    private func observeAuthenticationSignals() {
        NotificationCenter.default.publisher(for: .viciAuthenticationLost)
            .sink { _ in
                Task { @MainActor [weak self] in self?.noteAuthenticationLost() }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .viciAuthenticationRecovered)
            .sink { _ in
                Task { @MainActor [weak self] in await self?.noteAuthenticationRecovered() }
            }
            .store(in: &cancellables)
    }

    private func noteAuthenticationLost() {
        guard isSignedIn else { return }
        isAuthenticationLost = true
    }

    /// A silent re-login succeeded. `SESSION_STALE` means the permissions
    /// themselves changed, so the account is reloaded rather than assumed.
    private func noteAuthenticationRecovered() async {
        isAuthenticationLost = false
        await reloadCurrentUser()
    }

    // MARK: - Session

    func bootstrap() async {
        isCheckingSession = true
        let authed = await APIClient.shared.restoreSessionIfNeeded()
        isSignedIn = authed
        isCheckingSession = false
        if authed {
            isAuthenticationLost = false
            await reloadCurrentUser()
            await MessageNotificationManager.shared.enableAndSync()
            await voice.requestMicrophonePermissionIfNeeded()
            await voice.connectIfPossible()
        }
        // A failed restore leaves the Keychain untouched on purpose. The login
        // screen is shown, but a VoIP push arriving in the meantime still finds
        // its SIP credentials and still rings.
    }

    /// Legacy shared-password sign-in. Two people use this in production.
    func signIn(password: String) async throws {
        try await APIClient.shared.login(password: password)
        await completeSignIn()
    }

    /// Named-account sign-in. An empty email falls back to the shared-password
    /// path inside the client, so the same button serves both.
    func signIn(email: String, password: String) async throws {
        if email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try await APIClient.shared.login(password: password)
        } else {
            try await APIClient.shared.login(email: email, password: password)
        }
        await completeSignIn()
    }

    private func completeSignIn() async {
        // Pull SIP credentials immediately so a later cold launch from a push
        // has everything it needs in the Keychain.
        _ = try? await APIClient.shared.fetchSIPCredentials()
        isSignedIn = true
        isAuthenticationLost = false
        await reloadCurrentUser()
        await MessageNotificationManager.shared.enableAndSync()
        // Resolve microphone access now. If it is still undetermined when a
        // call is answered from the lock screen, iOS cannot prompt and the
        // call connects with no microphone.
        await voice.requestMicrophonePermissionIfNeeded()
        await voice.connectIfPossible(force: true)
    }

    /// The only path that may destroy credentials, and it exists solely behind
    /// an explicit tap on Sign Out in Settings.
    ///
    /// `disablePushNotificationsAndWait()` takes effect server-side at Telnyx
    /// and cannot be rolled back from the client, and `CredentialStore.clearAll()`
    /// removes the SIP login the VoIP answer path reads synchronously. Neither
    /// may ever run on a non-interactive path: a 401, a failed session restore,
    /// `ACCOUNT_DISABLED`, and `SESSION_STALE` all stop at a banner instead.
    func signOut() async {
        // Unregister push BEFORE dropping the socket — the disable message
        // travels over that socket, so we wait for the acknowledgement.
        // Skipping this leaves Telnyx pushing to a signed-out device, which
        // then rings for calls it cannot answer.
        await voice.disablePushNotificationsAndWait()
        await MessageNotificationManager.shared.unregisterFromBackend()
        await MessageNotificationManager.shared.clearBadge()
        voice.disconnect()
        await APIClient.shared.logout()
        CredentialStore.clearAll()
        isSignedIn = false
        isAuthenticationLost = false
        currentUser = nil
        permissions = []
    }

    /// Called when the app returns to the foreground — re-establishes the SIP
    /// socket if it dropped while backgrounded.
    func refreshConnection() {
        guard isSignedIn else { return }
        Task {
            // A foreground return is a good moment to clear a stuck
            // "signed out" banner. This only ever re-logs in from the
            // Keychain; it cannot sign the user out or clear a credential.
            if isAuthenticationLost, await APIClient.shared.restoreSessionIfNeeded() {
                isAuthenticationLost = false
                await reloadCurrentUser()
            }
            await MessageNotificationManager.shared.enableAndSync()
            await voice.connectIfPossible()
        }
    }

    // MARK: - Call controls

    func startOutgoingCall(to number: String) { voice.startOutgoingCall(to: number) }
    func endCall()       { voice.endCall() }
    func toggleMute()    { voice.toggleMute() }
    func toggleHold()    { voice.toggleHold() }
    func toggleSpeaker() { voice.toggleSpeaker() }
    func sendDTMF(_ d: String) { voice.sendDTMF(d) }
}

extension SessionModel: VoiceManagerObserver {

    nonisolated func voiceManager(_ manager: TelnyxVoiceManager, didUpdate call: ActiveCall?) {
        Task { @MainActor in self.activeCall = call }
    }

    nonisolated func voiceManager(_ manager: TelnyxVoiceManager,
                                  didChangeReadiness ready: Bool,
                                  status: String) {
        Task { @MainActor in
            self.isVoiceReady = ready
            self.voiceStatusText = status
        }
    }
}
