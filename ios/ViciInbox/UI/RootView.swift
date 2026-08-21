import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionModel
    @State private var showingReauthentication = false

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
                    // A 401 that could not be recovered shows this and nothing
                    // else. The app is not signed out, no credential is
                    // cleared, push stays registered, and the SIP socket is
                    // untouched, so an incoming call still rings and can still
                    // be answered while this banner is on screen.
                    .overlay(alignment: .top) {
                        if session.isAuthenticationLost {
                            AuthenticationLostBanner {
                                showingReauthentication = true
                            }
                            .padding(.horizontal, 12)
                            .transition(.move(edge: .top).combined(with: .opacity))
                        }
                    }
                    .sheet(isPresented: $showingReauthentication) { LoginView() }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: session.activeCall?.id)
        .animation(.default, value: session.isSignedIn)
        .animation(.easeInOut(duration: 0.2), value: session.isAuthenticationLost)
        .onChange(of: session.isAuthenticationLost) { lost in
            if !lost { showingReauthentication = false }
        }
    }
}

/// "Signed out — tap to sign in". Deliberately a banner rather than a forced
/// logout screen: the operator keeps the inbox they can already see, and the
/// device keeps every credential it needs to answer a call.
private struct AuthenticationLostBanner: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                VStack(alignment: .leading, spacing: 1) {
                    Text("Signed out").font(.footnote.weight(.semibold))
                    Text("Tap to sign in again").font(.caption2)
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(ViciTheme.destructive.opacity(0.35))
            )
            .foregroundColor(ViciTheme.destructive)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Signed out. Tap to sign in again.")
    }
}

struct MainTabView: View {

    /// Tabs are an enum rather than bare integers.
    ///
    /// The Analytics tab is now conditional on `analytics.read`. With the old
    /// `.tag(0)`…`.tag(4)` literals, hiding a tab silently renumbers the rest
    /// and `AnalyticsView(isSelected: selection == 4)` would end up bound to
    /// whichever tab happened to land on index 4.
    enum Tab: Int, Hashable {
        case inbox, contacts, automations, calls, analytics
    }

    @State private var selection: Tab = .inbox
    @StateObject private var inboxModel = InboxModel()
    // Owned here rather than inside the Calls tab so the badge is right before
    // the operator ever opens it.
    @StateObject private var callsModel = CallHistoryModel()
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @EnvironmentObject private var session: SessionModel
    @Environment(\.scenePhase) private var scenePhase

    /// Hidden UI is not security. The server rejects the Analytics endpoints
    /// for this role regardless of what the tab bar shows.
    private var showsAnalytics: Bool { session.can(Permission.analyticsRead) }

    var body: some View {
        TabView(selection: $selection) {
            InboxView(model: inboxModel)
                .tabItem { Label("Inbox", systemImage: "message.fill") }
                .badge(inboxModel.unreadTotal)
                .tag(Tab.inbox)

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }
                .tag(Tab.contacts)

            ActivityView()
                .tabItem { Label("Automations", systemImage: "bolt.fill") }
                .tag(Tab.automations)

            CallsView(model: callsModel)
                .tabItem { Label("Calls", systemImage: "phone.fill") }
                .badge(callsModel.unseenMissed)
                .tag(Tab.calls)

            if showsAnalytics {
                AnalyticsView(isSelected: selection == .analytics)
                    .tabItem { Label("Analytics", systemImage: "chart.bar.xaxis") }
                    .tag(Tab.analytics)
            }
        }
        // A permission change can arrive mid-session (that is what a
        // SESSION_STALE re-login means). Leaving the selection on a tab that no
        // longer exists renders an empty screen.
        .onChange(of: showsAnalytics) { visible in
            if !visible && selection == .analytics { selection = .inbox }
        }
        // Both halves of the deep link. `onAppear` is required as well as
        // `onChange`: on a cold launch from a notification tap, `didReceive`
        // runs before this view exists, so `onChange` never fires. Same pattern
        // InboxViews already uses for `pendingConversationPhone`.
        .onAppear { applyPendingNotificationRoute() }
        .onChange(of: notifications.pendingConversationPhone) { _ in
            applyPendingNotificationRoute()
        }
        .onChange(of: notifications.pendingScreen) { _ in
            applyPendingNotificationRoute()
        }
        // RootView replaces this whole view with the in-call screen while a call
        // is up, so this also runs each time a call finishes — which is exactly
        // when a new missed call would have appeared.
        .task { await callsModel.load() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await callsModel.load() } }
        }
    }

    /// Routes a tapped notification. The conversation itself is opened by
    /// InboxView; this only decides which tab is in front.
    private func applyPendingNotificationRoute() {
        if let phone = notifications.pendingConversationPhone, !phone.isEmpty {
            selection = .inbox
        }

        guard let screen = notifications.pendingScreen, !screen.isEmpty else { return }
        switch screen.lowercased() {
        case "analytics":
            // Silently ignored rather than redirected when the role cannot see
            // Analytics: landing somewhere unrelated is more confusing than
            // staying put.
            if showsAnalytics { selection = .analytics }
        case "inbox", "messages":
            selection = .inbox
        case "contacts":
            selection = .contacts
        case "automations", "activity":
            selection = .automations
        case "calls":
            selection = .calls
        default:
            break
        }
        notifications.consumePendingScreen()
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @State private var isSigningOut = false

    var body: some View {
        NavigationView {
            List {
                if let user = session.currentUser {
                    Section("Signed in") {
                        LabeledContent("Name", value: user.name)
                        if let email = user.email, !email.isEmpty {
                            LabeledContent("Email", value: email)
                        }
                        LabeledContent("Role", value: RoleCatalog.label(user.role))
                    }
                }

                // Not a sixth tab: the TabView already carries five, and a
                // sixth collapses into the "More" overflow on smaller iPhones.
                if session.can(Permission.auditRead) || session.can(Permission.userManage) {
                    Section {
                        if session.can(Permission.auditRead) {
                            NavigationLink {
                                ActivityLogView()
                            } label: {
                                Label("Activity", systemImage: "clock.arrow.circlepath")
                            }
                        }
                        if session.can(Permission.userManage) {
                            NavigationLink {
                                TeamView()
                            } label: {
                                Label("Team", systemImage: "person.2.badge.gearshape")
                            }
                        }
                    } header: {
                        Text("Team")
                    } footer: {
                        Text("Activity records who did what across messages, calls, automations, and settings. Team manages who has access and what their role allows.")
                    }
                }

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
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}
