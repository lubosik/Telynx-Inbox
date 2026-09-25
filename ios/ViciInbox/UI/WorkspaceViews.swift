import SwiftUI
import AVKit
import AVFoundation

struct ContactsView: View {
    @StateObject private var model = ContactsModel()
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @State private var search = ""
    @State private var showingCreate = false

    private var filtered: [ConversationSummary] {
        let contacts = model.contacts.filter { $0.phone != session.callerNumber }
        guard !search.isEmpty else { return contacts }
        let query = search.lowercased()
        return contacts.filter {
            $0.displayName.lowercased().contains(query) || $0.phone.contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false)
        }
    }

    private var businessLineMatchesSearch: Bool {
        guard !session.callerNumber.isEmpty else { return false }
        guard !search.isEmpty else { return true }
        let query = search.lowercased()
        return "vici peptides".contains(query) || session.callerNumber.contains(query) ||
            PhoneFormatter.pretty(session.callerNumber).lowercased().contains(query)
    }

    var body: some View {
        NavigationStack(path: $router.contactsPath) {
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
                                            Text("Vici Peptides").fontWeight(.semibold)
                                            Image(systemName: "pin.fill").font(.caption2).foregroundColor(ViciTheme.tint)
                                        }
                                        Text(PhoneFormatter.pretty(session.callerNumber))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("Business line").font(.caption2).foregroundStyle(.secondary)
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
                    }.listStyle(.plain).refreshable { await model.load() }
                }
            }
            .navigationTitle("Contacts")
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .businessLine:
                    BusinessLineDetailView(phone: session.callerNumber)
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
            .task { if model.contacts.isEmpty { await model.load() } }
            .alert("Contacts error", isPresented: errorBinding) { Button("OK", role: .cancel) {} }
                message: { Text(model.errorMessage ?? "Unknown error") }
        }
    }

    private var errorBinding: Binding<Bool> { Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } }) }
}

private struct BusinessLineDetailView: View {
    let phone: String
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
                Text("This is the Vici Peptides Telnyx number used for customer messages and calls.")
            }
        }
        .navigationTitle("Business Line")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ContactDetailView: View {
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
                    CartRecoveryJourneyListView()
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
                Button("Try again") { Task { await model.load() } }
            }
        } header: {
            Text("Abandoned cart recovery")
        } footer: {
            Text("AI may classify a customer reply and prepare a draft. It never sends that draft without a person approving it.")
        }
        .task { if canRead && model.dashboard == nil { await model.load() } }
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
            async let journeys: Void = model.load()
            async let dashboard: Void = dashboardModel.load()
            _ = await (journeys, dashboard)
        }
        .task {
            async let journeys: Void = model.load()
            async let dashboard: Void = dashboardModel.load()
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
                                } label: {
                                    if draft?.voiceID == voice.id {
                                        Label("\(voice.name) · Professional clone", systemImage: "checkmark")
                                    } else {
                                        Text("\(voice.name) · Professional clone")
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
                               ? (voicePreview.isLoading ? "Loading preview" : "Preview voice")
                               : "Stop preview") {
                            toggleVoicePreview()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(selectedRecoveryVoice == nil)
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
                voiceCatalogueError = nil
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
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.player = nil
                self.previewingVoiceID = nil
                self.isLoading = false
                self.errorMessage = "That preview could not be played. Check your connection and try again."
                self.deactivateSession()
            }
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

/// The automatic 21-day check-in, at the top of the Automations screen.
/// Enabling it authorizes future automatic customer messages, so its copy is
/// intentionally explicit about what the switch does.
struct CheckInAutomationSection: View {
    @EnvironmentObject private var session: SessionModel
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
                    LabeledContent("Next send") {
                        Text(next.formatted(date: .abbreviated, time: .shortened))
                            .foregroundStyle(.secondary)
                    }
                }
                if let last = automation?.lastCampaign {
                    NavigationLink(value: AppRoute.campaign(id: last.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(last.title ?? "This week's check-in").lineLimit(2)
                            Text((last.status ?? "").capitalized)
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
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
                Text("Everybody whose order passed the three-week mark in the last seven days is asked how it went. No offer, no code, and nobody is asked twice. It is built, approved and scheduled without you. Switching this off stops the next one; anything already scheduled still goes out unless you cancel it.")
            } else {
                Text("Off. Nobody is checked in on unless you build the campaign yourself. Switching it on lets check-ins be approved and sent without you reading them first.")
            }
        }
        .task { if automation == nil { await load() } }
    }

    private func load() async {
        do {
            let fresh = try await APIClient.shared.fetchCheckInAutomation()
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
            automation = try? await APIClient.shared.fetchCheckInAutomation()
        } catch {
            // Put the switch back where it was. A control that stays where it
            // was tapped while the change did not happen is worse than one that
            // visibly refuses.
            isOn = !wanted
            failed = true
            message = error.localizedDescription
        }
    }
}

struct AutomationQueueView: View {
    @StateObject private var model = ActivityModel()
    @EnvironmentObject private var session: SessionModel
    @State private var cancelTarget: ActivityRecord?

    /// Cancelling a queued automation is a permissioned action. The control is
    /// disabled rather than hidden: a Support Agent should understand why the
    /// button will not work, not conclude the app is broken. The server rejects
    /// the request independently either way.
    private var canCancel: Bool { session.can(Permission.automationCancel) }

    private let flows = ["all", "failed-msg1", "failed-msg2", "failed-msg3", "hold-msg1", "hold-msg2", "hold-msg3", "confirmed-new", "confirmed-returning", "shipped-msg1"]

