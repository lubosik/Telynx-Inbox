import SwiftUI

private enum VIPCampaignFocus: String, CaseIterable, Identifiable {
    case all
    case pastTiming
    case atTiming
    case withinTiming
    case noTiming

    var id: String { rawValue }

    func includes(_ conversation: ConversationSummary) -> Bool {
        switch self {
        case .all: return true
        case .pastTiming: return conversation.vipState == "needs_attention"
        case .atTiming: return conversation.vipState == "due_soon"
        case .withinTiming:
            return conversation.vipState == "active" && conversation.typicalOrderGapDays != nil
        case .noTiming: return conversation.typicalOrderGapDays == nil
        }
    }

    var label: String {
        switch self {
        case .all: return "All VIPs"
        case .pastTiming: return "Past usual timing"
        case .atTiming: return "At usual timing"
        case .withinTiming: return "Within usual timing"
        case .noTiming: return "No reliable timing"
        }
    }

    var detail: String {
        switch self {
        case .all: return "Every current VIP customer"
        case .pastTiming: return "Personal check-ins for customers beyond their usual pattern"
        case .atTiming: return "Customers currently around their usual reorder pattern"
        case .withinTiming: return "Active customers still within their usual pattern"
        case .noTiming: return "VIPs without enough history for a reliable pattern"
        }
    }

    var campaignTitle: String {
        switch self {
        case .all: return "VIP customer update"
        case .pastTiming: return "VIP personal check-in"
        case .atTiming: return "VIP first-access invitation"
        case .withinTiming: return "VIP loyalty thank-you"
        case .noTiming: return "VIP customer feedback"
        }
    }

    var campaignMessage: String {
        switch self {
        case .all:
            return "Vin from Vici: Hi {{first_name}}, thanks for being one of our best customers. Want first access to new arrivals and offers?"
        case .pastTiming:
            return "Vin from Vici: Hi {{first_name}}, I wanted to check in personally. Is there anything we could improve for you?"
        case .atTiming:
            return "Vin from Vici: Hi {{first_name}}, I wanted to give you first access to our next new arrival. Would you like the details?"
        case .withinTiming:
            return "Vin from Vici: Hi {{first_name}}, thanks for being one of our best customers. Would you like first access to our next release?"
        case .noTiming:
            return "Vin from Vici: Hi {{first_name}}, thanks for being one of our best customers. What would you like to see from Vici next?"
        }
    }

    var campaignBrief: String {
        switch self {
        case .all:
            return "Thank all VIP customers and invite them to ask for first access to verified new arrivals or a real VIP offer."
        case .pastTiming:
            return "Write a warm personal check-in from Vin. Ask how Vici can improve. Never mention tracking, cadence, being overdue or running low."
        case .atTiming:
            return "Invite VIP customers to request first access to a verified new arrival. Never mention reorder timing or monitoring."
        case .withinTiming:
            return "Thank current VIP customers and offer first access to the next verified release. Keep it conversational."
        case .noTiming:
            return "Thank VIP customers and ask what they would like to see from Vici next. Do not invent a timing or product recommendation."
        }
    }
}

