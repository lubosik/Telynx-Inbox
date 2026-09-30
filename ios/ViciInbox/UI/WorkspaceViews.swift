import SwiftUI
import AVKit
import AVFoundation

struct ContactsView: View {
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    @StateObject private var model = ContactsModel()
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @State private var search = ""
    @State private var showingCreate = false

    private var businessLineNumber: String {
        if workspace == .main { return session.callerNumber }
        return model.contacts.first(where: \.isVIP)?.replyFromNumber ?? ""
    }

    private var filtered: [ConversationSummary] {
        let contacts = model.contacts.filter { $0.phone != session.callerNumber && workspace.includes($0) }
        guard !search.isEmpty else { return contacts }
        let query = search.lowercased()
        return contacts.filter {
            $0.displayName.lowercased().contains(query) || $0.phone.contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false)
        }
    }

    private var businessLineMatchesSearch: Bool {
        guard !businessLineNumber.isEmpty else { return false }
        guard !search.isEmpty else { return true }
        let query = search.lowercased()
        return "vici peptides".contains(query) || businessLineNumber.contains(query) ||
            PhoneFormatter.pretty(businessLineNumber).lowercased().contains(query)
    }

    var body: some View {
        NavigationStack(path: $router.contactsPath) {
            VStack(spacing: 0) {
                Picker("Inbox", selection: $workspace) {
                    ForEach(InboxWorkspace.allCases) { value in
                        Text(value.label).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 10)
                Divider()
            Group {
                if model.isLoading && model.contacts.isEmpty { ProgressView("Loading contacts…") }
                else if filtered.isEmpty && !businessLineMatchesSearch {
                    EmptyState(icon: "person.2", title: "No contacts", detail: search.isEmpty ? "Create the first contact." : "Try another search.")
                } else {
                    List {
                        if businessLineMatchesSearch {
                            NavigationLink(value: AppRoute.businessLine) {
                                HStack(spacing: 12) {
                                    InitialsAvatar(name: "Vici Peptides", imageURL: nil)
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 5) {
                                            Text(workspace == .vip ? "Vici VIP" : "Vici Peptides").fontWeight(.semibold)
                                            Image(systemName: "pin.fill").font(.caption2).foregroundColor(ViciTheme.tint)
                                        }
                                        Text(PhoneFormatter.pretty(businessLineNumber))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(workspace == .vip ? "SMS + calls" : "SMS line")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }

                        ForEach(filtered) { contact in
                            NavigationLink(value: AppRoute.contact(phone: contact.phone)) {
                                HStack(spacing: 12) {
                                    InitialsAvatar(name: contact.displayName, imageURL: contact.avatarURL)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.displayName)
                                        Text(contact.phone).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if let status = contact.latestOrderStatus {
                                        Text(status.replacingOccurrences(of: "-", with: " ").capitalized)
                                            .font(.caption2).padding(.horizontal, 7).padding(.vertical, 3)
                                            .background(Color(.tertiarySystemFill)).clipShape(Capsule())
                                    }
                                }
                            }
                        }
                    }.listStyle(.plain).refreshable { await model.load(audience: workspace) }
                }
            }
            }
            .navigationTitle(workspace == .vip ? "VIP Contacts" : "Main Contacts")
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .businessLine:
                    BusinessLineDetailView(phone: businessLineNumber, workspace: workspace)
                case .contact(let phone):
                    ContactDetailView(phone: phone, model: model)
                default:
                    EmptyView()
                }
            }
            .searchable(text: $search, prompt: "Name, phone, or email")
            .accountToolbar()
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showingCreate = true } label: { Image(systemName: "person.badge.plus") }
                        .accessibilityLabel("New contact")
                }
            }
            .sheet(isPresented: $showingCreate) {
                ContactEditor(title: "New Contact") { first, last, phone, email, notes in
                    let saved = await model.create(firstName: first, lastName: last, phone: phone, email: email, notes: notes)
                    if saved { showingCreate = false }
                    return saved
                }
            }
            .task(id: workspace) { await model.load(audience: workspace) }
            .alert("Contacts error", isPresented: errorBinding) { Button("OK", role: .cancel) {} }
                message: { Text(model.errorMessage ?? "Unknown error") }
        }
    }

    private var errorBinding: Binding<Bool> { Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } }) }
}

private struct BusinessLineDetailView: View {
    let phone: String
    let workspace: InboxWorkspace
    @State private var copied = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    InitialsAvatar(name: "Vici Peptides", imageURL: nil)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Vici Peptides").font(.title3.bold())
                        Text(PhoneFormatter.pretty(phone)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.padding(.vertical, 4)
            }
            Section {
                Button {
                    UIPasteboard.general.string = phone
                    copied = true
                } label: {
                    Label(copied ? "Number copied" : "Copy business number", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
            } footer: {
                if workspace == .vip {
                    Text("VIP customers can text or call this number. Calls route to the Vici team in the app.")
                } else {
                    Text("This is the Vici Peptides messaging line for the Main workspace.")
                }
            }
        }
        .navigationTitle(workspace == .vip ? "VIP Line" : "SMS Line")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ContactDetailView: View {
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    let phone: String
    @ObservedObject var model: ContactsModel
    @EnvironmentObject private var session: SessionModel
    @State private var editing = false

    var body: some View {
        Group {
            if model.isLoading && model.detail?.contact.phone != phone { ProgressView("Loading contact…") }
            else if let detail = model.detail, detail.contact.phone == phone {
                List {
                    Section {
                        HStack(spacing: 14) {
                            InitialsAvatar(name: detail.contact.displayName, imageURL: detail.contact.avatarURL)
                            VStack(alignment: .leading) {
                                Text(detail.contact.displayName).font(.title3.bold())
                                Text(detail.contact.phone).foregroundStyle(.secondary)
                                if let email = detail.contact.email, !email.isEmpty { Text(email).font(.subheadline).foregroundStyle(.secondary) }
                            }
                        }.padding(.vertical, 4)
                        HStack {
                            Button { session.startOutgoingCall(to: detail.contact.phone) } label: { Label("Call", systemImage: "phone.fill") }
                            Spacer()
                            Button { editing = true } label: { Label("Edit", systemImage: "pencil") }
                        }
                    }
                    if let notes = detail.contact.notes, !notes.isEmpty { Section("Notes") { Text(notes) } }
                    Section("Orders") {
                        if detail.orders.isEmpty { Text("No orders").foregroundStyle(.secondary) }
                        ForEach(detail.orders) { order in OrderRow(order: order) }
                    }
                    if let intelligence = detail.intelligence {
                        Section("Customer intelligence") {
                            if let summary = intelligence.summary { Text(summary) }
                            if let sentiment = intelligence.sentiment { LabeledContent("Sentiment", value: sentiment.capitalized) }
                            if let interests = intelligence.interests, !interests.isEmpty { LabeledContent("Interests", value: interests.joined(separator: ", ")) }
                        }
                    }
                    if let suggestions = detail.suggestions, !suggestions.isEmpty {
                        Section("Campaign suggestions") {
                            ForEach(suggestions) { suggestion in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(suggestion.suggestedMessage ?? "Suggested message")
                                    if let reason = suggestion.reason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
                .refreshable { await model.loadDetail(phone: phone) }
                .sheet(isPresented: $editing) {
                    ContactEditor(title: "Edit Contact", contact: detail.contact) { first, last, _, email, notes in
                        let saved = await model.update(detail.contact, firstName: first, lastName: last, email: email, notes: notes)
                        if saved { editing = false }
                        return saved
                    }
                }
            } else { EmptyState(icon: "person.crop.circle.badge.questionmark", title: "Contact unavailable", detail: "Pull to try again.") }
        }
        .navigationTitle("Contact")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadDetail(phone: phone) }
        .task(id: model.detail?.contact.phone == phone ? model.detail?.contact.customerTier : nil) {
            if let contact = model.detail?.contact, contact.phone == phone, contact.customerTier != nil {
                workspace = InboxWorkspace.destination(for: contact)
            }
        }
    }
}

private struct OrderRow: View {
    let order: OrderRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(order.wooOrderID.map { "Order #\($0.rawValue)" } ?? "Order").fontWeight(.semibold)
                Spacer()
                Text((order.status ?? "unknown").replacingOccurrences(of: "-", with: " ").capitalized)
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let items = order.items, !items.isEmpty {
                Text(items.map { "\($0.quantity ?? 1)× \($0.name ?? "Item")" }.joined(separator: ", "))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            HStack {
                if let total = order.total { Text("$\(total.currencyText)").font(.subheadline.bold()) }
                Spacer()
                if let date = ServerDate.parse(order.createdAt) { Text(date, style: .date).font(.caption).foregroundStyle(.secondary) }
            }
            if let tracking = order.trackingNumber, !tracking.isEmpty {
                Label("\(order.carrier ?? "Tracking"): \(tracking)", systemImage: "shippingbox")
                    .font(.caption).textSelection(.enabled)
            }
        }.padding(.vertical, 4)
    }
}

private struct ContactEditor: View {
    let title: String
    let contact: ConversationSummary?
    let save: (String, String, String, String, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var firstName: String
    @State private var lastName: String
    @State private var phone: String
    @State private var email: String
    @State private var notes: String
    @State private var saving = false

    init(title: String, contact: ConversationSummary? = nil,
         save: @escaping (String, String, String, String, String) async -> Bool) {
        self.title = title; self.contact = contact; self.save = save
        _firstName = State(initialValue: contact?.firstName ?? "")
        _lastName = State(initialValue: contact?.lastName ?? "")
        _phone = State(initialValue: contact?.phone ?? "")
        _email = State(initialValue: contact?.email ?? "")
        _notes = State(initialValue: contact?.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("First name", text: $firstName); TextField("Last name", text: $lastName) }
                Section("Contact") {
                    TextField("Phone", text: $phone).keyboardType(.phonePad).disabled(contact != nil)
                    TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                }
                Section("Notes") { TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...8) }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task { _ = await save(firstName, lastName, phone, email, notes); saving = false }
                    }.disabled(phone.isEmpty || saving)
                }
            }
        }
        .assistantDraftOwner(
            source: .contact,
            isDirty: firstName != (contact?.firstName ?? "") ||
                lastName != (contact?.lastName ?? "") ||
                phone != (contact?.phone ?? "") ||
                email != (contact?.email ?? "") || notes != (contact?.notes ?? ""),
            onDiscard: {
                firstName = contact?.firstName ?? ""
                lastName = contact?.lastName ?? ""
                phone = contact?.phone ?? ""
                email = contact?.email ?? ""
                notes = contact?.notes ?? ""
                dismiss()
            }
        )
    }
}

/// Growth summary and entry point for the abandoned-cart sales engine.
struct AbandonedCartRecoverySection: View {
    @StateObject private var model = CartRecoveryDashboardModel()
    @EnvironmentObject private var session: SessionModel
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main

    private var canRead: Bool { session.can(Permission.automationRead) }
    private var canConfigure: Bool { session.can(Permission.campaignsApprove) }

