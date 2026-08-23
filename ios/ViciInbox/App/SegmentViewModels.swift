import Foundation

/// View models for the Segments screens.
///
/// Every mutation here is refused server side without `campaigns.manage`, and
/// the views hide rather than disable those controls. Both halves matter: the
/// hiding is what a Support Agent experiences, the server check is what makes
/// it true.

// MARK: - Who did this

/// Turns an override's `createdByUserId` into a name.
///
/// `GET /api/users` needs `user.read`, which Owner and Admin hold and a Support
/// Agent does not. So this is asked for permission first and degrades to "a
/// team member" rather than firing a request that will come back 403. The date
/// and the reason are always shown regardless, because those come with the
/// override row itself and are the part that matters most.
@MainActor
final class SegmentAuthorDirectory: ObservableObject {
    static let shared = SegmentAuthorDirectory()

    @Published private(set) var namesByID: [String: String] = [:]
    private var hasLoaded = false
    private var isLoading = false

    func load(canReadTeam: Bool) async {
        guard canReadTeam, !hasLoaded, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        guard let directory = try? await APIClient.shared.fetchTeam() else { return }
        var resolved: [String: String] = [:]
        for member in directory.members where !member.id.isEmpty {
            resolved[member.id] = member.name
        }
        namesByID = resolved
        hasLoaded = true
    }

    /// `currentUserID` is compared as a string because `AuthUser.id` is a
    /// string and the override carries a numeric id. `FlexibleID` already
    /// normalised both to the same representation.
    func name(for userID: FlexibleID?, currentUserID: String?) -> String {
        guard let userID else { return "a team member" }
        if let currentUserID, currentUserID == userID.rawValue { return "you" }
        if let known = namesByID[userID.rawValue] { return known }
        return "a team member"
    }
}

// MARK: - The list

@MainActor
final class SegmentListModel: ObservableObject {
    @Published private(set) var segments: [SegmentRecord] = []
    /// Automatic definitions this workspace has not saved yet. Present in the
    /// same payload as the list, so the empty state costs no extra request.
    @Published private(set) var catalogue: [SegmentCatalogueEntry] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    /// The catalogue key currently being turned on, so its row can show
    /// progress and cannot be tapped twice.
    @Published private(set) var startingKey: String?
    @Published private(set) var isRemoving = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?

    private var nextPage = 1
    private var total = 0
    private let pageSize = 50

    var hasMore: Bool { segments.count < total }
    var automatic: [SegmentRecord] { segments.filter { $0.kind == .automatic } }
    var manual: [SegmentRecord] { segments.filter { $0.kind != .automatic } }
    var isEmpty: Bool { segments.isEmpty && !isLoading }