struct CampaignsView: View {
    @ObservedObject var inboxModel: InboxModel
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @StateObject private var model = CampaignListModel()
    @State private var showingNewCampaign = false
    @State private var showingPlanner = false
    @State private var showingVIPCampaigns = false
    @State private var showingVIPPlaybook = false

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
        .sheet(isPresented: $showingPlanner) {
            CampaignPlannerSheet {
                Task { await model.load(reset: true) }
            }
        }
        .sheet(isPresented: $showingVIPCampaigns) {
            VIPCampaignHubView(conversations: vipConversations) {
                Task { await model.load(reset: true) }
            }
        }
        .sheet(isPresented: $showingVIPPlaybook) {
            VIPPlaybookSheet()
        }
        .refreshable {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load(reset: true)
            await inboxModel.load()
        }
        .task(id: session.can(Permission.campaignsRead)) {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load()
            await inboxModel.load()
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

    private var vipConversations: [ConversationSummary] {
        inboxModel.conversations.filter(\.isVIP)
    }

    private var vipSegmentID: String? {
        vipConversations.compactMap(\.vipSegmentID).first { !$0.isEmpty }
    }

    private var campaignList: some View {
        List {
            Section { CampaignSafetyNotice() }

            if !vipConversations.isEmpty {
                Section("VIP customers") {
                    if session.can(Permission.campaignsManage) {
                        Button { showingVIPCampaigns = true } label: {
                            Label("Create a VIP campaign", systemImage: "crown")
                        }
                    }
                    if let vipSegmentID {
                        Button {
                            router.open(.segment(id: vipSegmentID, name: "Best Repeat Customers"))
                        } label: {
                            Label("Open VIP audience", systemImage: "person.3")
                        }
                    }
                    Button { showingVIPPlaybook = true } label: {
                        Label("VIP offer ideas", systemImage: "gift")
                    }
                }
            }

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

                    if !vipConversations.isEmpty {
                        Button("Create a VIP Campaign") { showingVIPCampaigns = true }
                            .buttonStyle(.bordered)
                    }

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

private struct VIPCampaignHubView: View {
    let conversations: [ConversationSummary]
    let onSaved: () -> Void
    @State private var selectedFocus: VIPCampaignFocus?
    @Environment(\.dismiss) private var dismiss

    private func customers(for focus: VIPCampaignFocus) -> [ConversationSummary] {
        conversations.filter(focus.includes)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Choose who you want to speak to. The app selects that group and starts with editable, personalized copy. Nothing sends from this screen.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Choose a VIP group") {
                    ForEach(VIPCampaignFocus.allCases) { focus in
                        let count = customers(for: focus).count
                        Button {
                            selectedFocus = focus
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: focus == .all ? "crown.fill" : "person.2")
                                    .foregroundStyle(focus == .all ? Color.orange : ViciTheme.tint)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(focus.label).foregroundStyle(.primary)
                                    Text(focus.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 8)
                                Text(count.formatted())
                                    .font(.subheadline.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                        .disabled(count == 0)
                        .accessibilityLabel("Draft for \(focus.label), \(count) customers")
                    }
                }

                Section {
                    Text("Timing groups are planning tools. Customer copy never says that somebody is overdue, being monitored, or expected to reorder.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("VIP Campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(item: $selectedFocus) { focus in
                CampaignEditorView(
                    initialContacts: customers(for: focus),
                    initialTitle: focus.campaignTitle,
                    initialMessage: focus.campaignMessage,
                    initialBrief: focus.campaignBrief,
                    workflowCategory: "vip",
                    onSaved: onSaved
                )
            }
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
    @EnvironmentObject private var appearance: AppearanceModel
    @StateObject private var model: CampaignDetailModel
    @State private var showingEditor = false
    @State private var showingMessageEditor = false
    @State private var editorRecipients: [CampaignRecipient] = []
    @State private var preparingEditor = false
    @State private var confirmingApproval = false
    @State private var showingRejection = false
    @State private var showingSchedule = false
    @State private var showingCancellation = false
    @State private var showingAllRecipients = false
    @State private var confirmingRemoveAllExcluded = false

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
        .sheet(isPresented: $showingMessageEditor) {
            if let campaign = model.campaign {
                CampaignMessageEditSheet(message: campaign.message) { message in
                    await model.saveMessage(message)
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
            let existing = model.campaign.flatMap { ServerDate.parse($0.scheduledFor) }
            let businessZone = model.detail?.scheduling?.businessTimeZone ?? "America/New_York"
            CampaignScheduleSheet(existingDate: existing,
                                  businessTimeZoneID: businessZone,
                                  viewerTimeZone: appearance.effectiveTimeZone,
                                  actorName: session.currentUser?.displayName ?? "this account") { date in
                showingSchedule = false
                await confirmThenSchedule(for: date, rescheduling: existing != nil)
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
        .confirmationDialog("Remove every blocked recipient?",
                            isPresented: $confirmingRemoveAllExcluded,
                            titleVisibility: .visible) {
            Button("Remove all \(model.preview?.excludedCount ?? 0)", role: .destructive) {
                Task { await model.removeAllExcludedRecipients() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deselects the exact people the current message cannot personalise. It does not delete their contact records, approve the campaign or send anything.")
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
    private func confirmThenSchedule(for date: Date, rescheduling: Bool) async {
        let outcome = await BiometricConfirmation.confirm(
            reason: rescheduling
                ? "Confirm the new send time for this campaign"
                : "Confirm scheduling this campaign to go out to customers"
        )
        guard outcome != .declined else { return }
        if rescheduling { await model.reschedule(for: date) }
        else { await model.schedule(for: date) }
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
                if let scheduled = ServerDate.parse(campaign.scheduledFor) {
                    let businessZone = TimeZone(identifier: model.detail?.scheduling?.businessTimeZone
                                                ?? "America/New_York")
                        ?? TimeZone(identifier: "America/New_York")!
                    LabeledContent("Customer send time",
                                   value: formattedSchedule(scheduled, in: businessZone))
                    if businessZone.identifier != appearance.effectiveTimeZone.identifier {
                        LabeledContent("Your time",
                                       value: formattedSchedule(scheduled,
                                                                in: appearance.effectiveTimeZone))
                    }
                    if let scheduler = model.detail?.scheduling?.scheduledBy {
                        LabeledContent("Scheduled by", value: scheduler.name)
                    } else {
                        LabeledContent("Scheduled by", value: "Automation")
                    }
                } else if let date = keyDate(for: campaign) {
                    LabeledContent(keyDateLabel(for: campaign),
                                   value: date.formatted(date: .abbreviated, time: .shortened))
                }
                LabeledContent("Type", value: campaign.workflowCategory.replacingOccurrences(of: "_", with: " ").capitalized)
            }

            Section {
                Text(campaign.message)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text("This is the reusable template. Customer names and coupon fields are filled below in Customer Message Preview.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if campaign.finalMessage != nil && !campaign.status.isEditable {
                    Label("This is the message frozen for this revision.", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                HStack {
                    Text("Campaign Template")
                    Spacer()
                    if campaign.status.isEditable && session.can(Permission.campaignsManage) {
                        Button { showingMessageEditor = true } label: {
                            Image(systemName: "pencil.circle.fill")
                        }
                        .accessibilityLabel("Edit customer message")
                    }
                }
            }

            if let preview = model.preview {
                CampaignPreviewSection(
                    preview: preview,
                    removing: model.removingRecipients,
                    isRemovingAll: model.isRemovingExcludedRecipients,
                    onRemove: { id in Task { await model.removeRecipient(id) } },
                    onRemoveAll: campaign.status.isEditable && session.can(Permission.campaignsManage)
                        ? { confirmingRemoveAllExcluded = true } : nil,
                    onEditMessage: campaign.status.isEditable && session.can(Permission.campaignsManage)
                        ? { showingMessageEditor = true } : nil,
                    status: campaign.status
                )
            } else {
                CampaignPreviewLoadingSection(
                    isLoading: model.isLoadingPreview || model.previewErrorMessage == nil,
                    errorMessage: model.previewErrorMessage,
                    onRetry: { Task { await model.refreshPreview() } }
                )
            }

            // A rejection belongs to the revision it decided. Once that copy
            // is edited the campaign is a new draft; showing the old reason as
            // if it described the current revision makes a fixed campaign look
            // rejected forever.
            if campaign.status == .rejected,
               let rejection = campaign.rejectionReason, !rejection.isEmpty {
                Section("Reason for changes") { Text(rejection) }
            }
            if let cancellation = campaign.cancellationReason, !cancellation.isEmpty {
                Section("Cancellation reason") { Text(cancellation) }
            }

            // Put the one-handset proof directly below the exact rendered
            // customer messages. It is part of reviewing the message, not an
            // unrelated action buried beneath results and eligibility.
            if session.can(Permission.campaignsApprove),
               campaign.status != .sending,
               !campaign.status.isTerminal {
                CampaignTestSendSection(campaignID: campaign.id, offerLabel: campaign.offerLabel)
            }

            // Approval and scheduling are immediate next steps after reading
            // the exact message and proving it on one phone.
            actionSection(campaign)

            if let performance = model.performance {
                CampaignPerformanceSection(performance: performance)
                if let coupons = performance.coupons, coupons.hasCodes {
                    CampaignCouponRevenueSection(coupons: coupons)
                }
            }

            // Kept only for a campaign that genuinely has tiered attribution
            // data. The measured campaign results above remain the primary
            // results section and this never displays an empty headline.
            if session.can(Permission.analyticsRead),
               let financial = model.financial,
               financial.availability.revenueAttribution,
               financial.orders.attributed > 0 || financial.orders.influenced > 0 {
                CampaignFinancialSection(campaignID: campaign.id, financial: financial)
            }

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
                Section(approval.revision == campaign.revision
                        ? "Current Revision Decision"
                        : "Previous Revision History") {
                    LabeledContent("Decision", value: approval.decision.capitalized)
                    LabeledContent("Revision", value: approval.revision.formatted())
                    LabeledContent("Recipients", value: approval.recipientCount.formatted())
                    if let date = ServerDate.parse(approval.decidedAt) {
                        LabeledContent("Recorded", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                    if approval.revision != campaign.revision {
                        Text("That decision applied to revision \(approval.revision). Revision \(campaign.revision) is currently \(campaign.status.title) and has not inherited it.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
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

            fullEditorSection(campaign)
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
                    Button("Submit for Review") {
                        Task { await model.submitForReview() }
                    }
                    .disabled(!model.canSubmitForReview)
                    .accessibilityHint(model.canSubmitForReview
                                       ? "Submits the current draft for internal review."
                                       : reviewSubmissionHint)

                    if !model.canSubmitForReview {
                        Text(reviewSubmissionHint)
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

                if campaign.status == .scheduled && canLaunch {
                    Button("Reschedule Campaign") { showingSchedule = true }
                        .disabled(model.isActing)
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

    private var reviewSubmissionHint: String {
        if model.isLoadingPreview || model.preview == nil {
            return "Wait for Customer Message Preview to finish loading before submitting."
        }
        if let excluded = model.preview?.excludedCount, excluded > 0 {
            return "Remove all \(excluded) contacts whose messages cannot be personalised before submitting."
        }
        if model.dryRun == nil || model.dryRun?.eligible == 0 {
            return "Run a successful eligibility check with at least one eligible recipient before submitting."
        }
        return "The campaign is ready to submit for internal review."
    }

    @ViewBuilder
    private func fullEditorSection(_ campaign: CampaignRecord) -> some View {
        if campaign.status.isEditable && session.can(Permission.campaignsManage) {
            Section {
                Button {
                    prepareEditor()
                } label: {
                    if preparingEditor {
                        Label("Preparing Full Editor", systemImage: "hourglass")
                    } else {
                        Label("Edit Full Campaign", systemImage: "slider.horizontal.3")
                    }
                }
                .disabled(preparingEditor || model.isActing)
            } header: {
                Text("Campaign Settings")
            } footer: {
                Text("Change the title, offer or audience here. Use the pencil beside the message for quick copy edits.")
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
        if campaign.approvedAt != nil { return "Approved" }
        if campaign.submittedForReviewAt != nil { return "Submitted" }
        return "Created"
    }

    private func formattedSchedule(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = timeZone
        formatter.dateFormat = "EEE, MMM d 'at' h:mm a zzz"
        return "\(formatter.string(from: date)) · \(timeZone.identifier)"
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
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model: CampaignEditorModel
    @FocusState private var focusedField: CampaignWizardField?
    @State private var showingCouponBuilder = false
    let onSaved: () -> Void

    init(campaign: CampaignRecord? = nil,
         recipients: [CampaignRecipient] = [],
         initialContacts: [ConversationSummary] = [],
         initialTitle: String = "",
         initialMessage: String = "Vin from Vici: ",
         initialBrief: String = "",
         workflowCategory: String = "manual",
         onSaved: @escaping () -> Void) {
        _model = StateObject(wrappedValue: CampaignEditorModel(campaign: campaign,
                                                               recipients: recipients,
                                                               initialContacts: initialContacts,
                                                               seedTitle: initialTitle,
                                                               seedMessage: initialMessage,
                                                               seedBrief: initialBrief,
                                                               seedWorkflowCategory: workflowCategory))
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
            .sheet(isPresented: $showingCouponBuilder) {
                CampaignCouponBuilderSheet { coupon in
                    model.attachCoupon(coupon)
                }
            }
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
                .accessibilityAddTraits(model.audienceMode == mode ? .isSelected : [])
            }
            if model.isLoadingContacts && !model.hasLoadedContactSnapshot {
                ProgressView("Checking contact-list size")
            } else if !model.hasLoadedContactSnapshot {
                Text("Loading the current contact total.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if !model.allContactsAvailable {
                Text("No contacts are available yet.")
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
        Section("All Contacts") {
            LabeledContent("Contacts", value: model.allContactsTotal.formatted())
            Label("The server freezes the complete list when you create the draft.", systemImage: "person.3.fill")
                .font(.subheadline.weight(.semibold))
            Text("This count is not permission to message everyone. Current consent, opt-outs, DND, invalid numbers, internal identities and other suppression rules are checked individually before delivery.")
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
                if model.audienceMode == .allContacts {
                    Label("Complete contact list selected", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(ViciTheme.success)
                    Text("The final eligible total appears after the draft is saved and checked against live consent and suppression data.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
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
                }
                if model.audienceMode != .allContacts && model.audienceCount > 50 {
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
                Text("Keep Vin from Vici at the start and end with: Reply STOP to opt out.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Line breaks, extra spaces, and smart phone punctuation are tidied automatically before review. You will see the exact wording before saving.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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

            if session.can(Permission.campaignsApprove) {
                Section("Campaign Coupon") {
                    if let coupon = model.attachedCoupon {
                        Label("\(coupon.code) attached", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(ViciTheme.success)
                        LabeledContent("Discount", value: "\(coupon.percent)%")
                        LabeledContent("Minimum order", value: coupon.minimumAmount > 0
                                       ? "$\(Int(coupon.minimumAmount))" : "None")
                        LabeledContent("Total uses", value: coupon.usageLimit.formatted())
                        LabeledContent("Per customer", value: coupon.usageLimitPerUser.formatted())
                        if let expiry = coupon.expiry {
                            LabeledContent("Expires", value: String(expiry.prefix(10)))
                        }
                        Text("The coupon is live in WooCommerce, but this campaign is still only a draft. Nothing has been sent or scheduled.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if let code = model.existingCouponCode,
                              let percent = model.existingDiscountPercent {
                        Label("\(code) attached", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(ViciTheme.success)
                        LabeledContent("Discount", value: "\(percent)%")
                        Text("Previews and test messages use this exact WooCommerce coupon.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button {
                            showingCouponBuilder = true
                        } label: {
                            Label("Generate Coupon", systemImage: "ticket.fill")
                        }
                        Text("Create a WooCommerce coupon, configure its limits, and attach it to this draft. This never sends the campaign.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if model.aiCopyEnabled {
                Section("Copy assistant") {
                    Button {
                        Task { await model.suggestValidCopy() }
                    } label: {
                        if model.isDrafting {
                            HStack { ProgressView(); Text("Writing three versions") }
                        } else {
                            Label("Improve this message", systemImage: "wand.and.stars")
                        }
                    }
                    .disabled(!model.canSuggestValidCopy)
                    .accessibilityHint("Rewrites the message above in your style and shows only versions that pass the campaign copy checks")

                    Text("Get three ready-to-use versions in your usual tone. Your message changes only after you choose one.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Text("Describe a different message or change")
                        .font(.subheadline.weight(.semibold))
                    TextEditor(text: $model.brief)
                        .frame(minHeight: 70)
                        .focused($focusedField, equals: .brief)
                        .accessibilityLabel("What the message should say")
                        .overlay(alignment: .topLeading) {
                            if model.brief.isEmpty {
                                Text("For example: make it shorter and lead with Apple Pay. Tap the microphone to speak it.")
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
                            Label("Create three versions", systemImage: "sparkles")
                        }
                    }
                    .disabled(model.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isDrafting)

                    if !model.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            Task { await model.draftWithAI(refining: true) }
                        } label: {
                            Label(model.refinementCount > 0 ? "Apply another change" : "Apply this to the message",
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

            if session.can(Permission.campaignsApprove) {
                CampaignTestSendSection(campaignID: saved.id, offerLabel: saved.offerLabel)
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

/// A deliberately isolated one-message proving ground. It calls the test-send
/// endpoint only: no approval, schedule, audience or delivery action is
/// reachable from this view.
private struct CampaignTestSendSection: View {
    let campaignID: String
    let offerLabel: String?

    @State private var phone = ""
    @State private var isSending = false
    @State private var result: CampaignTestSendResponse?
    @State private var errorMessage: String?
    @State private var confirming = false

    private var cleanPhone: String {
        phone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isValidE164: Bool {
        cleanPhone.range(of: #"^\+[1-9][0-9]{7,14}$"#, options: .regularExpression) != nil
    }

    var body: some View {
        Section {
            TextField("+13055551234", text: $phone)
                .keyboardType(.phonePad)
                .textContentType(.telephoneNumber)
                .accessibilityLabel("Test phone number")

            if cleanPhone.isEmpty {
                Text("Enter the phone that should receive the test in full international format. The button will then become available.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let offerLabel {
                Label("This test will use \(offerLabel).", systemImage: "ticket.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(offerLabel.contains("not attached") ? ViciTheme.warning : ViciTheme.success)
            }

            if !cleanPhone.isEmpty && !isValidE164 {
                Label("Use full international format, starting with + and country code.",
                      systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.warning)
            }

            Button {
                confirming = true
            } label: {
                if isSending {
                    HStack { ProgressView(); Text("Sending One Test") }
                } else {
                    Label("Send One Test Message", systemImage: "iphone.and.arrow.forward")
                }
            }
            .disabled(!isValidE164 || isSending)

            if let result {
                Label("Test sent to \(PhoneFormatter.pretty(result.to))",
                      systemImage: "checkmark.circle.fill")
                    .foregroundStyle(ViciTheme.success)
                    .font(.subheadline.weight(.semibold))
                Text(result.message)
                    .font(.footnote)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(result.segments) SMS credit\(result.segments == 1 ? "" : "s"). The campaign and audience were not changed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Test on a Phone")
        } footer: {
            Text("This sends one real SMS to the number above with the exact attached coupon. It does not approve, schedule or send the campaign to its audience.")
        }
        .confirmationDialog("Send one real test message?",
                            isPresented: $confirming,
                            titleVisibility: .visible) {
            Button("Send Test to \(cleanPhone)") {
                Task { await sendTest() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only this test number will receive it. The campaign audience and schedule stay untouched.")
        }
        .alert("Test message was not sent", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Please try again.")
        }
    }

    private func sendTest() async {
        guard isValidE164, !isSending else { return }
        isSending = true
        result = nil
        defer { isSending = false }
        do {
            result = try await APIClient.shared.sendCampaignTest(id: campaignID, to: cleanPhone)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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
    let businessTimeZone: TimeZone
    let viewerTimeZone: TimeZone
    let actorName: String
    let isRescheduling: Bool
    @State private var scheduledFor: Date
    @State private var initialScheduledFor: Date
    @State private var isWorking = false

    init(existingDate: Date?,
         businessTimeZoneID: String,
         viewerTimeZone: TimeZone,
         actorName: String,
         action: @escaping (Date) async -> Void) {
        let now = Date()
        // An overdue campaign can still be scheduled while live sending is
        // gated off. Do not initialise DatePicker outside its future-only
        // range; show the old time on the detail screen and start the edit at
        // the next sensible time instead.
        let initial = existingDate.flatMap { $0 > now ? $0 : nil }
            ?? now.addingTimeInterval(900)
        businessTimeZone = TimeZone(identifier: businessTimeZoneID)
            ?? TimeZone(identifier: "America/New_York")!
        self.viewerTimeZone = viewerTimeZone
        self.actorName = actorName
        isRescheduling = existingDate != nil
        _scheduledFor = State(initialValue: initial)
        _initialScheduledFor = State(initialValue: initial)
        self.action = action
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Schedule for",
                               selection: $scheduledFor,
                               in: Date()...,
                               displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, businessTimeZone)
                } header: {
                    Text("Send time")
                } footer: {
                    Text("Choose the customer send time in \(businessTimeZone.identifier).")
                }

                Section("Exact timing") {
                    LabeledContent("Customer time") {
                        Text(formatted(scheduledFor, in: businessTimeZone))
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Your time") {
                        Text(formatted(scheduledFor, in: viewerTimeZone))
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Recorded as", value: actorName)
                }
                Section {
                    Text("The campaign sends at this time only while live sending is switched on for this workspace. Every recipient is checked again for consent, opt-outs and quiet hours at the moment of sending, not now.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(isRescheduling ? "Reschedule Campaign" : "Schedule Campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isRescheduling ? "Reschedule" : "Schedule") {
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

    private func formatted(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = timeZone
        formatter.dateFormat = "EEE, MMM d 'at' h:mm a zzz"
        return "\(formatter.string(from: date)) · \(timeZone.identifier)"
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
    let isRemovingAll: Bool
    let onRemove: (String) -> Void
    let onRemoveAll: (() -> Void)?
    let onEditMessage: (() -> Void)?
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
        Section {
            HStack {
                Label("What each person receives", systemImage: "message.fill")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let onEditMessage {
                    Button(action: onEditMessage) {
                        Image(systemName: "pencil.circle.fill")
                    }
                    .accessibilityLabel("Edit customer message")
                }
            }
            Text("These are the exact customer-facing messages after names and the verified coupon are filled in.")
                .font(.footnote)
                .foregroundStyle(.secondary)

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
                    Text(preview.couponCode.map { "\($0) · \(percent)% off" }
                         ?? "\(percent)% · coupon not attached")
                        .font(.caption)
                        .foregroundStyle(preview.couponCode == nil ? ViciTheme.warning : Color.secondary)
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
                if let onRemoveAll {
                    Button(role: .destructive, action: onRemoveAll) {
                        if isRemovingAll {
                            HStack { ProgressView(); Text("Removing blocked recipients") }
                        } else {
                            Label("Remove all \(preview.excludedCount)", systemImage: "person.2.badge.minus")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.destructive)
                    .disabled(isRemovingAll)
                }
                // One representative failure is enough to explain the issue.
                // The complete count remains above and Remove all acts on the
                // complete server-computed set, not merely this example.
                ForEach(preview.excluded.prefix(1)) { row in
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
                if preview.excludedCount > 1 {
                    Text("Showing 1 example. Remove all applies to all \(preview.excludedCount) blocked contacts.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if isFinished && preview.excludedCount > 0 {
                Text("\(preview.excludedCount) could not be personalised and were left out of the send.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // One successful message plus the representative failure above
            // are the only two examples needed to understand this campaign.
            ForEach(preview.samples.prefix(1)) { sample in
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

            // Only true before approval. Afterwards the codes in these messages
            // are the real ones that went out, and calling them placeholders
            // would be a lie about a message somebody has already received.
            if !isFinished, preview.couponCode == nil {
                Text("Codes shown here are placeholders. The real single-use codes are created when you approve, not now.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if !isFinished, let couponCode = preview.couponCode {
                Text("\(couponCode) is the exact verified WooCommerce coupon used by previews, phone tests and the final campaign.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Customer Message Preview")
        }
    }
}

/// The preview has a permanent home even before its network request returns.
/// Without this, the whole section appeared out of nowhere several seconds
/// after opening a campaign, so a new operator had no reason to wait for it.
private struct CampaignPreviewLoadingSection: View {
    let isLoading: Bool
    let errorMessage: String?
    let onRetry: () -> Void

    var body: some View {
        Section {
            if isLoading {
                HStack(spacing: 12) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Loading customer messages")
                            .font(.subheadline.weight(.semibold))
                        Text("Checking names, coupon details and the exact message each person would receive.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Customer message preview is loading")
            } else {
                Label("The customer message preview could not load.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ViciTheme.warning)
                if let errorMessage, !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button("Try Loading Preview Again", action: onRetry)
            }
        } header: {
            Text("Customer Message Preview")
        } footer: {
            Text("Submit for Review stays unavailable until this preview finishes and every message can be personalised.")
        }
    }
}

private struct CampaignMessageEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let initialMessage: String
    @State private var message: String
    @State private var errorMessage: String?
    @State private var isSaving = false
    @FocusState private var messageFocused: Bool
    let onSave: (String) async -> CampaignMessageSaveOutcome

    init(message: String, onSave: @escaping (String) async -> CampaignMessageSaveOutcome) {
        initialMessage = message
        _message = State(initialValue: message)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $message)
                        .frame(minHeight: 180)
                        .focused($messageFocused)
                    Text("\(message.count) characters")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Customer Message")
                } footer: {
                    Text("Save updates the campaign revision, customer preview and eligibility estimate. It does not change the audience, approve, schedule or send the campaign.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(ViciTheme.warning)
                    }
                }
            }
            .navigationTitle("Edit Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    KeyboardDoneButton { messageFocused = false }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(isSaving)
        }
        .assistantDraftOwner(
            source: .campaign,
            isDirty: message != initialMessage,
            onDiscard: { dismiss() }
        )
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        let outcome = await onSave(message)
        if let normalized = outcome.normalizedMessage { message = normalized }
        errorMessage = outcome.errorMessage
        if outcome.saved { dismiss() }
    }
}

/// What this campaign earned, and the orders that prove it.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// WHY THERE IS ONE SECTION HERE AND THERE WERE TWO
///
///   "Revenue from the codes" said $626.10. "Revenue Attribution", directly
///   below it, said $0.00 — for the same campaign, in a bigger font, with the
///   confidence tiers and the evidence link.
///
///   The owner's read was that they are the same thing, and he was right about
///   something worse: NOTHING has ever written to sms_campaign_attributions,
///   so the tiered section could only ever show zero. A headline number that
///   is structurally incapable of being right, sitting above one that is
///   measured, teaches somebody to distrust both.
///
///   So: one section, backed by the thing that actually works. Every pound
///   traces to a code on a specific paid order, which is why it says measured
///   rather than estimated.
///
/// WHY THE ORDERS ARE HERE RATHER THAN A SCREEN AWAY
///
///   The owner's words: so the client knows the app is not making this up. A
///   number somebody has to navigate to verify is a number they stop
///   verifying.
private struct CampaignCouponRevenueSection: View {
    let coupons: CampaignCouponRevenue

    var body: some View {
        Section("Revenue from this campaign") {
            VStack(alignment: .leading, spacing: 4) {
                Text(coupons.formattedRevenue)
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(ViciTheme.success)
                Text("\(coupons.redeemed ?? 0) of \(coupons.issued ?? 0) codes redeemed, \(coupons.formattedRate)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let redemptions = coupons.redemptions, !redemptions.isEmpty {
                DisclosureGroup("See the \(redemptions.count) order\(redemptions.count == 1 ? "" : "s")") {
                    ForEach(redemptions) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text("#\(row.wooOrderID)")
                                    .font(.caption.weight(.semibold).monospacedDigit())
                                Text(row.readableWho)
                                    .font(.caption)
                                Spacer()
                                Text(row.formattedTotal)
                                    .font(.caption.weight(.semibold).monospacedDigit())
                            }
                            Text("used \(row.code)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
                .font(.footnote)
            }

            Text("Every order here used a code from this campaign, on a paid order placed after the message reached that person. Refunded and cancelled orders are not counted.")
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

private struct CampaignCouponBuilderSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreated: (CampaignCoupon) -> Void

    @State private var code = ""
    @State private var name = ""
    @State private var percent = 20
    @State private var expiryDays = 30
    @State private var minimumAmount = 100.0
    @State private var maximumAmount = 0.0
    @State private var usageLimit = 1_200
    @State private var usageLimitPerUser = 1
    @State private var individualUse = true
    @State private var excludeSaleItems = false
    @State private var freeShipping = false
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Coupon") {
                    TextField("Code, for example CC20", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("Internal name", text: $name)
                    Stepper("Discount: \(percent)%", value: $percent, in: 1...99)
                }
                Section("When it can be used") {
                    Stepper("Expires in \(expiryDays) days", value: $expiryDays, in: 1...365)
                    TextField("Minimum order", value: $minimumAmount, format: .number)
                        .keyboardType(.decimalPad)
                    TextField("Maximum order, 0 means none", value: $maximumAmount, format: .number)
                        .keyboardType(.decimalPad)
                    Toggle("Exclude sale items", isOn: $excludeSaleItems)
                    Toggle("Free shipping", isOn: $freeShipping)
                }
                Section("Limits") {
                    TextField("Total uses", value: $usageLimit, format: .number)
                        .keyboardType(.numberPad)
                    Stepper("Uses per customer: \(usageLimitPerUser)",
                            value: $usageLimitPerUser, in: 1...20)
                    Toggle("Cannot be combined with other coupons", isOn: $individualUse)
                }
                Section {
                    Label("Creating the coupon does not send, approve, or schedule this campaign.",
                          systemImage: "lock.shield")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button {
                        Task { await create() }
                    } label: {
                        if isCreating {
                            HStack { ProgressView(); Text("Creating in WooCommerce") }
                        } else {
                            Text("Create and Attach Coupon")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isCreating || code.trimmingCharacters(in: .whitespacesAndNewlines).count < 4
                              || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let errorMessage {
                    Section("What happened") {
                        Text(errorMessage).font(.footnote).foregroundStyle(ViciTheme.destructive)
                    }
                }
            }
            .navigationTitle("Generate Coupon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isCreating)
                }
            }
            .interactiveDismissDisabled(isCreating)
        }
    }

    private func create() async {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            let response = try await APIClient.shared.createCampaignCoupon(
                code: code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                percent: percent, expiryDays: expiryDays,
                minimumAmount: minimumAmount, maximumAmount: maximumAmount,
                usageLimit: usageLimit, usageLimitPerUser: usageLimitPerUser,
                individualUse: individualUse, excludeSaleItems: excludeSaleItems,
                freeShipping: freeShipping
            )
            guard !response.sent && !response.scheduled else {
                errorMessage = "The server returned an unsafe coupon result. Nothing was attached."
                return
            }
            onCreated(response.coupon)
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
                    Section("What happened and what to do next") {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(ViciTheme.warning)
                    }
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
            if let couponError = plan.couponError {
                Text(couponError.message).font(.footnote).foregroundStyle(ViciTheme.destructive)
            }
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

        if !plan.ready, let steps = plan.nextSteps, !steps.isEmpty {
            Section("How to make it work") {
                ForEach(steps.indices, id: \.self) { index in
                    Text("\(index + 1). \(steps[index])")
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
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
                Text(audienceCreationDescription(plan))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func audienceCreationDescription(_ plan: CampaignPlan) -> String {
        let audience = plan.audience?.kind == "all_contacts"
            ? "The full contact list is frozen into a draft campaign."
            : "The segment is saved, its members are calculated, and a draft campaign is created."
        return "\(audience) You can edit it, submit it for review, approve it, then schedule it. Nothing is sent from this screen."
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
        guard let audience = plan.audience, let message = chosenCopy else { return }
        guard audience.kind == "all_contacts" || audience.ruleSet != nil else { return }
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            try await APIClient.shared.acceptCampaignPlan(
                title: title,
                audienceDescription: audience.description,
                audienceKind: audience.kind,
                ruleSet: audience.ruleSet,
                message: message,
                discountPercent: plan.discountPercent,
                couponCode: plan.couponCode,
                workflowCategory: plan.workflowCategory
            )
            onCreated()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
