import Foundation

/// Lightweight tab-badge state. It intentionally fetches only the review count,
/// rather than constructing the campaign list before the operator opens Growth.
/// A failed refresh preserves the last known value so a transient connection
/// problem does not make pending work appear to have disappeared.
@MainActor
final class CampaignReviewCountModel: ObservableObject {
    @Published private(set) var count = 0
    private var isLoading = false

    func load(enabled: Bool) async {
        guard enabled else {
            count = 0
            return
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            count = max(0, try await APIClient.shared.fetchCampaignReviewCount())
        } catch {
            // Cosmetic and best effort. CampaignsView still exposes a retryable
            // load error when the operator opens the real review queue.
        }
    }
}

@MainActor
final class CampaignListModel: ObservableObject {
    @Published private(set) var campaigns: [CampaignRecord] = []
    @Published private(set) var reviewCount = 0
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published var errorMessage: String?

    /// Campaign id -> archived timestamp, for the items currently loaded.
    /// Absent means not archived.
    @Published private(set) var archivedAt: [String: String] = [:]

    /// Whether archived campaigns are included in the list.
    ///
    /// Off by default: the point of archiving is that the working list stops
    /// showing the thing. Changing it reloads from page one, because paging
    /// state cannot survive a change to what the pages contain.
    @Published var showsArchived = false

    /// Set to the campaign currently being archived, restored or deleted, so
    /// its row can show progress and its actions cannot be fired twice.
    @Published private(set) var mutatingID: String?

    /// A short confirmation of what just happened, shown and then dismissed.
    /// Archiving is silent otherwise, and silence after a destructive-looking
    /// swipe reads as failure.
    @Published var statusMessage: String?

    private var nextPage = 1
    private var total = 0
    private let pageSize = 25

    var hasMore: Bool { campaigns.count < total }

    func isArchived(_ campaign: CampaignRecord) -> Bool {
        archivedAt[campaign.id] != nil
    }

    /// Deleting is offered only for a draft or a rejected draft — something
    /// that has never been approved and never reached a customer. Everything
    /// else is archived instead. The server is the actual gate; this only keeps
    /// the app from offering an action that is going to be refused.
    func canDelete(_ campaign: CampaignRecord) -> Bool {
        campaign.status.isEditable
    }

