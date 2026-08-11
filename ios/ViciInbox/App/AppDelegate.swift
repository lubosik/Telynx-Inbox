import UIKit
import PushKit
import CallKit
import UserNotifications

/// PushKit lives on the app delegate because VoIP pushes can arrive when the
/// app has been terminated — the delegate is the earliest guaranteed entry
/// point after iOS relaunches the process.
final class AppDelegate: NSObject, UIApplicationDelegate {

    private var pushRegistry: PKPushRegistry?

    /// The last VoIP token PushKit handed us, kept here as well as in the voice
    /// manager. PushKit delivers the token exactly once per launch, through the
    /// delegate callback below — it cannot be asked for it again. Signing out
    /// clears the voice manager's copy, so without this the app would sit on
    /// "Waiting for VoIP token…" until the process was relaunched, unable to
    /// receive calls.
    ///
    /// Written from the registry's main queue and read from the voice manager's
    /// async connect path, so access is locked rather than left to chance.
    private static let voIPTokenLock = NSLock()
    private static var storedVoIPPushToken: String?

    static var lastVoIPPushToken: String? {
        get { voIPTokenLock.lock(); defer { voIPTokenLock.unlock() }; return storedVoIPPushToken }
        set { voIPTokenLock.lock(); defer { voIPTokenLock.unlock() }; storedVoIPPushToken = newValue }
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Log.app("didFinishLaunching")

        // Touching the coordinator early ensures the CXProvider exists before
        // any push can arrive.
        _ = CallKitCoordinator.shared
        _ = TelnyxVoiceManager.shared

        MessageNotificationManager.shared.configure()

        registerForVoIPPushes()
        return true
    }

    // MARK: - PushKit

    private func registerForVoIPPushes() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.pushRegistry = registry
        Log.push("PushKit registered for VoIP")
    }

    // MARK: - Standard APNs (message alerts)

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MessageNotificationManager.shared.didReceiveDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MessageNotificationManager.shared.didFailToRegister(error)
    }
}

extension AppDelegate: PKPushRegistryDelegate {

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate credentials: PKPushCredentials,
                      for type: PKPushType) {
        guard type == .voIP else { return }
        // Match the Telnyx 4.1.2 reference implementation exactly. Hex is
        // semantically case-insensitive, but using the documented uppercase
        // form removes an avoidable variable from push-token troubleshooting.
        let token = credentials.token.reduce("") { $0 + String(format: "%02X", $1) }
        Log.push("received VoIP push token")
        AppDelegate.lastVoIPPushToken = token
        TelnyxVoiceManager.shared.updatePushToken(token)
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        Log.push("VoIP push token invalidated")
        // Only iOS itself reaches here, and it means the token is genuinely
        // dead — unlike sign-out, which must not discard it.
        AppDelegate.lastVoIPPushToken = nil
        TelnyxVoiceManager.shared.invalidatePushToken()
    }

    /// Every VoIP push MUST result in a reported call before this returns.
    /// Failing to do so gets the app terminated by the OS, and repeated
    /// failures make iOS stop delivering VoIP pushes to the app altogether.
    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }

        Log.push("incoming VoIP push")
        TelnyxVoiceManager.shared.handleVoIPPush(payload: payload)

        completion()
    }
}