    var body: some View {
        Section {
            if !canRead {
                Label("Your role cannot view recovery journeys", systemImage: "lock")
                    .foregroundStyle(.secondary)
            } else if model.isLoading && model.dashboard == nil {
                HStack { ProgressView(); Text("Loading recovery activity").foregroundStyle(.secondary) }
            } else if let dashboard = model.dashboard {
                NavigationLink {
                    CartRecoveryJourneyListView(workspace: workspace)
                } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Label(dashboard.automation?.enabled == true ? "Running" : "Off",
                                  systemImage: dashboard.automation?.enabled == true
                                  ? "arrow.triangle.2.circlepath.circle.fill" : "pause.circle")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(dashboard.automation?.enabled == true
                                                 ? ViciTheme.success : Color.secondary)
                            Spacer()
                            if dashboard.mode.lowercased() != "live" {
                                Text(dashboard.mode.replacingOccurrences(of: "_", with: " ").uppercased())
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 7).padding(.vertical, 3)
                                    .background(ViciTheme.warning.opacity(0.14))
                                    .foregroundStyle(ViciTheme.warning)
                                    .clipShape(Capsule())
                            }
                        }
                        Text("A personal checkout-help text after 45 minutes, an eligible Vin voice follow-up after 3 hours, then a guarded app offer after 48 hours.")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 0) {
                            CartRecoveryMiniStat(value: dashboard.metrics.active, label: "Active")
                            CartRecoveryMiniStat(value: dashboard.metrics.replied, label: "Replied")
                            CartRecoveryMiniStat(value: dashboard.metrics.converted, label: "Won")
                        }
                    }
                    .padding(.vertical, 4)
                }

                if let revenue = dashboard.metrics.recoveredRevenue {
                    LabeledContent("Recovered revenue",
                                   value: cartRecoveryMoney(revenue, currency: dashboard.metrics.currency))
                }

                NavigationLink {
                    CartRecoverySettingsView(canEdit: canConfigure)
                } label: {
                    Label("Recovery settings", systemImage: "slider.horizontal.3")
                }
            } else if let error = model.errorMessage {
                Label("Recovery activity unavailable", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(ViciTheme.warning)
                Text(error).font(.footnote).foregroundStyle(.secondary)
                Button("Try again") { Task { await model.load(audience: workspace) } }
            }
        } header: {
            Text("Abandoned cart recovery")
        } footer: {
            Text("AI may classify a customer reply and prepare a draft. It never sends that draft without a person approving it.")
        }
        .task(id: workspace) { if canRead { await model.load(audience: workspace) } }
    }
}

