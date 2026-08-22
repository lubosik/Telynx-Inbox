import SwiftUI

struct CampaignsView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model = CampaignListModel()
    @State private var showingNewCampaign = false

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
            if session.can(Permission.campaignsManage) {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showingNewCampaign = true } label: {
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
        .refreshable {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load(reset: true)
        }
        .task(id: session.can(Permission.campaignsRead)) {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load()
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
    }

    private var campaignList: some View {
        List {
            Section { CampaignSafetyNotice() }

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
                    NavigationLink {
                        CampaignDetailView(campaignID: campaign.id)
                    } label: {
                        CampaignRow(campaign: campaign)
                    }
                    .onAppear { Task { await model.loadMoreIfNeeded(after: campaign) } }
                }
                if model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
        .listStyle(.insetGrouped)
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
                }
            }
            .padding(24)
        }
    }
}

private struct CampaignRow: View {
    let campaign: CampaignRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(campaign.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 8)
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
        .accessibilityElement(children: .combine)
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
                await model.schedule(for: date)
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
        .confirmationDialog("Approve this exact revision?",
                            isPresented: $confirmingApproval,
                            titleVisibility: .visible) {
            Button("Approve Revision \(model.campaign?.revision ?? 0)") {
                Task { await model.approve() }
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

            if let rejection = campaign.rejectionReason, !rejection.isEmpty {
                Section("Reason for changes") { Text(rejection) }
            }
            if let cancellation = campaign.cancellationReason, !cancellation.isEmpty {
                Section("Cancellation reason") { Text(cancellation) }
            }

            if let performance = model.performance {
                CampaignPerformanceSection(performance: performance)
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

            Section("Recipients") {
                if model.recipients.isEmpty {
                    Text("No recipients")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.recipients) { recipient in
                    CampaignRecipientRow(recipient: recipient,
                                         eligibility: eligibility(for: recipient))
                        .onAppear {
                            Task { await model.loadMoreRecipientsIfNeeded(after: recipient) }
                        }
                }
                if model.isLoadingMore { ProgressView().frame(maxWidth: .infinity) }
            } footer: {
                Text("Showing \(model.recipients.count.formatted()) of \(model.recipientTotal.formatted()). Inclusion explains why the person entered the draft. Eligibility explains whether current safety checks allow a future send.")
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
            Section("Actions") {
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
                        Label("Scheduling is unavailable", systemImage: "lock.fill")
                            .foregroundStyle(.secondary)
                    }
                }

                if (campaign.status == .approved || campaign.status == .scheduled) && canCancel {
                    Button("Cancel Campaign", role: .destructive) { showingCancellation = true }
                        .disabled(model.isActing)
                }

                if model.isActing { ProgressView().frame(maxWidth: .infinity) }
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
        Section("Revenue Attribution") {
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

            NavigationLink {
                CampaignAttributionListView(campaignID: campaignID)
            } label: {
                Label("View Order Evidence", systemImage: "doc.text.magnifyingglass")
            }
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

private struct CampaignAttributionListView: View {
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
        Section("Campaign Results") {
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
        } footer: {
            Text("Provider accepted is not the same as delivered. Delivered counts only trusted delivery events.")
        }
    }
}

private struct CampaignEligibilitySection: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let dryRun: CampaignDryRun

    var body: some View {
        Section("Eligibility Preview") {
            LazyVGrid(columns: dynamicTypeSize.isAccessibilitySize
                      ? [GridItem(.flexible())]
                      : [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())],
                      alignment: .leading,
                      spacing: 12) {
                CampaignCountMetric(value: dryRun.total, label: "Selected")
                CampaignCountMetric(value: dryRun.eligible, label: "Eligible")
                CampaignCountMetric(value: dryRun.suppressed, label: "Suppressed")
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
                        .foregroundStyle(eligibility.eligible ? ViciTheme.success : ViciTheme.destructive)
                        .accessibilityLabel(CampaignReasonCopy.label(eligibility.reason))
                }
            }
            Text(recipient.inclusionSummary)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = eligibility?.reason, reason != "eligible" {
                Text(CampaignReasonCopy.label(reason))
                    .font(.caption)
                    .foregroundStyle(ViciTheme.destructive)
            } else if let reason = recipient.suppressionReason, !reason.isEmpty {
                Text(CampaignReasonCopy.label(reason))
                    .font(.caption)
                    .foregroundStyle(ViciTheme.destructive)
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
            Text("The current backend does not include a campaign delivery worker. A recorded schedule cannot deliver messages until that separately reviewed service is installed.")
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
        case .completed, .approved: return ViciTheme.success
        case .reviewRequired, .approvalPending, .scheduled, .sending: return ViciTheme.warning
        case .failed, .rejected, .cancelled: return ViciTheme.destructive
        case .draft: return ViciTheme.tint
        }
    }
}

struct CampaignEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: CampaignEditorModel
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
            .navigationTitle(model.existingID == nil ? "New Campaign" : "Edit Campaign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.savedCampaign == nil ? "Cancel" : "Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    if model.canGoBack {
                        Button("Back") { model.back() }
                    }
                    Spacer()
                    if model.savedCampaign != nil {
                        if model.savedCampaign?.status.isEditable == true {
                            Button("Submit for Review") {
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
                            Task {
                                if await model.saveAndCheckEligibility() { onSaved() }
                            }
                        }
                        .disabled(model.isSaving)
                    } else {
                        Button("Next") { model.advance() }
                            .buttonStyle(.borderedProminent)
                            .tint(ViciTheme.tint)
                    }
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
        Section("Enter Numbers") {
            TextEditor(text: $model.recipientsText)
                .font(.body.monospaced())
                .frame(minHeight: 180)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .accessibilityLabel("Campaign recipient phone numbers")
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

            Section("Selected Audience") {
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
            } footer: {
                Text("This is the requested audience, not the final eligible audience. No message is queued or sent from this screen.")
            }
        }
    }

    private var messageStep: some View {
        Section("Message") {
            TextEditor(text: $model.message)
                .frame(minHeight: 220)
                .accessibilityLabel("Campaign message")
            HStack {
                Text("SMS length and carrier segmentation may vary.")
                Spacer()
                Text("\(model.messageCount)/1600").monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(model.messageCount > 1_600 ? ViciTheme.destructive : Color.secondary)
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
                Text("There is no Send Now action. A schedule can be recorded only after review and approval. The current backend has no campaign delivery worker, so a schedule alone cannot deliver messages.")
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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $reason).frame(minHeight: 120)
                } footer: {
                    Text(prompt)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
    }
}

private struct CampaignScheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let action: (Date) async -> Void
    @State private var scheduledFor = Date().addingTimeInterval(900)
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
                    Text("This records a schedule only. The current backend has no campaign delivery worker, so scheduling alone cannot send messages. Eligible recipients must still be checked again by a separately reviewed sender.")
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
    }
}
