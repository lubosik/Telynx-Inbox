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
    /// Granting or revoking the Owner role. Deliberately not held by `admin` or
    /// `legacy` in scripts/rbac-migration.sql, so only an Owner sees Owner in a
    /// role picker. The server refuses it independently with 403
    /// `OWNER_ROLE_REQUIRES_OWNER`.
    static let userManageOwner  = "user.manage.owner"
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

/// Offline fallback for role display names.
///
/// The authority is the server's own catalogue: `GET /api/users` answers
/// `{ users: [...], roles: [...] }` and each role carries a `display_name` read
/// from `sms_roles`. Prefer `TeamModel.roleLabel(_:)`, which consults that
/// catalogue first. This enum is only what the client shows before the
/// catalogue has loaded, or if the server stops sending it — a renamed role
/// reads correctly from the server and stale here, which is the right way round.
///
/// It must never be the reason the interface says "agent" where the product
/// says "Support Agent".
enum RoleCatalog {
    static let seeds = ["admin", "agent"]

    /// The one role key with a client-side rule attached: an Owner may not
    /// change a *different* Owner's role or deactivate them.
    static let owner = "owner"

    static func isOwner(_ raw: String?) -> Bool {
        raw?.lowercased() == owner
    }

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

/// One entry of the server's role catalogue, as returned alongside the member
/// list by `GET /api/users`.
///
/// `routes/users.js` passes `sms_roles` rows straight through from PostgREST,
/// so the keys are snake_case (`display_name`, `is_assignable`) even though the
/// `users` array beside them is camelCase. Both spellings are accepted here
/// because that asymmetry is easy to "tidy up" on the server by accident, and
/// the cost of guessing wrong is a picker that silently shows raw keys.
struct TeamRole: Decodable, Identifiable, Hashable {
    let key: String
    let displayName: String?
    let rank: Int?
    let isAssignable: Bool?
    let summary: String?

    var id: String { key }

    /// The product's name for this role. Falls back to the client's own table
    /// and then to the raw key, so an unrecognised role is still legible.
    var label: String { displayName?.isEmpty == false ? displayName! : RoleCatalog.label(key) }

    /// Absent means assignable. A role the server has not marked either way is
    /// offered rather than hidden; the server refuses it with
    /// `ROLE_NOT_ASSIGNABLE` if that guess is wrong.
    var assignable: Bool { isAssignable ?? true }

    var isOwner: Bool { RoleCatalog.isOwner(key) }

    private enum CodingKeys: String, CodingKey {
        case key
        case displayNameSnake = "display_name"
        case displayNameCamel = "displayName"
        case rank
        case isAssignableSnake = "is_assignable"
        case isAssignableCamel = "isAssignable"
        case description
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? container.decode(String.self, forKey: .key)) ?? ""
        displayName = (try? container.decodeIfPresent(String.self, forKey: .displayNameSnake))
            ?? (try? container.decodeIfPresent(String.self, forKey: .displayNameCamel))
            ?? nil
        rank = (try? container.decodeIfPresent(Int.self, forKey: .rank)) ?? nil
        isAssignable = (try? container.decodeIfPresent(Bool.self, forKey: .isAssignableSnake))
            ?? (try? container.decodeIfPresent(Bool.self, forKey: .isAssignableCamel))
            ?? nil
        summary = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? nil
    }
}

/// `GET /api/users` answers with both halves of the Team screen in one payload.
/// Keeping them together means the role catalogue is never a second request
/// that can fail on its own and leave the picker showing raw keys.
struct TeamDirectory {
    let members: [TeamMember]
    let roles: [TeamRole]

    static let empty = TeamDirectory(members: [], roles: [])
}

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
    var isOwner: Bool { RoleCatalog.isOwner(role) }

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

