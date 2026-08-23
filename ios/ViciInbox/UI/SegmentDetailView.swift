import SwiftUI

/// One segment: who is in it, who has been overruled, and why each of them is
/// where they are.
///
/// THE OVERRIDE MODEL, WHICH THIS SCREEN MUST NOT MISREPRESENT
///   On an automatic segment, forcing somebody in or out is not an edit to the
///   membership list. It is a standing instruction stored in its own table that
///   outlives every future recompute until somebody revokes it. Recompute
///   rewrites member rows; that is exactly why overrides do not live on them.
///   So the copy here never says "remove from segment" for an automatic
///   segment, and revoking never claims to put anybody back: the next update
///   decides, which is the whole point of an automatic segment.
///
///   On a manual segment the opposite is true. There is no engine, so add and
///   remove are literal and the server refuses an override with 409.
struct SegmentDetailView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model: SegmentDetailModel
    @StateObject private var picker = SegmentContactPickerModel()
    @ObservedObject private var authors = SegmentAuthorDirectory.shared
    @State private var showingAddMember = false

    private let initialName: String

    init(segmentID: String, initialName: String) {
        _model = StateObject(wrappedValue: SegmentDetailModel(segmentID: segmentID))
        self.initialName = initialName
    }

    private var canManage: Bool { session.can(Permission.campaignsManage) }

    var body: some View {
        Group {
            if model.isLoading && model.segment == nil {
                ProgressView("Loading segment")
            } else if let segment = model.segment {
                detailList(segment)
            } else {
                EmptyState(icon: "exclamationmark.triangle",
                           title: "Segment unavailable",
                           detail: model.errorMessage ?? "This segment could not be loaded.")
                    .padding(24)
            }
        }
        .navigationTitle(model.segment?.name ?? initialName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load()
            await authors.load(canReadTeam: session.can(Permission.userRead))
        }
        .refreshable { await model.load() }
        .sheet(isPresented: $showingAddMember) {
            SegmentAddMemberSheet(model: model, picker: picker)
        }
        .alert("Segment error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        .overlay(alignment: .bottom) {
            if let message = model.statusMessage {
                SegmentToast(message: message)
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(nanoseconds: 3_500_000_000)
                        guard !Task.isCancelled else { return }
                        model.statusMessage = nil
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.statusMessage)
    }

    @ViewBuilder
    private func detailList(_ segment: SegmentRecord) -> some View {
        List {
            Section {
                HStack {
                    SegmentOriginBadge(kind: segment.kind)
                    Spacer()
                    Text(segment.memberCount == 1 ? "1 person" : "\(segment.memberCount.formatted()) people")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                }
                if let description = segment.description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(segment.kind.originDetail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let updated = segment.lastComputedDate {
                    LabeledContent("Last worked out",
                                   value: updated.formatted(date: .abbreviated, time: .shortened))
                } else if segment.kind == .automatic {
                    LabeledContent("Last worked out", value: "Never")
                }
            }

            if model.isAutomatic && canManage {
                recomputeSection
            }

            if let run = model.lastRun, !run.replayed {
                SegmentRunSection(run: run)
            }

            if segment.kind == .manual && canManage {
                Section {
                    Button {
                        showingAddMember = true
                    } label: {
                        Label("Add someone", systemImage: "person.badge.plus")
                    }
                    .disabled(model.isActing)
                } footer: {
                    Text("Adding somebody here puts them in this segment straight away. It does not check whether they can be messaged.")
                }
            }

            if !model.activeOverrides.isEmpty {
                SegmentOverridesSection(model: model,
                                        overrides: model.activeOverrides,
                                        currentUserID: session.currentUser?.id,
                                        title: "Decisions a person has made",
                                        footer: "These stay in force through every update until somebody revokes them. Tap one to see who made it and to reverse it.")
            }

            membersSection(segment)

            if !model.revokedOverrides.isEmpty {
                SegmentOverridesSection(model: model,
                                        overrides: model.revokedOverrides,
                                        currentUserID: session.currentUser?.id,
                                        title: "Reversed decisions",
                                        footer: "Kept on purpose. A revoked override is never deleted, so who decided what and who undid it both stay readable.")
            }

            if !canManage {
                Section {
                    Text("You can see everyone in this segment and the evidence behind each membership. Changing it needs the campaigns manage permission.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// Recompute, described as what it does rather than as what it is called.
    private var recomputeSection: some View {
        Section {
            Button {
                Task { await model.recompute() }
            } label: {
                if model.isActing {
                    Label("Working it out", systemImage: "hourglass")
                } else {
                    Label("Update membership", systemImage: "arrow.clockwise")
                }
            }
            .disabled(model.isActing)
        } header: {
            Text("Keeping it current")
        } footer: {
            Text("This re-reads order history and works out who belongs here now. Running it twice on an unchanged world changes nothing. Anybody a person has held out stays out.")
        }
    }

    @ViewBuilder
    private func membersSection(_ segment: SegmentRecord) -> some View {
        Section {
            if model.members.isEmpty {
                SegmentEmptyMembership(segment: segment,
                                       hasBeenComputed: model.hasBeenComputed,
                                       canManage: canManage)
            }
            ForEach(model.members) { member in
                NavigationLink {
                    SegmentMemberEvidenceView(segmentID: model.segmentID,
                                              segmentKind: segment.kind,
                                              phone: member.contactPhone,
                                              fallbackName: member.displayName,
                                              parent: model)
                } label: {
                    SegmentMemberRow(member: member)
                }
                .onAppear { Task { await model.loadMoreIfNeeded(after: member) } }
            }
            if model.isLoadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            Text("In this segment")
        } footer: {
            if model.memberTotal > 0 {
                Text("Showing \(model.members.count.formatted()) of \(model.memberTotal.formatted()). Tap anybody to see exactly why they are here.")
            } else {
                Text("Tap anybody to see exactly why they are here.")
            }
        }
    }
}

// MARK: - Membership rows

private struct SegmentMemberRow: View {
    let member: SegmentMember

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(member.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if member.membershipSource != .computed {
                    Text(member.membershipSource.label)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                        .foregroundStyle(.secondary)
                }
            }
            if member.contactName?.isEmpty == false {
                Text(PhoneFormatter.pretty(member.contactPhone))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if member.isKeptAgainstTheEngine {
                Label("The engine no longer matches them", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(ViciTheme.warning)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Zero members is a real answer here, and it means different things depending
/// on whether the engine has run yet. Neither reading is an error.
private struct SegmentEmptyMembership: View {
    let segment: SegmentRecord
    let hasBeenComputed: Bool
    let canManage: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(headline).font(.subheadline.weight(.semibold))
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    private var headline: String {
        if segment.kind == .manual { return "Nobody in it yet" }
        return hasBeenComputed ? "The engine found nobody" : "Not worked out yet"
    }

    private var detail: String {
        if segment.kind == .manual {
            return canManage
                ? "Add the first person and they show up here straight away."
                : "Somebody with the campaigns manage permission can add people to it."
        }
        if hasBeenComputed {
            return "Nobody currently matches these rules. The engine only looks at customers it holds a current, clear commercial eligibility record for, so this stays empty until there are consent eligible customers with the right order history. It fills itself in as that changes."
        }
        return canManage
            ? "This segment has been saved but its membership has not been worked out. Use Update membership above."
            : "This segment has been saved but its membership has not been worked out yet."
    }
}

// MARK: - Runs

/// What the last update actually did. Shown only when something moved, because
/// a replayed run is reported in the toast and does not need a panel.
private struct SegmentRunSection: View {
    let run: SegmentRecomputeRun

    var body: some View {
        Section {
            LabeledContent("Joined", value: run.joinedCount.formatted())
            LabeledContent("Left", value: run.leftCount.formatted())
            if run.forcedIncludeCount > 0 {
                LabeledContent("Kept in by a person", value: run.forcedIncludeCount.formatted())
            }
            if run.excludedCount > 0 {
                LabeledContent("Held out by a person", value: run.excludedCount.formatted())
            }
        } header: {
            Text("The last update")
        } footer: {
            Text("Only people the engine put here can leave. Anybody a person forced in stays in.")
        }
    }
}

// MARK: - Overrides

/// The active and the reversed decisions, each as a sentence naming who made
/// it and when.
private struct SegmentOverridesSection: View {
    @ObservedObject var model: SegmentDetailModel
    let overrides: [SegmentOverride]
    let currentUserID: String?
    let title: String
    let footer: String
    @ObservedObject private var authors = SegmentAuthorDirectory.shared

    init(model: SegmentDetailModel,
         overrides: [SegmentOverride],
         currentUserID: String?,
         title: String,
         footer: String) {
        _model = ObservedObject(wrappedValue: model)
        self.overrides = overrides
        self.currentUserID = currentUserID
        self.title = title
        self.footer = footer
    }

    var body: some View {
        Section {
            ForEach(overrides) { override in
                NavigationLink {
                    SegmentMemberEvidenceView(segmentID: model.segmentID,
                                              segmentKind: model.segment?.kind ?? .automatic,
                                              phone: override.contactPhone,
                                              fallbackName: PhoneFormatter.pretty(override.contactPhone),
                                              parent: model)
                } label: {
                    SegmentOverrideRow(override: override,
                                       author: authors.name(for: override.createdByUserId,
                                                            currentUserID: currentUserID),
                                       revoker: authors.name(for: override.revokedByUserId,
                                                             currentUserID: currentUserID))
                }
            }
        } header: {
            Text(title)
        } footer: {
            Text(footer)
        }
    }
}

private struct SegmentOverrideRow: View {
    let override: SegmentOverride
    let author: String
    let revoker: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(PhoneFormatter.pretty(override.contactPhone),
                  systemImage: override.overrideType.symbolName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(override.isActive ? tint : Color.secondary)
            Text(override.attributionSentence(author: author))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = override.reason, !reason.isEmpty {
                Text("Reason: \(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            if let revocation = override.revocationSentence(author: revoker) {
                Text(revocation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var tint: Color {
        override.overrideType == .exclude ? ViciTheme.destructive : ViciTheme.tint
    }
}

// MARK: - Why is this person here

/// The per-person rule trace.
///
/// The evidence row the engine wrote is read back as a sentence and a short
/// checklist, never as a JSON dump. Nothing on this screen recomputes anything:
/// every number is what the rules said at the time, which is also why the rules
/// version is shown at the bottom of the checklist rather than hidden.
struct SegmentMemberEvidenceView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model: SegmentMemberDetailModel
    @ObservedObject private var authors = SegmentAuthorDirectory.shared
    @ObservedObject private var parent: SegmentDetailModel
    @Environment(\.dismiss) private var dismiss

    @State private var pendingAction: SegmentPersonAction?
    @State private var confirmingRemoval = false

    private let segmentKind: SegmentKind

    init(segmentID: String,
         segmentKind: SegmentKind,
         phone: String,
         fallbackName: String,
         parent: SegmentDetailModel) {
        _model = StateObject(wrappedValue: SegmentMemberDetailModel(segmentID: segmentID,
                                                                    phone: phone,
                                                                    fallbackName: fallbackName))
        _parent = ObservedObject(wrappedValue: parent)
        self.segmentKind = segmentKind
    }

    private var canManage: Bool { session.can(Permission.campaignsManage) }

    var body: some View {
        List {
            if model.isLoading && model.detail == nil {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if let detail = model.detail {
                content(detail)
            } else {
                Section {
                    Text(model.errorMessage ?? "This person could not be loaded.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(model.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load()
            // Guarded and cached inside the directory, so this is a no-op when
            // the segment screen already loaded it. It is here anyway because
            // the author of an override is the one thing on this screen that
            // needs a second endpoint, and it must not depend on the order two
            // screens happened to appear in.
            await authors.load(canReadTeam: session.can(Permission.userRead))
        }
        .sheet(item: $pendingAction) { action in
            SegmentReasonSheet(action: action) { reason in
                pendingAction = nil
                await perform(action, reason: reason)
            }
        }
        .confirmationDialog("Remove \(model.displayName)?",
                            isPresented: $confirmingRemoval,
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    await parent.removeMember(phone: model.phone, displayName: model.displayName)
                    dismiss()
                }
            }
            Button("Keep them", role: .cancel) {}
        } message: {
            Text("They leave this manual segment straight away. Nothing else about them changes.")
        }
        .alert("Could not load", isPresented: Binding(
            get: { model.errorMessage != nil && model.detail != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
    }

    @ViewBuilder
    private func content(_ detail: SegmentMemberDetail) -> some View {
        Section {
            Text(headline(detail))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            LabeledContent("Phone", value: PhoneFormatter.pretty(model.phone))
        } header: {
            Text(model.isExcludedNonMember ? "Why they are not here" : "Why they are here")
        }

        if let notice = detail.member?.evidence.overruleNotice {
            Section {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        if let member = detail.member {
            let facts = member.evidence.facts
            if !facts.isEmpty {
                Section {
                    ForEach(facts) { fact in
                        LabeledContent(fact.label, value: fact.value)
                    }
                } header: {
                    Text("What that is based on")
                } footer: {
                    Text("These are the numbers the engine recorded at the time, not a fresh calculation. That is why an old membership still reads as what the rules said then.")
                }
            }
            SegmentMemberTimingSection(member: member)
        }

        if let active = detail.activeOverride {
            activeOverrideSection(active)
        } else if canManage {
            actionSection()
        }

        if detail.overrideHistory.count > (detail.activeOverride == nil ? 0 : 1) {
            Section {
                ForEach(detail.overrideHistory.filter { $0.id != detail.activeOverride?.id }) { override in
                    SegmentOverrideRow(override: override,
                                       author: authors.name(for: override.createdByUserId,
                                                            currentUserID: session.currentUser?.id),
                                       revoker: authors.name(for: override.revokedByUserId,
                                                             currentUserID: session.currentUser?.id))
                }
            } header: {
                Text("Earlier decisions about this person")
            } footer: {
                Text("Nothing here was deleted. Every decision and every reversal stays on the record.")
            }
        }
    }

    private func headline(_ detail: SegmentMemberDetail) -> String {
        if let member = detail.member {
            return member.evidence.headline(personName: model.displayName)
        }
        if detail.activeOverride?.overrideType == .exclude {
            return "\(model.displayName) is deliberately held out of this segment. The engine may or may not match them. While this exclusion stands they will not be added by any update."
        }
        return "\(model.displayName) is not in this segment."
    }

    @ViewBuilder
    private func activeOverrideSection(_ override: SegmentOverride) -> some View {
        Section {
            Text(override.attributionSentence(
                author: authors.name(for: override.createdByUserId,
                                     currentUserID: session.currentUser?.id)))
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            if let reason = override.reason, !reason.isEmpty {
                Text("Reason: \(reason)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if canManage {
                Button(role: .destructive) {
                    pendingAction = SegmentPersonAction(kind: .revoke,
                                                        phone: model.phone,
                                                        displayName: model.displayName,
                                                        overrideType: override.overrideType)
                } label: {
                    Label("Reverse this decision", systemImage: "arrow.uturn.backward")
                }
                .disabled(parent.isActing)
            }
        } header: {
            Text("A person overruled the engine")
        } footer: {
            Text(override.overrideType == .exclude
                 ? "This exclusion outlives every update. Reversing it does not add them back; the next update decides."
                 : "This force include keeps them in whether or not the engine matches them. Reversing it does not remove them; the next update decides.")
        }
    }

    /// The mutating controls. Absent entirely without `campaigns.manage`, and
    /// different in kind by segment origin: an automatic segment gets overrides
    /// because its membership is not a list anybody may edit, and a manual one
    /// gets a real removal because its membership is exactly that.
    @ViewBuilder
    private func actionSection() -> some View {
        if segmentKind == .automatic {
            Section {
                Button(role: .destructive) {
                    pendingAction = SegmentPersonAction(kind: .exclude,
                                                        phone: model.phone,
                                                        displayName: model.displayName,
                                                        overrideType: .exclude)
                } label: {
                    Label("Hold them out of this segment", systemImage: "nosign")
                }
                .disabled(parent.isActing)

                Button {
                    pendingAction = SegmentPersonAction(kind: .include,
                                                        phone: model.phone,
                                                        displayName: model.displayName,
                                                        overrideType: .include)
                } label: {
                    Label("Keep them in whatever the engine says", systemImage: "pin")
                }
                .disabled(parent.isActing)
            } header: {
                Text("Overrule the engine")
            } footer: {
                Text("Neither of these edits the membership list. They are standing instructions that survive every future update until somebody reverses them, and both are recorded against your name.")
            }
        } else if segmentKind == .manual {
            Section {
                Button(role: .destructive) {
                    confirmingRemoval = true
                } label: {
                    Label("Remove from this segment", systemImage: "person.badge.minus")
                }
                .disabled(parent.isActing)
            } footer: {
                Text("You chose everybody in this segment, so removing somebody is exactly that. Nothing recalculates afterwards.")
            }
        }
    }

    private func perform(_ action: SegmentPersonAction, reason: String?) async {
        switch action.kind {
        case .exclude, .include:
            await parent.setOverride(phone: action.phone,
                                     displayName: action.displayName,
                                     overrideType: action.overrideType,
                                     reason: reason)
        case .revoke:
            await parent.revokeOverride(phone: action.phone,
                                        displayName: action.displayName,
                                        reason: reason)
        }
        await model.load()
    }
}

/// When the engine first saw this person here, and when it last confirmed it.
private struct SegmentMemberTimingSection: View {
    let member: SegmentMember

    var body: some View {
        Section {
            LabeledContent("Membership source", value: member.membershipSource.label)
            if let first = SegmentDateText.day(member.firstSeenAt) {
                LabeledContent("First seen here", value: first)
            }
            if let last = SegmentDateText.day(member.lastSeenAt) {
                LabeledContent("Last confirmed", value: last)
            }
        } header: {
            Text("This membership")
        }
    }
}

// MARK: - Reason sheets

/// One pending decision about one person. A single piece of state rather than
/// three booleans, so it cannot be possible to show the revoke sheet while
/// holding the person the exclude button picked.
struct SegmentPersonAction: Identifiable {
    enum Kind { case exclude, include, revoke }

    let kind: Kind
    let phone: String
    let displayName: String
    let overrideType: SegmentOverrideType

    var id: String { "\(phone).\(kind)" }

    var title: String {
        switch kind {
        case .exclude: return "Hold out \(displayName)"
        case .include: return "Keep \(displayName) in"
        case .revoke:  return "Reverse this decision"
        }
    }

    var explanation: String {
        switch kind {
        case .exclude:
            return "\(displayName) will not be put in this segment by any future update, however well they match. This stands until somebody reverses it."
        case .include:
            return "\(displayName) stays in this segment even when the engine stops matching them. This stands until somebody reverses it."
        case .revoke:
            return overrideType == .exclude
                ? "The hold on \(displayName) is lifted. They are not added back by this. The next update decides whether they belong here."
                : "\(displayName) is no longer forced in. They are not removed by this. The next update decides whether they stay."
        }
    }

    var actionTitle: String {
        switch kind {
        case .exclude: return "Hold them out"
        case .include: return "Keep them in"
        case .revoke:  return "Reverse it"
        }
    }

    var isDestructive: Bool { kind != .include }
}

/// Asks for the reason before the decision is recorded.
///
/// The reason is optional at the API, and asked for anyway, because the whole
/// value of an override that survives recomputation is that a colleague can
/// read later why it is there.
private struct SegmentReasonSheet: View {
    let action: SegmentPersonAction
    let confirm: (String?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var isWorking = false
    @FocusState private var focused: Bool

    private var trimmed: String {
        reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(action.explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section {
                    TextField("Example: asked us not to contact them", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($focused)
                } header: {
                    Text("Reason")
                } footer: {
                    Text("Optional, and worth writing. Whoever reads this in three months will see your name, the date and this sentence, and nothing else.")
                }
            }
            .navigationTitle(action.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action.actionTitle,
                           role: action.isDestructive ? ButtonRole.destructive : nil) {
                        isWorking = true
                        focused = false
                        Task {
                            await confirm(trimmed.isEmpty ? nil : trimmed)
                            isWorking = false
                        }
                    }
                    .disabled(isWorking || trimmed.count > 500)
                }
            }
            .interactiveDismissDisabled(isWorking)
        }
    }
}

// MARK: - Adding somebody to a manual segment

private struct SegmentAddMemberSheet: View {
    @ObservedObject var model: SegmentDetailModel
    @ObservedObject var picker: SegmentContactPickerModel
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var isWorking = false
    @State private var chosen: ConversationSummary?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Search name, phone or email", text: $picker.search)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if picker.isSearching {
                        ProgressView().controlSize(.small)
                            .accessibilityLabel("Searching contacts")
                    }
                } header: {
                    Text("Who")
                } footer: {
                    Text("Search runs on the server. Adding somebody puts them in this segment straight away.")
                }

                Section("Contacts") {
                    if let problem = picker.searchProblem {
                        Text(problem).font(.footnote).foregroundStyle(.secondary)
                    } else if picker.results.isEmpty && !picker.isSearching {
                        Text("No contacts found").foregroundStyle(.secondary)
                    }
                    ForEach(picker.results) { contact in
                        Button {
                            chosen = contact
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.displayName)
                                    Text(PhoneFormatter.pretty(contact.phone))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: chosen?.phone == contact.phone
                                      ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(chosen?.phone == contact.phone
                                                     ? ViciTheme.tint : Color.secondary)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }

                Section {
                    TextField("Why are they in this group?", text: $reason, axis: .vertical)
                        .lineLimit(2...4)
                } header: {
                    Text("Reason")
                } footer: {
                    Text("Optional. It is stored as the evidence behind their membership, so it is what somebody sees when they ask why this person is here.")
                }
            }
            .navigationTitle("Add someone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isWorking ? "Adding" : "Add") { add() }
                        .disabled(chosen == nil || isWorking)
                }
            }
            .interactiveDismissDisabled(isWorking)
            .task(id: picker.search) {
                if !picker.search.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                }
                await picker.loadContacts()
            }
        }
    }

    private func add() {
        guard let contact = chosen, !isWorking else { return }
        isWorking = true
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = SegmentMemberInput(phone: PhoneFormatter.e164(contact.phone),
                                       name: contact.displayName,
                                       contactID: contact.recordID?.rawValue,
                                       reason: trimmed.isEmpty ? nil : trimmed)
        Task {
            await model.addMember(input)
            isWorking = false
            dismiss()
        }
    }
}
