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
                // The opportunities screen has existed, fully built, with
                // nothing anywhere navigating to it. This is the way in.
                //
                // On the Campaigns section because that is where somebody is
                // standing when they wonder what to send next, and it is a
                // read-only view of measured evidence, so campaigns.read is
                // the right gate.
                if router.growthSection == .campaigns && session.can(Permission.campaignsRead) {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink(value: AppRoute.opportunities) {
                            Image(systemName: "lightbulb")
                        }
                        .accessibilityLabel("Where the money is")
                    }
                }
                if router.growthSection == .automations && session.can(Permission.auditRead) {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink(value: AppRoute.activity(category: AuditCategory.automations.rawValue)) {
                            Image(systemName: "clock.arrow.circlepath")
                        }
                        .accessibilityLabel("Automation activity")
                    }
                }
                // Beside the audiences, because it is the last thing that
                // decides who a campaign reaches. Somebody about to send should
                // be able to check it without leaving Growth.
                if router.growthSection == .audiences && session.can(Permission.campaignsRead) {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink(value: AppRoute.doNotContact) {
                            Image(systemName: "nosign")
                        }
                        .accessibilityLabel("Do not contact list")
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
                case .doNotContact:
                    DoNotContactView()
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
    @State private var portfolio: CampaignOpportunityPortfolio?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading {
                Section { ProgressView("Reading the orders") }
            } else if let errorMessage {
                Section {
                    Label("Not available", systemImage: "exclamationmark.triangle")
                        .font(.headline)
                    Text(errorMessage).foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            } else if let portfolio {
                if portfolio.findings.isEmpty {
                    Section {
                        Label("Nothing stands out", systemImage: "checkmark.seal")
                            .font(.headline)
                        Text("The orders were read and no group looked worth a campaign right now.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        Text("Each of these is a group of real customers found in your own orders. "
                             + "Every line under one is a number that was measured, not estimated.")
                            .font(.footnote).foregroundStyle(.secondary)
                        if portfolio.freshness?.stale == true {
                            Label("These figures are stale. Pull to refresh before acting on them.",
                                  systemImage: "clock.badge.exclamationmark")
                                .font(.footnote)
                                .foregroundStyle(ViciTheme.warning)
                        }
                    }

                    // One section per finding. The working is the point of this
                    // screen and does not read as a list item.
                    ForEach(portfolio.findings.prefix(6), id: \.key) { finding in
                        Section {
                            if let people = finding.population {
                                LabeledContent("People", value: "\(people)")
                            }
                            if let floor = finding.actionability?.floor,
                               let below = finding.actionability?.belowFloor {
                                Text(below
                                     ? "Below the size floor of \(floor), so it is not worth a campaign yet"
                                     : "Above the size floor of \(floor)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(below ? Color.secondary : ViciTheme.tint)
                            }

                            // ── THE JOURNEY ──────────────────────────────
                            //
                            // Built server-side in reasoning-trail.js from the
                            // detector's own measured figures. Nothing here is
                            // inferred on the phone, and the step that says
                            // what the numbers do NOT claim is included on
                            // purpose: a baseline with no caveat reads as a
                            // forecast.
                            if let reasoning = finding.reasoning, !reasoning.isEmpty {
                                ForEach(Array(reasoning.enumerated()), id: \.offset) { index, step in
                                    HStack(alignment: .top, spacing: 10) {
                                        Text("\(index + 1)")
                                            .font(.caption2.monospacedDigit().weight(.bold))
                                            .foregroundStyle(.secondary)
                                            .frame(width: 16, alignment: .trailing)
                                        Text(step)
                                            .font(.footnote)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    .padding(.vertical, 1)
                                }
                            }
                        } header: {
                            Text(finding.title ?? label(finding.key))
                        }
                    }
                }
            }
        }
        .navigationTitle("Where the money is")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @MainActor
    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            portfolio = try await APIClient.shared.fetchCampaignOpportunities()
            errorMessage = nil
        } catch {
            portfolio = nil
            errorMessage = error.localizedDescription
        }
    }

    /// A finding key as a heading, for the case where the server sends no
    /// title: `one_time_lapsed` becomes "One Time Lapsed".
    private func label(_ code: String) -> String {
        code.replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}