/// A pending or historical invitation, as serialised by `publicInvitation()` in
/// routes/invitations.js.
///
/// Two field names here were wrong before this release and both failed
/// silently. The server sends `invitedAt`, not `createdAt`; and it has never
/// sent `inviteToken` / `inviteUrl` *inside* this object — on creation the raw
/// token and link are siblings of it, which is why the invite link never once
/// appeared on screen. `InvitationCreation` below reads them from where they
/// actually are. The two optional properties are kept only so a future server
/// that does nest them still works.
/// Decodable, not Codable, for the same reason as `AuditActor`: this is only
/// ever read from the server, and `CodingKeys` carries a `createdAt` alias with
/// no stored property behind it, so Swift cannot synthesise an encoder.
/// Declaring `Codable` asks for one and fails to compile.
struct Invitation: Decodable, Identifiable, Hashable {
    let id: String
    let email: String?
    let displayName: String?
    let role: String?
    /// `open`, `accepted`, `expired`, or `revoked`. Absent on an older backend.
    let status: String?
    let invitedAt: String?
    let expiresAt: String?
    let acceptedAt: String?
    let revokedAt: String?
    let inviteToken: String?
    let inviteUrl: String?

    var name: String { displayName ?? email ?? "Invited member" }
    var isAccepted: Bool { status?.lowercased() == "accepted" || acceptedAt != nil }
    var expiresDate: Date? { ServerDate.parse(expiresAt) }

    /// Still worth chasing: not accepted, not revoked, not expired. Falls back
    /// to the timestamps when the server does not send `status`, so an older
    /// backend degrades to the previous behaviour rather than to an empty list.
    var isPending: Bool {
        if let status = status?.lowercased(), !status.isEmpty { return status == "open" }
        if acceptedAt != nil || revokedAt != nil { return false }
        if let expiry = expiresDate { return expiry > Date() }
        return true
    }

    /// Why this invitation is no longer actionable, for the pending list's
    /// secondary line. Nil while it is still open.
    var statusLabel: String? {
        switch status?.lowercased() {
        case "accepted": return "Accepted"
        case "revoked":  return "Revoked"
        case "expired":  return "Expired"
        default:         return nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, email, displayName, role, status
        case invitedAt, createdAt, expiresAt, acceptedAt, revokedAt
        case inviteToken, inviteUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decode(String.self, forKey: .id) { id = value }
        else if let value = try? container.decode(Int.self, forKey: .id) { id = String(value) }
        else { id = UUID().uuidString }
        email = try? container.decodeIfPresent(String.self, forKey: .email)
        displayName = try? container.decodeIfPresent(String.self, forKey: .displayName)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        status = try? container.decodeIfPresent(String.self, forKey: .status)
        // `createdAt` is accepted as an alias so a rename in either direction
        // cannot blank the date again.
        invitedAt = (try? container.decodeIfPresent(String.self, forKey: .invitedAt))
            ?? (try? container.decodeIfPresent(String.self, forKey: .createdAt))
            ?? nil
        expiresAt = try? container.decodeIfPresent(String.self, forKey: .expiresAt)
        acceptedAt = try? container.decodeIfPresent(String.self, forKey: .acceptedAt)
        revokedAt = try? container.decodeIfPresent(String.self, forKey: .revokedAt)
        inviteToken = try? container.decodeIfPresent(String.self, forKey: .inviteToken)
        inviteUrl = try? container.decodeIfPresent(String.self, forKey: .inviteUrl)
    }
}

/// The answer to `POST /api/invitations`.
///
/// Deliberately tolerant, because the endpoint is being changed by another
/// workstream while this screen is being written. Today the server answers
/// `{ invitation, token, acceptUrl, note }` with no email sender at all. Once
/// a provider is configured it is expected to report whether the email
/// actually went. Every one of those shapes has to render honestly, and the
/// one thing this must never do is claim an email was sent because a field was
/// missing.
struct InvitationCreation: Decodable {
    let invitation: Invitation?
    private let token: String?
    private let acceptUrl: String?
    private let inviteUrl: String?
    private let inviteToken: String?
    private let emailSentFlag: Bool?
    private let nestedEmail: EmailReport?
    private let emailReason: String?
    let emailError: String?

    private struct EmailReport: Decodable {
        let sent: Bool?
        let delivered: Bool?
        let address: String?
        let to: String?
        let error: String?

        var didSend: Bool? { sent ?? delivered }
        var recipient: String? { address ?? to }
    }

    /// Whether the server says an email went out, as three states rather than
    /// two. `unknown` exists because "the field is absent" and "the field is
    /// false" mean different things, and collapsing them is exactly how a UI
    /// ends up lying to an admin.
    enum EmailOutcome: Equatable {
        case sent(String?)
        case notSent
        case unknown
    }

