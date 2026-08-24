import Foundation
import Combine

/// Queues a mailed deep link until a view exists to show it.
///
/// This app claims exactly two Universal Links, and they are the two that
/// `lib/apple-site-association.js` lists in `CLAIMED_COMPONENTS`:
///
///   * `https://<host>/accept-invite?token=<raw token>`  a team invitation
///   * `https://<host>/reset-password?token=<raw token>` a password reset
///
/// Both are token-bearing links mailed to somebody who cannot sign in: the
/// invitee has no account yet, and the person resetting has forgotten the only
/// credential they had. Both therefore render before the sign-in gate, and both
/// are parsed HERE, by one parser. A second parser is a second place for the
/// path normalisation and the token bounds to drift, and a claimed path the app
/// silently fails to recognise is worse than an unclaimed one: iOS caches the
/// association document, opens the app, and the app does nothing.
///
/// On a cold launch the continuation handler runs before `RootView` has
/// appeared, so a value written here can be missed by `onChange` alone. The fix
    /// is the one `AppRouter.pendingRoute` uses for notification navigation:
    /// park the value, and let the view drain it from both
/// `onAppear` and `onChange`.
///
/// The token is a bearer credential. It is never logged, never rendered, and
/// never written anywhere persistent.
@MainActor
final class InviteLinkRouter: ObservableObject {
    static let shared = InviteLinkRouter()

    /// Set when a claimed link has been opened and not yet shown.
    @Published private(set) var pendingLink: PendingLink?

    private init() {}

    /// Which screen a claimed link belongs to.
    enum Destination: Equatable {
        /// `/accept-invite`, handled by `AcceptInvitationView`.
        case invitation
        /// `/reset-password`, handled by `ResetPasswordView`.
        case passwordReset
    }

    /// A parsed link. `token` is empty when the link was recognised but its
    /// token is unusable, which the screen reports rather than presenting a
    /// form that cannot succeed.
    struct PendingLink: Equatable {
        let destination: Destination
        let token: String
        let problem: LinkProblem?
    }

    enum LinkProblem: Equatable {
        /// A claimed path with no `token` query item at all.
        case missing
        /// A token the server is guaranteed to reject on length or whitespace.
        case malformed
    }

    /// The claimed paths, lower-cased, and the screen each one opens.
    ///
    /// This list is the client-side twin of `CLAIMED_COMPONENTS` in
    /// `lib/apple-site-association.js`. Adding a path to that document without
    /// adding it here produces exactly the dead link the document's own header
    /// warns about, so the two must be changed together.
    static let claimedPaths: [String: Destination] = [
        "/accept-invite": .invitation,
        "/reset-password": .passwordReset
    ]

    /// Handles an `NSUserActivityTypeBrowsingWeb` continuation.
    ///
    /// - Returns: true when the URL was a claimed link and was consumed.
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
    /// - Returns: true only for a claimed path. Every other path falls through
    ///   untouched.
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let parsed = Self.parse(url) else { return false }
        pendingLink = parsed
        // Names the kind of link and nothing else. No token, no address, no URL.
        Log.app(parsed.destination == .invitation
                ? "invitation link received"
                : "password reset link received")
        return true
    }

    /// Called once a screen has taken ownership of the link, so a later
    /// `onAppear` does not reopen it.
    func consumePendingLink() {
        pendingLink = nil
    }

    /// Recognises the claimed paths and nothing else.
    ///
    /// Returns nil for every other path so the caller can fall through. Case
    /// and trailing slashes are normalised because Express routes that way and
    /// a link can be rewritten by whatever messaging app carried it.
    ///
    /// The 16 to 512 character bound and the whitespace rule mirror the guards
    /// in `routes/auth.js`, which answer `INVITATION_NOT_FOUND` and
    /// `RESET_NOT_FOUND` outside them. Checking here means a truncated link is
    /// explained immediately instead of after a password has been chosen, and
    /// in the reset case it also avoids spending an attempt on a token that
    /// cannot possibly match.
    static func parse(_ url: URL) -> PendingLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

        let scheme = components.scheme?.lowercased()
        guard scheme == nil || scheme == "https" || scheme == "http" else { return nil }

        var path = components.path.lowercased()
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        guard let destination = claimedPaths[path] else { return nil }

        let raw = components.queryItems?.first { $0.name.lowercased() == "token" }?.value
        let token = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if token.isEmpty {
            return PendingLink(destination: destination, token: "", problem: .missing)
        }
        if token.count < 16 || token.count > 512
            || token.rangeOfCharacter(from: .whitespacesAndNewlines) != nil {
            return PendingLink(destination: destination, token: "", problem: .malformed)
        }
        return PendingLink(destination: destination, token: token, problem: nil)
    }
}
