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

/// Team membership: who is on the account, what they can do, and pending
/// invitations.
@MainActor
final class TeamModel: ObservableObject {
    @Published private(set) var members: [TeamMember] = []
    @Published private(set) var invitations: [Invitation] = []
    @Published private(set) var isLoading = false
    @Published private(set) var busyMemberID: String?
    @Published var errorMessage: String?
    /// The one-time invite link, shown after a successful invitation. There is
    /// no email sender, so dismissing this without copying it loses the link.
    @Published var newInvitation: Invitation?

    func load() async {
        isLoading = members.isEmpty
        defer { isLoading = false }
        do {
            members = try await APIClient.shared.fetchTeam()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        // Pending invitations are secondary; an older backend without the
        // endpoint must not blank out the member list.
        invitations = (try? await APIClient.shared.fetchInvitations()) ?? invitations
    }

    /// Roles offered by the invite picker: the seeds this client knows about,
    /// merged with every role the server actually reports, so an unfamiliar
    /// role is still selectable and still round-trips.
    var availableRoles: [String] {
        var seen = RoleCatalog.seeds
        for role in members.compactMap(\.role) where !seen.contains(role) { seen.append(role) }
        for role in invitations.compactMap(\.role) where !seen.contains(role) { seen.append(role) }
        return seen
    }

    var activeAdminCount: Int {
        members.filter { $0.active && RoleCatalog.isAdminish($0.role) }.count
    }

    /// Why a destructive change to this member is not offered, or nil when it
    /// is allowed. The server enforces the same rule with a 409; this exists so
    /// the last admin is told before tapping rather than after.
    func blockingReason(for member: TeamMember, currentUserID: String?) -> String? {
        guard member.active, RoleCatalog.isAdminish(member.role), activeAdminCount <= 1 else { return nil }
        if let currentUserID, member.id == currentUserID {
            return "You are the last active admin. Promote someone else before changing your own role."
        }
        return "This is the last active admin. Promote someone else first."
    }

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

    func invite(email: String, role: String) async -> Bool {
        do {
            let invitation = try await APIClient.shared.createInvitation(email: email, role: role)
            newInvitation = invitation
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
