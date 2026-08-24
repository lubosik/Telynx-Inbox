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
    /// An enum rather than an integer tag, for the same reason `AppTab`
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
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @EnvironmentObject private var router: AppRouter

    var body: some View {
        NavigationStack(path: $router.growthPath) {
            VStack(spacing: 0) {
                Picker("Growth section", selection: $router.growthSection) {
                    ForEach(GrowthSection.allCases) { value in
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

                switch router.growthSection {
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
                if router.growthSection == .automations && session.can(Permission.auditRead) {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink(value: AppRoute.activity(category: AuditCategory.automations.rawValue)) {
                            Image(systemName: "clock.arrow.circlepath")
                        }
                        .accessibilityLabel("Automation activity")
                    }
                }
            }
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .campaign(let id):
                    CampaignDetailView(campaignID: id)
                case .segment(let id, let name):
                    SegmentDetailView(
                        segmentID: id,
                        initialName: name ?? "Segment",
                        assistantNavigationRoute: .segment(id: id, name: name)
                    )
                case .segmentPeople(let id, let name):
                    SegmentDetailView(segmentID: id,
                                      initialName: name ?? "Segment",
                                      focusPeopleOnAppear: true,
                                      assistantNavigationRoute: .segmentPeople(id: id, name: name))
                case .campaignProposals:
                    OffersAndProposalsView(assistantNavigationRoute: .campaignProposals)
                case .automationHistory(let id):
                    EntityHistoryView(entityType: "scheduled_message",
                                      entityID: id,
                                      title: "Message history")
                case .activity(let category):
                    ActivityLogView(category: AuditCategory(rawValue: category) ?? .all)
                case .opportunities:
                    AssistantOpportunityEvidenceView()
                case .campaignAttributions(let campaignID):
                    CampaignAttributionListView(campaignID: campaignID)
                default:
                    EmptyView()
                }
            }
        }
        .onChange(of: onboarding.currentStep?.target) { target in
            if target == .campaigns { router.growthSection = .campaigns }
            if target == .growth { router.growthSection = .automations }
        }
    }
}

/// Read-only substantiation for Assistant opportunity citations. This screen
/// renders the same cached portfolio as the tool, including staleness,
/// actionability floors and refusals. It never refreshes the detector and has
/// no campaign creation or send path.
struct AssistantOpportunityEvidenceView: View {
    @State private var portfolio: AssistantOpportunityPortfolioWire?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading {
                Section { ProgressView("Loading verified opportunity review...") }
            } else if let errorMessage {
                Section {
                    Label("Opportunity review unavailable",
                          systemImage: "exclamationmark.triangle")
                        .font(.headline)
                    Text(errorMessage).foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            } else if let portfolio {
                Section("Verified summary") {
                    LabeledContent("Findings", value: "\(portfolio.findings.count)")
                    LabeledContent(
                        "At or above actionability floor",
                        value: "\(portfolio.findings.filter { !$0.actionability.belowFloor }.count)"
                    )
                    LabeledContent("Sizing refusals", value: "\(portfolio.refusals.count)")
                    LabeledContent("Computed", value: compactDate(portfolio.computedAt))
                    if portfolio.freshness.stale {
                        Label("This stored review is stale. Verify it before acting.",
                              systemImage: "clock.badge.exclamationmark")
                            .foregroundStyle(ViciTheme.warning)
                    }
                }

                if portfolio.findings.isEmpty {
                    Section {
                        Label("No verified findings", systemImage: "checkmark.seal")
                            .font(.headline)
                        Text("The current stored review contains no findings.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Findings") {
                        ForEach(Array(portfolio.findings.prefix(5).enumerated()), id: \.offset) { _, finding in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(label(finding.key)).font(.headline)
                                LabeledContent("Population", value: "\(finding.population)")
                                LabeledContent("Actionability floor", value: "\(finding.actionability.floor)")
                                Text(finding.actionability.belowFloor
                                     ? "Below the actionability floor"
                                     : "Meets the actionability floor")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(finding.actionability.belowFloor
                                                     ? Color.secondary : ViciTheme.tint)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                if !portfolio.refusals.isEmpty {
                    Section("Sizing refusals") {
                        ForEach(Array(portfolio.refusals.prefix(12).enumerated()), id: \.offset) { _, refusal in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(label(refusal.finding)).font(.subheadline.weight(.semibold))
                                Text(label(refusal.reason))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Opportunity Evidence")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @MainActor
    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            portfolio = try await APIClient.shared.fetchAssistantOpportunityPortfolio()
        } catch {
            portfolio = nil
            errorMessage = "The verified source could not be loaded."
        }
        isLoading = false
    }

    private func label(_ code: String) -> String {
        code.replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private func compactDate(_ value: String) -> String {
        guard let date = ServerDate.parse(value) else { return "Verified source time" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
