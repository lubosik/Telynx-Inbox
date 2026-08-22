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
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        NavigationStack {
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
                case .campaigns:   CampaignsPlaceholderView()
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
        }
    }
}

/// Campaigns is not built. This screen says so.
///
/// It exists because the tab restructure landed before the feature did, and an
/// empty segment with no explanation reads as a bug. Everything below is
/// written in the future tense on purpose: there is no campaign code in this
/// release, on the client or the server, and nothing here should suggest
/// otherwise. `lib/audit/event-types.js` still has the six `campaign.*`
/// lifecycle types reserved and its writer throws on them.
struct CampaignsPlaceholderView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "megaphone")
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
                    .padding(.top, 36)

                VStack(spacing: 8) {
                    Text("Campaigns are not available yet")
                        .font(.headline)
                        .multilineTextAlignment(.center)
                    Text("Nothing here is running, scheduled, or sending. This is a placeholder for work that has not been built.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 8)

                VStack(alignment: .leading, spacing: 14) {
                    Text("PLANNED")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)

                    PlannedCampaign(
                        icon: "arrow.uturn.backward.circle",
                        title: "Automated win-backs",
                        detail: "Reach a customer who has not ordered in a while, once, without anyone having to remember."
                    )
                    PlannedCampaign(
                        icon: "arrow.clockwise.circle",
                        title: "Reorder reminders",
                        detail: "A nudge timed to when their last order would be running out."
                    )
                    PlannedCampaign(
                        icon: "shippingbox.circle",
                        title: "Back-in-stock alerts",
                        detail: "Tell the people who asked, as soon as the product is available again."
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(.secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                Text("Until then, the Automations segment beside this one is the live queue: order-triggered messages that really are scheduled and can be cancelled.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 28)
            }
            .padding(.horizontal, 16)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct PlannedCampaign: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
