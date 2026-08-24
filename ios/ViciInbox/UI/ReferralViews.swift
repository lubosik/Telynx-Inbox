import SwiftUI

struct ReferralsView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model = ReferralsModel()
    @State private var box: ReferralBox = .received

    var body: some View {
        Group {
            if session.currentUser?.isSharedTeamLogin != false {
                ReferralNamedAccountRequiredView()
            } else {
                VStack(spacing: 0) {
                    Picker("Referral box", selection: $box) {
                        ForEach(ReferralBox.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding()

                    if model.isLoading && model.items.isEmpty {
                        Spacer()
                        ProgressView("Loading referrals")
                        Spacer()
                    } else if model.items.isEmpty {
                        Spacer()
                        EmptyState(icon: "person.crop.circle.badge.checkmark",
                                   title: "No \(box.title.lowercased()) referrals",
                                   detail: box == .received
                                    ? "Customer conversations handed to you appear here."
                                    : "Conversations you hand to teammates appear here.")
                        Spacer()
                    } else {
                        List(model.items) { referral in
                            NavigationLink {
                                ReferralDetailView(referralID: referral.id)
                            } label: {
                                ReferralRow(referral: referral)
                            }
                        }
                        .listStyle(.plain)
                        .refreshable { await model.load(box: box) }
                    }
                }
            }
        }
        .navigationTitle("Referrals")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: box) { await model.load(box: box) }
        .alert("Referral error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Unknown error")
        }
    }
}

private struct ReferralRow: View {
    let referral: ReferralRecord

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: referral.attentionRequired ? "exclamationmark.circle.fill" : "person.2.fill")
                .font(.title3)
                .foregroundStyle(referral.attentionRequired ? .orange : ViciTheme.tint)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(referral.contactName).font(.headline)
                    Spacer()
                    Text(referral.state.rawValue.capitalized)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(referral.state == .resolved ? .secondary : ViciTheme.tint)
                }
                Text(referral.owner.map { "Owned by \($0.name)" }
                     ?? "For \(referral.recipientLabel)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let note = referral.initialNote, !note.isEmpty {
                    Text(note).font(.caption).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct ReferralComposerView: View {
    let conversation: ConversationSummary
    let completed: (ReferralRecord) -> Void

    @EnvironmentObject private var session: SessionModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = ReferralComposerModel()

    var body: some View {
        NavigationStack {
            Group {
                if session.currentUser?.isSharedTeamLogin != false {
                    ReferralNamedAccountRequiredView()
                } else if model.isLoading && model.recipients == nil {
                    ProgressView("Loading teammates")
                } else {
                    Form {
                        Section("Customer") {
                            LabeledContent(conversation.displayName, value: conversation.phone)
                        }
                        Section("Send to") {
                            if model.recipients?.anyAdminAvailable == true {
                                recipientRow(title: "Any Admin",
                                             detail: "The first available Owner or Admin can claim it.",
                                             recipient: .anyAdmin)
                            }
                            ForEach(model.recipients?.recipients ?? []) { teammate in
                                recipientRow(title: teammate.name,
                                             detail: RoleCatalog.label(teammate.role),
                                             recipient: .teammate(id: teammate.id))
                            }
                        }
                        Section {
                            TextField("What should your teammate know?", text: $model.draft.note, axis: .vertical)
                                .lineLimit(3...7)
                            Text("\(model.draft.note.count)/1,000")
                                .font(.caption)
                                // Spelled as Color on both sides. A ternary
                                // needs one type across both branches, and
                                // bare `.secondary` can infer
                                // HierarchicalShapeStyle, which has no `.red`.
                                .foregroundStyle(model.draft.note.count > 1_000 ? Color.red : Color.secondary)
                        } header: {
                            Text("Internal note (optional)")
                        } footer: {
                            Text("This note is only for your team. It is never sent to the customer and does not change the message draft.")
                        }
                    }
                }
            }
            .navigationTitle("Refer conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Refer") {
                        Task {
                            if let referral = await model.submit(phone: conversation.phone) {
                                completed(referral)
                                dismiss()
                            }
                        }
                    }
                    .disabled(!model.draft.canSubmit || model.isSubmitting)
                }
            }
            .task { await model.load() }
            .alert("Could not refer conversation", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) { Button("OK", role: .cancel) {} } message: {
                Text(model.errorMessage ?? "Unknown error")
            }
        }
        .assistantDraftOwner(
            source: .referral,
            isDirty: model.draft.recipient != nil || !model.draft.note.isEmpty,
            onDiscard: {
                model.draft = ReferralComposerDraft()
                dismiss()
            }
        )
    }

    private func recipientRow(title: String,
                              detail: String,
                              recipient: ReferralComposerDraft.Recipient) -> some View {
        Button {
            model.draft.recipient = recipient
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if model.draft.recipient == recipient {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(ViciTheme.tint)
                }
            }
        }
    }
}

