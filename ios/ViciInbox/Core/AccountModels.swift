import Foundation

/// Models for the multi-user release: the signed-in account, the audit trail,
/// team membership, and invitations.
///
/// These endpoints answer in camelCase, unlike the older inbox/contacts
/// endpoints which are snake_case Supabase rows. That difference is real and is
/// kept at this boundary rather than normalised, so a future backend change is
/// visible here instead of silently decoding to nil.

// MARK: - Account

/// Permission keys the server gates on. Hiding UI on these is a courtesy to the
/// operator, never a security boundary — the server enforces every one of them
/// independently on the request itself.
enum Permission {
    static let automationCancel = "automation.cancel"
    static let analyticsRead    = "analytics.read"
    static let auditRead        = "audit.read"
    static let userManage       = "user.manage"
    static let syncRun          = "sync.run"
    static let catchupSend      = "catchup.send"
}

struct AuthUser: Codable, Identifiable, Hashable {
    let id: String
    let displayName: String?
    let email: String?
    let role: String?
    let permissions: [String]?

    var name: String { displayName ?? email ?? "Signed in" }
    var permissionSet: Set<String> { Set(permissions ?? []) }

    private enum CodingKeys: String, CodingKey {
        case id, displayName, email, role, permissions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The id arrives as a UUID string today, but the older tables in this
        // app mix numeric and string ids, so accept either.
        if let value = try? container.decode(String.self, forKey: .id) {
            id = value
        } else if let value = try? container.decode(Int.self, forKey: .id) {
            id = String(value)
        } else {
            id = ""
        }
        displayName = try? container.decodeIfPresent(String.self, forKey: .displayName)
        email = try? container.decodeIfPresent(String.self, forKey: .email)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        permissions = try? container.decodeIfPresent([String].self, forKey: .permissions)
    }
}

/// `POST /auth/login` and `GET /auth/check`. Both are a strict superset of the
/// legacy `{ success: true }` / `{ authenticated: true }` bodies, so an older
/// backend still decodes with `user == nil`.
/// The server calls the identity object `actor`, not `user`. Decoding only
/// `user` leaves `currentUser` nil, which makes `can()` fail open — harmless
/// for the shared login, but it means a Support Agent would be shown admin
/// controls that then refuse server-side. `user` is kept as an accepted alias
/// so this survives the field being renamed in either direction.
struct AuthResponse: Decodable {
    let success: Bool?
    let authenticated: Bool?
    let actor: AuthUser?
    let user: AuthUser?

    var isAuthenticated: Bool { authenticated ?? success ?? false }
    var identity: AuthUser? { actor ?? user }
}

// MARK: - Roles

/// The role vocabulary is not part of the backend contract this client was
/// built against; only "Admin" and "Support Agent" are named. These are the
/// seeds for the invite picker and are merged with whatever roles the server
/// actually reports from `/api/users`, so a role this client has never heard of
/// still appears and still round-trips.
enum RoleCatalog {
    static let seeds = ["admin", "agent"]

    static func label(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "No role" }
        switch raw.lowercased() {
        case "admin": return "Admin"
        case "owner": return "Owner"
        case "agent", "support_agent", "support-agent": return "Support Agent"
        default:
            return raw
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
                .capitalized
        }
    }

    static func isAdminish(_ raw: String?) -> Bool {
        guard let raw = raw?.lowercased() else { return false }
        return raw == "admin" || raw == "owner"
    }
}

// MARK: - Audit trail

/// A single audit row.
///
/// `summary` is rendered verbatim. It is composed server-side at write time so
/// a row written five years ago still reads correctly after the product copy
/// changes. Do not add a client-side eventType-to-copy switch.
struct AuditItem: Codable, Identifiable, Hashable {
    let recordID: FlexibleID
    let occurredAt: String?
    let actorDisplayName: String?
    let actorRole: String?
    let eventType: String?
    let category: String?
    let severity: String?
    let summary: String?
    let entityType: String?
    let entityID: FlexibleID?
    let contactPhone: String?
    let changedFields: [String]?
    let previousState: JSONValue?
    let newState: JSONValue?

