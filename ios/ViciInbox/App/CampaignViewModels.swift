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

@MainActor
final class CampaignDetailModel: ObservableObject {
    @Published private(set) var detail: CampaignDetailResponse?
    @Published private(set) var recipients: [CampaignRecipient] = []
    @Published private(set) var recipientTotal = 0
    @Published private(set) var dryRun: CampaignDryRun?
    @Published private(set) var performance: CampaignPerformance?
    @Published private(set) var financial: CampaignFinancialOverview?
    @Published private(set) var financialUnavailableMessage: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var isActing = false
    @Published var errorMessage: String?
    @Published var confirmationMessage: String?

    let campaignID: String
    private var nextRecipientPage = 1
    private var allowsDryRun = false
    private var allowsFinancial = false

    init(campaignID: String) {
        self.campaignID = campaignID
    }

    var campaign: CampaignRecord? { detail?.campaign }
    var hasMoreRecipients: Bool { recipients.count < recipientTotal }
    var canSubmitForReview: Bool {
        campaign?.status.isEditable == true && (dryRun?.eligible ?? 0) > 0 && !isActing
    }

    func load(canDryRun: Bool, canFinancial: Bool) async {
        guard !isLoading else { return }
        allowsDryRun = canDryRun
        allowsFinancial = canFinancial
        isLoading = true
        defer { isLoading = false }
        do {
            async let detailRequest = APIClient.shared.fetchCampaign(id: campaignID)
            async let recipientRequest = APIClient.shared.fetchCampaignRecipients(id: campaignID)
            let values = try await (detailRequest, recipientRequest)
            detail = values.0
            recipients = values.1.items
            recipientTotal = values.1.total
            nextRecipientPage = 2
            errorMessage = nil
            // Performance was added after campaign detail. Keep detail usable
            // during an additive backend rollout where this endpoint may not
            // have reached every environment yet.
            performance = try? await APIClient.shared.fetchCampaignPerformance(id: campaignID)
            if canDryRun { await refreshDryRun() }
            if canFinancial {
                do {
                    financial = try await APIClient.shared.fetchCampaignFinancialOverview(id: campaignID)
                    financialUnavailableMessage = nil
                } catch {
                    financial = nil
                    financialUnavailableMessage = error.localizedDescription
                }
            } else {
                // Support must remain operational-only and must not retain
                // financial data if effective permissions change mid-session.
                financial = nil
                financialUnavailableMessage = nil
            }
        } catch {
            errorMessage = error.localizedDescription
        }
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
                                                latestApproval: current.latestApproval)
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
    static let maximumAllContactsAudience = 500

    @Published var step: CampaignWizardStep = .type
    @Published var title: String
    @Published var message: String
    @Published var recipientsText: String
    @Published var audienceMode: CampaignAudienceMode
    @Published var contactSearch = ""
    @Published private(set) var contactResults: [ConversationSummary] = []
    @Published private(set) var allContactsSnapshot: [ConversationSummary] = []
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
    @Published var errorMessage: String?

    let existingID: String?
    private var contactRequestID = UUID()
    private let existingRecipientMetadata: [String: CampaignRecipientInput]

    init(campaign: CampaignRecord? = nil, recipients: [CampaignRecipient] = []) {
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
        existingID = campaign?.id
        title = campaign?.title ?? ""
        message = campaign?.proposedMessage ?? ""
        audienceMode = campaign == nil ? .selectedContacts : .manualNumbers
        existingRecipientMetadata = metadata
        recipientsText = recipients
            .filter(\.selected)
            // Phone-only editing cannot be corrupted by a saved contact name
            // containing a comma. Matching metadata is restored below.
            .map(\.contactPhone)
            .joined(separator: "\n")
    }

    var titleCount: Int { title.count }
    var messageCount: Int { message.count }
    var progress: Double { Double(step.number) / Double(CampaignWizardStep.allCases.count) }
    var canGoBack: Bool { step.rawValue > 0 && savedCampaign == nil }
    var isFinalStep: Bool { step == .saveAndReview }
    var audienceInputs: [CampaignRecipientInput] {
        switch audienceMode {
        case .selectedContacts:
            return Self.inputs(from: Array(selectedContacts.values), source: "manual_contact_selection")
        case .allContacts:
            guard allContactsAvailable else { return [] }
            return Self.inputs(from: allContactsSnapshot, source: "all_contacts_snapshot")
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
    var audienceCount: Int { audienceInputs.count }
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
            return "\(audienceCount.formatted()) contacts in this bounded snapshot"
        case .manualNumbers:
            return "\(audienceCount.formatted()) manually entered recipient\(audienceCount == 1 ? "" : "s")"
        }
    }

    var canSubmitSavedDraft: Bool {
        savedCampaign?.status.isEditable == true && (dryRun?.eligible ?? 0) > 0 && !isSubmitting
    }

    func advance() {
        guard savedCampaign == nil else { return }
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

    /// Contact selection is bounded. `All Contacts` is offered only when the
    /// first 501-row request proves the complete workspace fits below the 500
    /// recipient ceiling. Larger workspaces can still use server-side search
    /// and explicit selection without downloading an unbounded address book.
    func loadContacts(search: String? = nil) async {
        let query = (search ?? contactSearch).trimmingCharacters(in: .whitespacesAndNewlines)
        let requestID = UUID()
        contactRequestID = requestID
        isLoadingContacts = true
        defer {
            if contactRequestID == requestID { isLoadingContacts = false }
        }
        do {
            let pageSize = query.isEmpty ? Self.maximumAllContactsAudience + 1 : 200
            let page = try await APIClient.shared.fetchContacts(search: query,
                                                                page: 1,
                                                                pageSize: pageSize)
            guard contactRequestID == requestID else { return }
            if query.isEmpty {
                let isComplete = !page.hasMore && page.contacts.count <= Self.maximumAllContactsAudience
                hasLoadedContactSnapshot = true
                allContactsAvailable = isComplete
                allContactsSnapshot = Array(page.contacts.prefix(Self.maximumAllContactsAudience))
                contactResults = allContactsSnapshot
                contactResultsTruncated = !isComplete
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
        let cleanMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { errorMessage = "Enter a campaign title."; return false }
        guard cleanTitle.count <= 160 else { errorMessage = "Keep the title to 160 characters or fewer."; return false }
        guard !cleanMessage.isEmpty else { errorMessage = "Enter a message."; return false }
        guard cleanMessage.count <= 1_600 else { errorMessage = "Keep the message to 1,600 characters or fewer."; return false }

        let recipients = audienceInputs
        guard !recipients.isEmpty else { errorMessage = "Add at least one recipient."; return false }

        isSaving = true
        do {
            let response: CampaignActionResponse
            if let existingID {
                response = try await APIClient.shared.editCampaign(
                    id: existingID,
                    title: cleanTitle,
                    message: cleanMessage,
                    recipients: recipients
                )
            } else {
                response = try await APIClient.shared.createCampaign(
                    title: cleanTitle,
                    message: cleanMessage,
                    recipients: recipients
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
                return "All Contacts is available only when the complete workspace has 500 contacts or fewer. Select contacts or enter numbers instead."
            }
            if audienceInputs.isEmpty { return "Add at least one recipient." }
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
}
