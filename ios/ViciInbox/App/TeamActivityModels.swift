import Foundation

/// One day's worth of audit rows, in the order the server returned them.
struct AuditSection: Identifiable {
    let id: String
    let title: String
    let items: [AuditItem]
}

/// Groups audit rows under Today / Yesterday / a date, without re-sorting.
///
/// The server already returns newest first; re-sorting on the client would
/// fight the cursor paging and make an appended page jump around the list.
enum AuditGrouping {

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    static func sections(for items: [AuditItem],
                         calendar: Calendar = .current,
                         now: Date = Date()) -> [AuditSection] {
        var order: [String] = []
        var buckets: [String: [AuditItem]] = [:]

        for item in items {
            let title = self.title(for: item.occurredDate, calendar: calendar, now: now)
            if buckets[title] == nil {
                buckets[title] = []
                order.append(title)
            }
            buckets[title]?.append(item)
        }

        return order.map { AuditSection(id: $0, title: $0, items: buckets[$0] ?? []) }
    }

    static func title(for date: Date?, calendar: Calendar = .current, now: Date = Date()) -> String {
        guard let date else { return "Undated" }
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return dayFormatter.string(from: date)
    }
}

/// Backing model for the Activity screen: category filter, actor filter, and
/// cursor-paged infinite scrolling.
@MainActor
final class ActivityLogModel: ObservableObject {
    @Published var category: AuditCategory
    /// Nil means every actor.
    @Published var actorID: String?

    @Published private(set) var items: [AuditItem] = []
    @Published private(set) var actors: [AuditActor] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = true
    @Published var errorMessage: String?

    private var cursor: Int?
    private var didLoadOnce = false
    private var pageInFlight = false

    init(category: AuditCategory = .all) {
        self.category = category
    }

    var sections: [AuditSection] { AuditGrouping.sections(for: items) }

    func loadIfNeeded() async {
        guard !didLoadOnce else { return }
        await reload()
    }