    var emailOutcome: EmailOutcome {
        let flag = emailSentFlag ?? nestedEmail?.didSend
        switch flag {
        case .some(true):  return .sent(nestedEmail?.recipient ?? invitation?.email)
        case .some(false): return .notSent
        case .none:        return .unknown
        }
    }

    /// The one-time acceptance link, if the server could build one. `APP_URL`
    /// is not always configured, in which case there is a token but no URL.
    var link: String? {
        for candidate in [acceptUrl, inviteUrl, invitation?.inviteUrl] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return nil
    }

    /// The raw token, which is all there is when no link could be built.
    var rawToken: String? {
        for candidate in [token, inviteToken, invitation?.inviteToken] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return nil
    }

    /// What to put on the clipboard: the link when there is one, the token
    /// otherwise. Nil means the server returned neither and there is genuinely
    /// nothing to hand over.
    var shareableSecret: String? { link ?? rawToken }

    /// True when the clipboard value is a bare token rather than a URL, so the
    /// copy can say so instead of calling it a link.
    var isBareToken: Bool { link == nil && rawToken != nil }

    private enum CodingKeys: String, CodingKey {
        case invitation, token, acceptUrl, inviteUrl, inviteToken
        case emailSent, emailWasSent, email, emailError, emailReason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        invitation = try? container.decodeIfPresent(Invitation.self, forKey: .invitation)
        token = (try? container.decodeIfPresent(String.self, forKey: .token)) ?? nil
        acceptUrl = (try? container.decodeIfPresent(String.self, forKey: .acceptUrl)) ?? nil
        inviteUrl = (try? container.decodeIfPresent(String.self, forKey: .inviteUrl)) ?? nil
        inviteToken = (try? container.decodeIfPresent(String.self, forKey: .inviteToken)) ?? nil
        emailSentFlag = (try? container.decodeIfPresent(Bool.self, forKey: .emailSent))
            ?? (try? container.decodeIfPresent(Bool.self, forKey: .emailWasSent))
            ?? nil
        // `email` is a String on some shapes (the address) and an object on
        // others (a delivery report). Only the object carries a claim about
        // sending, so a plain string is ignored rather than misread as one.
        nestedEmail = (try? container.decodeIfPresent(EmailReport.self, forKey: .email)) ?? nil
        emailReason = (try? container.decodeIfPresent(String.self, forKey: .emailReason)) ?? nil
        emailError = (try? container.decodeIfPresent(String.self, forKey: .emailError))
            ?? nestedEmail?.error
    }

    /// Why no email went, as a sentence rather than the machine token the
    /// server uses. An unrecognised reason is shown verbatim rather than
    /// swallowed — a strange word on screen is recoverable, a silent "no email"
    /// with no cause is not.
    var emailFailureExplanation: String? {
        if let emailError, !emailError.isEmpty { return emailError }
        guard let emailReason, !emailReason.isEmpty else { return nil }
        switch emailReason {
        case "not_configured":
            return "No email provider is configured on the server."
        case "no_app_url":
            return "The server has no public address configured, so it could not build a link to send."
        case "provider_error":
            return "The email provider rejected the message."
        case "timeout", "network_error":
            return "The server could not reach the email provider."
        case "invalid_message", "no_fetch", "unknown":
            return "The server could not send it."
        default:
            return emailReason
        }
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

// MARK: - Accepting an invitation

/// Password rules, mirrored from `validatePasswordStrength` in `lib/password.js`.
///
/// The server is the only authority here. These constants exist so the rules
/// can be stated before the invitee types rather than after a rejected attempt,
/// and the numbers are copied from `MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH`
/// in that file. If they ever drift, the server still wins: it answers
/// `PASSWORD_TOO_WEAK` with its own sentence and the screen shows that verbatim.
enum PasswordPolicy {
    static let minimumLength = 12
    static let maximumLength = 200

    /// The same three checks the server runs, in the same order.
    /// Returns nil when the password is acceptable.
    static func problem(with password: String) -> String? {
        if password.count < minimumLength {
            return "Password must be at least \(minimumLength) characters."
        }
        if password.count > maximumLength {
            return "Password must be at most \(maximumLength) characters."
        }
        if password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Password must not be only whitespace."
        }
        return nil
    }

    static var summary: String {
        "At least \(minimumLength) characters, up to \(maximumLength). No capital, digit or symbol is required. Length is what counts, and it cannot be only spaces."
    }
}

/// The 201 body of `POST /auth/invitation/accept`.
///
/// `mustChangePassword` is reported from the row the server actually created,
/// not assumed. When the invitation-password-fix migration has not been applied
/// the new account is still flagged, and the invitee has to be told rather than
/// promised a clean sign-in they will not get.
struct InvitationAcceptance: Decodable {
    let success: Bool?
    let userId: String?
    let email: String?
    let mustChangePassword: Bool?
    let note: String?

