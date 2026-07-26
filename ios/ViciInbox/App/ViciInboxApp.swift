import SwiftUI

@main
struct ViciInboxApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = SessionModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .task { await session.bootstrap() }
                .onChange(of: scenePhase) { phase in
                    if phase == .active { session.refreshConnection() }
                }
        }
    }
}
