import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var inviteLinks = InviteLinkRouter.shared
    @State private var showingReauthentication = false

    /// The invitation link this screen has taken ownership of. Drained out of
    /// `InviteLinkRouter` rather than read from it directly, so the router can
    /// be cleared immediately and a later `onAppear` cannot reopen a screen the
    /// invitee already finished with.
    @State private var pendingInvitation: InviteLinkRouter.PendingInvitation?

    /// Handed to `LoginView` after an invitation is accepted. The server echoes
    /// the invitee's address back on success, and prefilling it is the whole
    /// point of not signing them in automatically.
    @State private var signInPrefillEmail = ""

    /// An invitation must never sit in front of a ringing or connected call.
    /// Nothing else on this screen outranks the phone.
    private var isCallOnScreen: Bool {
        guard let call = session.activeCall else { return false }
        return call.phase != .idle
    }

    var body: some View {
        Group {
            // Before the sign-in gate, like LoginView, because the invitee has
            // no session and the account they would sign in with does not
            // exist yet. Everything below this line is unchanged.
            if let pendingInvitation, !isCallOnScreen {
                AcceptInvitationView(invitation: pendingInvitation) { email in
                    signInPrefillEmail = email
                    self.pendingInvitation = nil
                }
            } else if session.isCheckingSession {
                ProgressView().controlSize(.large)
            } else if !session.isSignedIn {
                // `id` forces a fresh LoginView when an invitation has just
                // supplied an address. Without it SwiftUI can reuse the view
                // that is already on screen, and the prefill is a `@State`
                // initial value that a reused view never re-reads.
                LoginView(prefilledEmail: signInPrefillEmail)
                    .id(signInPrefillEmail)
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
        // Both halves of the deep link, for the same reason MainTabView needs
        // both. A new teammate taps their invitation exactly once, on a freshly
        // installed app, so the cold launch is the normal case: the link is
        // delivered before this view exists and `onChange` never fires for it.
        .onAppear { applyPendingInvitation() }
        .onChange(of: inviteLinks.pendingInvitation) { _ in applyPendingInvitation() }
        // The prefill belongs to one invitation, not to the device. Dropping it
        // on sign-in stops a later sign-out from offering the invitee's address
        // to whoever picks the phone up next.
        .onChange(of: session.isSignedIn) { signedIn in
            if signedIn { signInPrefillEmail = "" }
        }
    }

    /// Takes ownership of a queued invitation link.
    ///
    /// The router is cleared as soon as the value is copied, so returning to
    /// this screen later does not reopen an invitation that was already
    /// accepted or dismissed. The token is not logged and not persisted.
    private func applyPendingInvitation() {
        guard let queued = inviteLinks.pendingInvitation else { return }
        pendingInvitation = queued
        inviteLinks.consumePendingInvitation()
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
    /// The Analytics tab is conditional on `analytics.read`. With the old
    /// `.tag(0)`…`.tag(4)` literals, hiding a tab silently renumbered the rest
    /// and `AnalyticsView(isSelected: selection == 4)` would end up bound to
    /// whichever tab happened to land on index 4. Because the tag is the case
    /// itself and not its position, a hidden tab cannot take another tab's
    /// identity — which is why `growth` is added here rather than as a literal.
    ///
    /// Five is the ceiling: iPhone shows five tabs and folds a sixth into a
    /// "More" list. Anything else belongs behind the account button.
    enum Tab: Int, Hashable {
        /// Was `automations`. The tab now holds Automations and Campaigns
        /// behind a segmented control, so the name follows the label.
        case inbox, contacts, growth, calls, analytics
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

            GrowthView()
                .tabItem { Label("Growth", systemImage: "bolt.fill") }
                .tag(Tab.growth)

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
        case "automations", "activity", "growth", "campaigns":
            // "automations" stays accepted: a push payload is composed by the
            // server and a device running the previous build is still out
            // there, so a new key is always a two-release change.
            selection = .growth
        case "calls":
            selection = .calls
        default:
            break
        }
        notifications.consumePendingScreen()
    }
}

/// Settings is now pushed from the account menu rather than presented as its
/// own sheet, so it no longer wraps itself in a NavigationView or carries a
/// Done button — the sheet around it owns both.
///
/// Two things that used to live here have moved up into that menu:
///
///   * Activity and Team. They were buried in the middle of this list, between
///     read-only diagnostics, and the owner's report was that nobody could
///     find them. They are one tap from every tab now, and duplicating them
///     here would only put them back in the haystack.
///   * Sign out. It has exactly one call site in the app, and moving it kept
///     it that way. `signOut()` disables Telnyx push and wipes the Keychain
///     the VoIP answer path reads, so the number of ways to reach it matters
///     more than the convenience of reaching it twice.
struct SettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared

    var body: some View {
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
            } footer: {
                Text("Reconnect re-establishes the calling socket. It does not sign you out and it does not touch this iPhone's stored credentials. Sign out is on the account menu.")
            }

            Section {
                LabeledContent("Version",
                               value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
            } footer: {
                Text("For incoming-call tests, leave the app normally with Home or the side gesture. Do not swipe it away from the app switcher; iOS can suppress relaunch after a force-quit.")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}