    /// Read from the response, never assumed by the client. The current server
    /// always sends this key explicitly on a 201, so an absent value means a
    /// backend that predates the flag and therefore has no lock to report.
    var requiresPasswordChange: Bool { mustChangePassword ?? false }

    /// Prefill for the sign-in form. Empty rather than nil so the caller does
    /// not have to distinguish "no email" from "blank email".
    var prefillEmail: String { email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    private enum CodingKeys: String, CodingKey {
        case success, userId, email, mustChangePassword, note
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = try? container.decodeIfPresent(Bool.self, forKey: .success)
        // The server sends a bigint id. Older rows and other backends have sent
        // it as a string, and neither is worth failing an account creation over.
        if let text = try? container.decodeIfPresent(String.self, forKey: .userId) {
            userId = text
        } else if let number = try? container.decodeIfPresent(Int.self, forKey: .userId) {
            userId = String(number)
        } else {
            userId = nil
        }
        email = try? container.decodeIfPresent(String.self, forKey: .email)
        mustChangePassword = try? container.decodeIfPresent(Bool.self, forKey: .mustChangePassword)
        note = try? container.decodeIfPresent(String.self, forKey: .note)
    }
}

/// Every failure `POST /auth/invitation/accept` can produce, as a case rather
/// than a string, so the screen can offer the right next action for each one.
///
/// The codes are the ones in `routes/auth.js` and `REDEMPTION_ERRORS` in
/// `routes/invitations.js`. An unrecognised code is not collapsed into a
/// generic failure: the server writes those sentences for a person to read.
enum InvitationAcceptError: Error, Equatable {
    case notFound
    case expired
    case revoked
    case alreadyUsed
    case emailAlreadyExists
    case passwordTooWeak(String?)
    case tooManyAttempts
    case serverFailure(String?)
    case network

    /// Maps a `code` from the error body. Nil when the code is not one of ours,
    /// which leaves the caller free to fall back to the server's own message.
    static func from(code: String?) -> InvitationAcceptError? {
        switch code {
        case "INVITATION_NOT_FOUND":     return .notFound
        case "INVITATION_EXPIRED":       return .expired
        case "INVITATION_REVOKED":       return .revoked
        case "INVITATION_USED":          return .alreadyUsed
        case "EMAIL_ALREADY_EXISTS":     return .emailAlreadyExists
        case "TOO_MANY_ATTEMPTS":        return .tooManyAttempts
        case "INVITATION_ACCEPT_FAILED": return .serverFailure(nil)
        default: return nil
        }
    }

    /// One sentence per cause, each one saying what to do next.
    var message: String {
        switch self {
        case .notFound:
            return "This invitation link is not valid. Ask whoever invited you to send a new one."
        case .expired:
            return "This invitation has expired. Ask whoever invited you for a fresh link."
        case .revoked:
            return "This invitation was revoked. Ask whoever invited you to send a new one."
        case .alreadyUsed:
            return "This invitation has already been used. If that was you, sign in instead."
        case .emailAlreadyExists:
            return "An account already exists for this address. Sign in instead."
        case .passwordTooWeak(let serverMessage):
            return serverMessage ?? "Password must be at least \(PasswordPolicy.minimumLength) characters."
        case .tooManyAttempts:
            return "Too many attempts from this network. Wait a few minutes and try again."
        case .serverFailure(let serverMessage):
            return serverMessage ?? "Something went wrong setting up the account. Try again in a moment."
        case .network:
            return "Could not reach the server. Check your connection and try again."
        }
    }

    /// Whether trying the same token again could ever work. A revoked, used or
    /// expired invitation cannot, so the screen offers sign-in instead of a
    /// retry that is guaranteed to fail.
    var isRetryable: Bool {
        switch self {
        case .notFound, .expired, .revoked, .alreadyUsed, .emailAlreadyExists:
            return false
        case .passwordTooWeak, .tooManyAttempts, .serverFailure, .network:
            return true
        }
    }
}
