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
        /// Segment id plus the name to show while it loads. A segment-change
        /// push carries the id and not the name.
        case segment(String, String)
    }

    /// An enum rather than an integer tag, for the same reason `MainTabView.Tab`
    /// is one: a raw index is a magic number that survives being wrong.
    ///
    /// Named `Segment`, not `Section`, because a nested type called `Section`
    /// would shadow SwiftUI's `Section` inside this type and turn the next
    /// person's ordinary list code into a baffling error. Note that this
    /// `Segment` is the segmented control and has nothing whatsoever to do with
    /// a customer segment; `SegmentRecord` is that. The collision is
    /// unfortunate and predates the feature.
    ///
    /// WHY AUDIENCES IS A THIRD TAB AND NOT SOMETHING TIDIER
    ///   A three-way segmented control is close to the point where the labels
    ///   start to crowd, and the honest alternative was to hang Audiences off
    ///   the Campaigns pane instead. That was rejected because it reproduces
    ///   the exact bug being fixed: Growth opens on Automations, the owner
    ///   opened Growth, and he could not find his segments. Anything that
    ///   requires switching to Campaigns first is still invisible from the
    ///   landing state.
    ///
    ///   These three are also genuinely peers of one workflow, in this order:
    ///   who you would talk to, what you would say, and what is already queued.
    ///   The label is "Audiences" rather than "Segments" both because it is
    ///   shorter, which is what buys the room, and because it is the word a
    ///   person uses. The screens themselves say segment, because that is what
    ///   the notifications and the rest of the product call them.
    enum Segment: Int, Hashable, CaseIterable, Identifiable {
        case automations, campaigns, audiences

        var id: Int { rawValue }

        var label: String {
            switch self {
            case .automations: return "Automations"
            case .campaigns:   return "Campaigns"
            case .audiences:   return "Audiences"
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
                // The tour's campaign step is about this control, so it points
                // at this control. If the frame never arrives the step falls
                // back to the Growth tab button rather than to a guess.
                .onboardingTarget(.campaigns)

                switch segment {
                case .automations: AutomationQueueView()
                case .campaigns:   CampaignsView()
                case .audiences:   SegmentsView()
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
                case .segment(let id, let name):
                    SegmentDetailView(segmentID: id, initialName: name)
                }
            }
        }
        .onChange(of: onboarding.currentStep?.target) { target in
            if target == .campaigns { segment = .campaigns }
            if target == .growth { segment = .automations }
        }
        .onAppear { applyPendingRoute() }
        .onChange(of: notifications.pendingScreen) { _ in applyPendingRoute() }
        .onChange(of: notifications.pendingCampaignID) { _ in applyPendingRoute() }
        .onChange(of: notifications.pendingSegmentID) { _ in applyPendingRoute() }
    }

    /// A tapped notification names a destination. Campaign pushes have carried
    /// one since the review queue landed; segment-change pushes carry
    /// `screen: "segments"` and a `segmentID`, prepared by
    /// `lib/campaigns/segment-notifications.js`.
    ///
    /// Both are handled here rather than in two places, because both consume
    /// the same `pendingScreen` slot. Before this, a segment push set
    /// `pendingScreen` to "segments", nothing recognised it, and it was never
    /// cleared.
    private func applyPendingRoute() {
        applyPendingCampaignRoute()
        applyPendingSegmentRoute()
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

    private func applyPendingSegmentRoute() {
        let isSegmentScreen = notifications.pendingScreen?.lowercased() == "segments"
        guard isSegmentScreen || notifications.pendingSegmentID?.isEmpty == false else { return }
        segment = .audiences
        // The push carries an id and a count, never a name, so the pushed
        // screen opens on a placeholder title and replaces it the moment the
        // segment loads. Better than refusing to deep link at all.
        if session.can(Permission.campaignsRead),
           let segmentID = notifications.pendingSegmentID,
           !segmentID.isEmpty {
            path = NavigationPath()
            path.append(Route.segment(segmentID, "Segment"))
        }
        notifications.consumePendingSegmentRoute()
    }
}