    func load(reset: Bool = false) async {
        if reset {
            nextPage = 1
            total = 0
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let page = APIClient.shared.fetchCampaigns(page: 1,
                                                             pageSize: pageSize,
                                                             includeArchived: showsArchived)
            async let count = APIClient.shared.fetchCampaignReviewCount()
            let result = try await (page, count)
            campaigns = result.0.page.items
            archivedAt = result.0.archivedAt
            total = result.0.page.total
            nextPage = 2
            reviewCount = result.1
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadMoreIfNeeded(after campaign: CampaignRecord) async {
        guard campaign.id == campaigns.last?.id, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let result = try await APIClient.shared.fetchCampaigns(page: nextPage,
                                                                   pageSize: pageSize,
                                                                   includeArchived: showsArchived)
            let known = Set(campaigns.map(\.id))
            campaigns.append(contentsOf: result.page.items.filter { !known.contains($0.id) })
            archivedAt.merge(result.archivedAt) { _, new in new }
            total = result.page.total
            nextPage += 1
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Archive, restore, delete

    /// Archiving removes nothing. The row leaves the working list when archived
    /// items are hidden, and is restorable from the same place.
    func archive(_ campaign: CampaignRecord) async {
        await mutate(campaign, confirmation: "\(campaign.title) archived.") {
            _ = try await APIClient.shared.archiveCampaign(id: campaign.id)
        }
    }

    func unarchive(_ campaign: CampaignRecord) async {
        await mutate(campaign, confirmation: "\(campaign.title) restored.") {
            _ = try await APIClient.shared.unarchiveCampaign(id: campaign.id)
        }
    }

    /// The destructive one. Only reached behind an explicit confirmation, and
    /// only offered for a draft, but the server decides.
    func delete(_ campaign: CampaignRecord) async {
        await mutate(campaign, confirmation: "\(campaign.title) deleted.") {
            try await APIClient.shared.deleteCampaign(id: campaign.id)
        }
    }

    /// Runs one campaign mutation and reloads.
    ///
    /// The list is reloaded from the server rather than edited in place. A
    /// local edit would have to guess whether an archived item still belongs on
    /// screen, what the new total is, and whether the review count moved; the
    /// server already knows all three.
    private func mutate(_ campaign: CampaignRecord,
                        confirmation: String,
                        action: () async throws -> Void) async {
        guard mutatingID == nil else { return }
        mutatingID = campaign.id
        defer { mutatingID = nil }
        do {
            try await action()
            errorMessage = nil
            statusMessage = confirmation
        } catch {
            statusMessage = nil
            errorMessage = error.localizedDescription
            return
        }
        await load(reset: true)
    }
}

struct CampaignMessageSaveOutcome {
    let saved: Bool
    let normalizedMessage: String?
    let errorMessage: String?
}

@MainActor
final class CampaignDetailModel: ObservableObject {
    @Published private(set) var detail: CampaignDetailResponse?
    @Published private(set) var recipients: [CampaignRecipient] = []
    @Published private(set) var recipientTotal = 0
    @Published private(set) var dryRun: CampaignDryRun?
    @Published private(set) var preview: CampaignPreview?
    @Published private(set) var isLoadingPreview = false
    @Published private(set) var previewErrorMessage: String?
    /// Recipients whose removal is in flight, so a second tap cannot fire the
    /// same call twice and a row can show it is working.
    @Published private(set) var removingRecipients: Set<String> = []
    @Published private(set) var isRemovingExcludedRecipients = false
    @Published private(set) var isSavingMessage = false
    @Published private(set) var performance: CampaignPerformance?
    @Published private(set) var financial: CampaignFinancialOverview?
    @Published private(set) var financialUnavailableMessage: String?
    @Published private(set) var isLoading = false
    /// The extra sections still arriving after the screen has already drawn.
    @Published private(set) var isEnriching = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var isActing = false
    @Published var errorMessage: String?
    @Published var confirmationMessage: String?

    let campaignID: String
    private var nextRecipientPage = 1
    private var allowsDryRun = false
    private var allowsFinancial = false
    private var previewRequestID = UUID()

    init(campaignID: String) {
        self.campaignID = campaignID
    }

    var campaign: CampaignRecord? { detail?.campaign }
    var hasMoreRecipients: Bool { recipients.count < recipientTotal }
    var canSubmitForReview: Bool {
        campaign?.status.isEditable == true
            && (dryRun?.eligible ?? 0) > 0
            && preview != nil
            && preview?.excludedCount == 0
            && !isLoadingPreview
            && !isActing
    }

    /**
     * Load the campaign.
     *
     * ── THE SCREEN RENDERS ON THE ESSENTIALS, NOT ON EVERYTHING ─────────────
     *
     * This used to await five things in sequence with the spinner up for all
     * of them: detail, recipients, performance, the dry run, the preview and
     * the financial overview. Measured against production, the preview alone
     * took twenty seconds, because it needs the product catalogue and
     * vicipeptides.com was returning 522 with Cloudflare holding each request
     * open for nineteen. So opening a campaign froze for the sum of every
     * request, and the owner reported the app as slow when most of the wait
     * was one third party being down.
     *
     * Now the spinner covers detail and recipients, which is everything the
     * screen needs to draw. The rest arrives afterwards and CONCURRENTLY, each
     * filling in its own section, so the slowest no longer sets the pace for
     * the others and none of them holds the first paint.
     */
    func load(canDryRun: Bool, canFinancial: Bool) async {
        guard !isLoading && !isEnriching else { return }
        allowsDryRun = canDryRun
        allowsFinancial = canFinancial
        isLoading = true

        do {
            async let detailRequest = APIClient.shared.fetchCampaign(id: campaignID)
            async let recipientRequest = APIClient.shared.fetchCampaignRecipients(id: campaignID)
            let values = try await (detailRequest, recipientRequest)
            detail = values.0
            recipients = values.1.items
            recipientTotal = values.1.total
            nextRecipientPage = 2
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
            return
        }
        isLoading = false

        // Support must remain operational-only and must not retain financial
        // data if effective permissions change mid-session. Cleared before the
        // enrichment rather than inside it, so a permission change takes effect
        // even if the fetch never runs.
        if !canFinancial {
            financial = nil
            financialUnavailableMessage = nil
        }

        await enrich(canDryRun: canDryRun, canFinancial: canFinancial)
    }

    /**
     * Everything the screen can render without: results, eligibility, the
     * rendered messages, the money.
     *
     * All four at once. They touch different endpoints and none depends on
     * another, so running them in sequence only ever added their latencies
     * together.
     */
    private func enrich(canDryRun: Bool, canFinancial: Bool) async {
        isEnriching = true
        defer { isEnriching = false }

        // ── FETCH CONCURRENTLY, ASSIGN AFTERWARDS ────────────────────────
        //
        // The child task an `async let` starts is NOT on the main actor, so
        // writing `self.performance = …` inside one is mutating main-actor
        // state from a nonisolated context and does not compile. The two pure
        // fetches are therefore `nonisolated static` helpers returning VALUES,
        // and every assignment happens below, after the await, back here.
        //
        // The dry run and the preview are the exception: they are methods on
        // this @MainActor class that already own their own state, so awaiting
        // them hops back on its own.
        async let performanceValue = Self.performanceOrNil(campaignID: campaignID)
        async let financialValue = Self.financialOutcome(campaignID: campaignID, wanted: canFinancial)
        async let dryRunDone: Void = dryRunIfWanted(canDryRun)
        async let previewDone: Void = refreshPreview()

        let (performanceResult, financialResult, _, _) =
            await (performanceValue, financialValue, dryRunDone, previewDone)

        performance = performanceResult

        switch financialResult {
        case .success(let overview):
            financial = overview
            financialUnavailableMessage = nil
        case .failure(let error):
            financial = nil
            financialUnavailableMessage = error.localizedDescription
        case .none:
            break // Already cleared in load(), before the permission-gated fetch.
        }
    }

    /**
     * Take one person out of the audience, then reload.
     *
     * The reload is the point. Removing somebody changes the eligible count,
     * the cost and whether the campaign can be approved at all, and a screen
     * still showing "1 cannot be personalised" after the person has gone would
     * teach somebody to distrust it.
     */
    func removeRecipient(_ recipientID: String) async {
        guard !removingRecipients.contains(recipientID) else { return }
        removingRecipients.insert(recipientID)
        defer { removingRecipients.remove(recipientID) }
        do {
            try await APIClient.shared.removeCampaignRecipient(
                campaignID: campaignID, recipientID: recipientID
            )
            await refreshAudienceState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeAllExcludedRecipients() async {
        guard !isRemovingExcludedRecipients else { return }
        isRemovingExcludedRecipients = true
        defer { isRemovingExcludedRecipients = false }
        do {
            try await APIClient.shared.removeAllExcludedCampaignRecipients(campaignID: campaignID)
            await refreshAudienceState()
            confirmationMessage = "Blocked recipients removed from the audience."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Save only the customer-facing message from the detail screen. Audience,
    /// title and offer metadata are preserved; preview and cost eligibility are
    /// then recomputed from the saved revision before the sheet dismisses.
    func saveMessage(_ draft: String) async -> CampaignMessageSaveOutcome {
        guard !isSavingMessage, let campaign else {
            return CampaignMessageSaveOutcome(saved: false, normalizedMessage: nil,
                                              errorMessage: "The campaign is still updating. Try again.")
        }
        let clean = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            return CampaignMessageSaveOutcome(saved: false, normalizedMessage: nil,
                                              errorMessage: "Enter the message customers should receive.")
        }
        guard clean.count <= 1_600 else {
            return CampaignMessageSaveOutcome(saved: false, normalizedMessage: nil,
                                              errorMessage: "Keep the message to 1,600 characters or fewer.")
        }

        isSavingMessage = true
        defer { isSavingMessage = false }
        do {
            let verdict = try await APIClient.shared.checkCampaignCopy(
                message: clean,
                couponCode: campaign.couponCode,
                workflowCategory: campaign.workflowCategory
            )
            let normalized = verdict.normalizedMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let normalized, !normalized.isEmpty, normalized != clean {
                return CampaignMessageSaveOutcome(
                    saved: false,
                    normalizedMessage: normalized,
                    errorMessage: "We tidied the punctuation. Check the updated message, then tap Save again."
                )
            }
            guard verdict.ok else {
                return CampaignMessageSaveOutcome(
                    saved: false,
                    normalizedMessage: nil,
                    errorMessage: verdict.failures.first?.reason ?? "Edit the message, then try again."
                )
            }

            let response = try await APIClient.shared.editCampaign(
                id: campaignID,
                title: campaign.title,
                message: normalized ?? clean,
                recipients: nil,
                couponCode: campaign.couponCode,
                discountPercent: campaign.effectiveDiscountPercent
            )
            detail = CampaignDetailResponse(campaign: response.campaign,
                                            latestApproval: detail?.latestApproval,
                                            scheduling: detail?.scheduling)
            preview = nil
            dryRun = nil
            async let previewDone: Void = refreshPreview()
            async let eligibilityDone: Void = dryRunIfWanted(allowsDryRun)
            _ = await (previewDone, eligibilityDone)
            confirmationMessage = "Message saved and preview updated."
            errorMessage = nil
            return CampaignMessageSaveOutcome(saved: true, normalizedMessage: nil, errorMessage: nil)
        } catch {
            return CampaignMessageSaveOutcome(saved: false, normalizedMessage: nil,
                                              errorMessage: error.localizedDescription)
        }
    }

    private func dryRunIfWanted(_ wanted: Bool) async {
        guard wanted else { return }
        await refreshDryRun()
    }

    /// Reload the three pieces changed by an audience edit without waiting for
    /// unrelated performance or financial requests that may still be running.
    /// A fast tap on Remove all can otherwise update the server while the
    /// screen keeps showing the old blocked count until it is reopened.
    private func refreshAudienceState() async {
        async let recipientsValue = APIClient.shared.fetchCampaignRecipients(id: campaignID)
        async let previewDone: Void = refreshPreview()
        async let eligibilityDone: Void = dryRunIfWanted(allowsDryRun)

        do {
            let page = try await recipientsValue
            recipients = page.items
            recipientTotal = page.total
            nextRecipientPage = 2
        } catch {
            errorMessage = error.localizedDescription
        }
        _ = await (previewDone, eligibilityDone)
    }

    /// Performance was added after campaign detail. Keep detail usable during
    /// an additive rollout where this endpoint may not have reached every
    /// environment yet — hence the swallow rather than a thrown error.
    nonisolated private static func performanceOrNil(campaignID: String) async -> CampaignPerformance? {
        try? await APIClient.shared.fetchCampaignPerformance(id: campaignID)
    }

    /// nil when the role cannot see money at all, which is different from a
    /// fetch that failed, and the screen says something different for each.
    nonisolated private static func financialOutcome(
        campaignID: String, wanted: Bool
    ) async -> Result<CampaignFinancialOverview, Error>? {
        guard wanted else { return nil }
        do { return .success(try await APIClient.shared.fetchCampaignFinancialOverview(id: campaignID)) }
        catch { return .failure(error) }
    }

    func loadMoreRecipientsIfNeeded(after recipient: CampaignRecipient) async {
        guard recipient.id == recipients.last?.id, hasMoreRecipients, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await APIClient.shared.fetchCampaignRecipients(
                id: campaignID,
                page: nextRecipientPage
            )
            let known = Set(recipients.map(\.id))
            recipients.append(contentsOf: page.items.filter { !known.contains($0.id) })
            recipientTotal = page.total
            nextRecipientPage += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func allRecipientsForEditing() async -> [CampaignRecipient]? {
        do {
            var result: [CampaignRecipient] = []
            var pageNumber = 1
            while true {
                let page = try await APIClient.shared.fetchCampaignRecipients(
                    id: campaignID,
                    page: pageNumber,
                    pageSize: 100
                )
                result.append(contentsOf: page.items)
                if result.count >= page.total || page.items.isEmpty { return result }
                guard pageNumber < 100 else {
                    errorMessage = "This audience is too large to edit safely on this device."
                    return nil
                }
                pageNumber += 1
            }
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// The finished messages, as customers would read them.
    ///
    /// Deliberately not fatal. Preview arrived after campaign detail, so on an
    /// environment where the endpoint has not rolled out yet the campaign must
    /// still be readable rather than showing an error over a working screen.
    /// A nil preview renders as "not available", never as "renders for
    /// everybody", because the second would be a reassuring lie.
    func refreshPreview() async {
        // A copy edit may finish while the previous revision's preview is
        // still in flight. Give every request an identity so the older result
        // cannot arrive last and put stale wording back on screen.
        let requestID = UUID()
        previewRequestID = requestID
        isLoadingPreview = true
        previewErrorMessage = nil
        defer {
            if previewRequestID == requestID { isLoadingPreview = false }
        }
        do {
            // The limit applies independently to successful and excluded
            // examples, so one returns exactly the useful pair while the
            // server still computes the complete counts for both groups.
            let result = try await APIClient.shared.previewCampaign(id: campaignID, limit: 1)
            guard previewRequestID == requestID else { return }
            preview = result
        } catch {
            guard previewRequestID == requestID else { return }
            preview = nil
            previewErrorMessage = error.localizedDescription
        }
    }

    func refreshDryRun() async {
        do {
            dryRun = try await APIClient.shared.dryRunCampaign(id: campaignID)
        } catch {
            // A dry-run error is useful, but the campaign itself must remain
            // readable for Support and Admin users.
            errorMessage = error.localizedDescription
        }
    }

    func submitForReview() async {
        await perform(success: "Submitted for review") {
            try await APIClient.shared.submitCampaignForReview(id: campaignID)
        }
    }

    func approve() async {
        await perform(success: "Campaign approved") {
            try await APIClient.shared.approveCampaign(id: campaignID)
        }
    }

    func reject(reason: String) async {
        await perform(success: "Campaign returned for changes") {
            try await APIClient.shared.rejectCampaign(id: campaignID, reason: reason)
        }
    }

    func schedule(for date: Date) async {
        await perform(success: "Campaign scheduled") {
            try await APIClient.shared.scheduleCampaign(id: campaignID, scheduledFor: date)
        }
    }

    func reschedule(for date: Date) async {
        await perform(success: "Campaign rescheduled") {
            try await APIClient.shared.rescheduleCampaign(id: campaignID, scheduledFor: date)
        }
    }

    func cancel(reason: String?) async {
        await perform(success: "Campaign cancelled") {
            try await APIClient.shared.cancelCampaign(id: campaignID, reason: reason)
        }
    }

    private func perform(success: String,
                         action: () async throws -> CampaignActionResponse) async {
        guard !isActing else { return }
        isActing = true
        defer { isActing = false }
        do {
            let response = try await action()
            if let current = detail {
                detail = CampaignDetailResponse(campaign: response.campaign,
                                                latestApproval: current.latestApproval,
                                                scheduling: current.scheduling)
            }
            confirmationMessage = success
            errorMessage = nil
            await load(canDryRun: allowsDryRun, canFinancial: allowsFinancial)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
final class CampaignAttributionListModel: ObservableObject {
    @Published private(set) var items: [AttributionRecord] = []
    @Published private(set) var currency = "USD"
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = false
    @Published var scope: AttributionScope = .attributed
    @Published var errorMessage: String?

    let campaignID: String
    private var page = 0

    init(campaignID: String) {
        self.campaignID = campaignID
    }

    func load(reset: Bool = false) async {
        if reset {
            items = []
            page = 0
            hasMore = false
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.fetchCampaignAttributions(
                id: campaignID,
                page: 1,
                scope: scope
            )
            items = response.items
            currency = response.currency
            page = response.pagination.page
            hasMore = response.pagination.hasMore
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadMoreIfNeeded(after item: AttributionRecord) async {
        guard item.id == items.last?.id, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let response = try await APIClient.shared.fetchCampaignAttributions(
                id: campaignID,
                page: page + 1,
                scope: scope
            )
            let known = Set(items.map(\.id))
            items.append(contentsOf: response.items.filter { !known.contains($0.id) })
            currency = response.currency
            page = response.pagination.page
            hasMore = response.pagination.hasMore
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
final class CampaignEditorModel: ObservableObject {
    @Published var step: CampaignWizardStep = .type
    @Published var title: String
    @Published var message: String {
        // A rendered preview describes copy that no longer exists the moment
        // the copy changes. Showing yesterday's message beside today's draft
        // is the one thing a preview must never do.
        didSet { if message != oldValue { livePreview = nil } }
    }
    @Published var recipientsText: String
    @Published var audienceMode: CampaignAudienceMode
    @Published var contactSearch = ""
    @Published private(set) var contactResults: [ConversationSummary] = []
    @Published private(set) var allContactsSnapshot: [ConversationSummary] = []
    @Published private(set) var allContactsTotal = 0
    @Published private(set) var selectedContacts: [String: ConversationSummary] = [:]
    @Published private(set) var allContactsAvailable = false
    @Published private(set) var hasLoadedContactSnapshot = false
    @Published private(set) var contactResultsTruncated = false
    @Published private(set) var isLoadingContacts = false
    @Published private(set) var contactErrorMessage: String?
    @Published private(set) var isSaving = false
    @Published private(set) var isCheckingEligibility = false
    @Published private(set) var isSubmitting = false
    @Published private(set) var savedCampaign: CampaignRecord?
    @Published private(set) var dryRun: CampaignDryRun?
    @Published private(set) var eligibilityErrorMessage: String?

    // ── Writing the message ────────────────────────────────────────────────
    /// What the owner wants the message to do, in their own words. Keyboard
    /// dictation fills this by voice; nothing bespoke is needed for that.
    @Published var brief = ""
    @Published private(set) var suggestions: [CampaignCopyCandidate] = []
    /// Which candidate the owner picked.
    ///
    /// The tap handler used to be one line, `model.message = candidate.text`,
    /// and the message box is far enough down the form to be off screen. So
    /// the copy changed and the screen did not, which reads as a dead button.
    /// The owner reported exactly that.
    @Published private(set) var chosenSuggestion: String?
    /// How many times this draft has been refined. Shown so a run of
    /// refinements reads as progress rather than as the same button again.
    @Published private(set) var refinementCount = 0
    @Published private(set) var mergeFields: [CampaignMergeField] = []
    @Published private(set) var aiCopyEnabled = false
    @Published private(set) var isDrafting = false
    @Published private(set) var isPreviewing = false
    @Published private(set) var livePreview: CampaignPreview?
    @Published private(set) var copyError: String?
    @Published private(set) var attachedCoupon: CampaignCoupon? = nil
    @Published var errorMessage: String?

    let existingID: String?
    let existingCouponCode: String?
    let existingDiscountPercent: Int?
    let workflowCategory: String
    private var contactRequestID = UUID()
    private let existingRecipientMetadata: [String: CampaignRecipientInput]
    private let initialTitle: String
    private let initialMessage: String
    private let initialRecipientsText: String
    private let initialAudienceMode: CampaignAudienceMode
    private let initialSelectedContacts: [String: ConversationSummary]

    init(campaign: CampaignRecord? = nil,
         recipients: [CampaignRecipient] = [],
         initialContacts: [ConversationSummary] = [],
         seedTitle: String = "",
         seedMessage: String = "Vin from Vici: ",
         seedBrief: String = "",
         seedWorkflowCategory: String = "manual") {
        var metadata: [String: CampaignRecipientInput] = [:]
        for recipient in recipients where recipient.selected {
            let key = Self.phoneKey(recipient.contactPhone)
            guard key.count >= 10, metadata[key] == nil else { continue }
            metadata[key] = CampaignRecipientInput(
                name: recipient.contactName,
                phone: recipient.contactPhone,
                contactID: recipient.contactID?.rawValue,
                source: recipient.inclusionSource
            )
        }
        // Resolved into locals BEFORE anything is assigned to self.
        //
        // `title`, `message`, `recipientsText` and `audienceMode` are
        // @Published, so reading one back is a property access through `self`.
        // Swift forbids that until every stored property is initialised, and
        // `initialTitle = title` was exactly that read. It parses cleanly and
        // fails to compile, which is why it survived the local parse check and
        // only surfaced on the Xcode gate.
        //
        // Assigning both the published property and its baseline from the same
        // local also removes the possibility of the two drifting apart, which
        // is what `hasUnsavedDraftChanges` compares.
        let resolvedTitle = campaign?.title ?? seedTitle
        let resolvedMessage = campaign?.proposedMessage ?? seedMessage
        let resolvedAudienceMode: CampaignAudienceMode = campaign == nil
            ? .selectedContacts
            : (campaign?.isAllContactsAudience == true ? .allContacts : .manualNumbers)
        let resolvedRecipientsText = (campaign?.isAllContactsAudience == true ? [] : recipients)
            .filter(\.selected)
            // Phone-only editing cannot be corrupted by a saved contact name
            // containing a comma. Matching metadata is restored below.
            .map(\.contactPhone)
            .joined(separator: "\n")
        let resolvedSelectedContacts: [String: ConversationSummary] = campaign == nil
            ? initialContacts.reduce(into: [:]) { contacts, contact in
                contacts[contact.phone] = contact
            }
            : [:]

        existingID = campaign?.id
        existingCouponCode = campaign?.couponCode
        existingDiscountPercent = campaign?.effectiveDiscountPercent
        workflowCategory = campaign?.workflowCategory ?? seedWorkflowCategory
        title = resolvedTitle
        message = resolvedMessage
        audienceMode = resolvedAudienceMode
        allContactsTotal = campaign?.isAllContactsAudience == true
            ? (campaign?.requestedRecipientCount ?? 0) : 0
        allContactsAvailable = campaign?.isAllContactsAudience == true
        existingRecipientMetadata = metadata
        recipientsText = resolvedRecipientsText
        initialTitle = resolvedTitle
        initialMessage = resolvedMessage
        initialRecipientsText = resolvedRecipientsText
        initialAudienceMode = resolvedAudienceMode
        selectedContacts = resolvedSelectedContacts
        initialSelectedContacts = resolvedSelectedContacts
        brief = campaign == nil ? seedBrief : ""
    }

    var hasUnsavedDraftChanges: Bool {
        guard savedCampaign == nil else { return false }
        return title != initialTitle || message != initialMessage ||
            recipientsText != initialRecipientsText || audienceMode != initialAudienceMode ||
            !selectedContacts.isEmpty || attachedCoupon != nil
    }

    /// Load what the editor needs to write copy: the variables the renderer
    /// will actually accept, and whether drafting is switched on server-side.
    ///
    /// Never fatal. The editor's job is editing; if this fails the writer
    /// simply gets no chips and no AI button rather than an error over a
    /// working screen.
    func loadCopyTools() async {
        guard mergeFields.isEmpty else { return }
        guard let catalogue = try? await APIClient.shared.fetchCampaignRecipeCatalogue() else { return }
        mergeFields = catalogue.mergeFields ?? []
        aiCopyEnabled = catalogue.aiCopyEnabled ?? false
    }

    /// Append a variable to the message.
    ///
    /// At the END, not at the cursor: SwiftUI's TextEditor exposes no
    /// selection range, so inserting "at the cursor" would mean guessing, and
    /// a guess that lands mid-word produces copy that reads as broken. The end
    /// is always visible and always movable.
    func insertVariable(_ field: CampaignMergeField) {
        let needsSpace = !message.isEmpty && !message.hasSuffix(" ") && !message.hasSuffix("\n")
        message += (needsSpace ? " " : "") + field.token
        // The preview describes copy that no longer exists the moment the copy
        // changes, and a stale rendered message is worse than none.
        livePreview = nil
    }

    func attachCoupon(_ coupon: CampaignCoupon) {
        attachedCoupon = coupon
        let condition = coupon.minimumAmount > 0
            ? " on orders of \(Int(coupon.minimumAmount)) dollars or more" : ""
        let offer = "Take \(coupon.percent)% off\(condition) with {{code}}."
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "Vin from Vici:" || trimmed.isEmpty {
            message = "Vin from Vici: \(offer) Reply STOP to opt out."
        } else if !trimmed.contains("{{code}}") {
            let suffix = "Reply STOP to opt out."
            if trimmed.hasSuffix(suffix) {
                message = String(trimmed.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
                    + " \(offer) \(suffix)"
            } else {
                message = trimmed + " \(offer)"
            }
        }
        livePreview = nil
    }

    /**
     * Ask the model for candidate copy.
     *
     * `refining` sends the message currently in the box along with the
     * instruction, which turns "write me three messages" into "change THIS
     * one, like so". Without it every request started from nothing, so an
     * instruction like "make it warmer" had no referent and the drafts came
     * back as unrelated generic messages — half of why the owner reported
     * that it ignored him.
     */
    func draftWithAI(refining: Bool = false) async {
        let text = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let current = message.trimmingCharacters(in: .whitespacesAndNewlines)
        await requestCopySuggestions(
            instruction: text,
            currentMessage: (refining && !current.isEmpty) ? current : nil,
            refining: refining
        )
    }

    /// One tap for somebody who has already written the message itself.
    ///
    /// This is deliberately different from `draftWithAI`: Dominic should not
    /// have to explain the same campaign twice merely to get safe copy. The
    /// current message is the brief. The server keeps its meaning, applies his
    /// learned writing traits, verifies an attached coupon in WooCommerce and
    /// returns only candidates that passed the deterministic copy checks.
    func suggestValidCopy() async {
        let current = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSuggestValidCopy else { return }
        await requestCopySuggestions(instruction: nil, currentMessage: current, refining: true)
    }

    private func requestCopySuggestions(
        instruction: String?, currentMessage: String?, refining: Bool
    ) async {
        isDrafting = true
        copyError = nil
        defer { isDrafting = false }
        do {
            let result = try await APIClient.shared.suggestCampaignCopy(
                brief: instruction,
                currentMessage: currentMessage,
                couponCode: attachedCoupon?.code,
                approvedLink: Self.approvedLink(in: currentMessage),
                workflowType: workflowCategory
            )
            let safeCandidates = result.candidates.filter { candidate in
                guard let coupon = attachedCoupon else { return true }
                guard candidate.text.contains("{{code}}"),
                      candidate.text.contains("\(coupon.percent)%") else { return false }
                return coupon.minimumAmount <= 0 || candidate.text.contains(String(Int(coupon.minimumAmount)))
            }
            suggestions = safeCandidates
            chosenSuggestion = nil
            refinementCount = refining ? refinementCount + 1 : 0
            if safeCandidates.isEmpty {
                // The text of a rejected draft is deliberately never returned,
                // so it cannot be shown. What CAN be shown is which rules they
                // broke, and that is the difference between "it ignored me"
                // and "it tried, and the compliance rules ate the results".
                copyError = attachedCoupon == nil
                    ? Self.rejectionMessage(result.rejected)
                    : "No version kept every coupon term. The current message is unchanged. Try Change the message above, or edit it directly."
            }
        } catch {
            copyError = error.localizedDescription
        }
    }

    /// Say WHY there is nothing to show.
    private static func rejectionMessage(_ rejected: [CampaignCopyRejection]?) -> String {
        let reasons = (rejected ?? []).flatMap { $0.reasons ?? [] }
        guard !reasons.isEmpty else {
            return "Every version broke a copy rule, so none can be shown. Try describing it differently."
        }
        // Distinct, and capped: five identical reasons is one fact.
        var seen: [String] = []
        for reason in reasons where !seen.contains(reason) { seen.append(reason) }
        let listed = seen.prefix(3).joined(separator: " ")
        return "Every version broke a copy rule, so none can be shown. \(listed) "
            + "Try asking for it differently."
    }

    /// Use a candidate, and say so.
    func chooseSuggestion(_ candidate: CampaignCopyCandidate) {
        message = candidate.text
        chosenSuggestion = candidate.text
        // The preview describes copy that no longer exists.
        livePreview = nil
    }

    /// Render the copy currently in the box against the real audience.
    ///
    /// Sends the unsaved text, so wording can be checked without bumping the
    /// revision and dropping an approval that already exists.
    func previewCurrentCopy(campaignID: String) async {
        isPreviewing = true
        copyError = nil
        defer { isPreviewing = false }
        do {
            livePreview = try await APIClient.shared.previewCampaign(
                id: campaignID, limit: 3, message: message
            )
        } catch {
            livePreview = nil
            copyError = error.localizedDescription
        }
    }

    func discardLocalDraft() {
        contactRequestID = UUID()
        title = initialTitle
        message = initialMessage
        recipientsText = initialRecipientsText
        audienceMode = initialAudienceMode
        selectedContacts = initialSelectedContacts
        attachedCoupon = nil
        contactSearch = ""
        step = .type
    }

    var titleCount: Int { title.count }
    var messageCount: Int { message.count }
    var canSuggestValidCopy: Bool {
        let current = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return aiCopyEnabled && !isDrafting && !current.isEmpty
            && current.caseInsensitiveCompare("Vin from Vici:") != .orderedSame
    }
    var progress: Double { Double(step.number) / Double(CampaignWizardStep.allCases.count) }
    var canGoBack: Bool { step.rawValue > 0 && savedCampaign == nil }
    var isFinalStep: Bool { step == .saveAndReview }
    var audienceInputs: [CampaignRecipientInput] {
        switch audienceMode {
        case .selectedContacts:
            return Self.inputs(from: Array(selectedContacts.values), source: "manual_contact_selection")
        case .allContacts:
            // Resolved and frozen by the server when the draft is created.
            // Sending thousands of phone numbers from a device is both stale
            // and the source of the old arbitrary 500-contact ceiling.
            return []
        case .manualNumbers:
            return Self.parseRecipients(recipientsText).map { input in
                guard let existing = existingRecipientMetadata[Self.phoneKey(input.phone)] else {
                    return input
                }
                return CampaignRecipientInput(
                    name: input.name ?? existing.name,
                    phone: input.phone,
                    contactID: existing.contactID,
                    source: existing.source
                )
            }
        }
    }
    var audienceCount: Int {
        audienceMode == .allContacts ? allContactsTotal : audienceInputs.count
    }
    var selectedContactList: [ConversationSummary] {
        selectedContacts.values.sorted {
            let order = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
            return order == .orderedSame ? $0.phone < $1.phone : order == .orderedAscending
        }
    }

    var audienceDescription: String {
        switch audienceMode {
        case .selectedContacts:
            return "\(audienceCount.formatted()) explicitly selected contact\(audienceCount == 1 ? "" : "s")"
        case .allContacts:
            return "\(audienceCount.formatted()) contacts will be frozen by the server when the draft is created"
        case .manualNumbers:
            return "\(audienceCount.formatted()) manually entered recipient\(audienceCount == 1 ? "" : "s")"
        }
    }

    var canSubmitSavedDraft: Bool {
        savedCampaign?.status.isEditable == true && (dryRun?.eligible ?? 0) > 0 && !isSubmitting
    }

    private static func approvedLink(in message: String?) -> String? {
        guard let message else { return nil }
        let punctuation = CharacterSet(charactersIn: ".,!?;:")
        return message.components(separatedBy: .whitespacesAndNewlines)
            .map { $0.trimmingCharacters(in: punctuation) }
            .compactMap { value -> String? in
                let bareHost = value.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                if bareHost == "vicipeptides.com" || bareHost == "www.vicipeptides.com" {
                    return "https://vicipeptides.com"
                }
                guard let url = URL(string: value), url.scheme?.lowercased() == "https" else {
                    return nil
                }
                let host = url.host?.lowercased()
                return host == "vicipeptides.com" || host == "www.vicipeptides.com"
                    ? value : nil
            }
            .first
    }

    func advance() {
        guard savedCampaign == nil else { return }
        // TextEditor uses Return for a perfectly ordinary visual paragraph,
        // while carrier-safe campaign copy is intentionally one line. The old
        // flow waited until Save, then showed the implementation detail
        // `"\\n" (U+000A)` as an error. Tidy it BEFORE the preview so the
        // reviewer sees the exact text that will be saved and sent.
        if step == .message { message = Self.singleLineCampaignCopy(message) }
        if let validation = validationMessage(for: step) {
            errorMessage = validation
            return
        }
        guard let next = CampaignWizardStep(rawValue: step.rawValue + 1) else { return }
        errorMessage = nil
        step = next
    }

    func back() {
        guard canGoBack,
              let previous = CampaignWizardStep(rawValue: step.rawValue - 1) else { return }
        errorMessage = nil
        step = previous
    }

    func chooseAudienceMode(_ mode: CampaignAudienceMode) {
        if existingID != nil && (initialAudienceMode == .allContacts || mode == .allContacts)
            && mode != initialAudienceMode {
            errorMessage = "To change an existing campaign to or from All Contacts, create a new draft. This keeps the saved audience intact."
            return
        }
        audienceMode = mode
        errorMessage = nil
    }

    func isSelected(_ contact: ConversationSummary) -> Bool {
        selectedContacts[contact.phone] != nil
    }

    func toggle(_ contact: ConversationSummary) {
        if selectedContacts.removeValue(forKey: contact.phone) == nil {
            selectedContacts[contact.phone] = contact
        }
    }

    func removeSelectedContact(phone: String) {
        selectedContacts.removeValue(forKey: phone)
    }

    /// Contact selection stays paged and bounded on the device. The total is
    /// metadata only; choosing `All Contacts` sends a server-owned selector,
    /// never the partial page held here.
    func loadContacts(search: String? = nil) async {
        let query = (search ?? contactSearch).trimmingCharacters(in: .whitespacesAndNewlines)
        if existingID != nil && initialAudienceMode == .allContacts && query.isEmpty { return }
        let requestID = UUID()
        contactRequestID = requestID
        isLoadingContacts = true
        defer {
            if contactRequestID == requestID { isLoadingContacts = false }
        }
        do {
            let pageSize = 200
            let page = try await APIClient.shared.fetchContacts(search: query,
                                                                page: 1,
                                                                pageSize: pageSize)
            guard contactRequestID == requestID else { return }
            if query.isEmpty {
                hasLoadedContactSnapshot = true
                allContactsTotal = page.total ?? page.contacts.count
                allContactsAvailable = allContactsTotal > 0
                allContactsSnapshot = page.contacts
                contactResults = allContactsSnapshot
                contactResultsTruncated = page.hasMore
            } else {
                contactResults = page.contacts
                contactResultsTruncated = page.hasMore
            }
            contactErrorMessage = nil
        } catch {
            guard contactRequestID == requestID else { return }
            contactErrorMessage = "Contacts could not be loaded. Try again."
        }
    }

    func saveAndCheckEligibility() async -> Bool {
        guard !isSaving else { return false }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var cleanMessage = Self.singleLineCampaignCopy(message)
        message = cleanMessage
        guard !cleanTitle.isEmpty else { errorMessage = "Enter a campaign title."; return false }
        guard cleanTitle.count <= 160 else { errorMessage = "Keep the title to 160 characters or fewer."; return false }
        guard !cleanMessage.isEmpty else { errorMessage = "Enter a message."; return false }
        guard cleanMessage.count <= 1_600 else { errorMessage = "Keep the message to 1,600 characters or fewer."; return false }

        do {
            let verdict = try await APIClient.shared.checkCampaignCopy(
                message: cleanMessage,
                couponCode: attachedCoupon?.code ?? existingCouponCode,
                workflowCategory: workflowCategory
            )
            if let normalized = verdict.normalizedMessage,
               !normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // The server is authoritative about the exact text that will
                // be saved. If it changed anything the phone did not already
                // tidy, let the operator see and approve that wording first.
                if normalized != cleanMessage {
                    message = normalized
                    step = .message
                    errorMessage = "We tidied the punctuation in the Message. Check the updated wording, then continue to Save Draft again."
                    return false
                }
                cleanMessage = normalized
                message = normalized
            }
            if !verdict.ok {
                step = .message
                errorMessage = "In the Message step: " + (verdict.failures.first?.reason
                    ?? "Edit the message, then try Save Draft again.")
                return false
            }
        } catch {
            errorMessage = error.localizedDescription
            return false
        }

        let recipients = audienceInputs
        guard audienceCount > 0 else { errorMessage = "Add at least one recipient."; return false }

        isSaving = true
        do {
            let response: CampaignActionResponse
            if let existingID {
                response = try await APIClient.shared.editCampaign(
                    id: existingID,
                    title: cleanTitle,
                    message: cleanMessage,
                    // A campaign detail fetch only loads page one. Editing
                    // copy must never replace the frozen audience with that
                    // partial page. Omit recipients unless the operator
                    // explicitly changed them in this editor.
                    recipients: audienceMode == .allContacts ||
                        (audienceMode == initialAudienceMode &&
                         recipientsText == initialRecipientsText &&
                         selectedContacts.isEmpty) ? nil : recipients,
                    couponCode: attachedCoupon?.code,
                    discountPercent: attachedCoupon?.percent
                )
            } else {
                response = try await APIClient.shared.createCampaign(
                    title: cleanTitle,
                    message: cleanMessage,
                    recipients: recipients,
                    allContacts: audienceMode == .allContacts,
                    workflowCategory: workflowCategory,
                    couponCode: attachedCoupon?.code,
                    discountPercent: attachedCoupon?.percent
                )
            }
            isSaving = false
            savedCampaign = response.campaign
            errorMessage = nil
            await checkEligibility()
            return true
        } catch {
            isSaving = false
            errorMessage = error.localizedDescription
            return false
        }
    }

    func checkEligibility() async {
        guard let campaignID = savedCampaign?.id, !isCheckingEligibility else { return }
        isCheckingEligibility = true
        defer { isCheckingEligibility = false }
        do {
            dryRun = try await APIClient.shared.dryRunCampaign(id: campaignID)
            eligibilityErrorMessage = nil
        } catch {
            dryRun = nil
            eligibilityErrorMessage = error.localizedDescription
        }
    }

    func submitSavedDraftForReview() async -> Bool {
        guard let campaign = savedCampaign, canSubmitSavedDraft else { return false }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let response = try await APIClient.shared.submitCampaignForReview(id: campaign.id)
            savedCampaign = response.campaign
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func validationMessage(for candidate: CampaignWizardStep) -> String? {
        switch candidate {
        case .type:
            let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if cleanTitle.isEmpty { return "Enter a campaign title." }
            if cleanTitle.count > 160 { return "Keep the title to 160 characters or fewer." }
        case .audience, .audienceReview:
            if audienceMode == .allContacts && !allContactsAvailable {
                return "All Contacts is unavailable until the contact total can be loaded."
            }
            if audienceCount == 0 { return "Add at least one recipient." }
        case .message:
            let cleanMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
            if cleanMessage.isEmpty { return "Enter a message." }
            if cleanMessage.count > 1_600 { return "Keep the message to 1,600 characters or fewer." }
        case .preview, .saveAndReview:
            break
        }
        return nil
    }

    static func parseRecipients(_ text: String) -> [CampaignRecipientInput] {
        var seen = Set<String>()
        var result: [CampaignRecipientInput] = []
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }
            let pieces = line.split(separator: ",", omittingEmptySubsequences: false).map {
                String($0).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let name = pieces.count >= 2
                ? pieces.dropLast().joined(separator: ", ").trimmingCharacters(in: .whitespacesAndNewlines)
                : nil
            let phone = pieces.last ?? line
            let dedupeKey = phoneKey(phone)
            guard dedupeKey.count >= 10, seen.insert(dedupeKey).inserted else { continue }
            result.append(CampaignRecipientInput(name: name?.isEmpty == false ? name : nil, phone: phone))
        }
        return result
    }

    private static func inputs(from contacts: [ConversationSummary],
                               source: String) -> [CampaignRecipientInput] {
        var seen = Set<String>()
        return contacts.compactMap { contact in
            let key = phoneKey(contact.phone)
            guard key.count >= 10, seen.insert(key).inserted else { return nil }
            return CampaignRecipientInput(
                name: contact.hasSavedName ? contact.displayName : nil,
                phone: contact.phone,
                contactID: contact.recordID?.rawValue,
                source: source
            )
        }
    }

    private static func phoneKey(_ phone: String) -> String {
        phone.filter(\.isNumber)
    }

    /// Campaign SMS is a single readable line. This runs in the editor, not
    /// the validator, because silent server-side repair would mean approving
    /// one string and sending another. Here the cleaned copy is shown on the
    /// next review step before it can be saved.
    static func singleLineCampaignCopy(_ value: String) -> String {
        let equivalents: [Character: String] = [
            "\u{2018}": "'", "\u{2019}": "'", "\u{201A}": "'", "\u{201B}": "'",
            "\u{201C}": "\"", "\u{201D}": "\"", "\u{201E}": "\"", "\u{201F}": "\"",
            "\u{2012}": "-", "\u{2013}": "-", "\u{2014}": "-", "\u{2015}": "-",
            "\u{2026}": "...", "\u{00A0}": " ", "\u{2007}": " ",
            "\u{202F}": " ", "\u{2009}": " ", "\u{00B4}": "'", "`": "'"
        ]
        let plain = value.reduce(into: "") { result, character in
            result += equivalents[character] ?? String(character)
        }
        return plain
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