private struct CartRecoveryMiniStat: View {
    let value: Int
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(String(value)).font(.headline.monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CartRecoveryJourneyListView: View {
    let workspace: InboxWorkspace
    @StateObject private var model = CartRecoveryJourneyListModel()
    @StateObject private var dashboardModel = CartRecoveryDashboardModel()

    private let filters = [
        ("all", "All"), ("active", "Active"), ("replied", "Replied"),
        ("blocked", "Blocked"), ("converted", "Won"), ("cancelled", "Cancelled")
    ]

    var body: some View {
        List {
            if let metrics = dashboardModel.dashboard?.metrics {
                Section("Performance") {
                    HStack(spacing: 0) {
                        CartRecoveryMiniStat(value: metrics.sent, label: "Sent")
                        CartRecoveryMiniStat(value: metrics.clicked, label: "Clicked")
                        CartRecoveryMiniStat(value: metrics.replied, label: "Replied")
                        CartRecoveryMiniStat(value: metrics.converted, label: "Won")
                    }
                    if let revenue = metrics.recoveredRevenue {
                        LabeledContent("Recovered revenue",
                                       value: cartRecoveryMoney(revenue, currency: metrics.currency))
                    }
                    if !metrics.topReasons.isEmpty {
                        ForEach(metrics.topReasons.prefix(5)) { reason in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(cartRecoveryLabel(reason.category))
                                    Spacer()
                                    Text(String(reason.count)).foregroundStyle(.secondary)
                                }
                                HStack(spacing: 10) {
                                    if let rate = reason.recoveryRate {
                                        Text("\(rate.formatted(.percent.precision(.fractionLength(0)))) recovered")
                                    }
                                    if let revenue = reason.recoveredRevenue {
                                        Text(cartRecoveryMoney(revenue, currency: metrics.currency))
                                    }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    DisclosureGroup("All automation counts") {
                        LabeledContent("Abandoned carts", value: String(metrics.abandonedCartsIdentified))
                        LabeledContent("SMS eligible", value: String(metrics.smsEligible))
                        LabeledContent("SMS queued", value: String(metrics.queued))
                        LabeledContent("SMS delivered", value: String(metrics.delivered))
                        LabeledContent("AI drafts", value: String(metrics.aiDrafts))
                        LabeledContent("Push queued", value: String(metrics.pushScheduled))
                        LabeledContent("Push sent", value: String(metrics.pushSent))
                        LabeledContent("Push clicked", value: String(metrics.pushClicked))
                        LabeledContent("Push blocked", value: String(metrics.pushBlocked))
                        LabeledContent("Voice eligible", value: String(metrics.voiceEligible))
                        LabeledContent("Voice queued", value: String(metrics.voiceQueued))
                        LabeledContent("Voice calls started", value: String(metrics.voiceInitiated))
                        LabeledContent("Human answers", value: String(metrics.voiceHumanDetected))
                        LabeledContent("Voicemails played", value: String(metrics.voiceVoicemailsPlayed))
                        LabeledContent("Team transfers", value: String(metrics.voiceTransfersConnected))
                        LabeledContent("Voice opt-outs", value: String(metrics.voiceOptOuts))
                        LabeledContent("Recovered orders", value: String(metrics.recoveredOrders))
                    }
                }
            }

            Section {
                Picker("Status", selection: $model.status) {
                    ForEach(filters, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.menu)
            }

            Section("Journeys") {
                if model.isLoading && model.journeys.isEmpty {
                    HStack { ProgressView(); Text("Loading journeys").foregroundStyle(.secondary) }
                } else if model.journeys.isEmpty {
                    EmptyState(icon: "cart", title: "No journeys",
                               detail: "No recovery journeys match this status.")
                } else {
                    ForEach(model.journeys) { journey in
                        NavigationLink {
                            CartRecoveryJourneyDetailView(journeyID: journey.id)
                        } label: {
                            CartRecoveryJourneyRow(journey: journey)
                        }
                        .task { await model.loadMoreIfNeeded(current: journey) }
                    }
                    if model.isLoadingMore {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                }
            }
        }
        .navigationTitle("Cart Recovery")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            async let journeys: Void = model.load(audience: workspace)
            async let dashboard: Void = dashboardModel.load(audience: workspace)
            _ = await (journeys, dashboard)
        }
        .task(id: workspace) {
            async let journeys: Void = model.load(audience: workspace)
            async let dashboard: Void = dashboardModel.load(audience: workspace)
            _ = await (journeys, dashboard)
        }
        .onChange(of: model.status) { _ in Task { await model.reloadForStatus() } }
        .alert("Cart recovery error", isPresented: Binding(
            get: { model.errorMessage != nil || dashboardModel.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil; dashboardModel.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? dashboardModel.errorMessage ?? "Unknown error")
        }
    }
}

private struct CartRecoveryJourneyRow: View {
    let journey: CartRecoveryJourney

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(journey.displayName).fontWeight(.semibold)
                Spacer()
                CartRecoveryStatusBadge(status: journey.status)
            }
            Text(journey.primaryProduct ?? journey.products.first?.name ?? "Cart")
                .font(.subheadline).lineLimit(2)
            HStack {
                if let amount = journey.cartValue {
                    Text(cartRecoveryMoney(amount, currency: journey.currency)).fontWeight(.semibold)
                }
                if journey.itemCount > 0 {
                    Text("\(journey.itemCount) item\(journey.itemCount == 1 ? "" : "s")")
                }
                Spacer()
                if let date = ServerDate.parse(journey.lastActivityAt) {
                    Text(date, style: .relative)
                }
            }
            .font(.caption).foregroundStyle(.secondary)
            if journey.category != "UNKNOWN" {
                Label(cartRecoveryLabel(journey.category), systemImage: "text.bubble")
                    .font(.caption).foregroundStyle(ViciTheme.tint)
            }
        }
        .padding(.vertical, 3)
    }
}

struct CartRecoveryJourneyDetailView: View {
    @StateObject private var model: CartRecoveryJourneyDetailModel
    @StateObject private var attemptPreview = CartRecoveryVoicePreviewPlayer()
    @EnvironmentObject private var session: SessionModel
    @State private var editReply: CartRecoveryReply?
    @State private var approveReply: CartRecoveryReply?
    @State private var discardReply: CartRecoveryReply?

    init(journeyID: String) {
        _model = StateObject(wrappedValue: CartRecoveryJourneyDetailModel(journeyID: journeyID))
    }

    private var canSend: Bool { session.can(Permission.messageSend) }

    var body: some View {
        Group {
            if model.isLoading && model.detail == nil {
                ProgressView("Loading journey")
            } else if let detail = model.detail {
                List {
                    journeySummary(detail.journey)
                    cartSection(detail.journey)
                    messageSection(detail.journey)
                    voiceSection(detail.journey, attempt: detail.voiceAttempt)
                    pushSection(detail.journey)

                    if !detail.replies.isEmpty {
                        Section("Customer replies") {
                            ForEach(detail.replies) { reply in
                                CartRecoveryReplyCard(
                                    reply: reply,
                                    isBusy: model.mutatingReplyID == reply.id,
                                    canSend: canSend,
                                    onEdit: { editReply = reply },
                                    onApprove: { approveReply = reply },
                                    onDiscard: { discardReply = reply }
                                )
                            }
                        }
                    }

                    Section("Timeline") {
                        if detail.timeline.isEmpty {
                            Text("No timeline events yet").foregroundStyle(.secondary)
                        } else {
                            ForEach(detail.timeline) { event in
                                CartRecoveryTimelineRow(event: event)
                            }
                        }
                    }
                }
                .refreshable { await model.load() }
            } else {
                EmptyState(icon: "cart.badge.questionmark", title: "Journey unavailable",
                           detail: "Pull to try again.")
            }
        }
        .onDisappear { attemptPreview.stop() }
        .navigationTitle("Recovery Journey")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .sheet(item: $editReply) { reply in
            CartRecoveryDraftEditor(
                reply: reply,
                saving: model.mutatingReplyID == reply.id,
                onSave: { text in await model.saveDraft(replyID: reply.id, text: text) }
            )
        }
        .confirmationDialog("Approve this reviewed reply?", isPresented: Binding(
            get: { approveReply != nil }, set: { if !$0 { approveReply = nil } }
        ), titleVisibility: .visible) {
            Button("Approve Reply") {
                if let reply = approveReply {
                    Task { _ = await model.approve(replyID: reply.id); approveReply = nil }
                }
            }
            Button("Keep reviewing", role: .cancel) { approveReply = nil }
        } message: {
            Text("In live mode this sends the reviewed text now. In dry-run mode it records a preview and sends nothing. AI never approves this step.")
        }
        .confirmationDialog("Discard this AI draft?", isPresented: Binding(
            get: { discardReply != nil }, set: { if !$0 { discardReply = nil } }
        ), titleVisibility: .visible) {
            Button("Discard Draft", role: .destructive) {
                if let reply = discardReply {
                    Task { _ = await model.discard(replyID: reply.id); discardReply = nil }
                }
            }
            Button("Keep Draft", role: .cancel) { discardReply = nil }
        }
        .alert("Cart recovery", isPresented: Binding(
            get: { model.errorMessage != nil || model.successMessage != nil },
            set: { if !$0 { model.errorMessage = nil; model.successMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? model.successMessage ?? "Updated")
        }
    }

    @ViewBuilder
    private func journeySummary(_ journey: CartRecoveryJourney) -> some View {
        Section {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(journey.displayName).font(.title3.bold())
                    if let phone = journey.phone { Text(PhoneFormatter.pretty(phone)).foregroundStyle(.secondary) }
                }
                Spacer()
                CartRecoveryStatusBadge(status: journey.status)
            }
            if let last = ServerDate.parse(journey.lastActivityAt) {
                LabeledContent("Last cart activity") { Text(last.formatted(date: .abbreviated, time: .shortened)) }
            }
            LabeledContent("Phone available", value: journey.phoneAvailable ? "Yes" : "No")
            LabeledContent("SMS consent", value: journey.smsConsent ? "Valid" : "Not available")
            LabeledContent("Voice consent", value: journey.voiceConsent ? "Valid" : "Not available")
            LabeledContent("Push permission", value: journey.pushPermission ? "Valid" : "Not available")
            if journey.identityResolutionAmbiguous {
                Label("Identity match needs review. Automated SMS is blocked.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(ViciTheme.warning)
            }
            if let purchase = journey.purchaseStatus {
                LabeledContent("Purchase", value: cartRecoveryLabel(purchase))
            }
            if let order = journey.orderID { LabeledContent("Order", value: "#\(order)") }
            if let recovered = journey.recoveredRevenue {
                LabeledContent("Net recovered revenue",
                               value: cartRecoveryMoney(recovered, currency: journey.currency))
            }
            if let gross = journey.grossRecoveredRevenue {
                LabeledContent("Gross recovered revenue", value: cartRecoveryMoney(gross, currency: journey.currency))
            }
            if let refund = journey.refundAmount, refund.value > 0 {
                LabeledContent("Refunds deducted", value: cartRecoveryMoney(refund, currency: journey.currency))
            }
            if let method = journey.attributionMethod {
                LabeledContent("Attribution", value: cartRecoveryLabel(method))
            }
            if let strength = journey.attributionStrength {
                LabeledContent("Confidence", value: strength.uppercased())
            }
        }
    }

    @ViewBuilder
    private func cartSection(_ journey: CartRecoveryJourney) -> some View {
        Section("Cart") {
            if journey.products.isEmpty {
                Text(journey.primaryProduct ?? "Cart details unavailable").foregroundStyle(.secondary)
            } else {
                ForEach(journey.products) { product in
                    HStack {
                        Text(product.name)
                        Spacer()
                        Text("×\(product.quantity)").foregroundStyle(.secondary)
                    }
                }
            }
            if let amount = journey.cartValue {
                LabeledContent("Cart value", value: cartRecoveryMoney(amount, currency: journey.currency))
            }
            if let urlString = journey.recoveryURL, let url = URL(string: urlString) {
                Link(destination: url) { Label("Open recovery checkout", systemImage: "arrow.up.right.square") }
            }
        }
    }

    @ViewBuilder
    private func messageSection(_ journey: CartRecoveryJourney) -> some View {
        Section("Checkout help SMS") {
            LabeledContent("Status", value: cartRecoveryLabel(journey.smsStatus ?? "not queued"))
            if let queued = ServerDate.parse(journey.smsQueuedAt) {
                LabeledContent("Queued for") { Text(queued.formatted(date: .abbreviated, time: .shortened)) }
            }
            if let copy = journey.smsContent { Text(copy).textSelection(.enabled) }
            if journey.category != "UNKNOWN" {
                LabeledContent("Reason", value: cartRecoveryLabel(journey.category))
                if let confidence = journey.classificationConfidence {
                    LabeledContent("Classification confidence",
                                   value: confidence.formatted(.percent.precision(.fractionLength(0))))
                }
            }
            if let summary = journey.aiSummary { Text(summary).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder
    private func voiceSection(_ journey: CartRecoveryJourney, attempt: CartRecoveryVoiceAttempt?) -> some View {
        Section("Vin voice follow-up") {
            LabeledContent("Status", value: cartRecoveryLabel(journey.voiceStatus ?? "not queued"))
            if let queued = ServerDate.parse(journey.voiceQueuedAt) {
                LabeledContent("Eligible at") {
                    Text(queued.formatted(date: .abbreviated, time: .shortened))
                }
            }
            LabeledContent("Attempts", value: "\(journey.voiceAttemptCount)")
            if let attempt {
                if let result = attempt.amdResult {
                    LabeledContent("Answer detected", value: cartRecoveryLabel(result))
                }
                if let latency = attempt.humanAnswerDetectionLatencyMs {
                    LabeledContent("Detection latency", value: "\(latency) ms")
                }
                if let firstAudio = attempt.humanAnswerFirstAudioLatencyMs {
                    LabeledContent("First audio latency", value: "\(firstAudio) ms")
                }
                if attempt.voicemailPlayedAt != nil {
                    Label("Voicemail delivered after the greeting", systemImage: "voicemail.fill")
                        .foregroundStyle(ViciTheme.success)
                    Button(attemptPreview.previewingVoiceID == "\(attempt.id):voicemail"
                           ? "Stop voicemail preview" : "Listen to voicemail script") {
                        attemptPreview.toggleAttempt(journeyID: journey.id,
                                                     attemptID: attempt.id, branch: "voicemail")
                    }
                }
                if attempt.humanMessagePlayedAt != nil {
                    Button(attemptPreview.previewingVoiceID == "\(attempt.id):human"
                           ? "Stop call-message preview" : "Listen to call-message script") {
                        attemptPreview.toggleAttempt(journeyID: journey.id,
                                                     attemptID: attempt.id, branch: "human")
                    }
                }
                if attempt.voicemailPlayedAt != nil || attempt.humanMessagePlayedAt != nil {
                    Text("This regenerates the saved words in Vin’s voice. It is not a recording of the customer call.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if attemptPreview.isLoading { ProgressView("Preparing message preview") }
                if let error = attemptPreview.errorMessage {
                    Text(error).font(.caption).foregroundStyle(ViciTheme.warning)
                }
                if attempt.transferConnectedAt != nil {
                    Label("Connected to the Vici team", systemImage: "phone.arrow.up.right.fill")
                        .foregroundStyle(ViciTheme.success)
                }
                if let method = attempt.optOutMethod {
                    Label("Voice opt-out: \(cartRecoveryLabel(method))", systemImage: "phone.down.fill")
                        .foregroundStyle(ViciTheme.warning)
                }
                if let failure = attempt.failureCode {
                    Label(cartRecoveryLabel(failure), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(ViciTheme.warning)
                }
            } else if !journey.voiceConsent {
                Text("Voice remains blocked because separate voice and AI-voice consent is unavailable.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func pushSection(_ journey: CartRecoveryJourney) -> some View {
        Section("48-hour app follow-up") {
            LabeledContent("Status", value: cartRecoveryLabel(journey.pushStatus ?? "not queued"))
            if let queued = ServerDate.parse(journey.pushQueuedAt) {
                LabeledContent("Queued for") { Text(queued.formatted(date: .abbreviated, time: .shortened)) }
            }
            if let copy = journey.pushContent { Text(copy).textSelection(.enabled) }
            if let destination = journey.pushDestination {
                LabeledContent("Destination", value: destination)
            }
            if let blocked = journey.pushBlockedReason {
                Label(cartRecoveryLabel(blocked), systemImage: "exclamationmark.shield")
                    .font(.footnote).foregroundStyle(ViciTheme.warning)
            }
        }
    }
}

private struct CartRecoveryReplyCard: View {
    let reply: CartRecoveryReply
    let isBusy: Bool
    let canSend: Bool
    let onEdit: () -> Void
    let onApprove: () -> Void
    let onDiscard: () -> Void

    private var mayReviewDraft: Bool {
        let status = reply.draftStatus.lowercased()
        return reply.draft != nil && status != "sent" && status != "discarded"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let message = reply.customerMessage {
                Text("Customer").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(message).textSelection(.enabled)
            }
            HStack {
                CartRecoveryStatusBadge(status: reply.category)
                if let confidence = reply.confidence {
                    Text(confidence.formatted(.percent.precision(.fractionLength(0))))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let summary = reply.summary {
                Text(summary).font(.footnote).foregroundStyle(.secondary)
            }
            if reply.medicalEscalation {
                Label("Medical or safety question. A qualified person must review this.",
                      systemImage: "cross.case")
                    .font(.footnote.weight(.semibold)).foregroundStyle(ViciTheme.warning)
            }
            if let draft = reply.draft {
                Divider()
                Text("AI draft, not sent").font(.caption.weight(.semibold)).foregroundStyle(ViciTheme.tint)
                Text(draft).textSelection(.enabled)
            }
            if mayReviewDraft {
                HStack {
                    Button("Edit", action: onEdit).buttonStyle(.bordered)
                    Button("Approve & Send", action: onApprove).buttonStyle(.borderedProminent)
                    Button("Discard", role: .destructive, action: onDiscard).buttonStyle(.borderless)
                }
                .font(.footnote.weight(.semibold))
                .disabled(!canSend || isBusy)
                if !canSend {
                    Text("Your role can review this draft but cannot send messages.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Label(cartRecoveryLabel(reply.draftStatus),
                      systemImage: reply.draftStatus.lowercased() == "sent" ? "checkmark.circle" : "doc")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if isBusy { ProgressView("Updating") }
        }
        .padding(.vertical, 4)
    }
}

private struct CartRecoveryDraftEditor: View {
    let reply: CartRecoveryReply
    let saving: Bool
    let onSave: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(reply: CartRecoveryReply, saving: Bool, onSave: @escaping (String) async -> Bool) {
        self.reply = reply
        self.saving = saving
        self.onSave = onSave
        _text = State(initialValue: reply.draft ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                if let customer = reply.customerMessage {
                    Section("Customer said") { Text(customer) }
                }
                Section {
                    TextEditor(text: $text).frame(minHeight: 140)
                } header: {
                    Text("Reply")
                } footer: {
                    Text("Review every claim. Saving updates the draft only. It does not send anything.")
                }
                if reply.medicalEscalation {
                    Section {
                        Label("Do not provide unsupported medical, treatment, dosing, or safety advice.",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(ViciTheme.warning)
                    }
                }
            }
            .navigationTitle("Edit Draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving" : "Save") {
                        Task { if await onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() } }
                    }
                    .disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private struct CartRecoveryTimelineRow: View {
    let event: CartRecoveryTimelineEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.title).fontWeight(.semibold)
                if let detail = event.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
                if let method = event.attributionMethod, let strength = event.attributionStrength {
                    Text("\(strength) · \(cartRecoveryLabel(method))")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(ViciTheme.success)
                }
                if let order = event.orderID { Text("Order #\(order)").font(.caption).foregroundStyle(.secondary) }
                if let revenue = event.netRevenue {
                    Text("Recovered revenue: \(cartRecoveryMoney(revenue, currency: event.currency ?? "USD"))")
                        .font(.caption.weight(.semibold))
                }
                if let refund = event.refundAmount, refund.value > 0 {
                    Text("Refunds deducted: \(cartRecoveryMoney(refund, currency: event.currency ?? "USD"))")
                        .font(.caption).foregroundStyle(ViciTheme.destructive)
                }
                if let date = ServerDate.parse(event.createdAt) {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var icon: String {
        let type = event.type.lowercased()
        if type.contains("purchase") || type.contains("paid") || type.contains("convert") { return "checkmark.seal.fill" }
        if type.contains("reply") { return "bubble.left.and.bubble.right.fill" }
        if type.contains("click") { return "cursorarrow.click.2" }
        if type.contains("push") { return "bell.fill" }
        if type.contains("sms") || type.contains("message") { return "message.fill" }
        if type.contains("cancel") || type.contains("block") { return "nosign" }
        return "circle.fill"
    }

    private var color: Color {
        let type = event.type.lowercased()
        if type.contains("purchase") || type.contains("paid") || type.contains("convert") { return ViciTheme.success }
        if type.contains("cancel") || type.contains("block") || type.contains("fail") { return ViciTheme.warning }
        return ViciTheme.tint
    }
}

struct CartRecoverySettingsView: View {
    let canEdit: Bool
    @StateObject private var model = CartRecoverySettingsModel()
    @State private var draft: CartRecoverySettings?
    @State private var isEditingFirstSMS = false
    @State private var recoveryVoices: [RecoveryVoiceOption] = []
    @State private var voiceCatalogueError: String?
    @StateObject private var voicePreview = CartRecoveryVoicePreviewPlayer()

    var body: some View {
        Form {
            if model.isLoading && draft == nil {
                Section { HStack { ProgressView(); Text("Loading settings") } }
            } else if draft != nil {
                Section {
                    Toggle("Enabled", isOn: binding(\.enabled, fallback: false))
                    LabeledContent("First SMS delay", value: "45 minutes")
                } footer: {
                    Text("The default journey waits 45 minutes after the customer's last cart activity.")
                }

                Section {
                    Toggle("Automated voice follow-up", isOn: binding(\.voiceEnabled, fallback: false))
                    Stepper("Call after \(binding(\.voiceDelayMinutes, fallback: 180).wrappedValue) minutes",
                            value: binding(\.voiceDelayMinutes, fallback: 180), in: 15...1_440, step: 15)

                    VStack(spacing: 14) {
                        AssistantOrb(phase: voicePreview.previewingVoiceID == nil ? .idle : .speaking,
                                     tint: .brand, size: .standard)
                            .accessibilityLabel(voicePreview.previewingVoiceID == nil
                                                ? "Selected Vin voice"
                                                : "Previewing the selected Vin voice")

                        Menu {
                            ForEach(recoveryVoices) { voice in
                                Button {
                                    voicePreview.stop()
                                    draft?.voiceID = voice.id
                                    draft?.voiceName = voice.name
                                    draft?.voiceProvider = voice.provider ?? "elevenlabs"
                                    if let model = voice.modelId { draft?.voiceModelID = model }
                                } label: {
                                    if draft?.voiceID == voice.id {
                                        Label("\(voice.name) · \(voice.kindLabel ?? voice.providerLabel ?? "Authorized voice")", systemImage: "checkmark")
                                    } else {
                                        Text("\(voice.name) · \(voice.kindLabel ?? voice.providerLabel ?? "Authorized voice")")
                                    }
                                }
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Voice of Vin").font(.caption).foregroundStyle(.secondary)
                                    Text(draft?.voiceName ?? "Choose an authorized voice")
                                        .font(.body.weight(.semibold))
                                }
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down")
                            }
                            .padding(12)
                            .background(ViciTheme.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        }
                        .disabled(recoveryVoices.isEmpty)

                        Button(voicePreview.previewingVoiceID == nil
                               ? (voicePreview.isLoading ? "Loading preview…" : "Preview voice")
                               : "Stop preview") {
                            toggleVoicePreview()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(selectedRecoveryVoice == nil)

                        if voicePreview.isLoading {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Fetching the saved preview. This should take only a few seconds.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        if let previewError = voicePreview.errorMessage {
                            Text(previewError)
                                .font(.caption)
                                .foregroundStyle(ViciTheme.warning)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)

                    if let voiceCatalogueError {
                        Label(voiceCatalogueError, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(ViciTheme.warning)
                    }
                    if let previewError = voicePreview.errorMessage {
                        Label(previewError, systemImage: "speaker.slash.fill")
                            .font(.footnote).foregroundStyle(ViciTheme.warning)
                    }

                    Picker("Human answers", selection: binding(\.voiceHumanAnswerMode, fallback: "DISABLED")) {
                        Text("Off").tag("DISABLED")
                        Text("Transfer only").tag("TRANSFER_ONLY")
                        Text("Automated message").tag("PRERECORDED")
                    }

                    TextField("Toll-free call opt-out number", text: optionalStringBinding(\.voiceOptOutTollFreeNumber))
                        .keyboardType(.phonePad)
                    Text("For voicemail, callers need a US toll-free number that automatically accepts requests to stop future calls. You can save a voice now, but customer calls stay locked until that line and the separate approvals are in place.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Live team transfer number", text: optionalStringBinding(\.voiceTransferNumber))
                        .keyboardType(.phonePad)
                    HStack {
                        TextField("Start", text: binding(\.voiceCallingWindowStart, fallback: "09:00"))
                        TextField("End", text: binding(\.voiceCallingWindowEnd, fallback: "20:00"))
                    }

                    Label(draft?.voiceProductionReady == true ? "Production gates passed" : "Production calling remains locked",
                          systemImage: draft?.voiceProductionReady == true ? "checkmark.shield.fill" : "lock.shield.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(draft?.voiceProductionReady == true ? ViciTheme.success : ViciTheme.warning)
                    if let blockers = draft?.voiceBlockers, !blockers.isEmpty {
                        Text(blockers.map(cartRecoveryVoiceBlocker).joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Vin voice recovery")
                } footer: {
                    Text("The selected workspace voice is used for the three-hour cart follow-up. Calls require separate voice and AI-voice consent, suppression checks, local calling hours, and production approval. Previewing never calls a customer.")
                }

                Section {
                    if isEditingFirstSMS {
                        TextEditor(text: binding(\.firstSmsTemplate, fallback: ""))
                            .frame(minHeight: 150)
                            .textInputAutocapitalization(.sentences)
                        HStack {
                            Text("\(draft?.firstSmsTemplate.count ?? 0)/500 characters")
                            Spacer()
                            Button("Done") { isEditingFirstSMS = false }
                                .fontWeight(.semibold)
                        }
                        .font(.caption)
                        .foregroundStyle((draft?.firstSmsTemplate.count ?? 0) > 500
                                         ? ViciTheme.destructive : .secondary)
                    } else {
                        Text(draft?.firstSmsTemplate ?? "")
                            .textSelection(.enabled)
                    }
                } header: {
                    HStack {
                        Text("First SMS template")
                        Spacer()
                        Button {
                            isEditingFirstSMS = true
                        } label: {
                            Label("Edit message", systemImage: "pencil")
                                .labelStyle(.iconOnly)
                        }
                        .disabled(!canEdit)
                        .accessibilityLabel("Edit abandoned cart message")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Available fields: {{first_name}}, {{product_name}}, {{recovery_url}}")
                        Text("Keep {{recovery_url}} exactly once and include “Reply STOP to opt out”. Changes affect future messages only.")
                        if let problem = firstSMSProblem {
                            Text(problem).foregroundStyle(ViciTheme.destructive)
                        }
                    }
                }

                Section {
                    Toggle("48-hour app follow-up", isOn: binding(\.pushEnabled, fallback: false))
                    Stepper("Push after \(binding(\.pushDelayHours, fallback: 48).wrappedValue) hours",
                            value: binding(\.pushDelayHours, fallback: 48), in: 1...168)
                    TextField("Push title", text: binding(\.pushTitle, fallback: ""))
                    TextField("Push body", text: binding(\.pushBody, fallback: ""), axis: .vertical)
                        .lineLimit(2...5)
                    LabeledContent("Discount", value: "15% with VICI15")
                    LabeledContent("One product", value: "Exact product")
                    LabeledContent("Multiple products", value: "Shop")
                } header: {
                    Text("App push")
                } footer: {
                    Text("A push is sent only when the customer has a valid app destination, VICI15 applies to the purchase, and every final eligibility check passes. Otherwise Growth shows it as blocked.")
                }

                Section {
                    Toggle("Use factual low-stock wording",
                           isOn: binding(\.lowStockMessagingEnabled, fallback: false))
                    Stepper("Low stock at \(binding(\.lowStockThreshold, fallback: 5).wrappedValue) or fewer",
                            value: binding(\.lowStockThreshold, fallback: 5), in: 1...50)
                } header: { Text("Stock") }
                footer: { Text("Only current WooCommerce stock can trigger this wording. No fake scarcity.") }

                Section {
                    Stepper("Recovery window: \(binding(\.attributionWindowDays, fallback: 7).wrappedValue) days",
                            value: binding(\.attributionWindowDays, fallback: 7), in: 1...30)
                    Stepper("Shop push click window: \(binding(\.pushShopAttributionWindowHours, fallback: 24).wrappedValue) hours",
                            value: binding(\.pushShopAttributionWindowHours, fallback: 24), in: 1...168)
                } header: { Text("Revenue attribution") }
                footer: { Text("Tracked SMS and product push clicks are DIRECT. VICI15 without a tracked click is STRONG only inside an eligible recovery episode.") }

                Section {
                    Toggle("Classify customer replies",
                           isOn: binding(\.aiClassificationEnabled, fallback: true))
                    Toggle("Prepare AI draft replies",
                           isOn: binding(\.aiDraftRepliesEnabled, fallback: true))
                    Toggle("Automatic AI sending", isOn: .constant(false)).disabled(true)
                    if draft?.automaticAiSending == true {
                        Label("The server reported automatic AI sending as on. Save these settings to force it off.",
                              systemImage: "exclamationmark.octagon.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(ViciTheme.destructive)
                    }
                } header: { Text("Conversation assistance") }
                footer: { Text("Automatic AI sending is always off. A person must edit or approve every reply.") }

                if !canEdit {
                    Section {
                        Label("Your role can view these settings but cannot change them.", systemImage: "lock")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let error = model.errorMessage {
                Section {
                    Label("Settings unavailable", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(ViciTheme.warning)
                    Text(error).foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .disabled(!canEdit && draft != nil)
        .navigationTitle("Recovery Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(model.isSaving ? "Saving" : "Save") {
                    guard let draft else { return }
                    Task {
                        if await model.save(draft) {
                            self.draft = model.settings
                            isEditingFirstSMS = false
                        }
                    }
                }
                .disabled(!canEdit || model.isSaving || draft == nil
                          || firstSMSProblem != nil
                          || (draft == model.settings && draft?.automaticAiSending != true))
            }
        }
        .task { await load() }
        .onDisappear { voicePreview.stop() }
        .alert("Recovery settings", isPresented: Binding(
            get: { model.errorMessage != nil || model.savedMessage != nil },
            set: { if !$0 { model.errorMessage = nil; model.savedMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? model.savedMessage ?? "Updated")
        }
    }

    private func load() async {
        async let settingsLoad: Void = model.load()
        async let voicesLoad: Void = loadRecoveryVoices()
        _ = await (settingsLoad, voicesLoad)
        draft = model.settings
    }

    private var selectedRecoveryVoice: RecoveryVoiceOption? {
        guard let id = draft?.voiceID else { return nil }
        return recoveryVoices.first { $0.id == id }
    }

    private func loadRecoveryVoices() async {
        do {
            let catalogue = try await APIClient.shared.fetchCartRecoveryVoices()
            await MainActor.run {
                recoveryVoices = catalogue.voices
                voiceCatalogueError = catalogue.providerWarnings?.first
            }
        } catch {
            await MainActor.run {
                voiceCatalogueError = "Authorized voices could not be loaded. Your saved choice is unchanged."
            }
        }
    }

    private func toggleVoicePreview() {
        guard let voice = selectedRecoveryVoice else { return }
        voicePreview.toggle(voice)
    }

    private func optionalStringBinding(_ keyPath: WritableKeyPath<CartRecoverySettings, String?>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? "" },
            set: { value in draft?[keyPath: keyPath] = value.isEmpty ? nil : value }
        )
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<CartRecoverySettings, Value>,
                                fallback: Value) -> Binding<Value> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? fallback },
            set: { value in draft?[keyPath: keyPath] = value }
        )
    }

    private var firstSMSProblem: String? {
        guard let message = draft?.firstSmsTemplate.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        if message.isEmpty { return "The message cannot be empty." }
        if message.count > 500 { return "Keep the message to 500 characters or fewer." }
        if message.components(separatedBy: "{{recovery_url}}").count - 1 != 1 {
            return "Include {{recovery_url}} exactly once."
        }
        let lower = message.lowercased()
        if !lower.contains("reply stop to opt out") && !lower.contains("reply stop to unsubscribe") {
            return "Include “Reply STOP to opt out”."
        }
        return nil
    }
}

@MainActor
private final class CartRecoveryVoicePreviewPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var previewingVoiceID: String?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private var player: AVAudioPlayer?
    private var loadTask: Task<Void, Never>?
    private var cachedAudio: [String: Data] = [:]

    func toggle(_ voice: RecoveryVoiceOption) {
        if previewingVoiceID == voice.id || isLoading {
            stop()
            return
        }
        start(voice)
    }

    func toggleAttempt(journeyID: String, attemptID: String, branch: String) {
        let playbackID = "\(attemptID):\(branch)"
        if previewingVoiceID == playbackID || isLoading {
            stop()
            return
        }
        start(id: playbackID) {
            try await APIClient.shared.previewCartRecoveryAttempt(journeyID: journeyID, branch: branch)
        }
    }

    private func start(_ voice: RecoveryVoiceOption) {
        if let data = cachedAudio[voice.id] {
            play(data, id: voice.id)
            return
        }
        start(id: voice.id) {
            try await APIClient.shared.previewCartRecoveryVoice(id: voice.id)
        }
    }

    private func start(id: String, retrieve: @escaping () async throws -> Data) {
        stop()
        isLoading = true
        errorMessage = nil
        loadTask = Task { [weak self] in
            do {
                let data = try await retrieve()
                guard !Task.isCancelled, let self else { return }
                self.cachedAudio[id] = data
                self.play(data, id: id)
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.player = nil
                self.previewingVoiceID = nil
                self.isLoading = false
                self.errorMessage = error.localizedDescription.isEmpty
                    ? "That preview could not be played. Try again."
                    : error.localizedDescription
                self.deactivateSession()
            }
        }
    }

    private func play(_ data: Data, id: String) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            let player = try AVAudioPlayer(data: data)
            player.delegate = self
            guard player.prepareToPlay(), player.play() else {
                throw NSError(domain: "ViciVoicePreview", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "The preview audio could not start."])
            }
            self.player = player
            self.previewingVoiceID = id
            self.isLoading = false
            self.errorMessage = nil
        } catch {
            self.player = nil
            self.previewingVoiceID = nil
            self.isLoading = false
            self.errorMessage = "That preview could not be played. Try again."
            deactivateSession()
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        player?.stop()
        player = nil
        previewingVoiceID = nil
        isLoading = false
        errorMessage = nil
        deactivateSession()
    }

    private func finishPlayback() {
        player = nil
        previewingVoiceID = nil
        isLoading = false
        deactivateSession()
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finishPlayback() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.finishPlayback()
            self.errorMessage = "That preview could not be played. Choose another voice or try again."
        }
    }
}

private struct CartRecoveryStatusBadge: View {
    let status: String
    var body: some View {
        Text(cartRecoveryLabel(status))
            .font(.caption2.weight(.bold))
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.14))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private var color: Color {
        let value = status.lowercased()
        if value.contains("convert") || value.contains("deliver") || value == "sent" { return ViciTheme.success }
        if value.contains("fail") || value.contains("block") || value.contains("cancel") { return ViciTheme.warning }
        if value.contains("reply") { return ViciTheme.tint }
        return .secondary
    }
}

private func cartRecoveryLabel(_ raw: String) -> String {
    raw.replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .lowercased().capitalized
}

private func cartRecoveryVoiceBlocker(_ code: String) -> String {
    switch code {
    case "toll_free_opt_out_missing":
        return "Add a working US toll-free automated call opt-out line"
    case "provider_approval_missing":
        return "Confirm the Telnyx outbound voice use case before production calls"
    case "toll_free_opt_out_handler_unverified":
        return "Test and verify the automated toll-free opt-out line"
    case "compliance_approval_missing":
        return "Voice consent, script and opt-out compliance review is pending"
    case "voice_worker_disabled":
        return "The production voice worker is off"
    case "voice_dry_run_enabled":
        return "Voice is in preview mode"
    case "vin_voice_missing":
        return "Choose and save a Vin voice"
    case "elevenlabs_api_key_missing":
        return "Reconnect the ElevenLabs voice provider"
    case "qwen_api_key_missing":
        return "Connect the Qwen voice provider"
    case "qwen_workspace_missing":
        return "Add the Qwen Singapore workspace ID"
    case "dia_endpoint_missing":
        return "Connect the private Dia voice endpoint"
    case "dia_api_key_missing":
        return "Add the private Dia endpoint credential"
    case "invalid_voice_provider":
        return "Choose an available Vin voice again"
    case "transfer_number_missing":
        return "Add a team phone number for live transfers"
    default:
        return cartRecoveryLabel(code)
    }
}

private func cartRecoveryMoney(_ amount: FlexibleDecimal, currency: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = currency.isEmpty ? "USD" : currency.uppercased()
    return formatter.string(from: NSDecimalNumber(decimal: amount.value))
        ?? "\(formatter.currencySymbol ?? "$")\(amount.currencyText)"
}

/// The automatic 21-day check-in in the Automations dashboard.
/// Enabling it authorizes future automatic customer messages, so its copy is
/// intentionally explicit about what the switch does.
struct CheckInAutomationSection: View {
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel
    @State private var automation: CheckInAutomation?

    /// ── WHY THE SWITCH HAS ITS OWN STATE ─────────────────────────────────
    ///
    /// It used to be driven by `Binding(get: { automation.enabled }, set: ...)`,
    /// where `automation` was an immutable snapshot unwrapped in the view body.
    /// Tapping called `set`, which started an async request, and SwiftUI then
    /// re-read `get` — which still returned the OLD value. So the switch flicked
    /// back under the owner's finger and only settled after a full round trip.
    ///
    /// He reported it as the toggle not working. The audit log shows him
    /// tapping it five times in a row, which is exactly what that bug looks
    /// like from the outside: it had turned on the first time.
    ///
    /// So the switch now reads a state this view owns and moves immediately.
    /// The request follows, and only a FAILURE moves it back.
    @State private var isOn = false
    @State private var isBusy = false
    @State private var message: String?
    @State private var failed = false
    @State private var loadFailed = false
    @State private var showingQueue = false
    @State private var showingTemplateEditor = false
    @State private var templateDrafts: [String: String] = [:]
    @State private var selectedTemplate = "named_how_it_went"

    private var canApprove: Bool { session.can(Permission.campaignsApprove) }

    var body: some View {
        Section {
            if loadFailed {
                Label("Could not load the check-in automation", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(ViciTheme.warning)
                Button("Try again") { Task { await load() } }
            } else if automation == nil {
                HStack { ProgressView(); Text("Loading").foregroundStyle(.secondary) }
            } else {
                Text("The queue shows \(workspace.customerLabel.lowercased()). The on/off switch and message templates are shared across both spaces.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle(isOn: Binding(
                    get: { isOn },
                    set: { wanted in
                        guard wanted != isOn, !isBusy else { return }
                        isOn = wanted                  // move NOW, with the finger
                        Task { await commit(wanted) }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Check in three weeks after an order")
                        // The state in words as well as in the switch, because
                        // "is that grey or green" is not a question anybody
                        // should have to squint at.
                        if isBusy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.mini)
                                Text(isOn ? "Turning on" : "Turning off")
                            }
                            .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            Label(isOn ? "ON, running every day" : "OFF, nothing is sent",
                                  systemImage: isOn ? "checkmark.circle.fill" : "pause.circle")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(isOn ? ViciTheme.success : .secondary)
                        }
                    }
                }
                .disabled(!canApprove || isBusy)

                if isOn, let next = automation?.nextSendDate {
                    AutomationSendTimeRows(label: "Next send", date: next,
                                           storeZoneID: automation?.timeZone,
                                           viewerZone: appearance.effectiveTimeZone)
                }
                if automation?.templateEditingAvailable == true {
                    Button {
                        templateDrafts = automation?.templates ?? [:]
                        showingTemplateEditor = true
                    } label: {
                        Label("Edit future check-in messages", systemImage: "pencil")
                    }
                    .disabled(!canApprove || isBusy)
                } else if canApprove {
                    Text("Check-in message editing becomes available after the database update.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let queued = automation?.queuedRecipients, !queued.isEmpty {
                    LabeledContent("Pending", value: String(queued.filter { $0.campaignStatus != "paused" }.count))
                        .fontWeight(.semibold)
                    ForEach(Array(queued.prefix(3))) { recipient in
                        AutomationRecipientPreview(name: recipient.contactName,
                                                   phone: recipient.phone,
                                                   message: recipient.message,
                                                   sendDate: recipient.sendDate,
                                                   timeZoneID: automation?.timeZone)
                    }
                    Button("See all \(queued.count) queued or paused check-ins") { showingQueue = true }
                } else if isOn {
                    Text("No personal check-ins are queued right now.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(failed ? ViciTheme.destructive : .secondary)
                }
            }
        } header: {
            Text("Automatic check-in")
        } footer: {
            if !canApprove {
                Text("Your role can see this but cannot switch it on or off. Switching it on authorises check-ins to be sent without anyone approving them, so it needs the same permission as approving a campaign.")
            } else if isOn {
                Text("At 6:00 PM in the store time zone, everybody whose order passed the three-week mark in the last seven days is asked how it went. No offer, no code, and nobody is asked twice. It is built, approved and scheduled without you. Switching this off stops the next one; anything already scheduled still goes out unless you cancel it.")
            } else {
                Text("Off. Nobody is checked in on unless you build the campaign yourself. Switching it on lets check-ins be approved and sent without you reading them first.")
            }
        }
        .task(id: workspace) { automation = nil; await load() }
        .sheet(isPresented: $showingQueue) {
            AutomationRecipientQueueSheet(
                title: "Scheduled check-ins",
                recipients: (automation?.queuedRecipients ?? []).map {
                    AutomationRecipientSummary(id: $0.id, campaignID: $0.campaignID,
                                               campaignTitle: $0.campaignTitle,
                                               name: $0.contactName, phone: $0.phone,
                                               message: $0.message, sendDate: $0.sendDate,
                                               campaignStatus: $0.campaignStatus)
                },
                timeZoneID: automation?.timeZone,
                onChanged: { Task { await load() } }
            )
        }
        .sheet(isPresented: $showingTemplateEditor) {
            NavigationStack {
                Form {
                    Picker("Message version", selection: $selectedTemplate) {
                        Text("Product check-in").tag("named_how_it_went")
                        Text("General check-in").tag("plain_how_it_went")
                        Text("Product journey").tag("named_journey")
                        Text("General journey").tag("plain_journey")
                    }
                    Section("Future message") {
                        TextEditor(text: Binding(
                            get: { templateDrafts[selectedTemplate] ?? "" },
                            set: { templateDrafts[selectedTemplate] = $0 }
                        ))
                        .frame(minHeight: 150)
                        Text("Use {{first_name}}. Product versions also need {{last_product}}. Keep a question and leave out offers.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section {
                        Button("Save all four versions") { Task { await saveTemplates() } }
                            .disabled(isBusy || templateDrafts.count != 4)
                        if failed, let message {
                            Text(message).foregroundStyle(ViciTheme.destructive)
                        }
                    } footer: {
                        Text("Only future check-ins change. Messages already scheduled keep their approved wording.")
                    }
                }
                .navigationTitle("Check-in messages")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { showingTemplateEditor = false }
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            let requestedWorkspace = workspace
            let fresh = try await APIClient.shared.fetchCheckInAutomation(audience: requestedWorkspace)
            guard requestedWorkspace == workspace else { return }
            automation = fresh
            // Only adopt the server's value when no write is in flight, or a
            // slow GET landing after a fast PUT would undo what was just set.
            if !isBusy { isOn = fresh.enabled }
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    private func commit(_ wanted: Bool) async {
        isBusy = true
        message = nil
        failed = false
        defer { isBusy = false }
        do {
            let change = try await APIClient.shared.setCheckInAutomation(enabled: wanted)
            // Trust the server's answer over the optimistic one.
            isOn = change.enabled
            message = change.note
            automation = try? await APIClient.shared.fetchCheckInAutomation(audience: workspace)
        } catch {
            // Put the switch back where it was. A control that stays where it
            // was tapped while the change did not happen is worse than one that
            // visibly refuses.
            isOn = !wanted
            failed = true
            message = error.localizedDescription
        }
    }

    private func saveTemplates() async {
        guard !isBusy else { return }
        isBusy = true
        message = nil
        failed = false
        defer { isBusy = false }
        do {
            let result = try await APIClient.shared.saveCheckInTemplates(templateDrafts)
            automation = try await APIClient.shared.fetchCheckInAutomation(audience: workspace)
            message = result.note
            showingTemplateEditor = false
        } catch {
            failed = true
            message = error.localizedDescription
        }
    }

    /// Delegates so this screen and the campaign screen cannot drift apart.
    private func checkInSendTime(_ date: Date, timeZoneID: String?) -> String {
        AutomationSendTime.exact(date, inZoneNamed: timeZoneID)
    }
}

/// A one-time welcome sent after a customer first crosses the VIP threshold.
/// The dashboard previews three people; the full queue opens in one sheet.
/// Campaign rows remain the immutable approval and delivery ledger.
struct VIPWelcomeAutomationSection: View {
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel
    @State private var automation: VIPWelcomeAutomation?
    @State private var isOn = false
    @State private var isBusy = false
    @State private var isEditingTemplate = false
    @State private var templateDraft = ""
    @State private var message: String?
    @State private var failed = false
    @State private var loadFailed = false
    @State private var showingQueue = false

    private var canApprove: Bool { session.can(Permission.campaignsApprove) }

    var body: some View {
        Section {
            if loadFailed {
                Label("Could not load the VIP welcome automation",
                      systemImage: "exclamationmark.triangle")
                    .foregroundStyle(ViciTheme.warning)
                Button("Try again") { Task { await load() } }
            } else if automation == nil {
                HStack { ProgressView(); Text("Loading").foregroundStyle(.secondary) }
            } else {
                Text("The queue shows \(workspace.customerLabel.lowercased()). The on/off switch and welcome template are shared across both spaces.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle(isOn: Binding(
                    get: { isOn },
                    set: { wanted in
                        guard wanted != isOn, !isBusy else { return }
                        isOn = wanted
                        Task { await save(enabled: wanted,
                                          template: automation?.messageTemplate ?? templateDraft,
                                          revertingToggleOnFailure: true) }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Welcome new VIP customers")
                        if isBusy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.mini)
                                Text(isOn ? "Turning on" : "Turning off")
                            }
                            .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            Label(isOn ? "ON, welcoming new VIPs" : "OFF, nothing is sent",
                                  systemImage: isOn ? "checkmark.circle.fill" : "pause.circle")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(isOn ? ViciTheme.success : .secondary)
                        }
                    }
                }
                .disabled(!canApprove || isBusy)

                Text("Welcomes new VIPs after \(automation?.delayHours ?? 24) hours, at the scheduled store time.")
                    .font(.footnote).foregroundStyle(.secondary)

                if isEditingTemplate {
                    TextEditor(text: $templateDraft)
                        .frame(minHeight: 150)
                        .textInputAutocapitalization(.sentences)
                    HStack {
                        Text("\(templateDraft.count)/500 characters")
                            .foregroundStyle(templateProblem == nil ? Color.secondary
                                                                    : ViciTheme.destructive)
                        Spacer()
                        Button("Cancel") {
                            templateDraft = automation?.messageTemplate ?? ""
                            isEditingTemplate = false
                        }
                        Button("Save") {
                            Task { await save(enabled: isOn,
                                              template: templateDraft,
                                              revertingToggleOnFailure: false) }
                        }
                        .fontWeight(.semibold)
                        .disabled(isBusy || templateProblem != nil
                                  || templateDraft == automation?.messageTemplate)
                    }
                    .font(.caption)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("VIP welcome template")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Button {
                                templateDraft = automation?.messageTemplate ?? ""
                                isEditingTemplate = true
                            } label: {
                                Label("Edit message", systemImage: "pencil")
                                    .labelStyle(.iconOnly)
                            }
                            .disabled(!canApprove || isBusy)
                            .accessibilityLabel("Edit VIP welcome message")
                        }
                        Text(automation?.messageTemplate ?? "")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }

                if let queued = automation?.queuedRecipients, !queued.isEmpty {
                    LabeledContent("Pending", value: String(queued.count))
                        .fontWeight(.semibold)
                    // The queue is sorted soonest first, so its head is when this
                    // batch actually goes out. Shown once, with the owner's own
                    // time beside it, rather than on all hundred rows.
                    if let soonest = queued.compactMap(\.sendDate).min() {
                        AutomationSendTimeRows(label: soonest < Date() ? "Overdue since" : "Sends at", date: soonest,
                                               storeZoneID: automation?.timeZone,
                                               viewerZone: appearance.effectiveTimeZone)
                        if soonest < Date() {
                            Label("This time has passed. These messages need a new eligible send time; they are not confirmed as sent.",
                                  systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote)
                                .foregroundStyle(ViciTheme.warning)
                        }
                    }
                    ForEach(Array(queued.prefix(3))) { recipient in
                        AutomationRecipientPreview(name: recipient.contactName,
                                                   phone: recipient.phone,
                                                   message: recipient.message,
                                                   sendDate: recipient.sendDate,
                                                   timeZoneID: automation?.timeZone)
                    }
                    Button("See all \(queued.count) queued or paused VIP welcomes") { showingQueue = true }
                } else if isOn {
                    Text("No VIP welcomes are queued right now.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(failed ? ViciTheme.destructive : .secondary)
                }
            }
        } header: {
            Text("VIP welcome")
        } footer: {
            if !canApprove {
                Text("Your role can see the VIP welcome queue but cannot change its standing authorisation or future message.")
            } else {
                Text("Recent conversations delay the welcome by at least \(automation?.conversationGuardHours ?? 2) hours. Editing the template changes future welcomes only; queued messages remain exactly as approved.")
            }
        }
        .task(id: workspace) { automation = nil; await load() }
        .sheet(isPresented: $showingQueue) {
            AutomationRecipientQueueSheet(
                title: "Scheduled VIP welcomes",
                recipients: (automation?.queuedRecipients ?? []).map {
                    AutomationRecipientSummary(id: $0.id, campaignID: $0.campaignID,
                                               campaignTitle: $0.campaignTitle,
                                               name: $0.contactName, phone: $0.phone,
                                               message: $0.message, sendDate: $0.sendDate,
                                               campaignStatus: $0.campaignStatus)
                },
                timeZoneID: automation?.timeZone,
                onChanged: { Task { await load() } }
            )
        }
    }

    private var templateProblem: String? {
        let clean = templateDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return "The welcome message cannot be empty." }
        if clean.count > 500 { return "Keep the welcome message to 500 characters or fewer." }
        if !clean.contains("{{first_name}}") {
            return "Include {{first_name}} so every welcome is personal."
        }
        return nil
    }

    private func load() async {
        do {
            let requestedWorkspace = workspace
            let fresh = try await APIClient.shared.fetchVIPWelcomeAutomation(audience: requestedWorkspace)
            guard requestedWorkspace == workspace else { return }
            automation = fresh
            if !isBusy {
                isOn = fresh.enabled
                templateDraft = fresh.messageTemplate
            }
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    private func save(enabled: Bool,
                      template: String,
                      revertingToggleOnFailure: Bool) async {
        guard !isBusy else { return }
        isBusy = true
        message = nil
        failed = false
        defer { isBusy = false }
        do {
            let fresh = try await APIClient.shared.updateVIPWelcomeAutomation(
                enabled: enabled,
                messageTemplate: template.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            automation = try await APIClient.shared.fetchVIPWelcomeAutomation(audience: workspace)
            isOn = fresh.enabled
            templateDraft = fresh.messageTemplate
            isEditingTemplate = false
            message = fresh.note ?? "VIP welcome automation updated."
        } catch {
            if revertingToggleOnFailure { isOn.toggle() }
            failed = true
            message = error.localizedDescription
        }
    }

    /// Delegates so this screen and the campaign screen cannot drift apart.
    private func vipWelcomeSendTime(_ date: Date, timeZoneID: String?) -> String {
        AutomationSendTime.exact(date, inZoneNamed: timeZoneID)
    }
}

/// ── ONE SEND-TIME FORMAT, SHARED WITH CAMPAIGNS ──────────────────────────
///
/// The owner asked to read automation send times "just like we can see the
/// campaigns", so this is deliberately the same format string the campaign
/// screen uses in `formattedSchedule`: weekday, date, time, zone abbreviation,
/// then the IANA identifier. Three automations previously printed a shorter
/// format with no weekday, which made the same instant look like a different
/// kind of fact depending on which screen it was read from.
///
/// ON "EASTERN STANDARD TIME". The store zone is `America/New_York`, which IS
/// Eastern Time and is the correct way to express it. The abbreviation shown is
/// whichever is actually in force: EDT through 31 October 2026, EST from
/// 1 November. Hard-coding "EST" year-round would print the wrong label all
/// summer and, worse, invite a fixed -5 offset that would send an hour late for
/// eight months of the year.
enum AutomationSendTime {
    static let storeZoneFallback = "America/New_York"

    static func zone(_ identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:))
            ?? TimeZone(identifier: storeZoneFallback)!
    }

    /// The exact instant, in the given zone, matching the campaign screen.
    static func exact(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = timeZone
        formatter.dateFormat = "EEE, MMM d 'at' h:mm a zzz"
        return "\(formatter.string(from: date)) · \(timeZone.identifier)"
    }

    static func exact(_ date: Date, inZoneNamed identifier: String?) -> String {
        exact(date, in: zone(identifier))
    }
}

/// The campaign screen's pairing: the customer send time, and the viewer's own
/// time beneath it whenever the two zones differ. Shown once per automation
/// rather than on every queued person, because the queue can run to a hundred
/// rows and the owner has already asked twice for these screens to be less
/// cluttered.
private struct AutomationSendTimeRows: View {
    let label: String
    let date: Date
    let storeZoneID: String?
    let viewerZone: TimeZone

    var body: some View {
        let store = AutomationSendTime.zone(storeZoneID)
        LabeledContent(label) {
            Text(AutomationSendTime.exact(date, in: store))
                .multilineTextAlignment(.trailing)
                .foregroundStyle(.secondary)
        }
        if store.identifier != viewerZone.identifier {
            LabeledContent("Your time") {
                Text(AutomationSendTime.exact(date, in: viewerZone))
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct AutomationRecipientSummary: Identifiable {
    let id: String
    let campaignID: String
    let campaignTitle: String?
    let name: String?
    let phone: String?
    let message: String?
    let sendDate: Date?
    let campaignStatus: String?
}

private struct AutomationRecipientPreview: View {
    let name: String?
    let phone: String?
    let message: String?
    let sendDate: Date?
    let timeZoneID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name ?? phone.map(PhoneFormatter.pretty) ?? "Unknown customer")
                .font(.subheadline.weight(.semibold))
            if let sendDate {
                Text(AutomationSendTime.exact(sendDate, inZoneNamed: timeZoneID))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let message, !message.isEmpty {
                Text(message).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The entire queue is one tap away. Each approved batch gets one edit link;
/// repeating that link on every customer made the dashboard look like a list
/// of campaigns instead of a list of scheduled personal messages.
private struct AutomationRecipientQueueSheet: View {
    let title: String
    let recipients: [AutomationRecipientSummary]
    let timeZoneID: String?
    let onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var session: SessionModel
    @State private var cancelledIDs = Set<String>()
    @State private var cancellingID: String?
    @State private var recipientToCancel: AutomationRecipientSummary?
    @State private var cancelError: String?

    private struct Batch: Identifiable { let id: String; let title: String; let paused: Bool }

    private var batches: [Batch] {
        var seen = Set<String>()
        return visibleRecipients.compactMap { recipient in
            guard seen.insert(recipient.campaignID).inserted else { return nil }
            return Batch(id: recipient.campaignID,
                         title: recipient.campaignTitle ?? "Automation batch",
                         paused: recipient.campaignStatus == "paused")
        }
    }

    private var visibleRecipients: [AutomationRecipientSummary] {
        recipients.filter { !cancelledIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(visibleRecipients) { recipient in
                        Group {
                          if let phone = recipient.phone {
                            Button {
                                dismiss()
                                _ = router.open(.conversation(phone: phone))
                            } label: {
                                HStack {
                                    AutomationRecipientPreview(name: recipient.name,
                                                               phone: recipient.phone,
                                                               message: recipient.message,
                                                               sendDate: recipient.sendDate,
                                                               timeZoneID: timeZoneID)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                          } else {
                            AutomationRecipientPreview(name: recipient.name,
                                                       phone: recipient.phone,
                                                       message: recipient.message,
                                                       sendDate: recipient.sendDate,
                                                       timeZoneID: timeZoneID)
                          }
                        }
                        .overlay(alignment: .topTrailing) {
                            if recipient.campaignStatus == "paused" {
                                Text("Paused")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(ViciTheme.warning)
                                    .padding(.trailing, 16)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if session.can(Permission.campaignsCancel) {
                                Button("Cancel", role: .destructive) {
                                    recipientToCancel = recipient
                                }
                                .disabled(cancellingID != nil)
                            }
                        }
                    }
                } header: {
                    Text("Messages · \(visibleRecipients.count)")
                }
                if !batches.isEmpty {
                    Section {
                        ForEach(batches) { batch in
                            Button(batch.paused ? "Paused · \(batch.title)" : "Open \(batch.title)") {
                                dismiss()
                                _ = router.open(.campaign(id: batch.id))
                            }
                        }
                    } header: {
                        Text("Batches")
                    } footer: {
                        Text("Swipe left on one person to cancel only their message. Open a batch to pause, resume, or cancel all remaining messages.")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .confirmationDialog("Cancel this person's message?", isPresented: Binding(
                get: { recipientToCancel != nil },
                set: { if !$0 { recipientToCancel = nil } }
            )) {
                if let recipient = recipientToCancel {
                    Button("Cancel only this message", role: .destructive) {
                        Task { await cancel(recipient) }
                    }
                }
            } message: {
                Text("Everyone else in the batch will still receive their scheduled message.")
            }
            .alert("Could not cancel this message", isPresented: Binding(
                get: { cancelError != nil }, set: { if !$0 { cancelError = nil } }
            )) { Button("OK") { cancelError = nil } } message: {
                Text(cancelError ?? "Please try again.")
            }
        }
    }

    private func cancel(_ recipient: AutomationRecipientSummary) async {
        guard cancellingID == nil else { return }
        cancellingID = recipient.id
        defer { cancellingID = nil }
        do {
            try await APIClient.shared.cancelCampaignRecipient(
                campaignID: recipient.campaignID, recipientID: recipient.id)
            cancelledIDs.insert(recipient.id)
            onChanged()
        } catch {
            cancelError = error.localizedDescription
        }
    }
}

struct AutomationQueueView: View {
    let workspace: InboxWorkspace
    @StateObject private var model = ActivityModel()
    @State private var overview: AutomationOverview?
    @State private var overviewError: String?
    @State private var showingPaymentActivity = false
    @State private var showingPaymentTemplates = false
    @State private var overviewGeneration = 0
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        List {
            Section("All automations") {
                if let overview {
                    HStack {
                        Stat(value: overview.pending, label: "Pending", color: ViciTheme.warning)
                        Stat(value: overview.sentToday, label: "Sent", color: ViciTheme.success)
                        Stat(value: overview.failedToday, label: "Failed", color: ViciTheme.destructive)
                        Stat(value: overview.cancelledToday, label: "Cancelled", color: .secondary)
                    }.padding(.vertical, 6)
                    Text("Pending now · sent or started, failed and cancelled today in \(overview.timeZone.replacingOccurrences(of: "_", with: " "))")
                        .font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Pending by automation") {
                        LabeledContent("Payment and order", value: String(overview.breakdown.paymentAndOrders.pending))
                        LabeledContent("VIP welcome", value: String(overview.breakdown.vipWelcome.pending))
                        LabeledContent("Check-ins", value: String(overview.breakdown.checkIns.pending))
                        LabeledContent("Abandoned cart", value: String(overview.breakdown.abandonedCart.pending))
                        Text("A cart can have a text, push and call queued separately.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if let overviewError {
                    Label("Automation totals unavailable", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(ViciTheme.warning)
                    Text(overviewError).font(.footnote).foregroundStyle(.secondary)
                    Button("Try again") { Task { await loadOverview() } }
                } else {
                    HStack { ProgressView(); Text("Loading all automations").foregroundStyle(.secondary) }
                }
            }
            Section("Payment reminders and order updates") {
                if model.isLoading && model.stats == nil {
                    ProgressView("Loading messages")
                } else if model.queue.isEmpty {
                    Text("No payment or order messages are pending.").foregroundStyle(.secondary)
                } else {
                    ForEach(Array(model.queue.prefix(3))) { item in
                        NavigationLink(value: AppRoute.automationHistory(id: item.id)) {
                            ActivityRow(item: item, date: item.sendAt, timeZoneID: model.timeZoneID)
                        }
                    }
                }
                Button("See all payment and order activity") {
                    showingPaymentActivity = true
                }
                if session.can(Permission.campaignsApprove) {
                    Button { showingPaymentTemplates = true } label: {
                        Label("Edit future payment reminders", systemImage: "pencil")
                    }
                }
            }
            VIPWelcomeAutomationSection()
            CheckInAutomationSection()
            AbandonedCartRecoverySection()
        }
        .refreshable {
            await model.load(audience: workspace)
            await loadOverview()
        }
        .task(id: workspace) {
            overviewGeneration += 1
            overview = nil
            await model.load(audience: workspace)
            await loadOverview()
        }
        .sheet(isPresented: $showingPaymentActivity) {
            AutomationPaymentActivitySheet(model: model)
        }
        .sheet(isPresented: $showingPaymentTemplates) {
            PaymentTemplateEditorView()
        }
        .alert("Activity error", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(model.errorMessage ?? "Unknown error") }
    }

    private func loadOverview() async {
        overviewGeneration += 1
        let generation = overviewGeneration
        do {
            let result = try await APIClient.shared.fetchAutomationOverview(audience: workspace)
            guard generation == overviewGeneration else { return }
            overview = result
            overviewError = nil
        } catch {
            if generation == overviewGeneration {
                overview = nil
                overviewError = error.localizedDescription
            }
        }
    }
}

private struct PaymentTemplateEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var settings: PaymentTemplateSettings?
    @State private var drafts: [String: String] = [:]
    @State private var selectedFlow = "hold-msg1"
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let labels: [(key: String, label: String)] = [
        ("hold-msg1", "Payment reminder 1"),
        ("hold-msg2", "Payment reminder 2"),
        ("hold-msg3", "Payment reminder 3"),
        ("failed-msg1", "Card retry 1"),
        ("failed-msg2", "Card retry 2"),
        ("failed-msg3", "Card retry 3")
    ]

    var body: some View {
        NavigationStack {
            Form {
                if settings == nil && errorMessage == nil {
                    ProgressView("Loading messages")
                } else if let settings, !settings.available {
                    Text("Run the payment reminder template database update to enable editing.")
                        .foregroundStyle(.secondary)
                } else if settings != nil {
                    Picker("Message", selection: $selectedFlow) {
                        ForEach(labels.indices, id: \.self) { index in
                            Text(labels[index].label).tag(labels[index].key)
                        }
                    }
                    Section("Future message") {
                        TextEditor(text: Binding(
                            get: { drafts[selectedFlow] ?? "" },
                            set: { drafts[selectedFlow] = $0 }
                        ))
                        .frame(minHeight: 180)
                        Text("Keep the placeholders in double braces. Hold reminders must end with Reply STOP to opt out.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section {
                        Button(isSaving ? "Saving" : "Save all six messages") {
                            Task { await save() }
                        }
                        .disabled(isSaving || drafts.count != 6)
                    } footer: {
                        Text("This changes future payment reminders. Use the pencil in the pending queue to edit one message already scheduled.")
                    }
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(ViciTheme.destructive)
                    Button("Try again") { Task { await load() } }
                }
            }
            .navigationTitle("Payment messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { if settings == nil { await load() } }
        }
    }

    private func load() async {
        do {
            let fresh = try await APIClient.shared.fetchPaymentTemplates()
            settings = fresh
            drafts = fresh.templates
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            settings = try await APIClient.shared.savePaymentTemplates(drafts)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct AutomationPaymentActivitySheet: View {
    @ObservedObject var model: ActivityModel
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @Environment(\.dismiss) private var dismiss
    @State private var tab = 0
    @State private var cancelTarget: ActivityRecord?
    @State private var editingItem: ActivityRecord?
    @State private var editDraft = ""
    @State private var editError: String?
    @State private var isSavingEdit = false
    private let flows = ["all", "failed-msg1", "failed-msg2", "failed-msg3", "hold-msg1", "hold-msg2", "hold-msg3", "confirmed-new", "confirmed-returning", "shipped-msg1"]
    private let editableFlows: Set<String> = ["failed-msg1", "failed-msg2", "failed-msg3", "hold-msg1", "hold-msg2", "hold-msg3", "hold-failed-nudge"]

    private var canCancel: Bool { session.can(Permission.automationCancel) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Status", selection: $tab) {
                        Text("Pending").tag(0)
                        Text("Sent").tag(1)
                        Text("Failed").tag(2)
                        Text("Cancelled").tag(3)
                    }.pickerStyle(.segmented)
                    Picker("Flow", selection: $model.flow) {
                        ForEach(flows, id: \.self) { Text(flowLabel($0)).tag($0) }
                    }
                }
                if tab == 0 {
                    Section("Scheduled messages") {
                        if model.queue.isEmpty { Text("Queue is empty").foregroundStyle(.secondary) }
                        ForEach(model.queue) { item in
                            HStack(alignment: .top, spacing: 12) {
                                Button {
                                    dismiss()
                                    _ = router.open(.automationHistory(id: item.id))
                                } label: {
                                    ActivityRow(item: item, date: item.sendAt, timeZoneID: model.timeZoneID)
                                }
                                .buttonStyle(.plain)
                                Spacer(minLength: 0)
                                if editableFlows.contains(item.flowType ?? "") {
                                    Button {
                                        editDraft = item.messageBody ?? ""
                                        editError = nil
                                        editingItem = item
                                    } label: {
                                        Image(systemName: "pencil")
                                    }
                                    .buttonStyle(.borderless)
                                    .disabled(!canCancel || !canEditBeforeSend(item))
                                    .accessibilityLabel("Edit pending message")
                                    .accessibilityHint("Available until two minutes before sending")
                                }
                                Button("Cancel") { cancelTarget = item }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(canCancel ? ViciTheme.destructive : Color.secondary)
                                    .disabled(!canCancel || model.cancellingID != nil)
                            }
                        }
                        if model.queueHasMore {
                            Button(model.isLoadingMore ? "Loading" : "Load more") {
                                Task { await model.loadMoreQueue() }
                            }.disabled(model.isLoadingMore)
                        }
                    }
                } else if tab == 1 {
                    Section("Recent sends") {
                        if model.recent.isEmpty { Text("No recent sends").foregroundStyle(.secondary) }
                        ForEach(model.recent) { item in
                            ActivityRow(item: item, date: item.sentAt, timeZoneID: model.timeZoneID)
                        }
                        if model.recentHasMore {
                            Button(model.isLoadingMore ? "Loading" : "Load more") {
                                Task { await model.loadMoreRecent() }
                            }.disabled(model.isLoadingMore)
                        }
                    }
                } else {
                    let records = tab == 2 ? model.failed : model.cancelled
                    let hasMore = tab == 2 ? model.failedHasMore : model.cancelledHasMore
                    let status = tab == 2 ? "failed" : "cancelled"
                    Section(tab == 2 ? "Failed messages" : "Cancelled messages") {
                        if records.isEmpty && model.isLoadingMore {
                            ProgressView("Loading messages")
                        } else if records.isEmpty {
                            Text("No \(status) messages.").foregroundStyle(.secondary)
                        }
                        ForEach(records) { item in
                            ActivityRow(item: item, date: item.sendAt, timeZoneID: model.timeZoneID)
                        }
                        if hasMore {
                            Button(model.isLoadingMore ? "Loading" : "Load more") {
                                Task { await model.loadStatus(status, more: true) }
                            }.disabled(model.isLoadingMore)
                        }
                    }
                }
            }
            .navigationTitle("Payment and order activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .refreshable {
                await model.load(audience: model.audience)
                if tab == 2 || tab == 3 {
                    await model.loadStatus(tab == 2 ? "failed" : "cancelled")
                }
            }
            .onChange(of: tab) { selected in
                if selected == 2 || selected == 3 {
                    Task { await model.loadStatus(selected == 2 ? "failed" : "cancelled") }
                }
            }
            .onChange(of: model.flow) { _ in
                Task {
                    await model.load(audience: model.audience)
                    if tab == 2 || tab == 3 {
                        await model.loadStatus(tab == 2 ? "failed" : "cancelled")
                    }
                }
            }
            .onDisappear {
                if model.flow != "all" {
                    model.flow = "all"
                }
            }
        }
        .sheet(item: $editingItem) { item in
            NavigationStack {
                Form {
                    Section("Message for \(item.contactName ?? item.phone.map(PhoneFormatter.pretty) ?? "customer")") {
                        TextEditor(text: $editDraft)
                            .frame(minHeight: 180)
                        Text("This changes only this pending reminder. Future reminders keep their existing wording.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let editError {
                        Text(editError).foregroundStyle(ViciTheme.destructive)
                    }
                    Button(isSavingEdit ? "Saving" : "Save pending message") {
                        Task { await savePendingMessage(item) }
                    }
                    .disabled(isSavingEdit || editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .navigationTitle("Edit reminder")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { editingItem = nil }
                    }
                }
            }
        }
        .confirmationDialog("Cancel this scheduled message?", isPresented: Binding(
            get: { cancelTarget != nil }, set: { if !$0 { cancelTarget = nil } }
        ), titleVisibility: .visible) {
            Button("Cancel scheduled message", role: .destructive) {
                if let item = cancelTarget { Task { await model.cancel(item); cancelTarget = nil } }
            }
            Button("Keep it", role: .cancel) { cancelTarget = nil }
        } message: { Text("This stops only this queued automation. It does not disable the flow.") }
        .alert("Activity error", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(model.errorMessage ?? "Unknown error") }
    }

    private func flowLabel(_ flow: String) -> String { flow == "all" ? "All flows" : flow.replacingOccurrences(of: "-", with: " ").capitalized }

    private func canEditBeforeSend(_ item: ActivityRecord) -> Bool {
        guard let date = ServerDate.parse(item.sendAt) else { return false }
        return date > Date().addingTimeInterval(2 * 60)
    }

    private func savePendingMessage(_ item: ActivityRecord) async {
        guard !isSavingEdit else { return }
        isSavingEdit = true
        editError = nil
        defer { isSavingEdit = false }
        do {
            try await APIClient.shared.updateScheduledMessage(
                id: item.id, message: editDraft, expectedMessage: item.messageBody ?? "")
            editingItem = nil
            await model.load(audience: model.audience)
        } catch {
            editError = error.localizedDescription
        }
    }
}
private struct Stat: View {
    let value: Int; let label: String; let color: Color
    var body: some View { VStack { Text(String(value)).font(.title3.bold()).foregroundColor(color); Text(label).font(.caption2).foregroundStyle(.secondary) }.frame(maxWidth: .infinity) }
}

/// ── AN EXACT INSTANT, NOT "IN 3 DAYS" ────────────────────────────────────
///
/// This row used to print `style: .relative`. The owner's instruction of
/// 27 Sep 2026 was that the Automations screen must show "the exact date and
/// time that these messages are going to be sent", for payment reminders as
/// well as check-ins and VIP welcomes, and a relative string hides exactly the
/// fact he opens this screen to check.
///
/// The zone is the store's, not the phone's. He reads this from the UK while
/// the business runs on New York time, so "6:00 PM" alone would be wrong by
/// four or five hours depending on the date. The zone is printed beside the
/// time for the same reason it is on the check-in and VIP welcome rows.
private struct ActivityRow: View {
    let item: ActivityRecord; let date: String?
    var timeZoneID: String?

    private func exactTime(_ parsed: Date) -> String {
        AutomationSendTime.exact(parsed, inZoneNamed: timeZoneID)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(item.contactName ?? item.phone.map(PhoneFormatter.pretty) ?? "Unknown contact").fontWeight(.semibold)
                Spacer()
                if let parsed = ServerDate.parse(date) {
                    Text(exactTime(parsed))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Text((item.flowType ?? "automation").replacingOccurrences(of: "-", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
            if let message = item.messageBody, !message.isEmpty { Text(message).font(.subheadline).lineLimit(3) }
        }.padding(.vertical, 3)
    }
}

struct CallsView: View {
    @ObservedObject var model: CallHistoryModel
    @State private var section = 0
    @EnvironmentObject private var router: AppRouter
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    var body: some View {
        NavigationStack(path: $router.callsPath) {
            VStack(spacing: 0) {
                CustomerWorkspacePicker(selection: $workspace, areaLabel: "Calls")
                if workspace == .vip {
                    Text("VIP customers can call the VIP line. Outgoing calls here show the VIP number when it is ready.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 6)
                }
                Divider()
                Picker("Calls section", selection: $section) {
                    Text("Keypad").tag(0); Text("History").tag(1)
                }.pickerStyle(.segmented).padding()
                if section == 0 { DialerView() }
                else { CallHistoryView(model: model, workspace: workspace) }
            }
            .navigationTitle("Calls")
            .accountToolbar()
        }
    }
}

private struct CallHistoryView: View {
    @ObservedObject var model: CallHistoryModel
    let workspace: InboxWorkspace
    @EnvironmentObject private var session: SessionModel
    /// Only one player is open at a time, so audio never overlaps.
    @State private var expandedRecording: String?
    var body: some View {
        Group {
            if model.isLoading && model.logs.isEmpty { ProgressView("Loading calls…") }
            else if model.logs.isEmpty { EmptyState(icon: "phone.arrow.down.left", title: "No calls yet", detail: "Incoming and outgoing calls will appear here.") }
            else {
                List(model.logs) { log in
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 12) {
                            Image(systemName: icon(log)).foregroundColor(color(log))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(log.contactName ?? log.contactPhone.map(PhoneFormatter.pretty) ?? "Unknown number")
                                if let name = log.contactName, let phone = log.contactPhone {
                                    Text(PhoneFormatter.pretty(phone)).font(.caption).foregroundStyle(.secondary)
                                }
                                HStack {
                                    Text((log.status ?? "unknown").capitalized)
                                    if let duration = log.durationSeconds, duration > 0 { Text("• \(duration / 60):\(String(format: "%02d", duration % 60))") }
                                }.font(.caption).foregroundStyle(.secondary)
                                if let line = log.businessLineNumber, !line.isEmpty {
                                    Text("\(log.direction == "inbound" ? "To" : "From") \(PhoneFormatter.pretty(line))")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if let date = ServerDate.parse(log.startedAt) { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) }
                            if let phone = log.contactPhone {
                                Button { session.startOutgoingCall(to: phone) } label: { Image(systemName: "phone") }.buttonStyle(.borderless)
                            }
                        }

                        // Recording, collapsed by default. Call history is long and
                        // most rows are not being listened to, so the player is
                        // opened deliberately and only then downloads the audio.
                        if log.hasRecording {
                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    expandedRecording = (expandedRecording == log.id) ? nil : log.id
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "waveform")
                                    Text("Recording")
                                    Image(systemName: expandedRecording == log.id ? "chevron.up" : "chevron.down")
                                        .font(.caption2)
                                }
                                .font(.caption.weight(.medium))
                                .foregroundColor(ViciTheme.tealFill)
                            }
                            .buttonStyle(.borderless)
                            .padding(.top, 6)

                            if expandedRecording == log.id {
                                // Keyed by id so switching rows builds a fresh
                                // player rather than reusing the previous audio.
                                RecordingPlayerView(callLogID: log.id).id(log.id)
                            }
                        }
                    }
                }.listStyle(.plain)
                    .refreshable {
                        await model.load(audience: workspace)
                        await model.markHistorySeen(audience: workspace)
                    }
            }
        }
        // Reaching this list is what clears the missed-call count: the operator
        // can see who called without opening anything further.
        .task(id: workspace) {
            await model.load(audience: workspace)
            await model.markHistorySeen(audience: workspace)
        }
        // A refresh can raise the count while this list is already on screen —
        // returning to the foreground reloads it. Clear it again rather than
        // showing a badge for calls the operator is currently looking at.
        .onChange(of: model.unseenMissed) { count in
            if count > 0 { Task { await model.markHistorySeen(audience: workspace) } }
        }
    }

    private func icon(_ log: CallLogRecord) -> String {
        if log.status == "missed" { return "phone.down.fill" }
        return log.direction == "inbound" ? "phone.arrow.down.left.fill" : "phone.arrow.up.right.fill"
    }
    private func color(_ log: CallLogRecord) -> Color { log.status == "missed" ? ViciTheme.destructive : ViciTheme.success }
}
