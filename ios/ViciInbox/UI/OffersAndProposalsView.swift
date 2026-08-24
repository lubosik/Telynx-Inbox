import SwiftUI

/// Read-only review of unapproved campaign ideas.
///
/// This view deliberately has no proposal decision or campaign mutation. A
/// separate human workflow may eventually accept a proposal into an ordinary
/// campaign draft, but nothing on this screen can approve, schedule, or send.
struct OffersAndProposalsView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model = OffersAndProposalsModel()
    let assistantNavigationRoute: AppRoute?

    init(assistantNavigationRoute: AppRoute? = nil) {
        self.assistantNavigationRoute = assistantNavigationRoute
    }

    private var canReview: Bool { session.can(Permission.campaignsManage) }

    var body: some View {
        Group {
            if !canReview {
                EmptyState(
                    icon: "lock.shield",
                    title: "Offers are not available",
                    detail: "This account does not have permission to review unapproved campaign proposals."
                )
                .padding(24)
            } else if model.isLoading && model.items.isEmpty {
                ProgressView("Loading unapproved proposals")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = model.errorMessage, model.items.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 38, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("Proposals unavailable").font(.title3.weight(.semibold))
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try Again") { Task { await model.load(reset: true) } }
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.items.isEmpty {
                emptyState
            } else {
                proposalList
            }
        }
        .navigationTitle("Offers & Proposals")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: canReview) {
            if canReview {
                await model.load(reset: true)
                reportAssistantReadiness()
            } else {
                model.clear()
            }
        }
        .onChange(of: model.didLoadSuccessfully) { loaded in
            if loaded { reportAssistantReadiness() }
        }
    }

    private func reportAssistantReadiness() {
        guard model.didLoadSuccessfully, let assistantNavigationRoute else { return }
        AssistantNavigationCoordinator.shared
            .destinationDidBecomeVisible(assistantNavigationRoute)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "lightbulb.max")
                .font(.system(size: 38, weight: .semibold))
                .foregroundStyle(.secondary)
            Text("No proposals waiting")
                .font(.title3.weight(.semibold))
            Text(model.withheld > 0
                 ? "No reviewable proposals are available. The server withheld \(model.withheld) item\(model.withheld == 1 ? "" : "s") that did not pass its copy checks."
                 : "There are no unapproved offer ideas or no-offer controls waiting for review.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if model.canLoadMore {
                Button(model.isLoading ? "Loading..." : "Check Next Page") {
                    Task { await model.loadMore() }
                }
                .disabled(model.isLoading)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var proposalList: some View {
        List {
            Section {
                Label("Review only", systemImage: "hand.raised.fill")
                    .font(.headline)
                Text("Every item below is an unapproved idea. Nothing here has been approved, scheduled, or sent.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if !model.structuredOffers.isEmpty {
                Section("Structured offer proposals") {
                    ForEach(model.structuredOffers) { proposal in
                        CampaignProposalReviewRow(proposal: proposal)
                    }
                }
            }

            if !model.noOfferControls.isEmpty {
                Section {
                    ForEach(model.noOfferControls) { proposal in
                        CampaignProposalReviewRow(proposal: proposal)
                    }
                } header: {
                    Text("Intentional no-offer controls")
                } footer: {
                    Text("These controls deliberately offer nothing. They let a reviewer compare outreach itself with proposals that spend margin or change an assortment.")
                }
            }

            if model.withheld > 0 {
                Section("Withheld by server checks") {
                    Text("\(model.withheld) stored proposal\(model.withheld == 1 ? " was" : "s were") not shown because the server's compliance validator withheld them.")
                        .foregroundStyle(.secondary)
                }
            }

            if model.canLoadMore {
                Section {
                    Button {
                        Task { await model.loadMore() }
                    } label: {
                        HStack {
                            Text(model.isLoading ? "Loading..." : "Load More Proposals")
                            Spacer()
                            if model.isLoading { ProgressView() }
                        }
                    }
                    .disabled(model.isLoading)
                }
            } else if model.total > model.items.count {
                Section {
                    Text("Showing \(model.items.count) reviewable proposals from \(model.total) stored rows. Some rows were withheld by server checks.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .refreshable { await model.load(reset: true) }
        .overlay(alignment: .bottom) {
            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding()
            }
        }
    }
}

@MainActor
final class OffersAndProposalsModel: ObservableObject {
    @Published private(set) var items: [CampaignProposal] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var total = 0
    @Published private(set) var withheld = 0
    @Published private(set) var didLoadSuccessfully = false

    private var page = 0
    private let pageSize = 50
    private var lifecycle = 0

    var structuredOffers: [CampaignProposal] {
        items.filter { !$0.offer.isIntentionalNoOffer }
    }

    var noOfferControls: [CampaignProposal] {
        items.filter { $0.offer.isIntentionalNoOffer }
    }

    var canLoadMore: Bool {
        CampaignProposalPagingPolicy.hasPage(after: page, pageSize: pageSize, total: total)
    }

    func load(reset: Bool) async {
        guard !isLoading else { return }
        if reset {
            clear()
        }
        let requestLifecycle = lifecycle
        isLoading = true
        errorMessage = nil
        defer {
            if requestLifecycle == lifecycle { isLoading = false }
        }

        do {
            var nextPage = page + 1
            while true {
                let response = try await APIClient.shared.fetchProposedCampaignProposals(
                    page: nextPage, pageSize: pageSize
                )
                try Task.checkCancellation()
                guard requestLifecycle == lifecycle else { return }
                guard response.page == nextPage, response.pageSize == pageSize else {
                    throw APIError.decoding
                }
                var byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
                for proposal in response.items { byID[proposal.id] = proposal }
                guard byID.count <= response.total else { throw APIError.decoding }
                items = byID.values.sorted {
                    if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                    return $0.id < $1.id
                }
                page = response.page
                total = response.total
                withheld += response.withheld

                // `total` is counted before the server removes proposals that
                // fail its surfaceability guard. An empty page can therefore
                // sit before a later reviewable page. Walk through empty pages
                // automatically, bounded by the exact page count, so valid
                // proposals cannot be stranded behind withheld rows.
                guard let followingPage = CampaignProposalPagingPolicy.nextPage(
                    after: page,
                    pageSize: pageSize,
                    total: total,
                    visibleCount: response.items.count
                ) else { break }
                nextPage = followingPage
            }
            didLoadSuccessfully = true
        } catch APIError.decoding {
            guard requestLifecycle == lifecycle else { return }
            purgeLoadedContent()
            errorMessage = "Proposal data could not be verified. Nothing was shown."
        } catch {
            guard requestLifecycle == lifecycle, !Task.isCancelled else { return }
            purgeLoadedContent()
            errorMessage = (error as? APIError)?.errorDescription
                ?? "The proposal queue could not be loaded."
        }
    }

    func loadMore() async {
        guard canLoadMore else { return }
        await load(reset: false)
    }

    func clear() {
        lifecycle += 1
        purgeLoadedContent()
        didLoadSuccessfully = false
        errorMessage = nil
        isLoading = false
    }

    private func purgeLoadedContent() {
        items = []
        page = 0
        total = 0
        withheld = 0
        didLoadSuccessfully = false
    }
}

private struct CampaignProposalReviewRow: View {
    let proposal: CampaignProposal

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 14) {
                detail("Audience", proposal.audience.plainEnglish)
                LabeledContent("Cohort size", value: proposal.audience.cohortSize.formatted())

                if proposal.audience.requiresSegment {
                    Label("This audience must be saved and reviewed as a segment before it can become a campaign draft.",
                          systemImage: "person.3.sequence")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                if proposal.offer.isIntentionalNoOffer {
                    detail("Control", proposal.offer.note)
                } else {
                    detail("Offer note", proposal.offer.note)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Terms a human must supply")
                            .font(.subheadline.weight(.semibold))
                        ForEach(proposal.offer.termsRequiredFromHuman, id: \.self) { term in
                            Label(term, systemImage: "person.crop.circle.badge.checkmark")
                                .font(.footnote)
                        }
                    }
                }

                detail("Unapproved draft message", proposal.copy.text)

                if !proposal.costs.isEmpty {
                    reviewList("Costs", proposal.costs.map(\.statement), icon: "dollarsign.circle")
                }
                if !proposal.risks.isEmpty {
                    reviewList("Risks", proposal.risks.map {
                        "\($0.severity.capitalized): \($0.statement)"
                    }, icon: "exclamationmark.triangle")
                }

                Text("This screen is read-only. Reviewing this idea does not create, approve, schedule, or send a campaign.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 8)
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(proposal.mechanismLabel)
                    .font(.headline)
                Text(proposal.opportunityTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Label(proposal.offer.isIntentionalNoOffer ? "No-offer control" : "Structured offer",
                      systemImage: proposal.offer.isIntentionalNoOffer ? "circle.slash" : "tag")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(proposal.offer.isIntentionalNoOffer ? .secondary : .blue)
                Text("Unapproved")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.orange)
            }
        }
    }

    private func detail(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func reviewList(_ title: String, _ items: [String], icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            ForEach(items, id: \.self) { item in
                Label(item, systemImage: icon).font(.footnote)
            }
        }
    }
}
