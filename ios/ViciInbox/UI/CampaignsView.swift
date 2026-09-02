import SwiftUI

struct CampaignsView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @StateObject private var model = CampaignListModel()
    @State private var showingNewCampaign = false
    @State private var showingRecipes = false
    @State private var showingPlanner = false

    /// The campaign a confirmation is currently being asked about, and which
    /// question is being asked. One piece of state rather than two booleans and
    /// a separate id, so it is not possible to show the delete confirmation
    /// while holding the campaign the archive swipe picked.
    @State private var pendingAction: PendingCampaignAction?

    /// Archiving and deleting are different in kind, not in degree, so they are
    /// confirmed differently: archive is reversible and says so, delete is not
    /// and says that instead.
    private struct PendingCampaignAction: Identifiable {
        enum Kind { case archive, unarchive, delete }
        let campaign: CampaignRecord
        let kind: Kind
        var id: String { "\(campaign.id).\(kind)" }
    }

    var body: some View {
        Group {
            if !session.can(Permission.campaignsRead) {
                EmptyState(icon: "lock.shield",
                           title: "Campaigns are not available",
                           detail: "This account does not have permission to view campaigns.")
                    .padding(24)
            } else if model.isLoading && model.campaigns.isEmpty {
                ProgressView("Loading campaigns")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.campaigns.isEmpty {
                campaignEmptyState
            } else {
                campaignList
            }
        }
        .toolbar {
            if session.can(Permission.campaignsRead) {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Toggle(isOn: $model.showsArchived) {
                            Label("Show Archived", systemImage: "archivebox")
                        }
                    } label: {
                        Image(systemName: model.showsArchived
                              ? "line.3.horizontal.decrease.circle.fill"
                              : "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel("Filter campaigns")
                }
            }
            if session.can(Permission.campaignsManage) {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button {
                            showingPlanner = true
                        } label: {
                            Label("Describe a campaign", systemImage: "text.bubble")
                        }
                        Button {
                            showingRecipes = true
                        } label: {
                            Label("Build a standard one", systemImage: "wand.and.stars")
                        }
                        Button {
                            showingNewCampaign = true
                        } label: {
                            Label("Write one from scratch", systemImage: "square.and.pencil")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New campaign")
                }
            }
        }
        .sheet(isPresented: $showingNewCampaign) {
            CampaignEditorView {
                Task { await model.load(reset: true) }
            }
        }
        .sheet(isPresented: $showingRecipes) {
            CampaignRecipeSheet {
                Task { await model.load(reset: true) }
            }
        }
        .sheet(isPresented: $showingPlanner) {
            CampaignPlannerSheet {
                Task { await model.load(reset: true) }
            }
        }
        .refreshable {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load(reset: true)
        }
        .task(id: session.can(Permission.campaignsRead)) {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load()
        }
        // Reloads from page one when archived items are shown or hidden. Paging
        // state cannot survive a change to what the pages contain.
        .task(id: model.showsArchived) {
            guard session.can(Permission.campaignsRead), !model.campaigns.isEmpty else { return }
            await model.load(reset: true)
        }
        .alert("Campaigns error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("Retry") { Task { await model.load(reset: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        // Confirmation before anything leaves the list. A swipe is easy to do
        // by accident on a phone, and one of these three actions cannot be
        // undone.
        .confirmationDialog(confirmationTitle,
                            isPresented: Binding(
                                get: { pendingAction != nil },
                                set: { if !$0 { pendingAction = nil } }
                            ),
                            titleVisibility: .visible,
                            presenting: pendingAction) { action in
            switch action.kind {
            case .archive:
                Button("Archive") { Task { await model.archive(action.campaign) } }
            case .unarchive:
                Button("Restore") { Task { await model.unarchive(action.campaign) } }
            case .delete:
                Button("Delete Permanently", role: .destructive) {
                    Task { await model.delete(action.campaign) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            switch action.kind {
            case .archive:
                Text("\(action.campaign.title) will be hidden from this list. Nothing is deleted, and you can restore it from Show Archived.")
            case .unarchive:
                Text("\(action.campaign.title) will return to the campaign list.")
            case .delete:
                Text("\(action.campaign.title) will be permanently deleted. This cannot be undone. Archive it instead if you only want it out of the way.")
            }
        }
        // Archiving is otherwise silent, and silence after a swipe reads as a
        // failure. Auto-dismissed rather than needing a tap.
        .overlay(alignment: .bottom) {
            if let message = model.statusMessage {
                CampaignStatusToast(message: message)
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        guard !Task.isCancelled else { return }
                        model.statusMessage = nil
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.statusMessage)
    }

    private var confirmationTitle: String {
        switch pendingAction?.kind {
        case .archive:   return "Archive this campaign?"
        case .unarchive: return "Restore this campaign?"
        case .delete:    return "Delete this campaign?"
        case nil:        return ""
        }
    }

    private var campaignList: some View {
        List {
            Section { CampaignSafetyNotice() }

            // Reachable whether or not there are campaigns yet. Drafts live on
            // a different screen from campaigns, which is the distinction that
            // caused all of this, so the way across is always visible.
            if session.can(Permission.campaignsManage) {
                Section {
                    Button {
                        router.open(.campaignProposals)
                    } label: {
                        Label("Campaign drafts", systemImage: "doc.text.magnifyingglass")
                    }
                    Button {
                        router.open(.opportunities)
                    } label: {
                        Label("Where the revenue is", systemImage: "chart.line.uptrend.xyaxis")
                    }
                }
            }

            if model.reviewCount > 0 {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(ViciTheme.warning)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Review queue").font(.subheadline.weight(.semibold))
                            Text("\(model.reviewCount) campaign\(model.reviewCount == 1 ? "" : "s") awaiting a decision")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(model.reviewCount.formatted())
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(ViciTheme.destructive, in: Capsule())
                            .accessibilityLabel("\(model.reviewCount) awaiting review")
                    }
                }
            }

            Section("Campaigns") {
                ForEach(model.campaigns) { campaign in
                    NavigationLink(value: AppRoute.campaign(id: campaign.id)) {
                        CampaignRow(campaign: campaign,
                                    isArchived: model.isArchived(campaign),
                                    isMutating: model.mutatingID == campaign.id)
                    }
                    .onAppear { Task { await model.loadMoreIfNeeded(after: campaign) } }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        campaignSwipeActions(for: campaign)
                    }
                    // The same actions without a swipe. A swipe is invisible
                    // until somebody guesses it is there.
                    .contextMenu { campaignSwipeActions(for: campaign) }
                }
                if model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// Archive, restore and delete for one campaign.
    ///
    /// Archive is offered for everything, because "get this out of my list" is
    /// a reasonable thing to want about any campaign. Delete is offered only
    /// for a draft, and is `role: .destructive` so it is red before it is read.
    /// Neither acts immediately; both raise a confirmation first.
    @ViewBuilder
    private func campaignSwipeActions(for campaign: CampaignRecord) -> some View {
        if session.can(Permission.campaignsManage) {
            if model.isArchived(campaign) {
                Button {
                    pendingAction = PendingCampaignAction(campaign: campaign, kind: .unarchive)
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }
                .tint(ViciTheme.tint)
            } else {
                Button {
                    pendingAction = PendingCampaignAction(campaign: campaign, kind: .archive)
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .tint(ViciTheme.warning)
            }

            if model.canDelete(campaign) {
                Button(role: .destructive) {
                    pendingAction = PendingCampaignAction(campaign: campaign, kind: .delete)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private var campaignEmptyState: some View {
        ScrollView {
            VStack(spacing: 20) {
                CampaignSafetyNotice()
                EmptyState(
                    icon: "megaphone",
                    title: "No campaigns yet",
                    detail: session.can(Permission.campaignsManage)
                        ? "Create a manual draft for a carefully selected audience. Drafting never sends a message."
                        : "Campaigns will appear here when an Admin creates them."
                )
                if session.can(Permission.campaignsManage) {
                    Button("Create Draft") { showingNewCampaign = true }
                        .buttonStyle(.borderedProminent)
                        .tint(ViciTheme.tint)

                    // THE TWO SCREENS NOBODY COULD REACH.
                    //
                    // Campaign drafts and Opportunities had no tap path at all:
                    // the only way in was to ask the assistant to take you.
                    // So being told "I've drafted four campaigns" and then
                    // finding this empty page was a dead end, and the drafts
                    // looked like they did not exist.
                    //
                    // Here rather than in the section picker because this is
                    // the screen somebody is standing on when they go looking.
                    VStack(spacing: 10) {
                        Button {
                            router.open(.campaignProposals)
                        } label: {
                            Label("Campaign drafts", systemImage: "doc.text.magnifyingglass")
                        }
                        Button {
                            router.open(.opportunities)
                        } label: {
                            Label("Where the revenue is", systemImage: "chart.line.uptrend.xyaxis")
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .tint(ViciTheme.tint)
                    .padding(.top, 4)
                }
            }
            .padding(24)
        }
    }
}

private struct CampaignRow: View {
    let campaign: CampaignRecord
    /// Archived rows stay legible but visibly set aside. Dimming alone would
    /// read as "disabled", so there is a word as well as an opacity change —
    /// archived and deleted must never look the same, and neither should look
    /// like a loading failure.
    var isArchived: Bool = false
    var isMutating: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(campaign.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 8)
                if isMutating {
                    ProgressView()
                } else if isArchived {
                    Label("Archived", systemImage: "archivebox.fill")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                CampaignStatusBadge(status: campaign.status)
            }
            Text(campaign.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 10) {
                if let count = campaign.requestedRecipientCount {
                    Label("\(count.formatted())", systemImage: "person.2")
                }
                Text("Revision \(campaign.revision)")
                if let created = ServerDate.parse(campaign.createdAt) {
                    Text(created.formatted(date: .abbreviated, time: .omitted))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .opacity(isArchived ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isArchived ? "Archived. \(campaign.title)" : campaign.title)
    }
}

/// A short, self-dismissing confirmation that an archive, restore or delete
/// actually happened.
private struct CampaignStatusToast: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Material.regular, in: Capsule())
            .overlay(Capsule().stroke(ViciTheme.tint.opacity(0.25)))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
            .accessibilityAddTraits(.isStaticText)
    }
}

struct CampaignDetailView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model: CampaignDetailModel
    @State private var showingEditor = false
    @State private var editorRecipients: [CampaignRecipient] = []
    @State private var preparingEditor = false
    @State private var confirmingApproval = false
    @State private var showingRejection = false
    @State private var showingSchedule = false
    @State private var showingCancellation = false
    @State private var showingAllRecipients = false

    /// How many recipients to show before the reviewer asks for more.
    private let recipientSampleSize = 3

    init(campaignID: String) {
        _model = StateObject(wrappedValue: CampaignDetailModel(campaignID: campaignID))
    }

    var body: some View {
        Group {
            if model.isLoading && model.campaign == nil {
                ProgressView("Loading campaign")
            } else if let campaign = model.campaign {
                campaignList(campaign)
            } else {
                EmptyState(icon: "exclamationmark.triangle",
                           title: "Campaign unavailable",
                           detail: model.errorMessage ?? "This campaign could not be loaded.")
                    .padding(24)
            }
        }
        .navigationTitle(model.campaign?.title ?? "Campaign")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load(canDryRun: session.can(Permission.campaignsManage),
                             canFinancial: session.can(Permission.analyticsRead))
        }
        .refreshable {
            await model.load(canDryRun: session.can(Permission.campaignsManage),
                             canFinancial: session.can(Permission.analyticsRead))
        }
        .sheet(isPresented: $showingEditor) {
            CampaignEditorView(campaign: model.campaign, recipients: editorRecipients) {
                Task {
                    await model.load(canDryRun: session.can(Permission.campaignsManage),
                                     canFinancial: session.can(Permission.analyticsRead))
                }
            }
        }
        .sheet(isPresented: $showingRejection) {
            CampaignReasonSheet(title: "Reject Campaign",
                                prompt: "Explain what needs to change.",
                                actionTitle: "Reject",
                                destructive: true) { reason in
                showingRejection = false
                await model.reject(reason: reason)
            }
        }
        .sheet(isPresented: $showingSchedule) {
            CampaignScheduleSheet { date in
                showingSchedule = false
                await confirmThenSchedule(for: date)
            }
        }
        .sheet(isPresented: $showingCancellation) {
            CampaignReasonSheet(title: "Cancel Campaign",
                                prompt: "Add an optional internal reason.",
                                actionTitle: "Cancel Campaign",
                                destructive: true,
                                requiresReason: false) { reason in
                showingCancellation = false
                await model.cancel(reason: reason)
            }
        }
        // MARK: Face ID on the two irreversible steps
        //
        // Approval is the moment a revision becomes the thing that may be sent,
        // and scheduling is the moment it acquires a time to go out. Both reach
        // real customers and neither can be taken back afterwards.
        //
        // Not authentication: the person is signed in and the server has
        // already decided what they may do. This is a physical act between an
        // intention and an outcome, in the two places where a mis-tap is
        // expensive.
        //
        // `.unavailable` proceeds, because the dialog above was already
        // answered and a phone with no passcode is not a reason somebody cannot
        // run their business.
        .confirmationDialog("Approve this exact revision?",
                            isPresented: $confirmingApproval,
                            titleVisibility: .visible) {
            Button("Approve Revision \(model.campaign?.revision ?? 0)") {
                Task { await confirmThenApprove() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Approval records the exact message and selected audience. It does not grant carrier or provider permission to send.")
        }
        .alert("Campaign error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        .alert("Campaign updated", isPresented: Binding(
            get: { model.confirmationMessage != nil },
            set: { if !$0 { model.confirmationMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.confirmationMessage ?? "Done")
        }
    }

    private func confirmThenApprove() async {
        let outcome = await BiometricConfirmation.confirm(
            reason: "Confirm approval of this campaign message and audience"
        )
        guard outcome != .declined else { return }
        await model.approve()
    }
    private func confirmThenSchedule(for date: Date) async {
        let outcome = await BiometricConfirmation.confirm(
            reason: "Confirm scheduling this campaign to go out to customers"
        )
        guard outcome != .declined else { return }
        await model.schedule(for: date)
    }

    private var visibleRecipients: [CampaignRecipient] {
        showingAllRecipients ? model.recipients : Array(model.recipients.prefix(recipientSampleSize))
    }

    /// What the reviewer actually needs from this section: how many will be
    /// reached, and how many will not, rather than a list they will not read.
    private var recipientFooter: String {
        let total = model.recipientTotal
        guard let dryRun = model.dryRun else {
            return "\(total.formatted()) in this draft. Run the eligibility check to see how many can be reached."
        }
        let blocked = dryRun.suppressed
        let base = "\(dryRun.eligible.formatted()) of \(total.formatted()) can be reached."
        return blocked == 0
            ? base + " Every recipient passed the current safety checks."
            : base + " \(blocked.formatted()) cannot, and the reasons are listed against each one."
    }

    private func campaignList(_ campaign: CampaignRecord) -> some View {
        List {
            Section {
                HStack {
                    CampaignStatusBadge(status: campaign.status)
                    Spacer()
                    Text("Revision \(campaign.revision)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let date = keyDate(for: campaign) {
                    LabeledContent(keyDateLabel(for: campaign),
                                   value: date.formatted(date: .abbreviated, time: .shortened))
                }
                LabeledContent("Type", value: campaign.workflowCategory.replacingOccurrences(of: "_", with: " ").capitalized)
            }

            Section("Message") {
                Text(campaign.message)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if campaign.finalMessage != nil && !campaign.status.isEditable {
                    Label("This is the message frozen for this revision.", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if let preview = model.preview, preview.personalised {
                CampaignPreviewSection(
                    preview: preview,
                    removing: model.removingRecipients,
                    onRemove: { id in Task { await model.removeRecipient(id) } },
                    status: campaign.status
                )
            }

            if let rejection = campaign.rejectionReason, !rejection.isEmpty {
                Section("Reason for changes") { Text(rejection) }
            }
            if let cancellation = campaign.cancellationReason, !cancellation.isEmpty {
                Section("Cancellation reason") { Text(cancellation) }
            }

            if let performance = model.performance {
                CampaignPerformanceSection(performance: performance)
                if let coupons = performance.coupons, coupons.hasCodes {
                    CampaignCouponRevenueSection(coupons: coupons)
                }
            }

            if session.can(Permission.analyticsRead) {
                if let financial = model.financial, financial.availability.revenueAttribution {
                    CampaignFinancialSection(campaignID: campaign.id, financial: financial)
                } else {
                    Section("Revenue Attribution") {
                        Label("Campaign revenue is not available yet.", systemImage: "chart.bar.doc.horizontal")
                            .foregroundStyle(.secondary)
                        if let message = model.financialUnavailableMessage, !message.isEmpty {
                            Text(message).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let dryRun = model.dryRun {
                CampaignEligibilitySection(dryRun: dryRun)
            } else if session.can(Permission.campaignsManage) {
                Section {
                    Button("Run Eligibility Check") { Task { await model.refreshDryRun() } }
                        .disabled(model.isActing)
                } footer: {
                    Text("This preview checks current consent and suppression state. Every recipient is checked again before any future send.")
                }
            }

            actionSection(campaign)

            // ── Three, not two hundred ──────────────────────────────────
            //
            // This listed every recipient with infinite scroll, so reviewing a
            // 221-person campaign meant scrolling past 221 rows to reach the
            // approval controls below. Nobody reads 221 rows, and the ones
            // worth reading are the exceptions, not the first three.
            //
            // So: a sample by default, and a toggle for the rest. The counts
            // in the footer are what the reviewer actually needs.
            Section {
                if model.recipients.isEmpty {
                    Text("No recipients")
                        .foregroundStyle(.secondary)
                }
                ForEach(visibleRecipients) { recipient in
                    CampaignRecipientRow(recipient: recipient,
                                         eligibility: eligibility(for: recipient))
                        .onAppear {
                            guard showingAllRecipients else { return }
                            Task { await model.loadMoreRecipientsIfNeeded(after: recipient) }
                        }
                }
                if model.recipientTotal > recipientSampleSize {
                    Button(showingAllRecipients
                           ? "Show fewer"
                           : "Show all \(model.recipientTotal.formatted())") {
                        showingAllRecipients.toggle()
                    }
                }
                if showingAllRecipients && model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Recipients")
            } footer: {
                Text(recipientFooter)
            }

            if let approval = model.detail?.latestApproval {
                Section("Latest decision") {
                    LabeledContent("Decision", value: approval.decision.capitalized)
                    LabeledContent("Revision", value: approval.revision.formatted())
                    LabeledContent("Recipients", value: approval.recipientCount.formatted())
                    if let date = ServerDate.parse(approval.decidedAt) {
                        LabeledContent("Recorded", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func actionSection(_ campaign: CampaignRecord) -> some View {
        let canManage = session.can(Permission.campaignsManage)
        let canApprove = session.can(Permission.campaignsApprove)
        let canLaunch = session.can(Permission.campaignsLaunch)
        let canCancel = session.can(Permission.campaignsCancel)

        if canManage || canApprove || canLaunch || canCancel {
            Section {
                if campaign.status.isEditable && canManage {
                    Button {
                        prepareEditor()
                    } label: {
                        if preparingEditor {
                            Label("Preparing Draft", systemImage: "hourglass")
                        } else {
                            Label("Edit Draft", systemImage: "pencil")
                        }
                    }
                    .disabled(preparingEditor || model.isActing)

                    Button("Submit for Review") {
                        Task { await model.submitForReview() }
                    }
                    .disabled(!model.canSubmitForReview)
                    .accessibilityHint(model.canSubmitForReview
                                       ? "Submits the current draft for internal review."
                                       : "Run a successful eligibility check with at least one eligible recipient first.")

                    if model.dryRun == nil || model.dryRun?.eligible == 0 {
                        Text("A successful eligibility check with at least one eligible recipient is required before review submission.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if campaign.status.needsReview && canApprove {
                    Button("Approve This Revision") { confirmingApproval = true }
                        .disabled(model.isActing)
                    Button("Reject for Changes", role: .destructive) { showingRejection = true }
                        .disabled(model.isActing)
                }

                if campaign.status == .approved && canLaunch {
                    if model.dryRun?.liveEligibility.allowed == true {
                        Button("Record Campaign Schedule") { showingSchedule = true }
                            .disabled(model.isActing || model.dryRun?.eligible == 0)
                    } else {
                        // "Scheduling is unavailable" and a padlock, with no
                        // reason. The campaign was approved, 221 messages were
                        // frozen and 221 coupons were minted, and the only
                        // thing standing between that and a send time was one
                        // unset environment variable that the screen did not
                        // name. A lock icon that will not say what it is
                        // locking is worse than the error it replaced.
                        VStack(alignment: .leading, spacing: 6) {
                            Label("Scheduling is unavailable", systemImage: "lock.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(ViciTheme.warning)
                            ForEach(model.dryRun?.liveEligibility.reasons ?? [], id: \.self) { reason in
                                Text(CampaignReasonCopy.label(reason))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if (model.dryRun?.liveEligibility.reasons ?? []).isEmpty {
                                Text("Run the eligibility check to see what is blocking it.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Text("Everything else is done: the messages are frozen and the codes exist. Once this is cleared you can set a send time.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if (campaign.status == .approved || campaign.status == .scheduled) && canCancel {
                    Button("Cancel Campaign", role: .destructive) { showingCancellation = true }
                        .disabled(model.isActing)
                }

                if model.isActing { ProgressView().frame(maxWidth: .infinity) }
            } header: {
                Text("Actions")
            } footer: {
                Text("Team approval and provider permission are separate. Approval never sends a campaign.")
            }
        }
    }

    private func prepareEditor() {
        preparingEditor = true
        Task {
            if let recipients = await model.allRecipientsForEditing() {
                editorRecipients = recipients
                showingEditor = true
            }
            preparingEditor = false
        }
    }

    private func eligibility(for recipient: CampaignRecipient) -> CampaignEligibilityResult? {
        model.dryRun?.recipients.first { $0.phone == recipient.contactPhone }
    }

    private func keyDate(for campaign: CampaignRecord) -> Date? {
        ServerDate.parse(
            campaign.scheduledFor
                ?? campaign.approvedAt
                ?? campaign.submittedForReviewAt
                ?? campaign.createdAt
        )
    }

    private func keyDateLabel(for campaign: CampaignRecord) -> String {
        if campaign.scheduledFor != nil { return "Scheduled for" }
        if campaign.approvedAt != nil { return "Approved" }
        if campaign.submittedForReviewAt != nil { return "Submitted" }
        return "Created"
    }
}

private struct CampaignFinancialSection: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let campaignID: String
    let financial: CampaignFinancialOverview

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(AnalyticsFormatting.money(financial.revenue.attributed,
                                               currency: financial.currency))
                    .font(.title2.bold().monospacedDigit())
                Text("Attributed Revenue")
                    .font(.subheadline.weight(.semibold))
                Text("Direct + strong evidence")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(columns: dynamicTypeSize.isAccessibilitySize
                      ? [GridItem(.flexible())]
                      : [GridItem(.flexible()), GridItem(.flexible())],
                      alignment: .leading,
                      spacing: 14) {
                CampaignRevenueMetric(value: financial.revenue.direct,
                                      orders: financial.orders.byConfidence.direct,
                                      title: "100% Direct",
                                      currency: financial.currency)
                CampaignRevenueMetric(value: financial.revenue.strong,
                                      orders: financial.orders.byConfidence.strong,
                                      title: "90% Strong",
                                      currency: financial.currency)
                if financial.revenue.influenced.value != 0 || financial.orders.influenced > 0 {
                    CampaignRevenueMetric(value: financial.revenue.influenced,
                                          orders: financial.orders.byConfidence.influenced,
                                          title: "60% Influenced",
                                          currency: financial.currency)
                }
                CampaignCountMetric(value: financial.conversion.recipients, label: "Converted recipients")
            }

            if let rate = financial.conversion.rate, rate.isFinite {
                LabeledContent("Conversion from trusted delivery",
                               value: "\((rate * 100).formatted(.number.precision(.fractionLength(0...1))))%")
            }

            NavigationLink(value: AppRoute.campaignAttributions(campaignID: campaignID)) {
                Label("View Order Evidence", systemImage: "doc.text.magnifyingglass")
            }
        } header: {
            Text("Revenue Attribution")
        } footer: {
            Text("Attributed Revenue includes Direct and Strong evidence. Influenced stays separate. Tap through to inspect gross value, refunds, net value and the reason for every order.")
        }
    }
}

private struct CampaignRevenueMetric: View {
    let value: FlexibleDecimal
    let orders: Int
    let title: String
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(AnalyticsFormatting.money(value, currency: currency))
                .font(.headline.monospacedDigit())
            Text(title).font(.caption.weight(.semibold))
            Text("\(orders.formatted()) order\(orders == 1 ? "" : "s")")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct CampaignAttributionListView: View {
    @StateObject private var model: CampaignAttributionListModel

    init(campaignID: String) {
        _model = StateObject(wrappedValue: CampaignAttributionListModel(campaignID: campaignID))
    }

    var body: some View {
        List {
            Section {
                Picker("Attribution scope", selection: $model.scope) {
                    ForEach(AttributionScope.allCases) { scope in
                        Text(scope.title).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
            }

            if model.isLoading && model.items.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if model.items.isEmpty {
                EmptyState(icon: "doc.text.magnifyingglass",
                           title: "No \(model.scope.title.lowercased()) orders",
                           detail: "No order-level evidence matches this classification.")
            } else {
                Section("Order Evidence") {
                    ForEach(model.items) { item in
                        NavigationLink {
                            CampaignAttributionEvidenceView(item: item, currency: model.currency)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text("Order #\(item.orderId)").font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(AnalyticsFormatting.money(item.netAmount, currency: model.currency))
                                        .font(.subheadline.bold().monospacedDigit())
                                }
                                Text(item.confidenceLabel)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.confidenceLevel == .influenced ? ViciTheme.warning : ViciTheme.tint)
                                Text(item.safeExplanation)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .padding(.vertical, 3)
                            .accessibilityElement(children: .combine)
                        }
                        .onAppear { Task { await model.loadMoreIfNeeded(after: item) } }
                    }
                    if model.isLoadingMore { ProgressView().frame(maxWidth: .infinity) }
                }
            }
        }
        .navigationTitle("Campaign Revenue")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .onChange(of: model.scope) { _ in Task { await model.load(reset: true) } }
        .refreshable { await model.load(reset: true) }
        .alert("Revenue evidence error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
    }
}

private struct CampaignAttributionEvidenceView: View {
    let item: AttributionRecord
    let currency: String

    var body: some View {
        List {
            Section("Order") {
                LabeledContent("Order", value: "#\(item.orderId)")
                LabeledContent("Classification", value: item.confidenceLabel)
                LabeledContent("Gross", value: AnalyticsFormatting.money(item.grossAmount, currency: currency))
                LabeledContent("Refunded", value: AnalyticsFormatting.money(item.refundedAmount, currency: currency))
                LabeledContent("Net", value: AnalyticsFormatting.money(item.netAmount, currency: currency))
            }
            Section("Why it was classified this way") { Text(item.safeExplanation) }
            if let action = ServerDate.parse(item.actionAt) {
                Section("Timeline") {
                    LabeledContent("Campaign action", value: action.formatted(date: .abbreviated, time: .shortened))
                    if let conversion = ServerDate.parse(item.conversionAt) {
                        LabeledContent("Order conversion", value: conversion.formatted(date: .abbreviated, time: .shortened))
                    }
                }
            }
            if !item.supportingEvidence.isEmpty {
                Section("Supporting evidence") {
                    ForEach(item.supportingEvidence, id: \.self) { evidence in
                        Label(CampaignReasonCopy.label(evidence), systemImage: "checkmark.circle")
                    }
                }
            }
            if item.invalidatedAt != nil {
                Section { Label("This attribution was invalidated and is excluded from active totals.", systemImage: "exclamationmark.triangle") }
            }
        }
        .navigationTitle("Order #\(item.orderId)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct CampaignPerformanceSection: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let performance: CampaignPerformance

    var body: some View {
        Section {
            LazyVGrid(columns: dynamicTypeSize.isAccessibilitySize
                      ? [GridItem(.flexible())]
                      : [GridItem(.flexible()), GridItem(.flexible())],
                      alignment: .leading,
                      spacing: 14) {
                CampaignCountMetric(value: performance.operational.recipients, label: "Recipients")
                CampaignCountMetric(value: performance.operational.providerAccepted, label: "Provider accepted")
                CampaignCountMetric(value: performance.operational.delivered, label: "Delivered")
                CampaignCountMetric(value: performance.operational.replies, label: "Replies")
                CampaignCountMetric(value: performance.operational.queued, label: "Queued")
                CampaignCountMetric(value: performance.operational.failed, label: "Failed")
                CampaignCountMetric(value: performance.operational.skipped, label: "Skipped")
                CampaignCountMetric(value: performance.operational.optOuts, label: "Opt-outs")
            }

            if !performance.availability.financial {
                Label("Revenue attribution is not available for this campaign yet.",
                      systemImage: "chart.bar.doc.horizontal")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(performance.warnings) { warning in
                Label(warning.message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.warning)
            }
        } header: {
            Text("Campaign Results")
        } footer: {
            Text("Provider accepted is not the same as delivered. Delivered counts only trusted delivery events.")
        }
    }
}

private struct CampaignEligibilitySection: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let dryRun: CampaignDryRun

    var body: some View {
        Section {
            LazyVGrid(columns: dynamicTypeSize.isAccessibilitySize
                      ? [GridItem(.flexible())]
                      : [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())],
                      alignment: .leading,
                      spacing: 12) {
                CampaignCountMetric(value: dryRun.total, label: "Selected")
                CampaignCountMetric(value: dryRun.eligible, label: "Eligible")
                CampaignCountMetric(value: dryRun.suppressed, label: "Suppressed")
            }

            // ── WHAT IT COSTS ────────────────────────────────────────────
            //
            // On the review screen, beside the audience, because this is where
            // somebody decides whether to send. Approving committed real money
            // and the screen said nothing about it: the owner had to ask where
            // the figure was, having already been told by a warning badge that
            // his message had become two segments.
            if let cost = dryRun.cost {
                LabeledContent("Estimated cost") {
                    Text(cost.estimatedCostUsd, format: .currency(code: "USD"))
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                }
                // The arithmetic, so a number that looks wrong can be checked
                // rather than believed. It is an estimate, and says so.
                Text(cost.workedOut)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if cost.multiSegment > 0 {
                    Text("\(cost.multiSegment.formatted()) of these are over 160 characters, so they cost two credits each and arrive as one message. At one credit each the whole send would be \(cost.ifAllSingleSegmentUsd.formatted(.currency(code: "USD"))).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Label(
                dryRun.liveEligibility.allowed
                    ? "The live scheduling gate is enabled."
                    : "Live sending is off. Drafting and review remain available.",
                systemImage: dryRun.liveEligibility.allowed ? "checkmark.shield.fill" : "lock.shield.fill"
            )
            .foregroundStyle(dryRun.liveEligibility.allowed ? ViciTheme.success : ViciTheme.warning)

            ForEach(dryRun.reasons.keys.sorted(), id: \.self) { reason in
                LabeledContent(CampaignReasonCopy.label(reason),
                               value: (dryRun.reasons[reason] ?? 0).formatted())
            }

            if !dryRun.liveEligibility.allowed {
                ForEach(dryRun.liveEligibility.reasons, id: \.self) { reason in
                    Label(CampaignReasonCopy.label(reason), systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Eligibility Preview")
        } footer: {
            Text("This is a read-only preview. Approval is an internal decision and does not grant provider permission. Safety checks run again at send time.")
        }
    }
}

private struct CampaignCountMetric: View {
    let value: Int
    let label: String

    var body: some View {
        VStack(spacing: 3) {
            Text(value.formatted()).font(.headline.monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct CampaignRecipientRow: View {
    let recipient: CampaignRecipient
    let eligibility: CampaignEligibilityResult?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(.subheadline.weight(.semibold))
                    if recipient.contactName?.isEmpty == false {
                        Text(PhoneFormatter.pretty(recipient.contactPhone))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let eligibility {
                    Label(CampaignReasonCopy.label(eligibility.reason),
                          systemImage: eligibility.eligible ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(eligibility.eligible
                                         ? ViciTheme.success
                                         : (CampaignReasonCopy.isCustomerRefusal(eligibility.reason)
                                            ? ViciTheme.destructive
                                            : ViciTheme.warning))
                        .accessibilityLabel(CampaignReasonCopy.label(eligibility.reason))
                }
            }
            // ── WHY THIS PERSON ─────────────────────────────────────────
            //
            // The step-by-step version when the server has evidence for it,
            // the one-line summary when it does not. Both come from
            // inclusion_reason; the difference is that the evidence used to be
            // thrown away at proposal acceptance, so the only answer available
            // was the segment's name.
            if let why = recipient.whyIncluded, !why.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(why.enumerated()), id: \.offset) { _, step in
                        Text(step)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text(recipient.inclusionSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reason = eligibility?.reason, reason != "eligible" {
                Text(CampaignReasonCopy.label(reason))
                    .font(.caption)
                    .foregroundStyle(CampaignReasonCopy.isCustomerRefusal(reason)
                                     ? ViciTheme.destructive : ViciTheme.warning)
            } else if let reason = recipient.suppressionReason, !reason.isEmpty {
                Text(CampaignReasonCopy.label(reason))
                    .font(.caption)
                    .foregroundStyle(CampaignReasonCopy.isCustomerRefusal(reason)
                                     ? ViciTheme.destructive : ViciTheme.warning)
            } else if recipient.state != "draft" {
                Text(recipient.state.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var displayName: String {
        guard let name = recipient.contactName, !name.isEmpty else {
            return PhoneFormatter.pretty(recipient.contactPhone)
        }
        return name
    }
}

private struct CampaignSafetyNotice: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label("Human approval required", systemImage: "checkmark.shield.fill")
                .font(.subheadline.weight(.semibold))
            Text("Campaigns begin as drafts. Approval never sends automatically, and current consent is checked again before any future send.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text("A schedule delivers only while live sending is switched on for this workspace. With it off, an approved and scheduled campaign waits and sends nothing.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct CampaignStatusBadge: View {
    let status: CampaignStatus

    var body: some View {
        Text(status.title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.13), in: Capsule())
            .accessibilityLabel("Status, \(status.title)")
    }

    private var color: Color {
        switch status {
        // Green means the messages went out. Nothing else earns it.
        case .completed, .approved: return ViciTheme.success
        // Sending is not a warning, it is the campaign working. It shared the
        // orange of "waiting for you" and so read as another thing needing
        // attention, which is exactly backwards while it is the one state that
        // needs nothing from anybody.
        case .sending: return ViciTheme.tint
        case .reviewRequired, .approvalPending, .scheduled: return ViciTheme.warning
        case .failed, .rejected, .cancelled: return ViciTheme.destructive
        case .draft: return ViciTheme.inkSecondary
        }
    }
}

/// Every text entry point in the wizard, so one Done button can clear whichever
/// is focused without each step tracking its own state.
private enum CampaignWizardField: Hashable {
    case title
    case contactSearch
    case recipients
    case message
    case brief
}

struct CampaignEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: CampaignEditorModel
    @FocusState private var focusedField: CampaignWizardField?
    let onSaved: () -> Void

    init(campaign: CampaignRecord? = nil,
         recipients: [CampaignRecipient] = [],
         onSaved: @escaping () -> Void) {
        _model = StateObject(wrappedValue: CampaignEditorModel(campaign: campaign,
                                                               recipients: recipients))
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Step \(model.step.number) of \(CampaignWizardStep.allCases.count)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(model.step.title)
                                .font(.caption.weight(.semibold))
                        }
                        ProgressView(value: model.progress)
                            .tint(ViciTheme.tint)
                            .accessibilityLabel("Campaign setup progress")
                            .accessibilityValue("Step \(model.step.number) of \(CampaignWizardStep.allCases.count), \(model.step.title)")
                    }
                }

                stepContent
            }
            .scrollDismissesKeyboard(.interactively)
            // The wizard's own controls, in a bar that rides above the keyboard
            // instead of behind it. See `wizardControls` for why this is not a
            // `ToolbarItemGroup(placement: .bottomBar)` any more.
            .safeAreaInset(edge: .bottom, spacing: 0) { wizardControls }
            .navigationTitle(model.existingID == nil ? "New Campaign" : "Edit Campaign")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.loadCopyTools() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.savedCampaign == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
            .interactiveDismissDisabled(model.isSaving || model.isCheckingEligibility || model.isSubmitting)
            .task(id: model.contactSearch) {
                guard model.step == .audience else { return }
                if !model.contactSearch.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                }
                await model.loadContacts()
            }
            .onChange(of: model.step) { step in
                focusedField = nil
                if step == .audience && model.contactResults.isEmpty {
                    Task { await model.loadContacts() }
                }
            }
            .alert("Campaign needs attention", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) { Button("OK", role: .cancel) {} } message: {
                Text(model.errorMessage ?? "Please try again.")
            }
        }
        .assistantDraftOwner(
            source: .campaign,
            isDirty: model.hasUnsavedDraftChanges,
            onDiscard: {
                focusedField = nil
                model.discardLocalDraft()
                dismiss()
            }
        )
    }

    /// Back, Next, Save — the controls that move the wizard along.
    ///
    /// THE TWO-TAP FIX. These used to be a `ToolbarItemGroup(placement:
    /// .bottomBar)`, which lives in the navigation controller's toolbar. That
    /// toolbar does not move when the keyboard appears, so the keyboard simply
    /// covered it. Step one of this wizard is a required title in a `TextField`
    /// and step four is the message in a `TextEditor`, so on the steps that
    /// matter the keyboard is up by definition and `Next` was underneath it.
    ///
    /// Commit e5062d8 recognised half of this — its own message says "the
    /// keyboard covers the bottom toolbar where Next lives" — and answered it
    /// with a Done button in the keyboard accessory bar. That unblocked the
    /// dead end, but it made every advance cost two taps by construction: one
    /// on Done to retract the keyboard and uncover the bar, then one on Next.
    /// The owner reported precisely that as "buttons need two taps", and it was
    /// not a hit-testing bug at all; the first tap was doing a real job.
    ///
    /// `safeAreaInset(edge: .bottom)` is the fix, because SwiftUI applies the
    /// keyboard as a bottom safe-area inset. The bar is therefore always
    /// visible, sitting directly above the keyboard while typing, and one tap
    /// on Next both resigns focus and advances. The keyboard accessory group is
    /// gone with it: the reason it existed no longer exists, and leaving it
    /// would stack two bars above the keyboard.
    private var wizardControls: some View {
        HStack(spacing: 12) {
            if model.canGoBack {
                Button("Back") { advanceOrGoBack(model.back) }
                    .buttonStyle(.bordered)
            }

            // Only while something is focused, and only because a TextEditor
            // treats Return as a newline. Dragging the form dismisses too, but
            // an explicit control is easier to find than a gesture.
            if focusedField != nil {
                Button {
                    focusedField = nil
                } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Hide keyboard")
            }

            Spacer(minLength: 0)

            if model.savedCampaign != nil {
                if model.savedCampaign?.status.isEditable == true {
                    Button("Submit for Review") {
                        focusedField = nil
                        Task {
                            if await model.submitSavedDraftForReview() { onSaved() }
                        }
                    }
                    .disabled(!model.canSubmitSavedDraft)
                }
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
            } else if model.isFinalStep {
                Button(model.existingID == nil ? "Save Draft" : "Save New Revision") {
                    focusedField = nil
                    Task {
                        if await model.saveAndCheckEligibility() { onSaved() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(ViciTheme.tint)
                .disabled(model.isSaving)
            } else {
                Button("Next") { advanceOrGoBack(model.advance) }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Material.bar)
    }

    /// Clears focus and then moves. Order matters: the step's validation reads
    /// `model.title` and `model.message`, and both are bound live, so the value
    /// is already committed by the time this runs. Resigning first only
    /// guarantees the keyboard does not follow the wizard onto the next step.
    private func advanceOrGoBack(_ move: () -> Void) {
        focusedField = nil
        move()
    }

    @ViewBuilder
    private var stepContent: some View {
        switch model.step {
        case .type:
            typeStep
        case .audience:
            audienceStep
        case .audienceReview:
            audienceReviewStep
        case .message:
            messageStep
        case .preview:
            safetyAndTimingStep
        case .saveAndReview:
            saveAndReviewStep
        }
    }

    private var typeStep: some View {
        Group {
            Section("Type") {
                Label("Manual Campaign", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.headline)
                Text("You choose the audience and write the message. The app saves a draft only, then checks every recipient using current safety rules.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Campaign name or purpose") {
                TextField("Example: August customer update", text: $model.title)
                    .focused($focusedField, equals: .title)
                    .submitLabel(.done)
                    .onSubmit { focusedField = nil }
                HStack {
                    Spacer()
                    Text("\(model.titleCount)/160")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(model.titleCount > 160 ? ViciTheme.destructive : Color.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var audienceStep: some View {
        Section("Audience Mode") {
            ForEach(CampaignAudienceMode.allCases) { mode in
                Button {
                    model.chooseAudienceMode(mode)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: model.audienceMode == mode ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.audienceMode == mode ? ViciTheme.tint : Color.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(mode.title).font(.body.weight(.semibold))
                            Text(mode.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .foregroundStyle(.primary)
                .disabled(mode == .allContacts && !model.allContactsAvailable)
                .accessibilityAddTraits(model.audienceMode == mode ? .isSelected : [])
            }
            if model.isLoadingContacts && !model.hasLoadedContactSnapshot {
                ProgressView("Checking contact-list size")
            } else if !model.hasLoadedContactSnapshot {
                Text("All Contacts stays unavailable until the contact list can be loaded safely.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if !model.allContactsAvailable {
                Text("All Contacts becomes available only when the complete workspace contains \(CampaignEditorModel.maximumAllContactsAudience.formatted()) contacts or fewer.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        switch model.audienceMode {
        case .selectedContacts:
            selectedContactsStep
        case .allContacts:
            allContactsStep
        case .manualNumbers:
            manualNumbersStep
        }
    }

    private var selectedContactsStep: some View {
        Group {
            Section {
                TextField("Search name, phone or email", text: $model.contactSearch)
                    .focused($focusedField, equals: .contactSearch)
                    .submitLabel(.done)
                    .onSubmit { focusedField = nil }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                LabeledContent("Selected", value: model.selectedContacts.count.formatted())
                if model.isLoadingContacts {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel("Searching contacts")
                }
            } footer: {
                Text("Search runs against the server. Selecting a contact does not confirm SMS eligibility.")
            }

            Section("Contacts") {
                if model.isLoadingContacts && model.contactResults.isEmpty {
                    ProgressView("Loading contacts")
                } else if let error = model.contactErrorMessage {
                    Text(error).font(.footnote).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await model.loadContacts() } }
                } else if model.contactResults.isEmpty {
                    Text("No contacts found").foregroundStyle(.secondary)
                } else {
                    ForEach(model.contactResults) { contact in
                        Button { model.toggle(contact) } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.displayName).font(.body.weight(.medium))
                                    Text(PhoneFormatter.pretty(contact.phone))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: model.isSelected(contact) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(model.isSelected(contact) ? ViciTheme.tint : Color.secondary)
                                    .accessibilityLabel(model.isSelected(contact) ? "Selected" : "Not selected")
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }
                if model.contactResultsTruncated {
                    Text("More contacts match. Refine the search to choose a specific person.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var allContactsStep: some View {
        Section("All Contacts Snapshot") {
            LabeledContent("Contacts", value: model.allContactsSnapshot.count.formatted())
            Label("This is not a list of eligible subscribers.", systemImage: "exclamationmark.shield")
                .font(.subheadline.weight(.semibold))
            Text("After the draft is saved, current consent, opt-outs, DND, invalid numbers, internal identities and other suppression rules are checked individually.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var manualNumbersStep: some View {
        Section {
            TextEditor(text: $model.recipientsText)
                .focused($focusedField, equals: .recipients)
                .font(.body.monospaced())
                .frame(minHeight: 180)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .accessibilityLabel("Campaign recipient phone numbers")
        } header: {
            Text("Enter Numbers")
        } footer: {
            Text("Enter one person per line as +15551234567 or Name, +15551234567. Duplicate numbers are removed. Eligibility is checked after the draft is saved.")
        }
    }

    private var audienceReviewStep: some View {
        Group {
            Section("Audience Summary") {
                LabeledContent("Mode", value: model.audienceMode.title)
                LabeledContent("Recipients", value: model.audienceCount.formatted())
                Text(model.audienceDescription)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                ForEach(Array(model.audienceInputs.prefix(50)), id: \.self) { recipient in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(recipient.name.flatMap { $0.isEmpty ? nil : $0 }
                                 ?? PhoneFormatter.pretty(recipient.phone))
                            if recipient.name?.isEmpty == false {
                                Text(PhoneFormatter.pretty(recipient.phone))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if model.audienceMode == .selectedContacts {
                            Button(role: .destructive) {
                                model.removeSelectedContact(phone: recipient.phone)
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .accessibilityLabel("Remove \(recipient.name ?? recipient.phone)")
                        }
                    }
                }
                if model.audienceCount > 50 {
                    Text("Plus \((model.audienceCount - 50).formatted()) more recipients")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Selected Audience")
            } footer: {
                Text("This is the requested audience, not the final eligible audience. No message is queued or sent from this screen.")
            }
        }
    }

    private var messageStep: some View {
        Group {
            Section("Message") {
                TextEditor(text: $model.message)
                    .frame(minHeight: 180)
                    .focused($focusedField, equals: .message)
                    .accessibilityLabel("Campaign message")
                HStack {
                    Text("Over 160 characters a message is sent in two parts and costs two credits. The recipient still sees one message.")
                    Spacer()
                    Text("\(model.messageCount)/1600").monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(model.messageCount > 1_600 ? ViciTheme.destructive : Color.secondary)
            }

            // Tapping inserts at the end rather than at the cursor. SwiftUI's
            // TextEditor exposes no selection range, and guessing one would
            // sometimes drop a variable into the middle of a word. The end is
            // always somewhere the writer can see it and move it.
            Section("Variables") {
                if model.mergeFields.isEmpty {
                    Text("Loading the variables this message may use.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.mergeFields) { field in
                                Button {
                                    model.insertVariable(field)
                                } label: {
                                    Text(field.label)
                                        .font(.caption.weight(.medium))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(ViciTheme.tint.opacity(0.12), in: Capsule())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Insert \(field.label)")
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    Text("These fill in per person when the campaign is approved. A variable this system cannot fill removes that one recipient rather than sending a gap.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if model.aiCopyEnabled {
                Section("Draft it with AI") {
                    TextEditor(text: $model.brief)
                        .frame(minHeight: 70)
                        .focused($focusedField, equals: .brief)
                        .accessibilityLabel("What the message should say")
                        .overlay(alignment: .topLeading) {
                            if model.brief.isEmpty {
                                Text("Say what the message should do, in your own words. Tap the microphone on the keyboard to speak it.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 8).padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                    // Two buttons, because they ask for different things. The
                    // second sends the message currently in the box, so an
                    // instruction like "shorter, and lead with the code" has
                    // something to act ON rather than starting from nothing.
                    Button {
                        Task { await model.draftWithAI() }
                    } label: {
                        if model.isDrafting {
                            HStack { ProgressView(); Text("Writing") }
                        } else {
                            Label("Write three versions", systemImage: "sparkles")
                        }
                    }
                    .disabled(model.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isDrafting)

                    if !model.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            Task { await model.draftWithAI(refining: true) }
                        } label: {
                            Label(model.refinementCount > 0 ? "Change it again" : "Change the message above",
                                  systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(model.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isDrafting)
                        .accessibilityHint("Rewrites the message you already have, using what you typed above")
                    }

                    ForEach(model.suggestions) { candidate in
                        // ── THE TAP HAS TO BE VISIBLE ────────────────────────
                        //
                        // This used to be `model.message = candidate.text` and
                        // nothing else. The message box is far enough down the
                        // form to be off screen, so the copy changed where the
                        // owner could not see it and the row looked dead. He
                        // reported it as the variants not registering a tap.
                        let isChosen = model.chosenSuggestion == candidate.text
                        Button {
                            model.chooseSuggestion(candidate)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: isChosen ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(isChosen ? ViciTheme.success : Color.secondary)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(candidate.text)
                                        .font(.footnote)
                                        .foregroundStyle(.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    HStack(spacing: 6) {
                                        if isChosen {
                                            Text("In the message box")
                                                .foregroundStyle(ViciTheme.success)
                                        }
                                        Text("\(candidate.septets) characters")
                                        // See the note on the preview below:
                                        // one message, two credits, no alarm.
                                        if !candidate.isSingleSegment {
                                            Label("2 credits", systemImage: "info.circle")
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .listRowBackground(isChosen ? ViciTheme.success.opacity(0.12) : nil)
                        .accessibilityAddTraits(isChosen ? [.isSelected] : [])
                        .accessibilityLabel(isChosen
                                            ? "Selected version: \(candidate.text)"
                                            : "Version: \(candidate.text)")
                    }
                    if !model.suggestions.isEmpty {
                        Text(model.chosenSuggestion == nil
                             ? "Every version above already passed the copy rules. Tap one to put it in the message box."
                             : "That version is now in the message box above. Edit it there, or type another instruction and tap Change it again.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if let campaignID = model.existingID {
                Section("See a real message") {
                    Button {
                        Task { await model.previewCurrentCopy(campaignID: campaignID) }
                    } label: {
                        if model.isPreviewing {
                            HStack { ProgressView(); Text("Rendering") }
                        } else {
                            Label("Preview what people receive", systemImage: "eye")
                        }
                    }
                    .disabled(model.isPreviewing || model.message.isEmpty)

                    if let preview = model.livePreview {
                        LabeledContent("Renders for") {
                            Text("\(preview.renderedCount) of \(preview.audienceCount)")
                                .font(.headline.monospacedDigit())
                                .foregroundStyle(preview.rendersForEveryone ? ViciTheme.success : ViciTheme.warning)
                        }
                        if !preview.rendersForEveryone {
                            Text("\(preview.excludedCount) cannot be personalised with this wording and would have to come out of the audience before it can be approved.")
                                .font(.footnote).foregroundStyle(ViciTheme.warning)
                        }
                        ForEach(preview.samples) { sample in
                            Text(sample.message)
                                .font(.footnote)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text("Nothing is saved by previewing, and the codes shown are placeholders. Real codes are created when you approve.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if let error = model.copyError {
                Section { Text(error).font(.footnote).foregroundStyle(ViciTheme.warning) }
            }
        }
    }

    private var safetyAndTimingStep: some View {
        Group {
            Section("Preview") {
                LabeledContent("Campaign", value: model.title)
                LabeledContent("Requested audience", value: model.audienceCount.formatted())
                Text(model.message)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Eligibility & Exclusions") {
                Label("Checked after draft save", systemImage: "checkmark.shield")
                    .font(.subheadline.weight(.semibold))
                Text("The preview will report eligible and suppressed recipients, including current opt-outs, DND, missing consent, invalid numbers, internal identities and active campaign suppressions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Timing") {
                LabeledContent("Next step", value: "Save and review")
                Text("There is no Send Now action. A schedule can be recorded only after review and approval, and it delivers only while live sending is switched on for this workspace.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var saveAndReviewStep: some View {
        if let saved = model.savedCampaign {
            Section("Draft Saved") {
                Label(saved.status.needsReview ? "Submitted for review" : "Saved as a draft",
                      systemImage: saved.status.needsReview ? "checkmark.seal.fill" : "doc.badge.checkmark")
                    .foregroundStyle(saved.status.needsReview ? ViciTheme.success : ViciTheme.tint)
                LabeledContent("Revision", value: saved.revision.formatted())
                LabeledContent("Status", value: saved.status.title)
                if model.existingID != nil {
                    Text("The edit created a new revision. Previous approval does not carry over.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if model.isCheckingEligibility {
                Section { ProgressView("Checking current eligibility") }
            } else if let dryRun = model.dryRun {
                CampaignEligibilitySection(dryRun: dryRun)
            } else {
                Section("Eligibility Preview") {
                    Label("Eligibility could not be checked.", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.secondary)
                    if let error = model.eligibilityErrorMessage {
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Try Again") { Task { await model.checkEligibility() } }
                }
            }

            if saved.status.isEditable {
                Section {
                    Text(model.canSubmitSavedDraft
                         ? "The draft can now be submitted for Admin review. Submission still does not send or schedule a message."
                         : "At least one currently eligible recipient is required before submitting this draft for review.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            Section("Final Review") {
                LabeledContent("Type", value: "Manual Campaign")
                LabeledContent("Campaign", value: model.title)
                LabeledContent("Requested audience", value: model.audienceCount.formatted())
                LabeledContent("Audience mode", value: model.audienceMode.title)
                Text(model.message)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section {
                Label("Saving creates or updates a draft. Nothing is sent.", systemImage: "lock.shield.fill")
                    .font(.footnote)
                Text("After saving, the app will run the server's current eligibility preview and show exclusions before you choose whether to submit the draft for review.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct CampaignReasonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let prompt: String
    let actionTitle: String
    let destructive: Bool
    var requiresReason = true
    let action: (String) async -> Void
    @State private var reason = ""
    @State private var isWorking = false
    @FocusState private var reasonFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $reason)
                        .frame(minHeight: 120)
                        .focused($reasonFocused)
                } footer: {
                    Text(prompt)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    KeyboardDoneButton { reasonFocused = false }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionTitle, role: destructive ? .destructive : nil) {
                        isWorking = true
                        Task { await action(reason.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    }
                    .disabled(isWorking || (requiresReason && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .interactiveDismissDisabled(isWorking)
        }
        .assistantDraftOwner(
            source: .campaign,
            isDirty: !reason.isEmpty,
            onDiscard: {
                reason = ""
                dismiss()
            }
        )
    }
}

private struct CampaignScheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let action: (Date) async -> Void
    @State private var scheduledFor = Date().addingTimeInterval(900)
    @State private var initialScheduledFor = Date().addingTimeInterval(900)
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Send Time") {
                    DatePicker("Schedule for",
                               selection: $scheduledFor,
                               in: Date()...,
                               displayedComponents: [.date, .hourAndMinute])
                }
                Section {
                    Text("The campaign sends at this time only while live sending is switched on for this workspace. Every recipient is checked again for consent, opt-outs and quiet hours at the moment of sending, not now.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Schedule Campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") {
                        isWorking = true
                        Task { await action(scheduledFor) }
                    }
                    .disabled(isWorking)
                }
            }
            .interactiveDismissDisabled(isWorking)
        }
        .assistantDraftOwner(
            source: .campaign,
            isDirty: abs(scheduledFor.timeIntervalSince(initialScheduledFor)) > 1,
            onDiscard: {
                scheduledFor = initialScheduledFor
                dismiss()
            }
        )
    }
}

/// The finished messages, as customers would read them.
///
/// WHY THIS SECTION EXISTS
///   The Message section above shows the TEMPLATE. Until this was added, a
///   reviewer approving copy containing {{first_name}} had no way to see a
///   single real message, which meant a campaign that personalises for 221 of
///   376 people looked exactly like one that personalises for all of them. It
///   also meant nobody could tell, by looking, that the merge fields were not
///   being substituted at all.
///
///   The counts come first and the samples second, deliberately. The number
///   that decides whether to approve is how many people drop out, not how
///   nicely the first message reads.
private struct CampaignPreviewSection: View {
    let preview: CampaignPreview
    /// Ids currently being removed, so a second tap cannot fire the same call.
    let removing: Set<String>
    let onRemove: (String) -> Void
    /// Whether the messages have already gone out. The section shows the same
    /// numbers either way and means different things by them, so it needs to
    /// know which question it is answering.
    let status: CampaignStatus

    var body: some View {
        // ── WHAT THIS SECTION IS FOR CHANGES ONCE THE MESSAGES ARE GONE ──
        //
        // Before approval it is a decision aid: who renders, who has to come
        // out of the audience, and what the wording looks like. After the
        // campaign has sent it is a record, and the two need different things.
        //
        // A sent campaign was showing "1 cannot be personalised and must be
        // removed from the audience before this can be approved" — advice
        // about an approval that happened yesterday, on a person who was
        // already excluded from a send that is finished. And it listed every
        // one of 375 messages, so reading the campaign meant scrolling past
        // all of them.
        let isFinished = status == .completed || status == .sending
        // ── THREE, ALWAYS ────────────────────────────────────────────────
        //
        // This showed all of them before approval, on the reasoning that a
        // reviewer deciding whether wording works should see the spread. The
        // owner's answer, having actually done that review: he needs three,
        // and a dozen means scrolling past a dozen to reach the approve
        // button.
        //
        // The number that decides an approval is how many people DROP OUT,
        // and that is stated above in one line. The samples are there to show
        // that the merge fields substitute at all, which three demonstrate as
        // well as three hundred.
        let sampleLimit = 3

        Section("What each person receives") {
            HStack {
                Label(isFinished
                        ? "\(preview.renderedCount) of \(preview.audienceCount) personalised"
                        : "\(preview.renderedCount) of \(preview.audienceCount) render",
                      systemImage: preview.rendersForEveryone || isFinished
                        ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(preview.rendersForEveryone || isFinished ? ViciTheme.success : ViciTheme.warning)
                Spacer()
                if let percent = preview.discountPercent {
                    Text("\(percent)% code")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if !preview.rendersForEveryone && !isFinished {
                // Not a warning to be dismissed. Approval is refused while any
                // selected recipient cannot be rendered, so this is the list of
                // people who have to come out of the audience first.
                //
                // Only before the send. Afterwards they were already left out,
                // and telling somebody to act before an approval that has
                // happened is noise dressed as an instruction.
                Text("\(preview.excludedCount) cannot be personalised and must be removed from the audience before this can be approved.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ForEach(preview.excluded) { row in
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent(row.name ?? row.phone.suffix(4).description,
                                       value: row.readableReason)
                            .font(.caption)

                        // What they would actually receive. Shown rather than
                        // described: "Use code BACK20 here: Reply STOP to opt
                        // out." makes the case for removal better than any
                        // sentence explaining it.
                        if let wouldRead = row.wouldRead, !wouldRead.isEmpty {
                            Text(wouldRead)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                        }

                        // The remedy, beside the problem. The instruction named
                        // a blocker and left somebody to find the number
                        // themselves; an instruction with no remedy is worse
                        // than no instruction.
                        if let recipientID = row.recipientID {
                            Button(role: .destructive) {
                                onRemove(recipientID)
                            } label: {
                                Label("Remove from audience", systemImage: "person.badge.minus")
                                    .font(.caption.weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                            .tint(ViciTheme.destructive)
                            .disabled(removing.contains(recipientID))
                        }
                    }
                    .padding(.vertical, 4)
                }
            } else if isFinished && preview.excludedCount > 0 {
                Text("\(preview.excludedCount) could not be personalised and were left out of the send.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(preview.samples.prefix(sampleLimit)) { sample in
                VStack(alignment: .leading, spacing: 4) {
                    Text(sample.message)
                        .font(.footnote)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Text("\(sample.message.count) characters")
                        // ── NOT A WARNING ───────────────────────────────
                        //
                        // This said "Two segments" beside an exclamation mark
                        // in warning colour, and the owner reasonably read it
                        // as something being wrong — his first question was
                        // whether people would receive the message twice.
                        //
                        // They do not. A segment is a billing unit, not a
                        // message: a long text is sent in parts and every
                        // handset joins them back into ONE message before
                        // anybody sees it. The only real consequence is that
                        // it costs two credits instead of one, so that is
                        // what it now says, in those words, without alarm.
                        if !sample.isSingleSegment {
                            Label("Arrives as one message, costs 2 credits",
                                  systemImage: "info.circle")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }

            if preview.samples.count > sampleLimit {
                Text("Showing 3 of \(preview.samples.count) messages.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Only true before approval. Afterwards the codes in these messages
            // are the real ones that went out, and calling them placeholders
            // would be a lie about a message somebody has already received.
            if !isFinished {
                Text("Codes shown here are placeholders. The real single-use codes are created when you approve, not now.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// What this campaign actually earned.
///
/// Measured, not modelled: every pound traces to a single-use code on a
/// specific paid order. That is why `attribution-policy.js` scores this above
/// a clicked link, and why the section says "measured" rather than
/// "estimated". Refunded and cancelled orders are excluded upstream, so a
/// campaign that attracted the wrong buyer does not get credit for it.
private struct CampaignCouponRevenueSection: View {
    let coupons: CampaignCouponRevenue

    var body: some View {
        Section("Revenue from the codes") {
            HStack {
                statTile("Issued", "\(coupons.issued ?? 0)")
                Divider()
                statTile("Redeemed", "\(coupons.redeemed ?? 0)")
                Divider()
                statTile("Rate", coupons.formattedRate)
            }
            LabeledContent("Revenue") {
                Text(coupons.formattedRevenue)
                    .font(.title3.weight(.semibold).monospacedDigit())
                    .foregroundStyle(ViciTheme.success)
            }
            Text("Each code works once and belongs to one person, so every order here is that customer acting on this message. Refunded and cancelled orders are not counted.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let anomalies = coupons.anomalies, !anomalies.isEmpty {
                // Surfaced rather than summed. A single-use code appearing
                // twice is a WooCommerce problem, not a second sale.
                DisclosureGroup("\(anomalies.count) needing a look") {
                    ForEach(anomalies) { row in
                        LabeledContent(row.code, value: row.readableReason)
                            .font(.caption)
                    }
                }
                .font(.footnote)
            }
        }
    }

    private func statTile(_ label: String, _ value: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.headline.monospacedDigit())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Build a campaign from a recipe, without leaving the app.
///
/// WHAT THIS REPLACED
///   Everything after "draft" already happened here: preview, edit, review,
///   approve, schedule. Everything BEFORE it happened in a terminal, so
///   creating a campaign meant running a script by hand on a laptop. This is
///   that script, behind a screen.
///
/// THE DRY RUN IS NOT OPTIONAL, AND THAT IS DELIBERATE
///   Picking a recipe checks the numbers first and writes nothing. A cohort
///   does not know who has already been messaged, so the interesting number is
///   rarely "how many qualify" and almost always "how many are left once the
///   people who already had this one are taken out". Showing that BEFORE the
///   Build button appears is what stops somebody building a duplicate campaign
///   and only noticing at the review step.
private struct CampaignRecipeSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onBuilt: () -> Void

    @State private var recipes: [CampaignRecipeSummary] = []
    @State private var selected: CampaignRecipeSummary?
    @State private var dryRun: CampaignBuildResult?
    @State private var isLoading = true
    @State private var isChecking = false
    @State private var isBuilding = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading campaigns")
                } else if recipes.isEmpty {
                    EmptyState(icon: "wand.and.stars",
                               title: "No campaigns to build",
                               detail: errorMessage ?? "This workspace has no campaign recipes configured.")
                        .padding(24)
                } else {
                    list
                }
            }
            .navigationTitle("Build a campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private var list: some View {
        List {
            ForEach(recipes) { recipe in
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(recipe.name)
                            .font(.headline)
                        Text(recipe.description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 8) {
                            Label(recipe.offerLabel, systemImage: "tag")
                            Label(recipe.dedupeLabel, systemImage: "clock.arrow.circlepath")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)

                    if selected?.key == recipe.key, let result = dryRun {
                        resultRows(result)
                    }

                    if selected?.key == recipe.key && isChecking {
                        HStack { ProgressView(); Text("Checking who qualifies").font(.footnote) }
                    } else if selected?.key != recipe.key {
                        Button("Check who qualifies") {
                            Task { await check(recipe) }
                        }
                        .disabled(isChecking || isBuilding)
                    }
                }
            }
            if let errorMessage, !recipes.isEmpty {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(ViciTheme.warning) }
            }
        }
    }

    @ViewBuilder
    private func resultRows(_ result: CampaignBuildResult) -> some View {
        LabeledContent("Qualify today", value: "\(result.candidates)")
        // The number that explains a small campaign. Shown even when zero, so
        // "nobody was excluded" is stated rather than inferred from absence.
        LabeledContent("Already had this one", value: "\(result.suppressedAsDuplicate)")
            .foregroundStyle(result.suppressedAsDuplicate > 0 ? ViciTheme.warning : .secondary)
        LabeledContent("Would be messaged") {
            Text("\(result.audience)")
                .font(.headline.monospacedDigit())
                .foregroundStyle(result.audience > 0 ? ViciTheme.success : .secondary)
        }

        if let note = result.note {
            Text(note)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if result.audience > 0 {
            ForEach(result.created) { group in
                LabeledContent(group.variant == "named" ? "Naming the product" : "Not naming it",
                               value: "\(group.recipients)")
                    .font(.caption)
            }
            Button {
                Task { await build() }
            } label: {
                if isBuilding {
                    HStack { ProgressView(); Text("Building") }
                } else {
                    Text("Create \(result.audience > 0 ? "the drafts" : "nothing")")
                }
            }
            .disabled(isBuilding)
            Text("Creates drafts only. Nothing is approved, scheduled or sent, and no code is created until you approve.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do { recipes = try await APIClient.shared.fetchCampaignRecipes() }
        catch { errorMessage = error.localizedDescription }
    }

    private func check(_ recipe: CampaignRecipeSummary) async {
        selected = recipe
        dryRun = nil
        isChecking = true
        errorMessage = nil
        defer { isChecking = false }
        do { dryRun = try await APIClient.shared.buildCampaign(recipe: recipe.key, dryRun: true) }
        catch {
            errorMessage = error.localizedDescription
            selected = nil
        }
    }

    private func build() async {
        guard let recipe = selected else { return }
        isBuilding = true
        errorMessage = nil
        defer { isBuilding = false }
        do {
            _ = try await APIClient.shared.buildCampaign(recipe: recipe.key, dryRun: false)
            onBuilt()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Describe a campaign in a sentence and get one back to review.
///
/// WHAT THIS REPLACED
///   Every piece of an arbitrary campaign already existed on a different
///   screen. Describing a segment in words lived under Segments; drafting copy
///   lived in the campaign editor; building an audience from a segment did not
///   exist at all until recently. Doing "a clearance on RT for people who
///   bought it and went quiet" meant three screens, four steps, and knowing
///   the order.
///
/// IT PROPOSES, THEN YOU DECIDE
///   Nothing is written until Create. The plan shows who, how many, what it
///   offers, what it says, and anything that would stop it, and each of those
///   can be wrong in a way worth catching before a segment and a campaign
///   exist.
private struct CampaignPlannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void

    @State private var brief = ""
    @State private var plan: CampaignPlan?
    @State private var chosenCopy: String?
    @State private var title = ""
    @State private var isPlanning = false
    @State private var isCreating = false
    @State private var errorMessage: String?
    @FocusState private var briefFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("What should this campaign do?") {
                    TextEditor(text: $brief)
                        .frame(minHeight: 90)
                        .focused($briefFocused)
                        .overlay(alignment: .topLeading) {
                            if brief.isEmpty {
                                Text("For example: a clearance on RT, 20% off, for anyone who has bought it. Tap the microphone on the keyboard to say it.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 8).padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                    Button {
                        Task { await makePlan() }
                    } label: {
                        if isPlanning {
                            HStack { ProgressView(); Text("Working it out") }
                        } else {
                            Label("Plan it", systemImage: "sparkles")
                        }
                    }
                    .disabled(brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isPlanning)
                }

                if let plan {
                    planSections(plan)
                }

                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(ViciTheme.warning) }
                }
            }
            .navigationTitle("Describe a campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }

    @ViewBuilder
    private func planSections(_ plan: CampaignPlan) -> some View {
        Section("Who it reaches") {
            if let audience = plan.audience {
                LabeledContent("People") {
                    Text("\(audience.matchedCount)")
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(audience.matchedCount > 0 ? ViciTheme.success : ViciTheme.warning)
                }
                Text(audience.description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let error = plan.audienceError {
                Text(error.message).font(.footnote).foregroundStyle(ViciTheme.warning)
            }
            LabeledContent("Offer", value: plan.offerLabel)
        }

        // Shown above the copy, because a blocking warning makes the copy
        // irrelevant and reading it first wastes the reviewer's attention.
        if !plan.warnings.isEmpty {
            Section("Worth knowing") {
                ForEach(plan.warnings) { warning in
                    Label(warning.message, systemImage: warning.isBlocking
                          ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(warning.isBlocking ? ViciTheme.destructive : ViciTheme.warning)
                }
            }
        }

        Section("What it says") {
            if plan.copy.isEmpty {
                Text(plan.copyError?.message ?? "No copy could be written.")
                    .font(.footnote).foregroundStyle(ViciTheme.warning)
            }
            ForEach(plan.copy) { candidate in
                Button {
                    chosenCopy = candidate.text
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: chosenCopy == candidate.text
                              ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(chosenCopy == candidate.text ? ViciTheme.tint : .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(candidate.text)
                                .font(.footnote)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("\(candidate.septets) characters")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }

        if plan.ready {
            Section("Create it") {
                TextField("Name this campaign", text: $title)
                Button {
                    Task { await create(plan) }
                } label: {
                    if isCreating {
                        HStack { ProgressView(); Text("Creating") }
                    } else {
                        Text("Create the draft")
                    }
                }
                .disabled(isCreating || chosenCopy == nil
                          || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("Creates a segment and a draft campaign. Nothing is approved, scheduled or sent, and no code exists until you approve.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func makePlan() async {
        isPlanning = true
        errorMessage = nil
        chosenCopy = nil
        briefFocused = false
        defer { isPlanning = false }
        do {
            let result = try await APIClient.shared.planCampaign(brief: brief)
            plan = result
            // Preselect the first, since most of the time it is the one used
            // and an unselected radio list reads as an unfinished screen.
            chosenCopy = result.copy.first?.text
            if title.isEmpty { title = String(brief.prefix(60)) }
        } catch {
            errorMessage = error.localizedDescription
            plan = nil
        }
    }

    private func create(_ plan: CampaignPlan) async {
        guard let audience = plan.audience, let ruleSet = audience.ruleSet, let message = chosenCopy else { return }
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            _ = try await APIClient.shared.acceptCampaignPlan(
                title: title,
                audienceDescription: audience.description,
                ruleSet: ruleSet,
                message: message,
                discountPercent: plan.discountPercent,
                workflowCategory: plan.workflowCategory
            )
            onCreated()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
