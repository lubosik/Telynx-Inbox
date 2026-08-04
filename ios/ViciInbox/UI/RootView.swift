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
    @State private var selection = 0
    @ObservedObject private var notifications = MessageNotificationManager.shared

    var body: some View {
        TabView(selection: $selection) {
            InboxView()
                .tabItem { Label("Inbox", systemImage: "message.fill") }
                .tag(0)

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }
                .tag(1)

            ActivityView()
                .tabItem { Label("Automations", systemImage: "bolt.fill") }
                .tag(2)

            CallsView()
                .tabItem { Label("Calls", systemImage: "phone.fill") }
                .tag(3)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(4)
        }
        .onChange(of: notifications.pendingConversationPhone) { phone in
            if phone != nil { selection = 0 }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared
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
                    LabeledContent("Status", value: notifications.statusText)
                    LabeledContent("APNs environment", value: notifications.environment.capitalized)
                    if notifications.authorizationStatus == .denied {
                        Button("Open iPhone Settings") { notifications.openSystemSettings() }
                    } else if !notifications.isRegisteredWithBackend {
                        Button("Enable notifications") {
                            Task { await notifications.enableAndSync() }
                        }
                    }
                    if let error = notifications.lastError {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Message notifications")
                } footer: {
                    Text("Message alerts use standard Apple notifications. Incoming calls use the separate VoIP connection above.")
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
