import Foundation

/// Static configuration for the app. The server URL points at the same
/// Railway backend the web inbox uses — the iOS app is a second client
/// onto the existing system, not a separate stack.
enum AppConfig {

    /// Base URL of the Vici inbox backend (Railway).
    /// Override at runtime with the `VICI_SERVER_URL` env var when debugging.
    static let serverURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["VICI_SERVER_URL"],
           let url = URL(string: raw) {
            return url
        }
        // Verified against the live deployment's /health endpoint and the
        // APP_URL in the backend .env — the Railway app has a generated name,
        // not a project-named one.
        return URL(string: "https://web-production-2551e.up.railway.app")!
    }()

    /// Telnyx push environment must match how the binary was signed:
    /// debug builds get a sandbox APNs token, TestFlight/App Store get production.
    /// Getting this wrong is the single most common cause of "push never arrives".
    static var pushEnvironmentIsProduction: Bool {
        #if DEBUG
        return false
        #else
        return true
        #endif
    }

    /// Shown as the app name in the native iOS call UI (lock screen, Recents).
    static let callKitDisplayName = "Vici Inbox"
}
