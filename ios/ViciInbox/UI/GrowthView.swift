import SwiftUI

/// The Growth tab: the automation queue this app has always had, plus a place
/// for campaigns to land later.
///
/// It replaces the tab previously labelled "Automations". A separate Campaigns
/// tab was not an option — iPhone shows five tabs before iOS folds the rest
/// into a "More" list — so the two share one tab behind a segmented control.
///
/// Note the name collision documented in AGENTS.md: `/api/activity/*` is the
/// scheduled-SMS queue behind this tab, not the audit trail. The audit trail is
/// `/api/audit`, reached from the account menu and from the history button in
/// this tab's toolbar.
struct GrowthView: View {
    private enum Route: Hashable {
        case campaign(String)
    }

    /// An enum rather than an integer tag, for the same reason `MainTabView.Tab`
    /// is one: a raw index is a magic number that survives being wrong.
    ///
    /// Named `Segment`, not `Section`, because a nested type called `Section`
    /// would shadow SwiftUI's `Section` inside this type and turn the next
    /// person's ordinary list code into a baffling error.
    enum Segment: Int, Hashable, CaseIterable, Identifiable {
        case automations, campaigns

        var id: Int { rawValue }

        var label: String {
            switch self {
            case .automations: return "Automations"
            case .campaigns:   return "Campaigns"
            }
        }
    }

    @State private var segment: Segment = .automations
    @State private var path = NavigationPath()
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @ObservedObject private var notifications = MessageNotificationManager.shared

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                Picker("Growth section", selection: $segment) {
                    ForEach(Segment.allCases) { value in
                        Text(value.label).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)

                switch segment {
                case .automations: AutomationQueueView()
                case .campaigns:   CampaignsView()
                }
            }
            .navigationTitle("Growth")
            .navigationBarTitleDisplayMode(.inline)
            .accountToolbar()
            .toolbar {
                // The automation-scoped shortcut into the audit trail. Kept on
                // the Growth bar rather than inside the queue view so switching
                // segments cannot leave a stale toolbar item behind.
                if segment == .automations && session.can(Permission.auditRead) {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink {
                            ActivityLogView(category: .automations)
                        } label: {
                            Image(systemName: "clock.arrow.circlepath")
                        }
                        .accessibilityLabel("Automation activity")
                    }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .campaign(let id): CampaignDetailView(campaignID: id)
                }
            }
        }
        .onChange(of: onboarding.currentStep?.target) { target in
            if target == .campaigns { segment = .campaigns }
            if target == .growth { segment = .automations }
        }
        .onAppear { applyPendingCampaignRoute() }
        .onChange(of: notifications.pendingScreen) { _ in applyPendingCampaignRoute() }
        .onChange(of: notifications.pendingCampaignID) { _ in applyPendingCampaignRoute() }
    }

    private func applyPendingCampaignRoute() {
        let isCampaignScreen = notifications.pendingScreen?.lowercased() == "campaigns"
        guard isCampaignScreen || notifications.pendingCampaignID?.isEmpty == false else { return }
        segment = .campaigns
        if session.can(Permission.campaignsRead),
           let campaignID = notifications.pendingCampaignID,
           !campaignID.isEmpty {
            path = NavigationPath()
            path.append(Route.campaign(campaignID))
        }
        notifications.consumePendingCampaignRoute()
    }
}
