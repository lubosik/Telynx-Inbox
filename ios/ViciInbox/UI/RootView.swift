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
    var body: some View {
        TabView {
            InboxView()
                .tabItem { Label("Inbox", systemImage: "message.fill") }

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }

            ActivityView()
                .tabItem { Label("Automations", systemImage: "bolt.fill") }

            CallsView()
                .tabItem { Label("Calls", systemImage: "phone.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
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
                    LabeledContent("VoIP token", value: TelnyxVoiceManager.shared.pushDiagnostics.hasToken ? "Received" : "Waiting")
                    LabeledContent("Push login", value: TelnyxVoiceManager.shared.pushDiagnostics.registeredLogin ? "Registered" : "Not confirmed")
                    LabeledContent("Push environment", value: TelnyxVoiceManager.shared.pushDiagnostics.environment)
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
                    Text("For incoming-call tests, leave the app normally with Home or the side gesture. Do not swipe it away from the app switcher; iOS can suppress relaunch after a force-quit.")
                }
            }
            .navigationTitle("Settings")
        }
        .navigationViewStyle(.stack)
    }
}
