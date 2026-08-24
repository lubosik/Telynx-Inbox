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
    /// Reads `/api/segments/:id/candidates`, which has already subtracted the
    /// people who are in this segment. Not the contacts picker: that one is for
    /// a segment that does not exist yet, where nobody can already be a member.
    @StateObject private var picker: SegmentCandidatePickerModel
    @ObservedObject private var authors = SegmentAuthorDirectory.shared
    @Environment(\.dismiss) private var dismiss
    @State private var showingAddMember = false
    @State private var confirmingSegmentRemoval = false

    private let initialName: String
    /// Called with the sentence describing what the server actually did, so the
    /// list behind this screen can refresh and say it. This screen is popped
    /// immediately afterwards and cannot say it itself.
    private let onRemoved: ((String) -> Void)?

    init(segmentID: String, initialName: String, onRemoved: ((String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: SegmentDetailModel(segmentID: segmentID))
        _picker = StateObject(wrappedValue: SegmentCandidatePickerModel(segmentID: segmentID))
        self.initialName = initialName
        self.onRemoved = onRemoved
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
            SegmentAddMemberSheet(model: model,
                                  picker: picker,
                                  segmentKind: model.segment?.kind ?? .manual,
                                  segmentPurpose: model.segment?.statedPurpose)
        }
        .confirmationDialog("Remove this segment?",
                            isPresented: $confirmingSegmentRemoval,
                            titleVisibility: .visible) {
            Button("Remove it", role: .destructive) {
                Task {
                    guard let message = await model.remove(archiveOnly: false) else { return }
                    onRemoved?(message)
                    dismiss()
                }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text(removalWarning)
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
                if let purpose = segment.statedPurpose {
                    // The segment's one reason. It is the explanation for
                    // everybody in it, so it is stated here once rather than
                    // repeated against every name below.
                    VStack(alignment: .leading, spacing: 3) {
                        Text("What this is for")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(purpose)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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

            if canManage {
                addSomeoneSection(segment)
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

            if canManage {
                Section {
                    Button(role: .destructive) {
                        confirmingSegmentRemoval = true
                    } label: {
                        Label("Remove this segment", systemImage: "trash")
                    }
                    .disabled(model.isActing)
                } footer: {
                    Text("Whether this is deleted or archived is not up to you or to this app. A segment that no campaign used, that the engine never worked out, that nobody overruled and where nobody wrote down why a named person is in it is deleted. Anything else is archived, stays readable, and can be put back.")
                }
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

    /// What the confirmation says before anybody taps Remove. It cannot promise
    /// either outcome, so it names the destructive possibility plainly.
    private var removalWarning: String {
        guard let segment = model.segment else {
            return "This may be deleted for good, or archived if it carries a record of a decision. Nobody is messaged either way."
        }
        let people = segment.memberCount == 1
            ? "1 person"
            : "\(segment.memberCount.formatted()) people"
        var text = "\(segment.name) holds \(people)."
        if segment.kind == .automatic {
            text += " The engine has worked it out, so it will be archived rather than deleted. Nothing about it is destroyed."
        } else {
            text += " If nobody used it for a campaign, overruled it, or wrote down why a named person is in it, it is deleted for good. Otherwise it is archived and nothing is destroyed."
        }
        return text + " Nobody is messaged either way."
    }

    /// Adding somebody, which means two different things.
    ///
    /// On a manual segment it is a literal membership edit. On an automatic one
    /// it is a force include: a standing instruction that keeps somebody in
    /// whether or not the engine agrees. Before this the second was only
    /// reachable from a person already listed, which made pinning somebody the
    /// engine had never matched impossible, and that is the case it is most for.
    @ViewBuilder
    private func addSomeoneSection(_ segment: SegmentRecord) -> some View {
        if segment.kind == .manual {
            Section {
                Button {
                    showingAddMember = true
                } label: {
                    Label("Add someone", systemImage: "person.badge.plus")
                }
                .disabled(model.isActing)
            } footer: {
                Text("Adding somebody here puts them in this segment straight away. People already in it are not offered again. It does not check whether they can be messaged.")
            }
        } else if segment.kind == .automatic {
            Section {
                Button {
                    showingAddMember = true
                } label: {
                    Label("Keep someone in", systemImage: "pin")
                }
                .disabled(model.isActing)
            } footer: {
                Text("This is a force include, not a membership edit. They stay in whether or not the engine matches them, until somebody reverses it. People already in this segment are not offered here; to pin one of them, open their name below.")
            }
        }
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
            // The way out of the single-audience view of a person. Most people
            // here are in several audiences and this screen cannot say so,
            // because it was only asked about one.
            NavigationLink {
                SegmentMembershipsView(phone: model.phone, fallbackName: model.displayName)
            } label: {
                Label("Every audience they are in", systemImage: "square.stack.3d.up")
            }
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
            let exits = member.evidence.exitConditions
            if !exits.isEmpty {
                Section {
                    ForEach(exits, id: \.self) { condition in
                        Label(condition, systemImage: "arrow.right.circle")
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } header: {
                    Text("What would take them back out")
                } footer: {
                    Text("An automatic segment is meant to be predictable. These are the conditions the engine checks, so you can tell in advance when somebody will drop out of it.")
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
            // The segment's purpose is passed in because it lives on the
            // segment and not on this person's evidence. It is the common-case
            // explanation; the per-person note, when there is one, is still
            // said underneath it rather than replaced by it.
            return member.evidence.headline(personName: model.displayName,
                                            segmentPurpose: detail.segment.statedPurpose)
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

// MARK: - Adding somebody to an existing segment

/// Adding somebody to a segment that already exists.
///
/// THE PEOPLE ALREADY IN IT ARE NOT HERE, AND THE SERVER IS WHY.
///   The owner added three contacts, opened this again, and all three were
///   still offered. The fix is not to filter what is on screen: this list is
///   paged and searchable, so a member on the next page would still have been
///   offered a scroll later. `/api/segments/:id/candidates` subtracts
///   membership before it pages, which is also the only way its counts can be
///   true. This view must not re-filter; it would be filtering a set the phone
///   does not hold.
///
/// SOMEBODY HELD OUT IS SHOWN, NOT HIDDEN.
///   An active exclude override is a decision a person made that outlives every
///   recompute. They are not a member and they are not simply absent either. A
///   database trigger refuses to add them while it stands, so hiding them would
///   leave a name missing with no way to find out why. They appear in their own
///   section, with who held them out and the reason, and tapping one opens the
///   page where that can be reversed.
private struct SegmentAddMemberSheet: View {
    @ObservedObject var model: SegmentDetailModel
    @ObservedObject var picker: SegmentCandidatePickerModel
    let segmentKind: SegmentKind
    let segmentPurpose: String?

    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var authors = SegmentAuthorDirectory.shared
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var isWorking = false
    @State private var chosen: SegmentCandidate?

    private var isForceInclude: Bool { segmentKind == .automatic }

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
                    Text(isForceInclude
                         ? "Search runs on the server. Anybody already in this segment is left out of these results."
                         : "Search runs on the server. Anybody already in this segment is left out of these results, so you cannot add the same person twice.")
                }

                candidatesSection

                if !picker.held.isEmpty {
                    heldSection
                }

                noteSection
            }
            .navigationTitle(isForceInclude ? "Keep someone in" : "Add someone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmTitle) { commit() }
                        .disabled(chosen == nil || isWorking)
                }
            }
            .interactiveDismissDisabled(isWorking)
            .task(id: picker.search) {
                if !picker.search.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                }
                await picker.load()
            }
            .task { await authors.load(canReadTeam: session.can(Permission.userRead)) }
        }
    }

    private var confirmTitle: String {
        if isWorking { return isForceInclude ? "Keeping" : "Adding" }
        return isForceInclude ? "Keep in" : "Add"
    }

    @ViewBuilder
    private var candidatesSection: some View {
        Section {
            if let problem = picker.problem {
                Text(problem).font(.footnote).foregroundStyle(.secondary)
                Button("Try again") { Task { await picker.load() } }
            } else if picker.isSearching && picker.candidates.isEmpty {
                ProgressView("Loading contacts")
            } else if picker.candidates.isEmpty {
                Text(picker.held.isEmpty
                     ? "Nobody left to add."
                     : "Nobody left to add. The only matches are people somebody has held out.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(picker.candidates) { candidate in
                    Button {
                        chosen = candidate
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.displayName)
                                Text(PhoneFormatter.pretty(candidate.contactPhone))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: chosen?.contactPhone == candidate.contactPhone
                                  ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(chosen?.contactPhone == candidate.contactPhone
                                                 ? ViciTheme.tint : Color.secondary)
                                .accessibilityLabel(chosen?.contactPhone == candidate.contactPhone
                                                    ? "Chosen" : "Not chosen")
                        }
                    }
                    .foregroundStyle(.primary)
                    .onAppear { Task { await picker.loadMoreIfNeeded(after: candidate) } }
                }
                if picker.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        } header: {
            Text("Contacts")
        } footer: {
            if let sentence = picker.alreadyInSentence {
                Text(sentence)
            } else {
                Text("Choosing somebody does not check whether they can be messaged.")
            }
        }
    }

    /// The people a person deliberately held out. Deliberately not selectable:
    /// the database refuses the insert while the exclusion stands, so an
    /// enabled control here would produce a 409 and teach nothing. The way
    /// back in is to reverse the decision, which is on their own page.
    @ViewBuilder
    private var heldSection: some View {
        Section {
            ForEach(picker.held) { person in
                NavigationLink {
                    SegmentMemberEvidenceView(segmentID: model.segmentID,
                                              segmentKind: segmentKind,
                                              phone: person.contactPhone,
                                              fallbackName: person.displayName,
                                              parent: model)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(person.displayName, systemImage: "nosign")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ViciTheme.destructive)
                        Text(PhoneFormatter.pretty(person.contactPhone))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(person.heldSentence(
                            author: authors.name(for: person.override?.createdByUserId,
                                                 currentUserID: session.currentUser?.id)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let reason = person.reason {
                            Text("Reason: \(reason)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("Held out of this segment")
        } footer: {
            Text("These people match your search but somebody decided to keep them out, and that decision survives every update. They cannot be added while it stands. Tap one to see who decided it and to reverse it.")
        }
    }

    /// The per-person note.
    ///
    /// On a manual segment the group already has a purpose, written once, that
    /// explains everybody in it. So this is genuinely optional here and is
    /// labelled as what it is: the extra thing that is true of this person and
    /// not of the rest.
    ///
    /// On an automatic segment there is no group purpose, because the detector
    /// is the purpose. Here the note is the whole record of why a human
    /// overruled the engine, which is the case it has always earned.
    @ViewBuilder
    private var noteSection: some View {
        Section {
            if let segmentPurpose, !isForceInclude {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Everybody in this segment is explained by:")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(segmentPurpose)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            TextField(isForceInclude
                      ? "Why are you overruling the engine for this person?"
                      : "Anything extra about this person?",
                      text: $note, axis: .vertical)
                .lineLimit(2...4)
        } header: {
            Text(isForceInclude ? "Reason" : "Note about this person")
        } footer: {
            Text(isForceInclude
                 ? "Worth writing. This override outlives every future update, and whoever reads it in three months will see your name, the date and this sentence."
                 : "Optional. The segment purpose above is already recorded for everybody here, so this is only for what is true of this one person, such as when and why they asked.")
        }
    }

    private func commit() {
        guard let candidate = chosen, !isWorking else { return }
        isWorking = true
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = trimmed.isEmpty ? nil : trimmed
        Task {
            if isForceInclude {
                await model.forceInclude(candidate, reason: reason)
            } else {
                await model.addMember(SegmentMemberInput(phone: candidate.contactPhone,
                                                         name: candidate.contactName,
                                                         contactID: candidate.contactId?.rawValue,
                                                         reason: reason))
            }
            isWorking = false
            dismiss()
        }
    }
}

// MARK: - Why is this person here

/// Every audience one person is in, each with its own reason, on one screen.
///
/// WHY THIS IS SEPARATE FROM SegmentMemberDetailView
///   That screen answers "why is this person in THIS segment", correctly, and
///   keeps the controls that act on that one membership. It is the right screen
///   when a segment is what you are working on.
///
///   It is the wrong screen when a PERSON is what you are working on, because
///   the audiences overlap. Measured on the live workspace: 1,607 memberships
///   across 517 people, 511 of them in more than one audience and 205 in four.
///   Reading them one at a time meant four screens, and nothing on any of the
///   four said there were three others.
///
/// READ ONLY, DELIBERATELY
///   Every mutating control stays on the per-segment screen. Acting on one
///   membership from a list of four invites acting on the wrong one, and the
///   confirmation would have to name which audience anyway. Tapping a card goes
///   there, where the controls already are and are already scoped.
struct SegmentMembershipsView: View {
    @StateObject private var model: SegmentMembershipsModel

    init(phone: String, fallbackName: String) {
        _model = StateObject(wrappedValue: SegmentMembershipsModel(phone: phone,
                                                                   fallbackName: fallbackName))
    }

    var body: some View {
        List {
            if let summary = model.summary {
                Section {
                    Text(summary.overview(personName: model.displayName))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                } footer: {
                    if summary.live.count > 1 {
                        // The question somebody asks the moment they see four
                        // cards. Answering it here stops it reading as a fault.
                        Text("Audiences overlap on purpose. A smaller group is often drawn inside a larger one, so the same person belongs in both and both reasons are true.")
                    }
                }

                if !summary.live.isEmpty {
                    Section("In these audiences now") {
                        ForEach(summary.live) { entry in
                            membershipCard(entry)
                        }
                    }
                }

                if !summary.archived.isEmpty {
                    Section {
                        ForEach(summary.archived) { entry in
                            membershipCard(entry)
                        }
                    } header: {
                        Text("Archived audiences")
                    } footer: {
                        Text("These are not used for anything. They are shown because this person is still recorded in them.")
                    }
                }

                if model.isEmptyResult {
                    Section {
                        Text("\(model.displayName) has not matched any audience. That usually means they have not ordered yet.")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if let message = model.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try again") { Task { await model.load() } }
                }
            } else {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Reading the reasons").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(model.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
    }

    /// One audience, and why this person is in it.
    @ViewBuilder
    private func membershipCard(_ entry: SegmentMembershipEntry) -> some View {
        // Opens the AUDIENCE, not the per-membership sheet.
        //
        // SegmentMemberEvidenceView needs a SegmentDetailModel parent, because
        // the controls on it act through that screen's state. Constructing a
        // throwaway parent here to satisfy the initialiser would give those
        // controls somewhere to write that nothing is listening to, which is
        // worse than not offering them: the tap would appear to work.
        //
        // Going to the audience is also the better answer. From there the
        // per-person sheet is one tap away, with the state it needs.
        NavigationLink {
            SegmentDetailView(segmentID: entry.segment.id, initialName: entry.segment.name)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.segment.name)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)

                Text(reason(for: entry))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if entry.isHumanDecision {
                    Label("Someone put them here by hand", systemImage: "hand.raised.fill")
                        .font(.caption)
                        .foregroundStyle(ViciTheme.warning)
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// The per-person sentence, written by the same code the single-segment
    /// screen uses. Reusing it is the point: two renderers for one fact drift,
    /// and the one that drifts is the one explaining why a real customer is
    /// about to be messaged.
    private func reason(for entry: SegmentMembershipEntry) -> String {
        if let member = entry.member {
            return member.evidence.headline(personName: model.displayName,
                                            segmentPurpose: entry.segment.statedPurpose)
        }
        if entry.activeOverride?.overrideType == .exclude {
            return "\(model.displayName) is deliberately held out of this audience."
        }
        if let purpose = entry.segment.statedPurpose, !purpose.isEmpty {
            return purpose
        }
        return "No reason was recorded for this membership."
    }
}
