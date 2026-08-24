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
    @Published private(set) var campaignRefreshSequence = 0
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
        registerNotificationCategories()
        Task {
            await refreshAuthorizationStatus()
            if authorizationAllowsNotifications {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// The daily digest category, its two actions, and its hidden-previews
    /// placeholder.
    ///
    /// `hiddenPreviewsBodyPlaceholder` has NO payload equivalent: it is a
    /// property of a UNNotificationCategory and can only be set here. It is
    /// what a Lock Screen with previews turned off shows instead of the body,
    /// and "Daily summary" is a great deal more useful than "Notification".
    ///
    /// TWO ACTIONS, AND DELIBERATELY NOT FOUR.
    ///   REVIEW opens the app to the audiences screen.
    ///   SNOOZE re-delivers this evening, locally.
    ///
    ///   There is no Approve and no Reject, and that is not an omission. A
    ///   digest covers several proposals, so "approve" has no single referent.
    ///   These are model-written messages aimed at real paying customers, and
    ///   approving one from a Lock Screen without having read the copy is a
    ///   defect dressed up as a convenience. And a background action has a few
    ///   seconds of execution time, so on a bad connection the call fails after
    ///   the notification has already been dismissed and the person believes
    ///   they approved something they did not.
    private func registerNotificationCategories() {
        let review = UNNotificationAction(
            identifier: Self.digestReviewAction,
            title: "Review",
            options: [.foreground]
        )
        let snooze = UNNotificationAction(
            identifier: Self.digestSnoozeAction,
            title: "Later today",
            options: []
        )
        let digest = UNNotificationCategory(
            identifier: Self.digestCategory,
            actions: [review, snooze],
            intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "Daily summary",
            options: []
        )
        let referral = UNNotificationCategory(
            identifier: Self.referralCategory,
            actions: [],
            intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "Conversation referral",
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([digest, referral])
    }

    static let digestCategory = "SEGMENT_DIGEST"
    static let referralCategory = "REFERRAL"
    static let digestReviewAction = "SEGMENT_DIGEST_REVIEW"
    static let digestSnoozeAction = "SEGMENT_DIGEST_SNOOZE"

    /// Hours from now that a snoozed digest reappears.
    ///
    /// Local, not a server round trip. A background action has seconds of
    /// execution time and no guarantee of a network, so asking the server to
    /// re-send would fail silently on exactly the connection where somebody is
    /// most likely to snooze. A local notification cannot fail that way, and a
    /// summary of this morning is still true this evening.
    private static let snoozeHours: Double = 8

    /// Called after authentication. The system prompt is shown only once; on
    /// later launches this simply refreshes the APNs token and backend row.
    func enableAndSync() async {
        backendRegistrationEnabled = true
        do {
            // `.providesAppNotificationSettings` puts a button INSIDE iOS
            // Settings that links back into this app's own notification
            // screen. Most apps ship the app-to-Settings direction and miss
            // this one; it is free once the option is in the set, and it is
            // implemented by `openSettingsFor` at the bottom of this file.
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound, .providesAppNotificationSettings])
            await refreshAuthorizationStatus()
            guard granted || authorizationAllowsNotifications else { return }
            UIApplication.shared.registerForRemoteNotifications()
            await syncRegistrationIfPossible()
        } catch {
            lastError = error.localizedDescription
            Log.push("message notification permission failed")
        }
    }

    /// The app's own pane in iOS Settings.
    ///
    /// `openNotificationSettingsURLString` (iOS 16+) lands directly on the
    /// Notifications pane rather than on the app's root pane, which is one
    /// fewer tap at exactly the moment somebody is already annoyed. It falls
    /// back to the root pane if the constant is ever unavailable.
    func openSystemSettings() {
        let target = URL(string: UIApplication.openNotificationSettingsURLString)
            ?? URL(string: UIApplication.openSettingsURLString)
        guard let target else { return }
        UIApplication.shared.open(target)
    }

    /// Re-deliver a digest later today, locally.
    ///
    /// The body is copied from the notification being snoozed rather than
    /// refetched: the person has already been told what it says and a second
    /// server read could return something different, which would make "later
    /// today" quietly mean "a different message".
    func snoozeDigest(title: String, body: String, digestDay: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "segment-digest"
        content.categoryIdentifier = Self.digestCategory
        content.userInfo = ["screen": "segments", "digestDay": digestDay]
        if #available(iOS 15.0, *) {
            // Same level as the original. Snoozing does not make it urgent.
            content.interruptionLevel = .active
            content.relevanceScore = 0.9
        }
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: Self.snoozeHours * 60 * 60, repeats: false)
        let request = UNNotificationRequest(
            // Keyed on the day, so snoozing twice replaces rather than stacks.
            identifier: "segment-digest-snooze-\(digestDay)",
            content: content,
            trigger: trigger
        )
        UNUserNotificationCenter.current().add(request) { error in
            if error != nil { Log.push("digest snooze could not be scheduled") }
        }
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

    private func noteCampaignActivity() {
        campaignRefreshSequence &+= 1
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
        let userInfo = notification.request.content.userInfo
        let screen = userInfo["screen"] as? String
        let campaignID = (userInfo["campaignId"] as? String)
            ?? (userInfo["campaign_id"] as? String)
        let segmentID = (userInfo["segmentID"] as? String)
            ?? (userInfo["segmentId"] as? String)
            ?? (userInfo["segment_id"] as? String)
        let referralID = (userInfo["referralID"] as? String)
            ?? (userInfo["referralId"] as? String)
            ?? (userInfo["referral_id"] as? String)
        Task { @MainActor in
            switch AppNotificationRouteParser.foregroundKind(
                screen: screen,
                campaignID: campaignID,
                segmentID: segmentID,
                referralID: referralID
            ) {
            case .campaign:
                MessageNotificationManager.shared.noteCampaignActivity()
            case .message:
                MessageNotificationManager.shared.noteIncomingMessage()
            case .navigation:
                // A release, analytics or settings destination is not a message
                // and cannot be cleared by opening a conversation.
                break
            }
        }
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// iOS Settings asking the app to show its own notification screen.
    ///
    /// The other half of `.providesAppNotificationSettings`. Without this the
    /// option adds a button that does nothing. `notification` is nil when the
    /// person arrived from the Settings app rather than from a delivered
    /// notification, which is the case that matters here.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            openSettingsFor notification: UNNotification?) {
        Task { @MainActor in
            AppRouter.shared.queue(.notificationSettings)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo

        // "Later today" on a digest. Handled before the routing below because
        // it must NOT open the app, must not queue a screen, and must not be
        // treated as a tap on the notification itself.
        if response.actionIdentifier == MessageNotificationManager.digestSnoozeAction {
            let content = response.notification.request.content
            let day = (userInfo["digestDay"] as? String) ?? ""
            Task { @MainActor in
                MessageNotificationManager.shared.snoozeDigest(
                    title: content.title, body: content.body, digestDay: day)
                completionHandler()
            }
            return
        }
        let phone = userInfo["phone"] as? String
        // A top-level `screen` is a destination rather than a conversation, so
        // it is handled alongside `phone` rather than instead of it. The two are
        // independent: a payload may carry either, both, or neither.
        let screen = userInfo["screen"] as? String
        let campaignID = (userInfo["campaignId"] as? String)
            ?? (userInfo["campaign_id"] as? String)
        let segmentID = (userInfo["segmentID"] as? String)
            ?? (userInfo["segmentId"] as? String)
            ?? (userInfo["segment_id"] as? String)
        let referralID = (userInfo["referralID"] as? String)
            ?? (userInfo["referralId"] as? String)
            ?? (userInfo["referral_id"] as? String)

        guard let route = AppNotificationRouteParser.route(
            screen: screen,
            phone: phone,
            campaignID: campaignID,
            segmentID: segmentID,
            referralID: referralID
        ) else {
            completionHandler()
            return
        }

        Task { @MainActor in
            let manager = MessageNotificationManager.shared
            switch route {
            case .conversation:
                manager.noteIncomingMessage()
            case .campaign, .segment, .growth(.campaigns), .growth(.audiences):
                manager.noteCampaignActivity()
            default:
                break
            }
            AppRouter.shared.queue(route)
            completionHandler()
        }
    }
}
