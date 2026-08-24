import SwiftUI

/// Saved campaign segments: who the engine thinks is worth contacting, and who
/// a person has overruled it about.
///
/// The backend for this shipped complete and headless. The owner opened Growth,
/// found nothing, and asked where his segments were, which is a fair question
/// to ask of a feature with no interface. This is that interface.
///
/// PERMISSIONS
///   `campaigns.read` sees everything on these screens, including the evidence
///   behind one person's membership, because "why is this customer being
///   contacted?" is a question a Support Agent gets asked and should be able to
///   answer. `campaigns.manage` is what changes anything.
///
///   Read-only means CONTROLS ARE ABSENT, not greyed out. Support Agents do not
///   hold `campaigns.manage`, every mutating route answers them 403, and a
///   disabled button that errors on tap teaches nothing. This follows
///   CampaignsView, which hides its New Campaign button the same way. The
///   contrast with TeamView is deliberate: TeamView disables a control and
///   explains why, because there the actor COULD normally do it and one
///   specific rule is stopping them. Here they never can, so there is nothing
///   to explain at the control and the explanation belongs once, at the bottom
///   of the list.
struct SegmentsView: View {
    @EnvironmentObject private var session: SessionModel
    @StateObject private var model = SegmentListModel()
    @State private var showingNewManual = false
    /// The segment a removal has been asked about but not yet confirmed. One
    /// piece of state rather than a boolean plus a separate selection, so it
    /// cannot be possible to show the dialog holding the wrong segment.
    @State private var pendingRemoval: SegmentRecord?
    @State private var showingDescribe = false

    private var canManage: Bool { session.can(Permission.campaignsManage) }

