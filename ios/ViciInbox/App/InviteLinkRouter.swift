import Foundation
import Combine

/// Queues an invitation deep link until a view exists to show it.
///
/// A team invitation is `https://<host>/accept-invite?token=<raw token>`. The
/// new teammate taps it exactly once, on a freshly installed app, so the cold
/// launch is the normal case rather than the edge case. On a cold launch the
/// continuation handler runs before `RootView` has appeared, which means a
/// value written here can be missed by `onChange` alone. The fix is the one
/// `MessageNotificationManager.pendingConversationPhone` already uses in this
/// codebase: park the value, and let the view drain it from both `onAppear`
/// and `onChange`.
///
/// The token is a bearer credential for creating an account. It is never
/// logged, never rendered, and never written anywhere persistent.
@MainActor
final class InviteLinkRouter: ObservableObject {
    static let shared = InviteLinkRouter()

    /// Set when a `/accept-invite` link has been opened and not yet shown.
    @Published private(set) var pendingInvitation: PendingInvitation?

    private init() {}

    /// A parsed invitation link. `token` is empty when the link was recognised
    /// but its token is unusable, which the screen reports rather than
    /// presenting a form that cannot succeed.
    struct PendingInvitation: Equatable {
        let token: String
        let problem: LinkProblem?
    }

    enum LinkProblem: Equatable {
        /// `/accept-invite` with no `token` query item at all.
        case missing
        /// A token the server is guaranteed to reject on length or whitespace.
        case malformed
    }

    /// Handles a `NSUserActivityTypeBrowsingWeb` continuation.
    ///
    /// - Returns: true when the URL was an invitation link and was consumed.
    ///   Anything else returns false and is left to normal behaviour, so an
    ///   unrelated link is not swallowed.
    @discardableResult
    func handle(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = activity.webpageURL
        else { return false }
        return handle(url)
    }

    /// Handles a URL delivered directly rather than through a user activity.
    ///
    /// - Returns: true only for `/accept-invite`. Every other path falls
    ///   through untouched.
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let parsed = Self.parse(url) else { return false }
        pendingInvitation = parsed
        Log.app("invitation link received")
        return true
    }

    /// Called once the Accept Invitation screen has taken ownership of the
    /// link, so a later `onAppear` does not reopen it.
    func consumePendingInvitation() {
        pendingInvitation = nil
    }

    /// Recognises `/accept-invite` and nothing else.
    ///
    /// Returns nil for every other path so the caller can fall through. Case
    /// and trailing slashes are normalised because Express routes that way and
    /// a link can be rewritten by whatever messaging app carried it.
    ///
    /// The 16 to 512 character bound and the whitespace rule mirror the guard
    /// in `routes/auth.js`, which answers `INVITATION_NOT_FOUND` outside them.
    /// Checking here means a truncated link is explained immediately instead of
    /// after the invitee has chosen a password.
    static func parse(_ url: URL) -> PendingInvitation? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

        let scheme = components.scheme?.lowercased()
        guard scheme == nil || scheme == "https" || scheme == "http" else { return nil }

        var path = components.path.lowercased()
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        guard path == "/accept-invite" else { return nil }

        let raw = components.queryItems?.first { $0.name.lowercased() == "token" }?.value
        let token = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if token.isEmpty {
            return PendingInvitation(token: "", problem: .missing)
        }
        if token.count < 16 || token.count > 512
            || token.rangeOfCharacter(from: .whitespacesAndNewlines) != nil {
            return PendingInvitation(token: "", problem: .malformed)
        }
        return PendingInvitation(token: token, problem: nil)
    }
}
