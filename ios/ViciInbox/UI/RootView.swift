import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        Group {
            if session.isCheckingSession {
                ProgressView().controlSize(.large)
            } else if !session.isSignedIn {
                LoginView()
            } else if let call = session.activeCall, call.phase != .idle {
                InCallView(call: call)
                    .transition(.move(edge: .bottom))
            } else {
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: session.activeCall?.id)
        .animation(.default, value: session.isSignedIn)
    }
}

struct MainTabView: View {
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        TabView {
            DialerView()
                .tabItem { Label("Keypad", systemImage: "circle.grid.3x3.fill") }

            RecentsPlaceholderView()
                .tabItem { Label("Recents", systemImage: "clock.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
    }
}

/// Call history lives in the web inbox today. This tab is a deliberate stub for
/// phase 2 — the backend already exposes GET /api/voice/logs.
struct RecentsPlaceholderView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Call history")
                .font(.headline)
            Text("Incoming calls appear in the iPhone's own Recents.\nFull history is in the web inbox.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

struct SettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @State private var isSigningOut = false

    var body: some View {
        NavigationView {
            List {
                Section("Connection") {
                    LabeledContent("Status", value: session.voiceStatusText)
                    LabeledContent("Number", value: session.callerNumber.isEmpty
                                   ? "—" : PhoneFormatter.pretty(session.callerNumber))
                    LabeledContent("Server", value: AppConfig.serverURL.host ?? "—")
                }

                Section {
                    Button("Reconnect") { session.refreshConnection() }
                    Button("Sign out", role: .destructive) {
                        // Sign-out waits for the push-disable acknowledgement,
                        // so guard against a double tap.
                        isSigningOut = true
                        Task { @MainActor in
                            await session.signOut()
                            isSigningOut = false
                        }
                    }
                    .disabled(isSigningOut)
                }

                Section {
                    LabeledContent("Version",
                                   value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                } footer: {
                    Text("Incoming calls ring natively even when this app is closed.")
                }
            }
            .navigationTitle("Settings")
        }
        .navigationViewStyle(.stack)
    }
}