    func load(reset: Bool = false) async {
        guard !isLoading else { return }
        if reset { nextPage = 1; total = 0 }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await APIClient.shared.fetchSegments(page: 1, pageSize: pageSize)
            segments = page.items
            catalogue = page.catalogue
            total = page.total
            nextPage = 2
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadMoreIfNeeded(after segment: SegmentRecord) async {
        guard segment.id == segments.last?.id, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await APIClient.shared.fetchSegments(page: nextPage, pageSize: pageSize)
            let known = Set(segments.map(\.id))
            segments.append(contentsOf: page.items.filter { !known.contains($0.id) })
            catalogue = page.catalogue
            total = page.total
            nextPage += 1
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Save a catalogue definition, then work out who is in it.
    ///
    /// Two calls on purpose. `POST /api/segments` saves an automatic segment
    /// with no members at all; only a recompute reads the engine. Leaving the
    /// second call to the operator would mean every new segment appeared as
    /// "0 people", which reads as broken rather than as unfinished.
    ///
    /// A failed recompute is reported but does not undo the save. The segment
    /// exists, it is simply not worked out yet, and its own screen says so and
    /// offers the button again.
    func startTracking(_ entry: SegmentCatalogueEntry) async {
        guard startingKey == nil else { return }
        startingKey = entry.key
        defer { startingKey = nil }

        let created: SegmentCreationResponse
        do {
            created = try await APIClient.shared.createAutomaticSegment(definitionKey: entry.key)
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        var outcome = created.didCreate
            ? "\(entry.name) is now being tracked."
            : "\(entry.name) was already being tracked."
        do {
            let run = try await APIClient.shared.recomputeSegment(id: created.segment.id)
            outcome = "\(entry.name) is now being tracked. \(run.outcomeSentence)"
            errorMessage = nil
        } catch {
            // The save stood. Say what did and did not happen rather than
            // implying the whole action failed.
            errorMessage = "\(entry.name) was saved, but working out who is in it did not finish. Open it and try Update membership. \(error.localizedDescription)"
        }
        statusMessage = outcome
        await load(reset: true)
    }

    /// Returns the new segment on success so the caller can navigate into it.
    ///
    /// `purpose` is required by the server and by the form. It is the one
    /// reason a manual segment carries, and it becomes the explanation shown
    /// for every person in it.
    func createManual(name: String,
                      purpose: String,
                      members: [SegmentMemberInput]) async -> SegmentRecord? {
        do {
            let response = try await APIClient.shared.createManualSegment(name: name,
                                                                          purpose: purpose,
                                                                          members: members)
            errorMessage = nil
            let count = response.memberCount ?? members.count
            statusMessage = count == 0
                ? "\(response.segment.name) created. Nobody is in it yet."
                : "\(response.segment.name) created with \(count == 1 ? "1 person" : "\(count) people")."
            await load(reset: true)
            return response.segment
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Remove a segment, and report which of the two things actually happened.
    ///
    /// THE CLIENT DOES NOT DECIDE. It may ask for the archive; it may never ask
    /// for the deletion. A segment that no campaign used, that the engine never
    /// ran on, that nobody overrode and where nobody wrote down why a named
    /// person is in it is destroyed. Everything else is archived, and the
    /// server says which and why. So the confirmation this follows must warn
    /// about the destructive possibility, and the message afterwards must
    /// report the outcome rather than repeat the request.
    @discardableResult
    func remove(_ segment: SegmentRecord, archiveOnly: Bool = false) async -> Bool {
        guard !isRemoving else { return false }
        isRemoving = true
        defer { isRemoving = false }
        do {
            let result = try await APIClient.shared.removeSegment(id: segment.id,
                                                                  archiveOnly: archiveOnly)
            errorMessage = nil
            var message = result.outcomeSentence(segmentName: segment.name)
            if !result.wasDeleted, let why = result.explanations.first {
                message += " \(why)"
            }
            statusMessage = message
            await load(reset: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

// MARK: - The archive

/// Archived segments, on their own screen.
///
/// They leave the working list and they do not leave the database, which is the
/// whole difference between archiving and deleting. If there were no way to
/// look at them the archive would be indistinguishable from a slow delete, and
/// an operator who cannot find a segment again will reach for the destructive
/// path next time.
@MainActor
final class SegmentArchiveModel: ObservableObject {
    @Published private(set) var segments: [SegmentRecord] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isActing = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?

    var isEmpty: Bool { segments.isEmpty && !isLoading }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await APIClient.shared.fetchSegments(page: 1,
                                                                pageSize: 100,
                                                                includeArchived: true)
            // The server returns live rows alongside archived ones when asked
            // for both, so this screen keeps only the ones it is about.
            segments = page.items.filter(\.isArchived)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func restore(_ segment: SegmentRecord) async {
        guard !isActing else { return }
        isActing = true
        defer { isActing = false }
        do {
            _ = try await APIClient.shared.restoreSegment(id: segment.id)
            statusMessage = "\(segment.name) is back on the list."
            errorMessage = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Choosing people by hand

/// Server-side contact search for a manual segment, and the running selection.
///
/// Bounded by construction: the search runs on the server and the picker never
/// downloads the whole address book. A manual segment is capped at 10,000
/// people by the backend, which nothing reachable from this screen can approach
/// one tap at a time.
@MainActor
final class SegmentContactPickerModel: ObservableObject {
    @Published var search = ""
    @Published private(set) var results: [ConversationSummary] = []
    @Published private(set) var isSearching = false
    @Published private(set) var resultsTruncated = false
    @Published private(set) var searchProblem: String?
    /// Phone number to chosen person, so choosing the same person twice from
    /// two different searches cannot produce a duplicate.
    @Published private(set) var selected: [String: SegmentMemberInput] = [:]

    private var requestID = UUID()

    var selectedCount: Int { selected.count }
    var selectedInputs: [SegmentMemberInput] {
        selected.keys.sorted().compactMap { selected[$0] }
    }

    func isSelected(_ contact: ConversationSummary) -> Bool {
        selected[PhoneFormatter.e164(contact.phone)] != nil
    }

    func toggle(_ contact: ConversationSummary) {
        let phone = PhoneFormatter.e164(contact.phone)
        guard !phone.isEmpty else { return }
        if selected[phone] != nil {
            selected.removeValue(forKey: phone)
            return
        }
        selected[phone] = SegmentMemberInput(phone: phone,
                                             name: contact.displayName,
                                             contactID: contact.recordID?.rawValue)
    }

    func remove(phone: String) {
        selected.removeValue(forKey: phone)
    }

    func loadContacts() async {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = UUID()
        requestID = id
        isSearching = true
        defer { if requestID == id { isSearching = false } }
        do {
            let page = try await APIClient.shared.fetchContacts(search: query, page: 1, pageSize: 100)
            guard requestID == id else { return }
            results = page.contacts
            resultsTruncated = page.hasMore
            searchProblem = nil
        } catch {
            guard requestID == id else { return }
            searchProblem = "Contacts could not be loaded. Try again."
        }
    }
}

/// Who can still be added to one existing segment.
///
/// A different model from `SegmentContactPickerModel` on purpose, and the
/// difference is the whole fix. That one is for a segment that does not exist
/// yet, where nobody can already be a member and `/api/contacts` is the right
/// source. This one is for a segment that does exist, so the question is not
/// "who are our contacts?" but "who is not already in this?", and only the
/// server can answer that: membership runs to thousands of rows, the list is
/// paged, and subtracting inside the page the phone happens to be holding would
/// hide the members on screen and leave the rest one scroll away.
///
/// It also carries `held`, the people a person deliberately excluded. Those are
/// shown rather than dropped. A standing exclusion is a decision somebody made,
/// the database refuses to add them while it stands, and reversing it is a real
/// thing to want to do from here.
@MainActor
final class SegmentCandidatePickerModel: ObservableObject {
    @Published var search = ""
    @Published private(set) var candidates: [SegmentCandidate] = []
    @Published private(set) var held: [SegmentHeldCandidate] = []
    @Published private(set) var alreadyInSentence: String?
    @Published private(set) var isSearching = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = false
    @Published private(set) var problem: String?

    let segmentID: String
    private var requestID = UUID()
    private var nextPage = 2
    private let pageSize = 50

    init(segmentID: String) {
        self.segmentID = segmentID
    }

    var isEmpty: Bool { candidates.isEmpty && held.isEmpty && !isSearching }

    func load() async {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = UUID()
        requestID = id
        isSearching = true
        defer { if requestID == id { isSearching = false } }
        do {
            let response = try await APIClient.shared.fetchSegmentCandidates(id: segmentID,
                                                                             search: query,
                                                                             page: 1,
                                                                             pageSize: pageSize)
            // A slower earlier keystroke must not overwrite a faster later one.
            guard requestID == id else { return }
            candidates = response.candidates.items
            held = response.heldPeople
            alreadyInSentence = response.alreadyInSentence
            hasMore = response.candidates.hasMore ?? false
            nextPage = 2
            problem = nil
        } catch {
            guard requestID == id else { return }
            problem = error.localizedDescription
        }
    }

    func loadMoreIfNeeded(after candidate: SegmentCandidate) async {
        guard candidate.id == candidates.last?.id, hasMore, !isLoadingMore else { return }
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = requestID
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let response = try await APIClient.shared.fetchSegmentCandidates(id: segmentID,
                                                                             search: query,
                                                                             page: nextPage,
                                                                             pageSize: pageSize)
            guard requestID == id else { return }
            let known = Set(candidates.map(\.id))
            candidates.append(contentsOf: response.candidates.items.filter { !known.contains($0.id) })
            hasMore = response.candidates.hasMore ?? false
            nextPage += 1
            problem = nil
        } catch {
            guard requestID == id else { return }
            problem = error.localizedDescription
        }
    }
}

// MARK: - One segment

@MainActor
final class SegmentDetailModel: ObservableObject {
    @Published private(set) var segment: SegmentRecord?
    @Published private(set) var members: [SegmentMember] = []
    @Published private(set) var memberTotal = 0
    @Published private(set) var activeOverrides: [SegmentOverride] = []
    @Published private(set) var revokedOverrides: [SegmentOverride] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var isActing = false
    @Published private(set) var lastRun: SegmentRecomputeRun?
    @Published var errorMessage: String?
    @Published var statusMessage: String?

    let segmentID: String
    private var nextPage = 1
    private let pageSize = 50

    init(segmentID: String) {
        self.segmentID = segmentID
    }

    var hasMoreMembers: Bool { members.count < memberTotal }
    var isAutomatic: Bool { segment?.kind == .automatic }
    var hasBeenComputed: Bool { segment?.lastComputedDate != nil }

    /// People held out of this segment by an active exclude override. They have
    /// no member row by definition, so they are listed from the override side
    /// or they are invisible.
    var excludedPhones: [String] {
        activeOverrides.filter { $0.overrideType == .exclude }.map(\.contactPhone)
    }

    func activeOverride(for phone: String) -> SegmentOverride? {
        activeOverrides.first { $0.contactPhone == phone }
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.fetchSegment(id: segmentID,
                                                                   page: 1,
                                                                   pageSize: pageSize)
            apply(response)
            nextPage = 2
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadMoreIfNeeded(after member: SegmentMember) async {
        guard member.id == members.last?.id, hasMoreMembers, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let response = try await APIClient.shared.fetchSegment(id: segmentID,
                                                                   page: nextPage,
                                                                   pageSize: pageSize)
            let known = Set(members.map(\.id))
            members.append(contentsOf: response.members.items.filter { !known.contains($0.id) })
            memberTotal = response.members.total
            activeOverrides = response.overrides.active
            revokedOverrides = response.overrides.revoked
            nextPage += 1
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func apply(_ response: SegmentDetailResponse) {
        segment = response.segment
        members = response.members.items
        memberTotal = response.members.total
        activeOverrides = response.overrides.active
        revokedOverrides = response.overrides.revoked
    }

    // MARK: Mutations

    func recompute() async {
        await act {
            let response = try await APIClient.shared.recomputeSegment(id: self.segmentID)
            self.lastRun = response.run
            return response.outcomeSentence
        }
    }

    func addMember(_ input: SegmentMemberInput) async {
        await act {
            let response = try await APIClient.shared.addSegmentMember(id: self.segmentID,
                                                                       member: input)
            return "\(response.member.displayName) added."
        }
    }

    func removeMember(phone: String, displayName: String) async {
        await act {
            _ = try await APIClient.shared.removeSegmentMember(id: self.segmentID, phone: phone)
            return "\(displayName) removed."
        }
    }

    /// Force a person in or out. Not a membership edit: an exclude outlives
    /// every future recompute until it is revoked here.
    func setOverride(phone: String,
                     displayName: String,
                     overrideType: SegmentOverrideType,
                     reason: String?) async {
        await act {
            _ = try await APIClient.shared.setSegmentOverride(id: self.segmentID,
                                                              phone: phone,
                                                              overrideType: overrideType,
                                                              reason: reason,
                                                              name: displayName)
            return overrideType == .exclude
                ? "\(displayName) is now held out of this segment until this is revoked."
                : "\(displayName) is now kept in this segment until this is revoked."
        }
    }

    func revokeOverride(phone: String, displayName: String, reason: String?) async {
        await act {
            let response = try await APIClient.shared.revokeSegmentOverride(id: self.segmentID,
                                                                            phone: phone,
                                                                            reason: reason)
            return response.override.overrideType == .exclude
                ? "The hold on \(displayName) was lifted. The next update decides whether they come back."
                : "\(displayName) is no longer forced in. The next update decides whether they stay."
        }
    }

    /// Force somebody in who is not in this segment at all.
    ///
    /// The same call as the force include on a member's own page, reached from
    /// the picker instead. Before this the only way to pin a person was to find
    /// them already listed, so pinning somebody the engine had never matched
    /// was unreachable, which is the case the feature is most for.
    func forceInclude(_ candidate: SegmentCandidate, reason: String?) async {
        await setOverride(phone: candidate.contactPhone,
                          displayName: candidate.displayName,
                          overrideType: .include,
                          reason: reason)
    }

    /// Remove this segment.
    ///
    /// Returns the sentence describing what ACTUALLY happened, or nil on
    /// failure. The screen is about to be popped, so the message has to travel
    /// to whoever is still on screen rather than being shown here: the caller
    /// hands it to the list. And it has to be the server's answer, not the
    /// request, because a segment that gains an override between the tap and
    /// the statement is archived rather than deleted.
    func remove(archiveOnly: Bool) async -> String? {
        guard let segment, !isActing else { return nil }
        isActing = true
        defer { isActing = false }
        do {
            let result = try await APIClient.shared.removeSegment(id: segmentID,
                                                                  archiveOnly: archiveOnly)
            errorMessage = nil
            var message = result.outcomeSentence(segmentName: segment.name)
            if !result.wasDeleted, let why = result.explanations.first {
                message += " \(why)"
            }
            return message
        } catch {
            statusMessage = nil
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// One mutation, one reload. The list is reread from the server rather than
    /// patched locally: an override changes the member count, the override
    /// lists and sometimes membership itself, and the server already knows all
    /// three.
    private func act(_ operation: @escaping () async throws -> String) async {
        guard !isActing else { return }
        isActing = true
        defer { isActing = false }
        do {
            statusMessage = try await operation()
            errorMessage = nil
        } catch {
            statusMessage = nil
            errorMessage = error.localizedDescription
            return
        }
        // `load()` always reads page one and resets the cursor itself on
        // success, and deliberately leaves it alone on failure. Setting it here
        // as well would strand paging at page two over a stale first page.
        await load()
    }
}

// MARK: - One person

/// Backs the "why are they here" sheet. A separate request rather than reuse of
/// the row already on screen, because this endpoint also returns the full
/// override history for that person and the list endpoint does not.
@MainActor
final class SegmentMemberDetailModel: ObservableObject {
    @Published private(set) var detail: SegmentMemberDetail?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    let segmentID: String
    let phone: String
    /// Shown while the request is in flight, so the sheet opens with the
    /// person's name on it rather than a blank bar.
    let fallbackName: String

    init(segmentID: String, phone: String, fallbackName: String) {
        self.segmentID = segmentID
        self.phone = phone
        self.fallbackName = fallbackName
    }

    var displayName: String { detail?.member?.displayName ?? fallbackName }

    /// True when the person is not a member at all and is only here because
    /// somebody excluded them. The sheet answers the opposite question then.
    var isExcludedNonMember: Bool {
        detail?.member == nil && detail?.activeOverride?.overrideType == .exclude
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await APIClient.shared.fetchSegmentMember(id: segmentID, phone: phone)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