    var id: String { recordID.rawValue }
    var actorName: String { actorDisplayName ?? "System" }
    var occurredDate: Date? { ServerDate.parse(occurredAt) }
    var summaryText: String { summary ?? eventType ?? "Activity" }

    /// The paging envelope (`items` / `nextCursor` / `hasMore`) is camelCase
    /// because routes/audit.js builds it in JavaScript. The rows inside it are
    /// not: they are selected straight out of PostgREST, so every column keeps
    /// its snake_case database name. Assuming one convention for both decodes
    /// exactly one field — `id` — and renders every row as fallback text.
    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case occurredAt = "occurred_at"
        case actorDisplayName = "actor_display_name"
        case actorRole = "actor_role"
        case eventType = "event_type"
        case category
        case severity, summary
        case entityType = "entity_type"
        case entityID = "entity_id"
        case contactPhone = "contact_phone"
        case changedFields = "changed_fields"
        case previousState = "previous_state"
        case newState = "new_state"
    }

    /// Field-level before/after pairs for the per-entity history screen.
    /// Only fields the server listed in `changedFields` are shown, so a large
    /// state blob never turns into an unreadable wall of JSON.
    ///
    /// A named struct rather than a tuple because Swift 5 has no key paths to
    /// tuple elements, and `ForEach(_:id:)` needs one.
    var fieldChanges: [AuditFieldChange] {
        guard let changedFields, !changedFields.isEmpty else { return [] }
        return changedFields.map { field in
            AuditFieldChange(field: field,
                             before: previousState?.child(field)?.displayText,
                             after: newState?.child(field)?.displayText)
        }
    }
}

struct AuditFieldChange: Identifiable, Hashable {
    let field: String
    let before: String?
    let after: String?

    var id: String { field }
}

struct AuditPage: Codable {
    let items: [AuditItem]
    let nextCursor: Int?
    let hasMore: Bool?
}

// Decodable, not Codable. This is a response model — it is only ever read from
// the server, never sent back — and its CodingKeys map the server's field names
// (`actor_user_id`, `actor_display_name`) rather than the property names, so
// Swift cannot synthesise a matching encoder. Declaring Codable asks for one and
// fails to compile. `swiftc -frontend -parse` does not type-check, so this only
// surfaced in CI.
struct AuditActor: Decodable, Identifiable, Hashable {
    let id: String
    let displayName: String?
    let role: String?

    var name: String { displayName ?? "Unknown" }

    /// `GET /api/audit/actors` answers `{ actors: [...] }`, and each entry is
    /// shaped like the audit row it was derived from — `actor_user_id`,
    /// `actor_display_name`, `actor_role`. A system or integration actor has a
    /// null id, so the display name is the only stable identity for it.
    private enum CodingKeys: String, CodingKey {
        case actorUserID = "actor_user_id"
        case actorDisplayName = "actor_display_name"
        case actorRole = "actor_role"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try? container.decodeIfPresent(String.self, forKey: .actorDisplayName)
        role = try? container.decodeIfPresent(String.self, forKey: .actorRole)

        // `try?` on an already-Optional expression flattens rather than nesting,
        // so each of these binds a non-Optional value. A second `let value`
        // would be unwrapping something that is not an Optional.
        //
        // Both branches exist because Postgres bigint arrives as a JSON number
        // from PostgREST but is quoted by some clients; decoding only one shape
        // silently drops the id and collapses every actor onto the name key.
        if let value = try? container.decodeIfPresent(Int.self, forKey: .actorUserID) {
            id = String(value)
        } else if let value = try? container.decodeIfPresent(String.self, forKey: .actorUserID) {
            id = value
        } else {
            // No user id: the automation, a webhook, or the shared identity.
            // Key the picker on the name so those rows stay filterable.
            id = "name:\(displayName ?? "system")"
        }
    }
}