struct ReferralDetailView: View {
    let referralID: String

    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @StateObject private var model: ReferralDetailModel
    @State private var transition: ReferralTransition?

    init(referralID: String) {
        self.referralID = referralID
        _model = StateObject(wrappedValue: ReferralDetailModel(id: referralID))
    }

    var body: some View {
        Group {
            if session.currentUser?.isSharedTeamLogin != false {
                ReferralNamedAccountRequiredView()
            } else if model.isLoading && model.detail == nil {
                ProgressView("Loading referral")
            } else if let detail = model.detail {
                List {
                    referralSection(detail.referral)
                    if !detail.events.isEmpty { historySection(detail.events) }
                    actionsSection(detail.referral)
                }
            } else {
                EmptyState(icon: "person.crop.circle.badge.xmark",
                           title: "Referral unavailable",
                           detail: "It may have changed or you may no longer have access.")
            }
        }
        .navigationTitle("Referral")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .sheet(item: $transition) { transition in
            ReferralTransitionView(
                transition: transition,
                recipients: model.recipients?.recipients ?? [],
                originalReferrer: model.detail?.referral.referredBy,
                completed: { recipient, note in
                    switch transition {
                    case .reassign:
                        guard let recipient else { return }
                        await model.reassign(to: recipient, note: note)
                    case .handBack:
                        await model.handBack(note: note)
                    }
                }
            )
        }
        .alert("Referral error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Unknown error")
        }
    }

    private func referralSection(_ referral: ReferralRecord) -> some View {
        Section("Conversation") {
            LabeledContent("Customer", value: referral.contactName)
            LabeledContent("Status", value: referral.state.rawValue.capitalized)
            LabeledContent("Referred by", value: referral.referredBy?.name ?? "Named teammate")
            LabeledContent("Originally for", value: referral.recipientLabel)
            if let owner = referral.owner { LabeledContent("Current owner", value: owner.name) }
            if let note = referral.initialNote, !note.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Initial note").font(.caption).foregroundStyle(.secondary)
                    Text(note)
                }
            }
            Button {
                router.dismissAccount()
                router.open(.referral(id: referral.id, phone: referral.contactPhone))
            } label: {
                Label("Open conversation", systemImage: "message.fill")
            }
        }
    }

    private func historySection(_ events: [ReferralEvent]) -> some View {
        Section("History") {
            ForEach(events) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text(eventTitle(event)).font(.subheadline.weight(.semibold))
                    if let note = event.note, !note.isEmpty { Text(note).font(.subheadline) }
                    if let date = ServerDate.parse(event.occurredAt) {
                        Text(date, style: .relative).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    @ViewBuilder
    private func actionsSection(_ referral: ReferralRecord) -> some View {
        let access = ReferralActionAvailability.resolve(
            referral: referral,
            currentUser: session.currentUser,
            canAct: session.can("referral.act")
        )
        if access.canClaim || access.canReassign || access.canHandBack || access.canResolve {
            Section {
                if access.canClaim {
                    Button("Claim referral") { Task { await model.claim() } }
                }
                if access.canReassign {
                    Button("Reassign") { transition = .reassign }
                }
                if access.canHandBack {
                    Button("Hand back") { transition = .handBack }
                }
                if access.canResolve {
                    Button("Resolve", role: .destructive) { Task { await model.resolve() } }
                }
                if model.isActing { ProgressView() }
            } header: {
                Text("Actions")
            } footer: {
                Text("The server checks ownership again when you act, so a referral claimed on another phone cannot be overwritten.")
            }
        }
    }

    private func eventTitle(_ event: ReferralEvent) -> String {
        let actor = event.actor?.name ?? "A teammate"
        switch event.action {
        case "created": return "\(actor) referred the conversation"
        case "claimed": return "\(actor) claimed it"
        case "reassigned": return "\(actor) reassigned it to \(event.to?.name ?? "a teammate")"
        case "handed_back": return "\(actor) handed it back"
        case "resolved": return "\(actor) resolved it"
        default: return event.action.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

struct ReferralContextBanner: View {
    let referralID: String
    @StateObject private var model: ReferralDetailModel
    @State private var showsDetail = false

    init(referralID: String) {
        self.referralID = referralID
        _model = StateObject(wrappedValue: ReferralDetailModel(id: referralID))
    }

    var body: some View {
        Group {
            if let referral = model.detail?.referral {
                Button { showsDetail = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "person.2.fill")
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Conversation referral").font(.subheadline.weight(.semibold))
                            Text(referral.initialNote?.isEmpty == false
                                 ? referral.initialNote!
                                 : "From \(referral.referredBy?.name ?? "a teammate")")
                                .font(.caption).lineLimit(2)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption)
                    }
                    .padding(10)
                    .background(ViciTheme.tint.opacity(0.12))
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
            }
        }
        .task { await model.load() }
        .sheet(isPresented: $showsDetail) {
            NavigationStack { ReferralDetailView(referralID: referralID) }
        }
    }
}

private enum ReferralTransition: String, Identifiable {
    case reassign
    case handBack
    var id: String { rawValue }
}

private struct ReferralTransitionView: View {
    let transition: ReferralTransition
    let recipients: [ReferralRecipient]
    let originalReferrer: ReferralUser?
    let completed: (String?, String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedRecipient: String?
    @State private var note = ""
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                if transition == .reassign {
                    Section("New owner") {
                        ForEach(recipients.filter { $0.id != originalReferrer?.id }) { recipient in
                            Button {
                                selectedRecipient = recipient.id
                            } label: {
                                HStack {
                                    Text(recipient.name).foregroundStyle(.primary)
                                    Spacer()
                                    if selectedRecipient == recipient.id { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    }
                } else {
                    Section("Return to") {
                        Text(originalReferrer?.name ?? "Original referrer")
                    }
                }
                Section(transition == .handBack ? "Reason (required)" : "Internal note (optional)") {
                    TextField("Add context", text: $note, axis: .vertical).lineLimit(3...7)
                    Text("\(note.count)/1,000").font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(transition == .handBack ? "Hand back" : "Reassign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        isSaving = true
                        Task {
                            await completed(selectedRecipient, note.trimmingCharacters(in: .whitespacesAndNewlines))
                            isSaving = false
                            dismiss()
                        }
                    }
                    .disabled(isSaving || note.count > 1_000 ||
                              (transition == .reassign && selectedRecipient == nil) ||
                              (transition == .handBack && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
        }
        .assistantDraftOwner(
            source: .referral,
            isDirty: selectedRecipient != nil || !note.isEmpty,
            onDiscard: {
                selectedRecipient = nil
                note = ""
                dismiss()
            }
        )
    }
}

private struct ReferralNamedAccountRequiredView: View {
    var body: some View {
        EmptyState(icon: "person.badge.key.fill",
                   title: "Named account required",
                   detail: "Conversation referrals are available only to named team accounts. Sign out of the shared team login and use your own account.")
    }
}
