import Foundation
import Combine
import UIKit
import UserNotifications

/// Owns standard APNs registration for message alerts. This is deliberately
/// separate from PushKit: PushKit is reserved for incoming calls and must not
/// be used for ordinary SMS notifications.
@MainActor
final class MessageNotificationManager: NSObject, ObservableObject {
    static let shared = MessageNotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var hasDeviceToken = false
    @Published private(set) var isRegisteredWithBackend = false
    @Published private(set) var lastError: String?
    @Published private(set) var pendingConversationPhone: String?
    @Published private(set) var inboxRefreshSequence = 0

    private let installationDefaultsKey = "vici.apns.installation-id"
    private var deviceToken: String?
    private var backendRegistrationEnabled = false

    // MARK: - Home Screen badge
    //
    // iOS gives the app one badge number, so it has to carry both halves of the
    // inbox: unread messages and missed calls. Both are persisted because a VoIP
    // push can cold-launch this process in the background, where an in-memory
    // count would start at zero and silently wipe the other half of the badge.

    @Published private(set) var unreadMessages = 0
    @Published private(set) var missedCalls = 0

    private let unreadDefaultsKey = "vici.badge.unread-messages"
    private let missedCallsDefaultsKey = "vici.badge.missed-calls"

    var statusText: String {
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            if isRegisteredWithBackend { return "Enabled" }
            return hasDeviceToken ? "Connecting…" : "Waiting for Apple…"
        case .denied: return "Disabled in iPhone Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private override init() {
        super.init()
        // Restored rather than defaulted to zero: a VoIP push can cold-launch
        // this process, and a fresh count would drop the badge the operator can
        // currently see on the Home Screen.
        unreadMessages = UserDefaults.standard.integer(forKey: unreadDefaultsKey)
        missedCalls = UserDefaults.standard.integer(forKey: missedCallsDefaultsKey)
    }

    func configure() {
        UNUserNotificationCenter.current().delegate = self
        Task {
            await refreshAuthorizationStatus()
            if authorizationAllowsNotifications {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Called after authentication. The system prompt is shown only once; on
    /// later launches this simply refreshes the APNs token and backend row.
    func enableAndSync() async {
        backendRegistrationEnabled = true
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            await refreshAuthorizationStatus()
            guard granted || authorizationAllowsNotifications else { return }
            UIApplication.shared.registerForRemoteNotifications()
            await syncRegistrationIfPossible()
        } catch {
            lastError = error.localizedDescription
            Log.push("message notification permission failed")
        }
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func queueConversation(phone: String) {
        pendingConversationPhone = phone
    }

    func consumePendingConversation() {
        pendingConversationPhone = nil
    }

    /// Reconciles the message half of the badge with the server-backed unread
    /// total.
    func setUnreadMessages(_ count: Int) async {
        unreadMessages = max(0, count)
        UserDefaults.standard.set(unreadMessages, forKey: unreadDefaultsKey)
        await applyBadge()
    }

    /// Reconciles the call half of the badge with the missed calls nobody has
    /// looked at yet.
    func setMissedCalls(_ count: Int) async {
        missedCalls = max(0, count)
        UserDefaults.standard.set(missedCalls, forKey: missedCallsDefaultsKey)
        await applyBadge()
    }

    /// A call that rang and was not answered. The VoIP push keeps this process
    /// alive for the duration of the call even when the app is in the
    /// background, so the badge can move immediately rather than waiting for the
    /// next launch. The server-derived count replaces this estimate as soon as
    /// call history loads.
    func noteMissedCall() async {
        await setMissedCalls(missedCalls + 1)
    }

    /// Both halves at once, for sign-out. A signed-out device must not keep
    /// advertising a count it can no longer refresh.
    func clearBadge() async {
        await setUnreadMessages(0)
        await setMissedCalls(0)
    }

    /// Failures are diagnostic only and must not make notification registration
    /// appear broken in Settings.
    private func applyBadge() async {
        do {
            try await UNUserNotificationCenter.current()
                .setBadgeCount(max(0, unreadMessages + missedCalls))
        } catch {
            Log.push("app icon badge update failed")
        }
    }

    func didReceiveDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        // APNs can rotate this value. Keep it only for the current process and
        // ask Apple for a current token on every launch.
        deviceToken = token
        hasDeviceToken = true
        lastError = nil
        Log.push("received standard APNs message token")
        Task { await syncRegistrationIfPossible() }
    }

    func didFailToRegister(_ error: Error) {
        hasDeviceToken = false
        isRegisteredWithBackend = false
        lastError = error.localizedDescription
        Log.push("standard APNs registration failed")
    }

    func syncRegistrationIfPossible() async {
        guard backendRegistrationEnabled,
              authorizationAllowsNotifications,
              let token = deviceToken else { return }
        do {
            try await APIClient.shared.registerMessagePushDevice(
                token: token,
                installationID: installationID,
                environment: environment
            )
            isRegisteredWithBackend = true
            lastError = nil
            Log.push("message notification token registered with backend")
        } catch {
            isRegisteredWithBackend = false
            lastError = error.localizedDescription
            Log.push("message notification backend registration failed")
        }
    }

    func unregisterFromBackend() async {
        // Set this first so a token callback racing sign-out cannot add the
        // device again after the delete request.
        backendRegistrationEnabled = false
        await APIClient.shared.unregisterMessagePushDevice(token: deviceToken,
                                                           installationID: installationID)
        isRegisteredWithBackend = false
    }

    func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private var authorizationAllowsNotifications: Bool {
        [.authorized, .provisional, .ephemeral].contains(authorizationStatus)
    }

    private func noteIncomingMessage() {
        inboxRefreshSequence &+= 1
    }

    private var installationID: String {
        if let existing = UserDefaults.standard.string(forKey: installationDefaultsKey) {
            return existing
        }
        let generated = UUID().uuidString
        UserDefaults.standard.set(generated, forKey: installationDefaultsKey)
        return generated
    }
}

extension MessageNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The inbox may already be onscreen, but an audible banner is still
        // valuable for a shared business inbox.
        Task { @MainActor in
            MessageNotificationManager.shared.noteIncomingMessage()
        }
        completionHandler([.banner, .list, .sound, .badge])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        if let phone = response.notification.request.content.userInfo["phone"] as? String,
           !phone.isEmpty {
            Task { @MainActor in
                MessageNotificationManager.shared.noteIncomingMessage()
                MessageNotificationManager.shared.queueConversation(phone: phone)
                completionHandler()
            }
        } else {
            completionHandler()
        }
    }
}