    func reload() async {
        guard !pageInFlight else { return }
        pageInFlight = true
        isLoading = items.isEmpty
        defer { pageInFlight = false; isLoading = false; didLoadOnce = true }
        do {
            let page = try await APIClient.shared.fetchAudit(category: category, actorID: actorID)
            items = page.items
            cursor = page.nextCursor
            hasMore = page.hasMore ?? (page.nextCursor != nil)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Called from the last visible row. The cursor is server-supplied state,
    /// so a page is requested only when the previous response actually offered
    /// one.
    func loadMoreIfNeeded(after item: AuditItem) async {
        guard hasMore, !pageInFlight, let cursor, item.id == items.last?.id else { return }
        pageInFlight = true
        isLoadingMore = true
        defer { pageInFlight = false; isLoadingMore = false }
        do {
            let page = try await APIClient.shared.fetchAudit(category: category,
                                                             actorID: actorID,
                                                             cursor: cursor)
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            self.cursor = page.nextCursor
            hasMore = (page.hasMore ?? (page.nextCursor != nil)) && page.nextCursor != nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The actor picker is a convenience; failing to load it must not make the
    /// list itself look broken.
    func loadActors() async {
        guard actors.isEmpty else { return }
        actors = (try? await APIClient.shared.fetchAuditActors()) ?? []
    }
}

/// The change history of one record, e.g. a single scheduled message.
@MainActor
final class EntityHistoryModel: ObservableObject {
    @Published private(set) var items: [AuditItem] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    let entityType: String
    let entityID: String

    init(entityType: String, entityID: String) {
        self.entityType = entityType
        self.entityID = entityID
    }

    func load() async {
        isLoading = items.isEmpty
        defer { isLoading = false }
        do {
            items = try await APIClient.shared.fetchEntityHistory(entityType: entityType,
                                                                  entityID: entityID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Who is asking, from the Team screen's point of view.
///
/// A struct rather than two loose arguments because the peer-Owner rule needs
/// both halves — which account is acting, and whether it may touch the Owner
/// role at all — and passing them separately is how one call site ends up
/// checking only one of them.
struct TeamActor {
    /// Nil for the legacy shared-password session, which has no named identity.
    let id: String?
    /// `user.manage.owner`. Note `SessionModel.can` fails open for an unknown
    /// account, so this is optimistic for the shared login. That is deliberate
    /// and matches the rest of the app: the server refuses with 403
    /// `OWNER_ROLE_REQUIRES_OWNER`, which now reads as a sentence.
    let canManageOwners: Bool
}

/// Team membership: who is on the account, what they can do, and pending
/// invitations.
@MainActor
final class TeamModel: ObservableObject {
    @Published private(set) var members: [TeamMember] = []
    /// The server's own role catalogue, from the same `GET /api/users` payload
    /// as the members. Display names come from here, never from a string
    /// literal — the product calls the `agent` role "Support Agent", and the
    /// only place that mapping is authoritative is `sms_roles`.
    @Published private(set) var roles: [TeamRole] = []
    @Published private(set) var invitations: [Invitation] = []
    @Published private(set) var isLoading = false
    @Published private(set) var busyMemberID: String?
    @Published var errorMessage: String?
    /// The result of the last successful invitation. It carries the one-time
    /// link and, when the backend reports it, whether an email actually went.
    /// Both are shown once and cannot be retrieved again.
    @Published var newInvitation: InvitationCreation?

    func load() async {
        isLoading = members.isEmpty
        defer { isLoading = false }
        do {
            let directory = try await APIClient.shared.fetchTeam()
            members = directory.members
            // Only overwrite a catalogue we already have if the server sent
            // one. An older backend that omits `roles` must not blank the
            // labels back to raw keys mid-session.
            if !directory.roles.isEmpty { roles = directory.roles }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        // Pending invitations are secondary; an older backend without the
        // endpoint must not blank out the member list.
        invitations = (try? await APIClient.shared.fetchInvitations()) ?? invitations
    }

    // MARK: - Roles

    /// The product's name for a role key.
    ///
    /// Server catalogue first, this client's small table second, raw key last.
    /// Never a literal at the call site.
    func roleLabel(_ key: String?) -> String {
        guard let key, !key.isEmpty else { return "No role" }
        if let role = roles.first(where: { $0.key.caseInsensitiveCompare(key) == .orderedSame }) {
            return role.label
        }
        return RoleCatalog.label(key)
    }

    var pendingInvitations: [Invitation] { invitations.filter(\.isPending) }

    /// Roles this actor may actually assign.
    ///
    /// Owner is offered only to an actor holding `user.manage.owner`, matching
    /// `ownerTransitionError` on the server. Promoting somebody to Owner is a
    /// supported action and a second Owner is allowed, so Owner is present in
    /// the list rather than filtered out of it.
    func assignableRoles(for actor: TeamActor) -> [String] {
        var keys: [String] = []
        if !roles.isEmpty {
            keys = roles
                .filter(\.assignable)
                .sorted { ($0.rank ?? 0) > ($1.rank ?? 0) }
                .map(\.key)
        } else {
            // No catalogue yet. Fall back to what this client knows plus what
            // it can see in use, so the picker is never empty.
            keys = RoleCatalog.seeds
            for role in members.compactMap(\.role) where !keys.contains(role) { keys.append(role) }
            for role in invitations.compactMap(\.role) where !keys.contains(role) { keys.append(role) }
        }
        if !actor.canManageOwners {
            keys.removeAll { RoleCatalog.isOwner($0) }
        }
        return keys
    }

    var activeAdminCount: Int {
        members.filter { $0.active && RoleCatalog.isAdminish($0.role) }.count
    }

    // MARK: - What this actor may not do to this member

    /// Why a role change or deactivation is not offered for this member, or nil
    /// when it is allowed.
    ///
    /// Two independent rules, checked in the order the server checks them:
    ///
    ///   1. The peer-Owner rule. The product owner's words: "an owner can edit
    ///      the role of an admin or support agent, but it cannot edit the role
    ///      or deactivate another owner." Promotion TO Owner is untouched —
    ///      this looks at the role the target holds already — and acting on
    ///      yourself is untouched.
    ///   2. The last-administrator rule, which the server returns as a 409
    ///      `CANNOT_DEACTIVATE_LAST_OWNER`.
    ///
    /// The controls are disabled with this sentence beside them rather than
    /// hidden, so the rule is legible instead of looking like a broken screen.
    /// None of this is a control: the server enforces both independently.
    func restriction(on member: TeamMember, actor: TeamActor) -> String? {
        if let reason = peerOwnerRestriction(on: member, actor: actor) { return reason }
        return lastAdministratorRestriction(on: member, actor: actor)
    }

    /// Nil unless the target is an Owner other than the person acting.
    func peerOwnerRestriction(on member: TeamMember, actor: TeamActor) -> String? {
        guard member.isOwner else { return nil }
        if let actorID = actor.id, !actorID.isEmpty, actorID == member.id { return nil }
        let label = roleLabel(member.role)
        if actor.canManageOwners {
            return "\(member.name) is \(article(for: label)) \(label). "
                + "An Owner cannot change another Owner's role or deactivate them. "
                + "They have to make that change themselves, or step down first."
        }
        return "\(member.name) is \(article(for: label)) \(label). "
            + "Only an Owner can change an Owner's role or deactivate them."
    }

    private func lastAdministratorRestriction(on member: TeamMember, actor: TeamActor) -> String? {
        guard member.active, RoleCatalog.isAdminish(member.role), activeAdminCount <= 1 else { return nil }
        if let actorID = actor.id, actorID == member.id {
            return "You are the last active administrator. Promote someone else before changing your own role."
        }
        return "This is the last active administrator. Promote someone else first."
    }

    private func article(for label: String) -> String {
        "AEIOU".contains(label.uppercased().prefix(1)) ? "an" : "a"
    }

    // MARK: - Mutations

    func changeRole(of member: TeamMember, to role: String) async -> Bool {
        guard busyMemberID == nil else { return false }
        busyMemberID = member.id
        defer { busyMemberID = nil }
        do {
            try await APIClient.shared.updateUserRole(id: member.id, role: role)
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deactivate(_ member: TeamMember) async -> Bool {
        guard busyMemberID == nil else { return false }
        busyMemberID = member.id
        defer { busyMemberID = nil }
        do {
            try await APIClient.shared.deactivateUser(id: member.id)
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// `POST /api/invitations` requires a name as well as an email. Sending
    /// only the email is what made every invitation fail with a validation
    /// error the admin had no field to correct.
    func invite(name: String, email: String, role: String) async -> Bool {
        do {
            let created = try await APIClient.shared.createInvitation(displayName: name,
                                                                      email: email,
                                                                      role: role)
            newInvitation = created
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
