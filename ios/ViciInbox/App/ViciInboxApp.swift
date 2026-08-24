import SwiftUI

@main
struct ViciInboxApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = SessionModel()
    @StateObject private var appearance = AppearanceModel()
    @StateObject private var onboarding = OnboardingCoordinator()
    @StateObject private var router = AppRouter.shared
    @StateObject private var assistantSpeech = AssistantSpeechCoordinator()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(appearance)
                .environmentObject(onboarding)
                .environmentObject(router)
                .environmentObject(assistantSpeech)
                // `resolvedColorScheme`, not `preference.colorScheme`: the
                // Scheduled preference has no fixed answer and the model is the
                // only thing that knows what time it is.
                .preferredColorScheme(appearance.resolvedColorScheme)
                .task { await session.bootstrap() }
                // The account's IANA timezone, when the server sends one, so a
                // scheduled evening means the workspace's evening. Absent or
                // unrecognised falls back to this device's timezone inside
                // `AppearanceTimeZoneResolver`; nothing here can fail.
                .task(id: session.currentUser?.timeZone) {
                    appearance.applyAccountTimeZone(
                        session.currentUser?.timeZone,
                        isDefault: session.currentUser?.timeZoneIsDefault ?? false
                    )
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active { session.refreshConnection() }
                }
                // Universal links. Registered on the WindowGroup's content
                // rather than inside a screen because this exists from the
                // moment the scene connects, which is what makes the cold
                // launch work: a freshly installed app opening its very first
                // invitation link is the normal case here, not the edge case.
                //
                // The router only claims `/accept-invite` with a token.
                // Everything else falls through to normal behaviour rather
                // than being swallowed, which matters because iOS also routes
                // ordinary web links for this domain through here once the
                // associated-domains entitlement is live.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    _ = InviteLinkRouter.shared.handle(activity)
                }
                // A universal link can also arrive as a plain URL rather than
                // a browsing activity, for example when another app opens it
                // directly. Same router, same single-path filter.
                .onOpenURL { url in
                    _ = InviteLinkRouter.shared.handle(url)
                }
        }
    }
}
