import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @ObservedObject private var inviteLinks = InviteLinkRouter.shared
    @State private var showingReauthentication = false
    @State private var showingPremiumWelcome = false

    /// The mailed link this screen has taken ownership of. Drained out of
    /// `InviteLinkRouter` rather than read from it directly, so the router can
    /// be cleared immediately and a later `onAppear` cannot reopen a screen the
    /// person already finished with.
    ///
    /// Two kinds arrive here, an invitation and a password reset, and both are
    /// shown before the sign-in gate for the same reason: neither person can
    /// sign in yet.
    @State private var pendingLink: InviteLinkRouter.PendingLink?

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
            if let pendingLink, !isCallOnScreen {
                switch pendingLink.destination {
                case .invitation:
                    AcceptInvitationView(invitation: pendingLink) { email in
                        signInPrefillEmail = email
                        self.pendingLink = nil
                    }
                case .passwordReset:
                    // Also before the gate. Somebody resetting a password has
                    // forgotten the only credential they had, so asking them to
                    // sign in first would be a closed loop.
                    ResetPasswordView(link: pendingLink) { email in
                        signInPrefillEmail = email
                        self.pendingLink = nil
                    }
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
            } else if session.mustChangePassword {
                // Below the call branch on purpose: nothing outranks a ringing
                // phone. Above MainTabView because while the flag is set the
                // server answers 403 PASSWORD_CHANGE_REQUIRED to every endpoint
                // the tabs use, so showing them would be an app where nothing
                // loads and nothing says why.
                ChangePasswordView(mode: .forced)
            } else {
                ZStack {
                    MainTabView()
                    if showingPremiumWelcome, let request = session.welcomeRequest {
                        PremiumWelcomeView(firstName: request.firstName) {
                            finishPremiumWelcome()
                        }
                        .transition(.opacity)
                        .zIndex(200)
                        .task(id: request.id) {
                            guard !voiceOverEnabled else { return }
                            try? await Task.sleep(nanoseconds: 1_800_000_000)
                            guard !Task.isCancelled else { return }
                            finishPremiumWelcome()
                        }
                    }
                }
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
        .animation(.default, value: session.mustChangePassword)
        .animation(.easeInOut(duration: 0.2), value: session.isAuthenticationLost)
        .onChange(of: session.isAuthenticationLost) { lost in
            if !lost { showingReauthentication = false }
        }
        // Both halves of the deep link, for the same reason MainTabView needs
        // both. A new teammate taps their invitation exactly once, on a freshly
        // installed app, so the cold launch is the normal case: the link is
        // delivered before this view exists and `onChange` never fires for it.
        // A reset link opened from Mail behaves the same way.
        .onAppear { applyPendingLink() }
        .onChange(of: inviteLinks.pendingLink) { _ in applyPendingLink() }
        // The prefill belongs to one link, not to the device. Dropping it on
        // sign-in stops a later sign-out from offering that address to whoever
        // picks the phone up next.
        .onChange(of: session.isSignedIn) { signedIn in
            if signedIn {
                signInPrefillEmail = ""
                presentNextExperienceIfReady()
            } else {
                showingPremiumWelcome = false
            }
        }
        .onChange(of: session.mustChangePassword) { required in
            if !required { presentNextExperienceIfReady() }
        }
        .onChange(of: session.welcomeRequest) { _ in presentNextExperienceIfReady() }
        .onChange(of: session.currentUser?.id) { _ in presentNextExperienceIfReady() }
    }

    /// Takes ownership of a queued link, whichever of the two it is.
    ///
    /// The router is cleared as soon as the value is copied, so returning to
    /// this screen later does not reopen an invitation that was already
    /// accepted, or a reset that was already completed. The token is not logged
    /// and not persisted.
    private func applyPendingLink() {
        guard let queued = inviteLinks.pendingLink else { return }
        pendingLink = queued
        inviteLinks.consumePendingLink()
    }

    private func presentNextExperienceIfReady() {
        guard session.isSignedIn,
              !session.mustChangePassword,
              !isCallOnScreen else { return }
        if session.welcomeRequest != nil {
            showingPremiumWelcome = true
        } else if !showingPremiumWelcome {
            onboarding.considerAutomaticTour(for: session.currentUser)
        }
    }

    private func finishPremiumWelcome() {
        guard showingPremiumWelcome else { return }
        showingPremiumWelcome = false
        session.consumeWelcomeRequest()
        onboarding.considerAutomaticTour(for: session.currentUser)
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

    /// The account menu, opened by the tour's last step rather than by the
    /// toolbar button. `AccountToolbarModifier` owns its own presentation and
    /// closes it whenever the tour starts, so this is a separate one; only one
    /// of the two is ever up.
    @State private var showingAccountHandoff = false
    @StateObject private var inboxModel = InboxModel()
    // Owned here rather than inside the Calls tab so the badge is right before
    // the operator ever opens it.
    @StateObject private var callsModel = CallHistoryModel()
    @StateObject private var campaignReviewCount = CampaignReviewCountModel()
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
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
                .badge(campaignReviewCount.count)
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
        // `overlayPreferenceValue` rather than `overlay`, so the tour is handed
        // the frames that `.onboardingTarget(_:)` published during this layout
        // pass. It is the only way an in-content subject — the Campaigns
        // segment, the revenue breakdown — can be highlighted where it actually
        // is instead of where the screen width suggests it might be.
        .overlayPreferenceValue(OnboardingTargetFrameKey.self) { contentFrames in
            if onboarding.isPresented {
                OnboardingOverlay(contentFrames: contentFrames,
                                  visibleTabs: visibleOnboardingTabs)
            }
        }
        .sheet(isPresented: $showingAccountHandoff) { AccountMenuSheet() }
        .onChange(of: onboarding.pendingHandoff) { handoff in
            guard handoff == .accountMenu else { return }
            onboarding.consumeHandoff()
            showingAccountHandoff = true
        }
        // iOS Settings asking for the app's own notification screen, through
        // `.providesAppNotificationSettings`. Without a handler the option adds
        // a button to iOS Settings that does nothing at all.
        //
        // It opens the account menu, which puts Settings one tap away and
        // Notifications two. It deliberately does NOT push both levels
        // automatically: this sheet's NavigationStack has no path binding, and
        // adding one to drive a blind two-level push, in a layer that cannot be
        // type-checked on this machine, is more risk than the tap is worth.
        // Landing somewhere real and obvious beats landing somewhere clever and
        // occasionally empty.
        .onChange(of: notifications.wantsNotificationSettings) { wanted in
            guard wanted else { return }
            notifications.consumeNotificationSettingsRequest()
            showingAccountHandoff = true
        }
        // Replay is started from Settings, which is two pushes inside this very
        // sheet. `AccountToolbarModifier` closes its own presentation when a
        // tour starts; this one is separate and has to close itself, or the
        // replay runs underneath the sheet it was launched from.
        .onChange(of: onboarding.isPresented) { presented in
            if presented { showingAccountHandoff = false }
        }
        .onChange(of: onboarding.currentStep?.target) { target in
            applyOnboardingTarget(target)
        }
        .onAppear { applyOnboardingTarget(onboarding.currentStep?.target) }
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
        .task(id: session.can(Permission.campaignsApprove)) {
            await campaignReviewCount.load(enabled: session.can(Permission.campaignsApprove))
        }
        .onChange(of: notifications.campaignRefreshSequence) { _ in
            Task {
                await campaignReviewCount.load(enabled: session.can(Permission.campaignsApprove))
            }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                Task {
                    await callsModel.load()
                    await campaignReviewCount.load(
                        enabled: session.can(Permission.campaignsApprove)
                    )
                }
            }
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
        case "automations", "activity", "growth":
            // "automations" stays accepted: a push payload is composed by the
            // server and a device running the previous build is still out
            // there, so a new key is always a two-release change.
            selection = .growth
        case "campaigns":
            selection = .growth
            // GrowthView owns the segment and nested NavigationStack. Leave the
            // route queued until that view has selected Campaigns and, when the
            // payload carries an ID, opened the exact campaign.
            return
        case "calls":
            selection = .calls
        default:
            break
        }
        notifications.consumePendingScreen()
    }

    /// The tab bar's targets, left to right, in the same order the tabs are
    /// declared above. The tour maps measured tab buttons onto this, so it must
    /// stay in step with the `TabView` body — including the conditional
    /// Analytics tab, which is why it is derived from `showsAnalytics` rather
    /// than written out as a constant.
    private var visibleOnboardingTabs: [OnboardingTarget] {
        var tabs: [OnboardingTarget] = [.inbox, .contacts, .growth, .calls]
        if showsAnalytics { tabs.append(.analytics) }
        return tabs
    }

    private func applyOnboardingTarget(_ target: OnboardingTarget?) {
        guard let target else { return }
        switch target {
        case .inbox: selection = .inbox
        case .contacts: selection = .contacts
        case .growth, .campaigns: selection = .growth
        case .calls: selection = .calls
        case .analytics, .revenueAttribution:
            if showsAnalytics { selection = .analytics }
        case .account:
            // Deliberately no tab change. The account button is on the
            // navigation bar of every tab, so the step highlights it wherever
            // the previous step left the app; switching tabs underneath the
            // final card would only make the screen jump. The menu itself is
            // opened by the `.accountMenu` handoff when Finish is tapped.
            break
        }
    }
}