/// The audit categories the server accepts as a filter.
enum AuditCategory: String, CaseIterable, Identifiable {
    // Must stay in step with CATEGORIES in lib/audit/event-types.js. `campaigns`
    // is live — campaign.suggestion.sent and .dismissed write real rows — even
    // though the six campaign.* lifecycle types are still reserved. Omitting it
    // makes those rows unreachable from the app.
    case all, messages, calls, automations, campaigns, contacts, team, settings, security

    var id: String { rawValue }

    var label: String {
        self == .all ? "All activity" : rawValue.capitalized
    }
}

// MARK: - Team

struct TeamMember: Codable, Identifiable, Hashable {
    let id: String
    let displayName: String?
    let email: String?
    let role: String?
    let isActive: Bool?
    let lastSeenAt: String?

    var name: String { displayName ?? email ?? "Member" }
    var active: Bool { isActive ?? true }
    var lastSeenDate: Date? { ServerDate.parse(lastSeenAt) }

    private enum CodingKeys: String, CodingKey {
        case id, displayName, email, role, isActive, lastSeenAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decode(String.self, forKey: .id) { id = value }
        else if let value = try? container.decode(Int.self, forKey: .id) { id = String(value) }
        else { id = "" }
        displayName = try? container.decodeIfPresent(String.self, forKey: .displayName)
        email = try? container.decodeIfPresent(String.self, forKey: .email)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        isActive = try? container.decodeIfPresent(Bool.self, forKey: .isActive)
        lastSeenAt = try? container.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }
}

struct Invitation: Codable, Identifiable, Hashable {
    let id: String
    let email: String?
    let role: String?
    let createdAt: String?
    let expiresAt: String?
    let acceptedAt: String?
    /// Returned once, only on creation. There is no email sender configured, so
    /// this is the only time the link can be handed to the invitee.
    let inviteToken: String?
    let inviteUrl: String?

    var isAccepted: Bool { acceptedAt != nil }

    private enum CodingKeys: String, CodingKey {
        case id, email, role, createdAt, expiresAt, acceptedAt, inviteToken, inviteUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decode(String.self, forKey: .id) { id = value }
        else if let value = try? container.decode(Int.self, forKey: .id) { id = String(value) }
        else { id = UUID().uuidString }
        email = try? container.decodeIfPresent(String.self, forKey: .email)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        createdAt = try? container.decodeIfPresent(String.self, forKey: .createdAt)
        expiresAt = try? container.decodeIfPresent(String.self, forKey: .expiresAt)
        acceptedAt = try? container.decodeIfPresent(String.self, forKey: .acceptedAt)
        inviteToken = try? container.decodeIfPresent(String.self, forKey: .inviteToken)
        inviteUrl = try? container.decodeIfPresent(String.self, forKey: .inviteUrl)
    }
}

// MARK: - Loose JSON

/// Minimal JSON value used for the audit trail's `previousState` / `newState`,
/// which are free-form objects. Kept deliberately small: it exists to print a
/// field's before/after value, not to model the server's schema.
indirect enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value):   try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value):  try container.encode(value)
        case .null:              try container.encodeNil()
        }
    }

    func child(_ key: String) -> JSONValue? {
        guard case .object(let dictionary) = self else { return nil }
        return dictionary[key]
    }

    var displayText: String {
        switch self {
        case .string(let value): return value.isEmpty ? "—" : value
        case .bool(let value):   return value ? "Yes" : "No"
        case .number(let value):
            return value == value.rounded()
                ? String(Int(value))
                : String(format: "%g", value)
        case .array(let values): return values.map(\.displayText).joined(separator: ", ")
        case .object(let values):
            return values.keys.sorted()
                .compactMap { key in values[key].map { "\(key): \($0.displayText)" } }
                .joined(separator: ", ")
        case .null: return "—"
        }
    }
}
