import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var assistantSpeech: AssistantSpeechCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @ObservedObject private var inviteLinks = InviteLinkRouter.shared
    @ObservedObject private var assistantNavigation = AssistantNavigationCoordinator.shared
    @ObservedObject private var assistantDrafts = AssistantUnsavedDraftRegistry.shared
    @State private var showingReauthentication = false
    @State private var showingPremiumWelcome = false
    @State private var pendingDiscardCompletion: (confirmationID: UUID, requestID: UUID)?

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

    private var assistantNavigationAccess: AppNavigationAccess {
        AppNavigationAccess(
            analytics: session.can(Permission.analyticsRead),
            campaigns: session.can(Permission.campaignsRead),
            campaignsManage: session.can(Permission.campaignsManage),
            activity: session.can(Permission.auditRead),
            team: session.can(Permission.userManage),
            referrals: session.currentUser?.isSharedTeamLogin == false &&
                session.can(Permission.referralRead),
            assistant: AssistantAccess.isPermitted(for: session.currentUser)
        )
    }

    private var assistantNavigationIdentityKey: String {
        guard let user = session.currentUser else { return "signed-out" }
        return AssistantIdentitySnapshot(user: user).stableKey
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
        .alert("Unsaved changes", isPresented: Binding(
            get: { assistantNavigation.pendingConfirmation != nil },
            // Buttons below own cancellation/confirmation. Letting SwiftUI's
            // automatic alert dismissal mutate the coordinator would cancel a
            // valid discard request immediately after the destructive button.
            set: { _ in }
        )) {
            Button("Stay", role: .cancel) {
                assistantNavigation.cancelPendingConfirmation()
            }
            Button("Discard & Continue", role: .destructive) {
                beginAssistantDiscard()
            }
        } message: {
            Text(assistantNavigation.pendingConfirmation?.message
                 ?? "Review your unsaved changes before navigating.")
        }
        .task {
            configureAssistantNavigationIfNeeded()
            synchronizeAssistantNavigationSession()
        }
        .onChange(of: session.isAuthenticationLost) { lost in
            updateAssistantNavigationRuntime()
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
                synchronizeAssistantNavigationSession()
                presentNextExperienceIfReady()
            } else {
                showingPremiumWelcome = false
                assistantSpeech.stopAll()
                assistantNavigation.updateAuthenticatedSession(userID: nil, access: nil)
                router.resetForSignOut()
            }
        }
        .onChange(of: session.mustChangePassword) { required in
            synchronizeAssistantNavigationSession()
            if !required { presentNextExperienceIfReady() }
        }
        .onChange(of: session.welcomeRequest) { _ in presentNextExperienceIfReady() }
        .onChange(of: session.currentUser?.id) { _ in
            synchronizeAssistantNavigationSession()
            presentNextExperienceIfReady()
        }
        .onChange(of: assistantNavigationIdentityKey) { _ in
            synchronizeAssistantNavigationSession()
        }
        .onChange(of: scenePhase) { phase in
            updateAssistantNavigationRuntime()
            guard phase != .active else { return }
            assistantSpeech.stopAll()
            // Siri and device authentication transiently make the scene
            // inactive. Preserve only the opaque navigation epoch there.
            guard phase == .background else { return }
            pendingDiscardCompletion = nil
            assistantNavigation.reset(reason: .background)
        }
        .onChange(of: assistantNavigation.announcement?.id) { _ in
            speakAssistantNavigationAnnouncement()
        }
        .onChange(of: assistantDrafts.revision) { _ in
            completeAssistantDiscardIfReady()
        }
        // This observer belongs above MainTabView. A ringing call removes the
        // entire tab hierarchy, so a child observer may be destroyed before it
        // runs. Closing the account sheet here also destroys AssistantView,
        // whose onDisappear clears its in-memory draft and transcript.
        .onChange(of: session.activeCall) { call in
            updateAssistantNavigationRuntime()
            if let call, call.phase != .idle {
                pendingDiscardCompletion = nil
                assistantSpeech.noteCallActivity(true)
                assistantNavigation.reset(reason: .callStarted)
                router.dismissAccount()
            } else {
                assistantSpeech.noteCallActivity(false)
            }
        }
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

    private func configureAssistantNavigationIfNeeded() {
        assistantNavigation.configureIfNeeded(operations: AssistantNavigationOperations(
            revalidateAuthorization: {
                do {
                    async let capabilityRead = APIClient.shared.fetchAssistantStatus()
                    async let identityRead = APIClient.shared.fetchCurrentUserStrict()
                    let (capability, user) = try await (capabilityRead, identityRead)
                    guard capability.enabled,
                          capability.mode == AssistantCapabilityStatus.supportedMode,
                          capability.minimumOSMajor <= ProcessInfo.processInfo.operatingSystemVersion.majorVersion else {
                        return .capabilityDisabled
                    }
                    guard !user.requiresPasswordChange,
                          AssistantAccess.isPermitted(for: user) else {
                        return .identityOrPermissionChanged
                    }
                    let permissions = user.permissionSet
                    return .authorized(AssistantNavigationAuthorization(
                        userID: user.id,
                        identityFingerprint: AssistantIdentitySnapshot(user: user).stableKey,
                        access: AppNavigationAccess(
                            analytics: permissions.contains(Permission.analyticsRead),
                            campaigns: permissions.contains(Permission.campaignsRead),
                            campaignsManage: permissions.contains(Permission.campaignsManage),
                            activity: permissions.contains(Permission.auditRead),
                            team: permissions.contains(Permission.userManage),
                            referrals: permissions.contains(Permission.referralRead),
                            assistant: true
                        )
                    )
                    )
                } catch {
                    return .unverifiable
                }
            },
            verifySegment: { id in
                guard let response = try? await APIClient.shared.fetchSegment(id: id),
                      response.segment.id == id,
                      !response.segment.isArchived else { return nil }
                return AssistantVerifiedSegment(id: response.segment.id,
                                                name: response.segment.name)
            },
            preflightRoute: { route in
                switch route {
                case .segment(let id, _), .segmentPeople(let id, _):
                    guard let response = try? await APIClient.shared.fetchSegment(id: id) else {
                        return false
                    }
                    return response.segment.id == id && !response.segment.isArchived
                case .campaignProposals:
                    return (try? await APIClient.shared.fetchProposedCampaignProposals(
                        page: 1, pageSize: 1
                    )) != nil
                default:
                    return true
                }
            },
            segmentPeopleRoute: { segment in
                .segmentPeople(id: segment.id, name: segment.name)
            },
            offersRoute: { .campaignProposals }
        ))
    }

    private func synchronizeAssistantNavigationSession() {
        updateAssistantNavigationRuntime()
        guard session.isSignedIn,
              !session.mustChangePassword,
              let user = session.currentUser,
              !user.isSharedTeamLogin,
              AssistantAccess.isPermitted(for: user) else {
            assistantNavigation.updateAuthenticatedSession(userID: nil, access: nil)
            return
        }
        assistantNavigation.updateAuthenticatedSession(
            userID: user.id,
            identityFingerprint: AssistantIdentitySnapshot(user: user).stableKey,
            access: assistantNavigationAccess
        )
    }

    private func updateAssistantNavigationRuntime() {
        let state: AssistantNavigationRuntimeState
        switch scenePhase {
        case .active: state = .active
        case .inactive: state = .inactive
        case .background: state = .background
        @unknown default: state = .background
        }
        assistantNavigation.updateRuntimeState(
            state,
            callIsActive: isCallOnScreen || session.isAuthenticationLost ||
                session.mustChangePassword || !session.isSignedIn
        )
    }

    private func beginAssistantDiscard() {
        guard let confirmation = assistantNavigation.pendingConfirmation else { return }
        Task {
            switch await assistantNavigation.confirmDiscardByVisualAction(id: confirmation.id) {
            case .discardRequested(let request):
                pendingDiscardCompletion = (confirmation.id, request.id)
                completeAssistantDiscardIfReady()
            case let outcome:
                pendingDiscardCompletion = nil
                assistantNavigation.publishVisualActionOutcome(outcome)
            }
        }
    }

    private func completeAssistantDiscardIfReady() {
        guard let pendingDiscardCompletion,
              let request = assistantDrafts.discardRequest,
              request.id == pendingDiscardCompletion.requestID,
              assistantDrafts.isAcknowledged(request) else { return }
        self.pendingDiscardCompletion = nil
        Task {
            let outcome = await assistantNavigation.completeConfirmedDiscardByVisualAction(
                confirmationID: pendingDiscardCompletion.confirmationID,
                discardRequestID: pendingDiscardCompletion.requestID
            )
            assistantNavigation.publishVisualActionOutcome(outcome)
        }
    }

    private func speakAssistantNavigationAnnouncement() {
        guard let announcement = assistantNavigation.announcement,
              announcement.source != .appIntent,
              scenePhase == .active,
              !isCallOnScreen else { return }
        Task { @MainActor in
            // Let the destination finish its first layout before audio begins.
            await Task.yield()
            guard assistantNavigation.announcement?.id == announcement.id,
                  scenePhase == .active,
                  !isCallOnScreen else { return }
            _ = assistantSpeech.speak(announcement.message) {}
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
    @StateObject private var inboxModel = InboxModel()
    // Owned here rather than inside the Calls tab so the badge is right before
    // the operator ever opens it.
    @StateObject private var callsModel = CallHistoryModel()
    @StateObject private var campaignReviewCount = CampaignReviewCountModel()
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @EnvironmentObject private var router: AppRouter
    @Environment(\.scenePhase) private var scenePhase

    /// Hidden UI is not security. The server rejects the Analytics endpoints
    /// for this role regardless of what the tab bar shows.
    private var showsAnalytics: Bool { session.can(Permission.analyticsRead) }

    private var navigationAccess: AppNavigationAccess {
        AppNavigationAccess(
            analytics: session.can(Permission.analyticsRead),
            campaigns: session.can(Permission.campaignsRead),
            campaignsManage: session.can(Permission.campaignsManage),
            activity: session.can(Permission.auditRead),
            team: session.can(Permission.userManage),
            referrals: session.currentUser?.isSharedTeamLogin == false &&
                session.can(Permission.referralRead),
            assistant: AssistantAccess.isPermitted(for: session.currentUser)
        )
    }

    var body: some View {
        TabView(selection: $router.selectedTab) {
            InboxView(model: inboxModel)
                .tabItem { Label("Inbox", systemImage: "message.fill") }
                .badge(inboxModel.unreadTotal)
                .tag(AppTab.inbox)

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }
                .tag(AppTab.contacts)

            GrowthView()
                .tabItem { Label("Growth", systemImage: "bolt.fill") }
                .badge(campaignReviewCount.count)
                .tag(AppTab.growth)

            CallsView(model: callsModel)
                .tabItem { Label("Calls", systemImage: "phone.fill") }
                .badge(callsModel.unseenMissed)
                .tag(AppTab.calls)

            if showsAnalytics {
                AnalyticsView(isSelected: router.selectedTab == .analytics)
                    .tabItem { Label("Analytics", systemImage: "chart.bar.xaxis") }
                    .tag(AppTab.analytics)
            }
        }
        // A permission change can arrive mid-session (that is what a
        // SESSION_STALE re-login means). Leaving the selection on a tab that no
        // longer exists renders an empty screen.
        .onChange(of: showsAnalytics) { visible in
            router.sanitize(access: navigationAccess)
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
        .sheet(isPresented: $router.isAccountPresented,
               onDismiss: { router.dismissAccount() }) { AccountMenuSheet() }
        .onChange(of: onboarding.pendingHandoff) { handoff in
            guard handoff == .accountMenu else { return }
            onboarding.consumeHandoff()
            router.presentAccount()
        }
        // Replay is started from Settings, which is two pushes inside this very
        // sheet. `AccountToolbarModifier` closes its own presentation when a
        // tour starts; this one is separate and has to close itself, or the
        // replay runs underneath the sheet it was launched from.
        .onChange(of: onboarding.isPresented) { presented in
            if presented { router.dismissAccount() }
        }
        .onChange(of: onboarding.currentStep?.target) { target in
            applyOnboardingTarget(target)
        }
        .onAppear { applyOnboardingTarget(onboarding.currentStep?.target) }
        // A notification can cold-launch before this hierarchy exists. The app
        // router parks one typed destination and this view drains it both now and
        // on change. During a call RootView removes MainTabView, so the request
        // remains queued until the call screen is gone.
        .onAppear { applyPendingNavigation() }
        .onAppear { reportAssistantTabRootIfVisible() }
        .onChange(of: router.pendingRoute) { _ in
            applyPendingNavigation()
        }
        .onChange(of: router.currentMainRoute) { _ in
            reportAssistantTabRootIfVisible()
        }
        .onChange(of: session.currentUser) { _ in
            router.sanitize(access: navigationAccess)
            applyPendingNavigation()
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

    private func applyPendingNavigation() {
        router.processPending(access: navigationAccess)
    }

    private func reportAssistantTabRootIfVisible() {
        let route = router.currentMainRoute
        guard route.isTabRoot else { return }
        Task { @MainActor in
            await Task.yield()
            guard router.currentMainRoute == route else { return }
            AssistantNavigationCoordinator.shared.destinationDidBecomeVisible(route)
        }
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
        case .inbox: router.open(.inbox, access: navigationAccess)
        case .contacts: router.open(.contacts, access: navigationAccess)
        case .growth: router.open(.growth(.automations), access: navigationAccess)
        case .campaigns: router.open(.growth(.campaigns), access: navigationAccess)
        case .calls: router.open(.calls, access: navigationAccess)
        case .analytics, .revenueAttribution:
            router.open(.analytics, access: navigationAccess)
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
