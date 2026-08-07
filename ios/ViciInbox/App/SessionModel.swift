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

    var callerNumber: String { CredentialStore.get(.callerNumber) ?? "" }

    private let voice = TelnyxVoiceManager.shared

    init() {
        voice.observer = self
        let readiness = voice.readiness
        isVoiceReady = readiness.ready
        voiceStatusText = readiness.status
        activeCall = voice.currentCall
    }

    // MARK: - Session

    func bootstrap() async {
        isCheckingSession = true
        let authed = await APIClient.shared.restoreSessionIfNeeded()
        isSignedIn = authed
        isCheckingSession = false
        if authed {
            await MessageNotificationManager.shared.enableAndSync()
            await voice.requestMicrophonePermissionIfNeeded()
            await voice.connectIfPossible()
        }
    }

    func signIn(password: String) async throws {
        try await APIClient.shared.login(password: password)
        // Pull SIP credentials immediately so a later cold launch from a push
        // has everything it needs in the Keychain.
        _ = try? await APIClient.shared.fetchSIPCredentials()
        isSignedIn = true
        await MessageNotificationManager.shared.enableAndSync()
        // Resolve microphone access now. If it is still undetermined when a
        // call is answered from the lock screen, iOS cannot prompt and the
        // call connects with no microphone.
        await voice.requestMicrophonePermissionIfNeeded()
        await voice.connectIfPossible(force: true)
    }

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
    }

    /// Called when the app returns to the foreground — re-establishes the SIP
    /// socket if it dropped while backgrounded.
    func refreshConnection() {
        guard isSignedIn else { return }
        Task {
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