    var body: some View {
        List {
            AbandonedCartRecoverySection()
            // First, because it is the only automation on this screen that
            // messages customers on its own initiative rather than in reply to
            // an order they just placed.
            CheckInAutomationSection()
            if let stats = model.stats {
                Section("Today") {
                    HStack {
                        Stat(value: stats.pending, label: "Pending", color: ViciTheme.warning)
                        Stat(value: stats.sentToday, label: "Sent", color: ViciTheme.success)
                        Stat(value: stats.failedToday, label: "Failed", color: ViciTheme.destructive)
                        Stat(value: stats.cancelledToday, label: "Cancelled", color: .secondary)
                    }.padding(.vertical, 6)
                }
            }
            Section {
                Picker("Flow", selection: $model.flow) {
                    ForEach(flows, id: \.self) { Text(flowLabel($0)).tag($0) }
                }
            }
            Section {
                if model.queue.isEmpty { Text("Queue is empty").foregroundStyle(.secondary) }
                ForEach(model.queue) { item in
                    // Visible button rather than swipe-only: a hidden
                    // gesture is undiscoverable, and stopping a message
                    // before it reaches a customer is time-sensitive.
                    // The swipe stays for anyone used to it.
                    HStack(alignment: .top, spacing: 12) {
                        // ActivityRow already stretches to fill, so it takes
                        // the slack and the button keeps its intrinsic width.
                        // The row itself opens this message's own history:
                        // scheduled by the hold flow at 09:12, cancelled by
                        // Dominic at 14:32.
                        NavigationLink(value: AppRoute.automationHistory(id: item.id)) {
                            ActivityRow(item: item, date: item.sendAt)
                        }
                        Button {
                            cancelTarget = item
                        } label: {
                            if model.cancellingID == item.id {
                                ProgressView()
                            } else {
                                Text("Cancel")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(canCancel ? ViciTheme.destructive : Color.secondary)
                            }
                        }
                        // Borderless keeps the button's tap target separate
                        // from the row's, which List would otherwise merge.
                        .buttonStyle(.borderless)
                        .disabled(!canCancel || model.cancellingID != nil)
                        .accessibilityLabel("Cancel scheduled \(item.flowType ?? "automation")")
                        .accessibilityHint(canCancel
                                           ? "Stops this queued automation"
                                           : "Your role cannot cancel automations")
                    }
                    // The swipe shortcut is attached only when the action is
                    // actually permitted; a swipe that always fails is worse
                    // than no swipe. The disabled button above carries the
                    // explanation.
                    .swipeActions {
                        if canCancel {
                            Button("Cancel", role: .destructive) { cancelTarget = item }
                        }
                    }
                }
            } header: {
                Text("Queued automations")
            } footer: {
                if canCancel {
                    Text("Tap a queued message to see everything that has happened to it.")
                } else {
                    Text("Your role can see the queue but cannot cancel automations. Ask an admin if a queued message needs stopping. Tap a message to see its history.")
                }
            }
            Section("Recent sends") {
                if model.recent.isEmpty { Text("No recent sends").foregroundStyle(.secondary) }
                ForEach(model.recent) { item in ActivityRow(item: item, date: item.sentAt) }
            }
        }
        .refreshable { await model.load() }
        .task { if model.stats == nil { await model.load() } }
        .onChange(of: model.flow) { _ in Task { await model.load() } }
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
}
private struct Stat: View {
    let value: Int; let label: String; let color: Color
    var body: some View { VStack { Text(String(value)).font(.title3.bold()).foregroundColor(color); Text(label).font(.caption2).foregroundStyle(.secondary) }.frame(maxWidth: .infinity) }
}

private struct ActivityRow: View {
    let item: ActivityRecord; let date: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(item.contactName ?? item.phone.map(PhoneFormatter.pretty) ?? "Unknown contact").fontWeight(.semibold)
                Spacer()
                if let parsed = ServerDate.parse(date) { Text(parsed, style: .relative).font(.caption).foregroundStyle(.secondary) }
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
    var body: some View {
        NavigationStack(path: $router.callsPath) {
            VStack(spacing: 0) {
                Picker("Calls section", selection: $section) {
                    Text("Keypad").tag(0); Text("History").tag(1)
                }.pickerStyle(.segmented).padding()
                if section == 0 { DialerView() } else { CallHistoryView(model: model) }
            }
            .navigationTitle("Calls")
            .accountToolbar()
        }
    }
}

private struct CallHistoryView: View {
    @ObservedObject var model: CallHistoryModel
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
                    .refreshable { await model.load(); await model.markHistorySeen() }
            }
        }
        // Reaching this list is what clears the missed-call count: the operator
        // can see who called without opening anything further.
        .task {
            if model.logs.isEmpty { await model.load() }
            await model.markHistorySeen()
        }
        // A refresh can raise the count while this list is already on screen —
        // returning to the foreground reloads it. Clear it again rather than
        // showing a badge for calls the operator is currently looking at.
        .onChange(of: model.unseenMissed) { count in
            if count > 0 { Task { await model.markHistorySeen() } }
        }
    }

    private func icon(_ log: CallLogRecord) -> String {
        if log.status == "missed" { return "phone.down.fill" }
        return log.direction == "inbound" ? "phone.arrow.down.left.fill" : "phone.arrow.up.right.fill"
    }
    private func color(_ log: CallLogRecord) -> Color { log.status == "missed" ? ViciTheme.destructive : ViciTheme.success }
}