    var body: some View {
        Group {
            if !session.can(Permission.campaignsRead) {
                EmptyState(icon: "lock.shield",
                           title: "Segments are not available",
                           detail: "This account does not have permission to view segments.")
                    .padding(24)
            } else if model.isLoading && model.segments.isEmpty {
                ProgressView("Loading segments")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.isEmpty {
                SegmentsEmptyStateView(model: model,
                                       canManage: canManage,
                                       createManual: { showingNewManual = true },
                                       createDescribed: { showingDescribe = true })
            } else {
                segmentList
            }
        }
        .toolbar {
            if canManage {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button {
                            showingDescribe = true
                        } label: {
                            Label("Describe one in words", systemImage: "text.bubble")
                        }
                        Button {
                            showingNewManual = true
                        } label: {
                            Label("Pick the people by hand", systemImage: "hand.point.up.left")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New segment")
                }
            }
        }
        .sheet(isPresented: $showingNewManual) {
            SegmentManualEditorView(model: model)
        }
        .sheet(isPresented: $showingDescribe) {
            SegmentRuleBuilderView(listModel: model)
        }
        .refreshable {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load(reset: true)
        }
        .task(id: session.can(Permission.campaignsRead)) {
            guard session.can(Permission.campaignsRead) else { return }
            await model.load()
        }
        .alert("Segments error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("Retry") { Task { await model.load(reset: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        .overlay(alignment: .bottom) {
            if let message = model.statusMessage {
                SegmentToast(message: message)
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        guard !Task.isCancelled else { return }
                        model.statusMessage = nil
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.statusMessage)
        .confirmationDialog(
            "Remove this segment?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { segment in
            Button("Remove it", role: .destructive) {
                let target = segment
                pendingRemoval = nil
                Task { await model.remove(target) }
            }
            Button("Keep it", role: .cancel) { pendingRemoval = nil }
        } message: { segment in
            Text(removalWarning(segment))
        }
    }

    /// What the confirmation has to say before anybody taps Remove.
    ///
    /// It cannot promise either outcome, because the client does not decide:
    /// the server destroys a segment that records no decision about anybody and
    /// archives everything else. So the warning states the destructive
    /// possibility plainly, and the message afterwards reports what actually
    /// happened.
    private func removalWarning(_ segment: SegmentRecord) -> String {
        let people = segment.memberCount == 1
            ? "1 person"
            : "\(segment.memberCount.formatted()) people"
        var text = "\(segment.name) holds \(people)."
        if segment.kind == .automatic {
            text += " It has been worked out by the engine, so it will be archived rather than deleted. It leaves this list and nothing about it is destroyed."
        } else {
            text += " If nobody has used it for a campaign, overridden it, or written down why a named person is in it, it is deleted for good. Otherwise it is archived and nothing is destroyed."
        }
        return text + " Nobody is messaged either way."
    }

    private var segmentList: some View {
        List {
            Section { SegmentSafetyNotice() }

            if !model.automatic.isEmpty {
                Section {
                    ForEach(model.automatic) { segment in
                        segmentRow(segment)
                    }
                } header: {
                    Text("Kept up to date by the engine")
                } footer: {
                    Text("Membership is worked out from order history. You can force one person in or out, and that decision survives every future update.")
                }
            }

            if !model.manual.isEmpty {
                Section {
                    ForEach(model.manual) { segment in
                        segmentRow(segment)
                    }
                } header: {
                    Text("Chosen by hand")
                } footer: {
                    Text("You decide who is in these. The engine never adds or removes anybody.")
                }
            }

            if canManage {
                SegmentDescribeSection { showingDescribe = true }
            }

            if canManage && !model.catalogue.isEmpty {
                SegmentCatalogueSection(model: model)
            }

            if model.isLoadingMore {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }

            Section {
                NavigationLink {
                    SegmentArchiveView(canManage: canManage)
                } label: {
                    Label("Archived segments", systemImage: "archivebox")
                }
            } footer: {
                Text("A segment that carries a record of a decision is archived instead of deleted. It leaves this list and stays readable here.")
            }

            if !canManage {
                Section {
                    Text("You can see who is in a segment and why they are in it. Changing one needs the campaigns manage permission.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func segmentRow(_ segment: SegmentRecord) -> some View {
        NavigationLink {
            // The detail screen is popped the moment a removal succeeds, so it
            // hands the outcome sentence back here to be said. It is the
            // SERVER's sentence: deleted or archived is not the app's call.
            SegmentDetailView(segmentID: segment.id,
                              initialName: segment.name,
                              onRemoved: { message in
                                  model.statusMessage = message
                                  Task { await model.load(reset: true) }
                              })
        } label: {
            SegmentRow(segment: segment)
        }
        .onAppear { Task { await model.loadMoreIfNeeded(after: segment) } }
        // Absent, not disabled. A Support Agent is refused this by the server
        // and a swipe that ends in a 403 teaches nothing.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canManage {
                Button(role: .destructive) {
                    pendingRemoval = segment
                } label: {
                    Label("Remove", systemImage: "trash")
                }
            }
        }
    }
}

// MARK: - The archive

/// Segments that have left the working list without leaving the database.
///
/// This screen is the difference between archiving and deleting. Without it an
/// archive is indistinguishable from a slow delete, and somebody who cannot
/// find a segment again reaches for the destructive path the next time.
struct SegmentArchiveView: View {
    let canManage: Bool
    @StateObject private var model = SegmentArchiveModel()

    var body: some View {
        List {
            if model.isLoading && model.segments.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if model.isEmpty {
                Section {
                    Text("Nothing has been archived.")
                        .foregroundStyle(.secondary)
                } footer: {
                    Text("A segment is archived when it carries a record of a decision: a campaign that used it, an engine run, an override, or a written reason about a named person.")
                }
            } else {
                Section {
                    ForEach(model.segments) { segment in
                        SegmentArchiveRow(segment: segment,
                                          canManage: canManage,
                                          isActing: model.isActing) {
                            Task { await model.restore(segment) }
                        }
                    }
                } header: {
                    Text("Archived")
                } footer: {
                    Text(canManage
                         ? "Nothing here was destroyed. Members, overrides and every recorded decision are intact, and putting one back changes none of them."
                         : "Nothing here was destroyed. Putting one back needs the campaigns manage permission.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .alert("Archive error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Please try again.")
        }
        .overlay(alignment: .bottom) {
            if let message = model.statusMessage {
                SegmentToast(message: message)
                    .padding(.bottom, 12)
                    .task(id: message) {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        guard !Task.isCancelled else { return }
                        model.statusMessage = nil
                    }
            }
        }
    }
}

private struct SegmentArchiveRow: View {
    let segment: SegmentRecord
    let canManage: Bool
    let isActing: Bool
    let restore: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(segment.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                SegmentOriginBadge(kind: segment.kind)
            }
            Text(segment.membershipSummary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let archived = segment.archivedDate {
                Text("Archived \(SegmentDateText.relative(archived)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let purpose = segment.statedPurpose {
                Text(purpose)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            if canManage {
                Button(action: restore) {
                    Label("Put it back", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(.bordered)
                .tint(ViciTheme.tint)
                .disabled(isActing)
            }
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Row

/// One saved segment.
///
/// The origin badge is not decoration. Automatic and manual segments behave
/// differently in a way that matters before you tap: one of them will change
/// under you and the other will not. So the word is on the row, next to the
/// count, rather than implied by which list it is in.
private struct SegmentRow: View {
    let segment: SegmentRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(segment.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                SegmentOriginBadge(kind: segment.kind)
            }

            Text(segment.membershipSummary)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if let description = segment.description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(segment.name). \(segment.kind.originLabel). \(segment.membershipSummary)")
    }
}

/// The origin label, as a word and an icon rather than a colour alone.
struct SegmentOriginBadge: View {
    let kind: SegmentKind

    var body: some View {
        Label(kind.originLabel, systemImage: kind.symbolName)
            .font(.caption2.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.14), in: Capsule())
            .foregroundStyle(tint)
            .accessibilityLabel("\(kind.originLabel) segment")
    }

    private var tint: Color {
        switch kind {
        case .automatic: return ViciTheme.tint
        case .manual:    return ViciTheme.onAvatar
        case .unknown:   return Color.secondary
        }
    }
}

// MARK: - Describing one in words

/// The entry point for the described-segment builder.
///
/// It sits above the catalogue rather than in a menu because it is the answer
/// to the question the catalogue raises: "none of these patterns is the group
/// I actually want." The sentence under the button is the honest description
/// of what happens, including the part where a person reads the rules before
/// anything is saved.
struct SegmentDescribeSection: View {
    let start: () -> Void

    init(_ start: @escaping () -> Void) {
        self.start = start
    }

    var body: some View {
        Section {
            Button(action: start) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Describe one in words", systemImage: "text.bubble")
                        .font(.body.weight(.semibold))
                    Text("Example: customers who bought BPC-157 more than twice and have not ordered since June")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } header: {
            Text("Build your own")
        } footer: {
            Text("Your sentence is turned into rules you can read and change. You see how many people match before anything is saved, and the segment then keeps itself up to date the same way the automatic ones do.")
        }
    }
}

// MARK: - The catalogue

/// The automatic definitions this workspace has not turned on yet.
///
/// `GET /api/segments` returns these in the same payload as the list, so
/// offering them costs nothing extra. Turning one on is idempotent by key:
/// pressing it twice cannot produce two of the same segment.
private struct SegmentCatalogueSection: View {
    @ObservedObject var model: SegmentListModel

    var body: some View {
        Section {
            ForEach(model.catalogue) { entry in
                SegmentCatalogueRow(entry: entry,
                                    isStarting: model.startingKey == entry.key,
                                    isBusy: model.startingKey != nil) {
                    Task { await model.startTracking(entry) }
                }
            }
        } header: {
            Text("Available to turn on")
        } footer: {
            Text("These are the patterns the engine already knows how to find. Turning one on saves it and works out who is in it right now. It never messages anybody.")
        }
    }
}

private struct SegmentCatalogueRow: View {
    let entry: SegmentCatalogueEntry
    let isStarting: Bool
    let isBusy: Bool
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.name).font(.body.weight(.semibold))
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: start) {
                if isStarting {
                    Label("Working out who is in it", systemImage: "hourglass")
                } else {
                    Label("Start tracking", systemImage: "plus.circle")
                }
            }
            .buttonStyle(.bordered)
            .tint(ViciTheme.tint)
            .disabled(isBusy)
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Empty state

/// What a workspace with zero segments sees.
///
/// It is written as a status, not a failure. There genuinely are no segments
/// yet, an automatic one finds nobody until there are consent eligible
/// customers for it to work with, and either way nothing on this screen can
/// message a person. Saying all three plainly is the difference between "not
/// set up yet" and "broken", and the owner has already read one of these
/// screens as the second thing.
private struct SegmentsEmptyStateView: View {
    @ObservedObject var model: SegmentListModel
    let canManage: Bool
    let createManual: () -> Void
    let createDescribed: () -> Void

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label("No segments yet", systemImage: "person.3")
                        .font(.headline)
                    Text("A segment is a saved group of customers. An automatic one is kept up to date by the engine from order history. A manual one holds whoever you put in it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("An automatic segment only ever looks at customers the engine holds a current, clear commercial eligibility record for. It appears once there are consent eligible customers to work with, and until then it will keep finding nobody. That is a fact about the data, not a fault.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }

            Section { SegmentSafetyNotice() }

            if canManage {
                SegmentDescribeSection(createDescribed)

                if model.catalogue.isEmpty {
                    Section {
                        Text("The engine offered no automatic patterns for this workspace. You can still build a segment by hand.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    SegmentCatalogueSection(model: model)
                }

                Section {
                    Button {
                        createManual()
                    } label: {
                        Label("Build one by hand", systemImage: "hand.point.up.left")
                    }
                    .disabled(model.startingKey != nil)
                } footer: {
                    Text("Pick the people yourself. Nothing is worked out for you and nothing changes underneath you.")
                }
            } else {
                Section {
                    Text("Segments appear here once somebody with the campaigns manage permission turns one on. You will be able to see who is in each one and why.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

// MARK: - Shared furniture

/// The sentence that has to be on this screen. A segment is a list of people,
/// not permission to text them, and confusing the two is the expensive mistake
/// this whole subsystem is built to avoid.
struct SegmentSafetyNotice: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label("A segment is not an audience you can text", systemImage: "lock.shield.fill")
                .font(.subheadline.weight(.semibold))
            Text("Nothing on these screens messages anybody, and nothing here can. Consent, provider approval and the live sending switches are all separate and all checked later.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("A segment of 400 people can still have zero people you are allowed to contact.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A short, self-dismissing confirmation. Turning a segment on and updating one
/// are otherwise silent, and silence after a tap reads as a failure.
struct SegmentToast: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote.weight(.medium))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Material.regular, in: Capsule())
            .overlay(Capsule().stroke(ViciTheme.tint.opacity(0.25)))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
            .padding(.horizontal, 20)
            .accessibilityAddTraits(.isStaticText)
    }
}

// MARK: - Creating a manual segment

/// Name it, say what it is for, and optionally choose the first people for it.
///
/// THE PURPOSE IS ONE FIELD, ASKED ONCE, AND REQUIRED.
///   The owner's words were "maybe we do one reason if we're doing a manual
///   segment, and then that reason appears for everybody". So this asks for it
///   here rather than next to each name, the server refuses the segment without
///   it, and it is shown as the explanation for every member.
///
///   It is NOT the per-person note. That still exists, on a member row and on
///   an override, and it answers a different question: not why this group
///   exists but why this one named human is in it, or deliberately not in it.
///   The two are kept apart everywhere.
///
/// A manual segment may legitimately start empty; the backend defaults
/// `members` to an empty array. So the people step is optional and the save
/// button never waits on it.
struct SegmentManualEditorView: View {
    @ObservedObject var model: SegmentListModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var picker = SegmentContactPickerModel()
    @State private var name = ""
    @State private var purpose = ""
    @State private var isSaving = false
    @FocusState private var searchFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedPurpose: String {
        purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Mirrors the server's own validation so a mistake is caught before the
    /// round trip. `textField()` and `requiredPurpose()` in segment-service.js
    /// check the same three things.
    private var validationProblem: String? {
        if trimmedName.isEmpty { return "Give this segment a name." }
        if trimmedName.count > 160 { return "That name is longer than 160 characters." }
        if trimmedPurpose.isEmpty { return "Say what this segment is for." }
        if trimmedPurpose.count > 500 { return "That purpose is longer than 500 characters." }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Example: Regulars who ask for a call", text: $name)
                        .textInputAutocapitalization(.sentences)
                } header: {
                    Text("Name")
                } footer: {
                    Text("Write it the way you would say it out loud. This name shows on the list and on every notification about the segment.")
                }

                Section {
                    TextField("Example: customers who asked about the December restock",
                              text: $purpose, axis: .vertical)
                        .lineLimit(2...5)
                        .textInputAutocapitalization(.sentences)
                } header: {
                    Text("What this segment is for")
                } footer: {
                    Text("Required, and written once. This is the reason shown for everybody in this segment, so you do not have to type it again next to each name. You can still add a note about one person when there is something extra to say about them.")
                }

                Section {
                    TextField("Search name, phone or email", text: $picker.search)
                        .focused($searchFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { searchFocused = false }
                    LabeledContent("Chosen", value: picker.selectedCount.formatted())
                    if picker.isSearching {
                        ProgressView().controlSize(.small)
                            .accessibilityLabel("Searching contacts")
                    }
                } header: {
                    Text("People")
                } footer: {
                    Text("Optional. You can save an empty segment now and add people to it later. Everybody you choose here is explained by the purpose above. Choosing somebody does not check whether they can be messaged.")
                }

                SegmentPickerResultsSection(picker: picker)

                if picker.selectedCount > 0 {
                    SegmentPickerChosenSection(picker: picker)
                }

                if let validationProblem, !trimmedName.isEmpty || picker.selectedCount > 0 {
                    Section {
                        Text(validationProblem)
                            .font(.footnote)
                            .foregroundColor(ViciTheme.destructive)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("New segment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving" : "Save") { save() }
                        .disabled(validationProblem != nil || isSaving)
                }
            }
            .interactiveDismissDisabled(isSaving)
            .task(id: picker.search) {
                if !picker.search.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                }
                await picker.loadContacts()
            }
        }
        .assistantDraftOwner(
            source: .segment,
            isDirty: !name.isEmpty || !purpose.isEmpty || picker.selectedCount > 0,
            onDiscard: {
                name = ""
                purpose = ""
                picker.discardLocalDraft()
                dismiss()
            }
        )
    }

    private func save() {
        guard validationProblem == nil, !isSaving else { return }
        isSaving = true
        searchFocused = false
        Task {
            let created = await model.createManual(name: trimmedName,
                                                   purpose: trimmedPurpose,
                                                   members: picker.selectedInputs)
            isSaving = false
            if created != nil { dismiss() }
        }
    }
}

private struct SegmentPickerResultsSection: View {
    @ObservedObject var picker: SegmentContactPickerModel

    var body: some View {
        Section {
            if let problem = picker.searchProblem {
                Text(problem).font(.footnote).foregroundStyle(.secondary)
                Button("Try again") { Task { await picker.loadContacts() } }
            } else if picker.isSearching && picker.results.isEmpty {
                ProgressView("Loading contacts")
            } else if picker.results.isEmpty {
                Text("No contacts found").foregroundStyle(.secondary)
            } else {
                ForEach(picker.results) { contact in
                    Button {
                        picker.toggle(contact)
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(contact.displayName).font(.body.weight(.medium))
                                Text(PhoneFormatter.pretty(contact.phone))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: picker.isSelected(contact) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(picker.isSelected(contact) ? ViciTheme.tint : Color.secondary)
                                .accessibilityLabel(picker.isSelected(contact) ? "Chosen" : "Not chosen")
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
        } header: {
            Text("Contacts")
        } footer: {
            if picker.resultsTruncated {
                Text("More contacts match. Narrow the search to find one person.")
            } else {
                Text("Search runs on the server, so it covers contacts this device has never loaded.")
            }
        }
    }
}

private struct SegmentPickerChosenSection: View {
    @ObservedObject var picker: SegmentContactPickerModel

    var body: some View {
        Section("Chosen") {
            ForEach(picker.selectedInputs, id: \.phone) { person in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.name ?? PhoneFormatter.pretty(person.phone))
                        if person.name != nil {
                            Text(PhoneFormatter.pretty(person.phone))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button(role: .destructive) {
                        picker.remove(phone: person.phone)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(person.name ?? person.phone)")
                }
            }
        }
    }
}
