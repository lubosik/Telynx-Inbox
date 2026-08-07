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
    @StateObject private var inboxModel = InboxModel()
    // Owned here rather than inside the Calls tab so the badge is right before
    // the operator ever opens it.
    @StateObject private var callsModel = CallHistoryModel()
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $selection) {
            InboxView(model: inboxModel)
                .tabItem { Label("Inbox", systemImage: "message.fill") }
                .badge(inboxModel.unreadTotal)
                .tag(0)

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }
                .tag(1)

            ActivityView()
                .tabItem { Label("Automations", systemImage: "bolt.fill") }
                .tag(2)

            CallsView(model: callsModel)
                .tabItem { Label("Calls", systemImage: "phone.fill") }
                .badge(callsModel.unseenMissed)
                .tag(3)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(4)
        }
        .onChange(of: notifications.pendingConversationPhone) { phone in
            if phone != nil { selection = 0 }
        }
        // RootView replaces this whole view with the in-call screen while a call
        // is up, so this also runs each time a call finishes — which is exactly
        // when a new missed call would have appeared.
        .task { await callsModel.load() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await callsModel.load() } }
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
                    LabeledContent("Queued", value: "Waiting at Telnyx")
                    LabeledContent("Sent", value: "Carrier received it")
                    LabeledContent("Delivered", value: "Delivery confirmed")
                    LabeledContent("Failed", value: "Not delivered")
                } header: {
                    Text("Sent message status guide")
                } footer: {
                    Text("This guide explains the status shown beneath messages you send. Delivered confirms carrier/device delivery, not that the recipient read it. SMS and MMS do not provide read receipts.")
                }

                Section {
                    LabeledContent("Example", value: "6 min")
                } header: {
                    Text("Inbox conversation times")
                } footer: {
                    Text("The time at the right of each conversation shows how long ago the latest message in that thread was sent or received. It updates as time passes.")
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
