import Foundation

/// Thin client for the existing Vici inbox backend.
///
/// Reuses the exact endpoints the web app already uses:
///   POST /auth/login        { password }        -> sets `vici_sess` cookie
///   GET  /auth/check                            -> { authenticated: Bool, actor: {...} }
///   GET  /api/voice/token                       -> { login, password, callerNumber }
///
/// Session is a cookie, so we let URLSession's shared cookie storage handle
/// it — same 30-day cookie the browser gets.
///
/// The multi-user release adds an optional named account: `POST /auth/login`
/// takes either `{ email, password }` or the legacy `{ password }` alone. Both
/// remain supported and the legacy path is still what two people use in
/// production, so it is never removed or deprecated in the client.
extension Notification.Name {
    /// Posted when a request 401'd and re-authenticating from the Keychain also
    /// failed. Purely informational: it drives a "signed out — tap to sign in"
    /// state. It must never trigger a sign-out, a credential wipe, or a push
    /// unregistration, because the VoIP answer path depends on the Keychain
    /// surviving every authentication failure.
    static let viciAuthenticationLost = Notification.Name("vici.auth.lost")
    /// Posted after a silent re-authentication succeeded. Permissions may have
    /// changed (that is what a 401 `SESSION_STALE` means), so the session model
    /// reloads the current user.
    static let viciAuthenticationRecovered = Notification.Name("vici.auth.recovered")
}

enum APIError: LocalizedError {
    case badResponse(Int)
    case unauthorised
    case decoding
    case server(String)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badResponse(let code): return "Server returned \(code)."
        case .unauthorised:          return "Wrong password, or the session expired."
        case .decoding:              return "Unexpected response from the server."
        case .server(let message):   return message
        case .transport(let err):    return err.localizedDescription
        }
    }
}

actor APIClient {
    static let shared = APIClient()

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    // MARK: - Auth

    /// The user object from the most recent successful login or session check.
    /// Kept so a backend without `/api/users/me` still yields a display name
    /// and permissions.
    private var lastKnownUser: AuthUser?

    /// Guards the silent re-authentication path against re-entrancy. A 401 on
    /// several concurrent requests must produce one login attempt, not one per
    /// request.
    private var isReauthenticating = false

    /// Legacy shared-password login. Still the path two people use in
    /// production; it is not deprecated and must keep working.
    @discardableResult
    func login(password: String) async throws -> Bool {
        try await performLogin(email: nil, password: password)
    }

    /// Named-account login. An empty email falls through to the legacy path
    /// rather than sending a blank username the server would have to reject.
    @discardableResult
    func login(email: String, password: String) async throws -> Bool {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await performLogin(email: trimmed.isEmpty ? nil : trimmed,
                                      password: password)
    }

    @discardableResult
    private func performLogin(email: String?, password: String) async throws -> Bool {
        var body: [String: Any] = ["password": password]
        if let email { body["email"] = email }
        // Never retried on 401: a wrong password must surface, not loop.
        let (data, response) = try await post("/auth/login", body: body, retryOn401: false)
        guard response.statusCode == 200 else {
            if response.statusCode == 401 { throw APIError.unauthorised }
            throw APIError.badResponse(response.statusCode)
        }
        if let decoded = try? decoder.decode(AuthResponse.self, from: data), let user = decoded.identity {
            lastKnownUser = user
        }
        // Cached so a cold launch from a VoIP push can re-authenticate silently.
        CredentialStore.set(password, for: .inboxPassword)
        CredentialStore.set(email, for: .inboxEmail)
        return true
    }

    func isAuthenticated() async -> Bool {
        // Not retried on 401: this call is itself the authentication probe.
        guard let (data, response) = try? await get("/auth/check", retryOn401: false),
              response.statusCode == 200
        else { return false }
        if let decoded = try? decoder.decode(AuthResponse.self, from: data) {
            if let user = decoded.identity { lastKnownUser = user }
            return decoded.isAuthenticated
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return json["authenticated"] as? Bool ?? false
    }

    /// Re-login using the stored credentials. Called on cold launch before
    /// fetching SIP credentials, so it must stay cheap and must never block on
    /// anything interactive.
    ///
    /// Fallback chain: a stored email uses the named-account form first, and a
    /// failure there still tries the legacy password-only form. That second
    /// attempt matters during the rollout — an account can exist locally as an
    /// email while the deployed server is still on the shared password.
    func restoreSessionIfNeeded() async -> Bool {
        if await isAuthenticated() { return true }
        return await loginFromStoredCredentials()
    }

    /// Shared by `restoreSessionIfNeeded` and the 401 interceptor. Returns
    /// false rather than throwing: no caller of this may treat a failure as a
    /// reason to sign the user out.
    private func loginFromStoredCredentials() async -> Bool {
        guard let password = CredentialStore.get(.inboxPassword) else { return false }
        if let email = CredentialStore.get(.inboxEmail), !email.isEmpty,
           ((try? await performLogin(email: email, password: password)) ?? false) {
            return true
        }
        return (try? await performLogin(email: nil, password: password)) ?? false
    }

    /// The current account, for the permission-aware UI.
    ///
    /// Falls back to the user captured at login when `/api/users/me` is absent
    /// (older backend) or unreachable. A nil result means "unknown", and the
    /// client treats unknown as the legacy full-access shared account rather
    /// than hiding the whole app.
    func loadCurrentUser() async -> AuthUser? {
        if let (data, response) = try? await get("/api/users/me"),
           (200..<300).contains(response.statusCode) {
            if let user = try? decoder.decode(AuthUser.self, from: data) {
                lastKnownUser = user
                return user
            }
            if let wrapped = try? decoder.decode(AuthResponse.self, from: data), let user = wrapped.identity {
                lastKnownUser = user
                return user
            }
        }
        return lastKnownUser
    }

    func logout() async {
        _ = try? await post("/auth/logout", body: [:], retryOn401: false)
        lastKnownUser = nil
    }

    // MARK: - Message notifications

    func registerMessagePushDevice(token: String,
                                   installationID: String,
                                   environment: String) async throws {
        let (data, response) = try await post("/api/mobile-push/register", body: [
            "deviceToken": token,
            "installationId": installationID,
            "environment": environment
        ])
        try validate(data: data, response: response)
    }

    func unregisterMessagePushDevice(token: String?, installationID: String) async {
        var body: [String: Any] = ["installationId": installationID]
        if let token { body["deviceToken"] = token }
        _ = try? await post("/api/mobile-push/unregister", body: body)
    }

    // MARK: - Inbox

    func fetchConversations() async throws -> [ConversationSummary] {
        let loaded: [ConversationSummary] = try await decodedGET("/api/conversations")
        // Decorate-sort-undecorate: parse each activity date once. Doing date
        // parsing inside the comparator caused O(n log n) formatter work on
        // the MainActor and visibly froze long inboxes while scrolling.
        return loaded.map { conversation in
            let latest = [
                conversation.latestOrderDate,
                conversation.lastSeen,
                conversation.lastMessage?.createdAt
            ].compactMap(ServerDate.parse).max() ?? .distantPast
            return (conversation, latest)
        }
        .sorted { $0.1 > $1.1 }
        .map { $0.0 }
    }

    func fetchThread(phone: String) async throws -> [MessageRecord] {
        try await decodedGET("/api/conversations/\(encodedPathSegment(phone))")
    }

    func sendMessage(to phone: String,
                     message: String,
                     mediaURLs: [String] = [],
                     replyToMessageID: Int? = nil) async throws {
        var body: [String: Any] = ["to": phone, "message": message, "mediaUrls": mediaURLs]
        if let replyToMessageID { body["replyToMessageId"] = replyToMessageID }
        let (data, response) = try await post("/api/send", body: body)
        try validate(data: data, response: response)
    }

    func react(to messageID: Int, type: String) async throws {
        let (data, response) = try await post("/api/react", body: ["messageId": messageID, "type": type])
        try validate(data: data, response: response)
    }

    func uploadJPEG(_ data: Data) async throws -> String {
        let body: [String: Any] = [
            "filename": "ios-\(UUID().uuidString).jpg",
            "contentType": "image/jpeg",
            "data": data.base64EncodedString()
        ]
        let (responseData, response) = try await post("/api/upload", body: body)
        try validate(data: responseData, response: response)
        guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              let url = json["url"] as? String else { throw APIError.decoding }
        return url
    }

    // MARK: - Contacts and orders

    func fetchContacts(search: String = "", page: Int = 1, pageSize: Int = 100) async throws -> ContactPage {
        var query = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "per_page", value: String(pageSize))
        ]
        if !search.isEmpty { query.append(URLQueryItem(name: "search", value: search)) }
        return try await decodedGET("/api/contacts", queryItems: query)
    }

    func fetchAllContacts(search: String = "") async throws -> [ConversationSummary] {
        var contacts: [ConversationSummary] = []
        var pageNumber = 1
        while true {
            let response = try await fetchContacts(search: search, page: pageNumber, pageSize: 1000)
            contacts.append(contentsOf: response.contacts)
            guard response.hasMore, pageNumber < 100 else { break }
            pageNumber += 1
        }
        return contacts.sorted {
            if $0.hasSavedName != $1.hasSavedName { return $0.hasSavedName }
            let order = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
            return order == .orderedSame ? $0.phone < $1.phone : order == .orderedAscending
        }
    }

    func fetchContact(phone: String) async throws -> ContactDetailResponse {
        try await decodedGET("/api/contacts/\(encodedPathSegment(phone))")
    }

    func createContact(firstName: String, lastName: String, phone: String,
                       email: String, notes: String) async throws -> ConversationSummary {
        let (data, response) = try await post("/api/contacts", body: [
            "first_name": firstName, "last_name": lastName, "phone": phone,
            "email": email, "notes": notes
        ])
        try validate(data: data, response: response)
        struct Created: Decodable { let contact: ConversationSummary }
        return try decoder.decode(Created.self, from: data).contact
    }

    func updateContact(phone: String, firstName: String, lastName: String,
                       email: String, notes: String) async throws -> ConversationSummary {
        let (data, response) = try await patch("/api/contacts/\(encodedPathSegment(phone))", body: [
            "first_name": firstName, "last_name": lastName,
            "email": email, "notes": notes
        ])
        try validate(data: data, response: response)
        struct Updated: Decodable { let contact: ConversationSummary }
        return try decoder.decode(Updated.self, from: data).contact
    }

    // MARK: - Automations

    func fetchActivityStats() async throws -> ActivityStats {
        try await decodedGET("/api/activity/stats")
    }

    func fetchActivityQueue(flow: String = "all", page: Int = 1) async throws -> ActivityPage {
        try await decodedGET("/api/activity/queue", queryItems: [
            URLQueryItem(name: "flow", value: flow), URLQueryItem(name: "page", value: String(page))
        ])
    }

    func fetchRecentActivity(flow: String = "all", page: Int = 1) async throws -> ActivityPage {
        try await decodedGET("/api/activity/recent", queryItems: [
            URLQueryItem(name: "flow", value: flow), URLQueryItem(name: "page", value: String(page))
        ])
    }

    func cancelScheduledMessage(id: String) async throws {
        let (data, response) = try await delete("/api/activity/queue/\(encodedPathSegment(id))")
        try validate(data: data, response: response)
    }

    // MARK: - Analytics

    func fetchAnalyticsOverview(query: AnalyticsQuery) async throws -> AnalyticsOverview {
        try await decodedGET("/api/analytics/overview", queryItems: query.queryItems)
    }

    func fetchAttributions(query: AnalyticsQuery,
                           page: Int = 1,
                           pageSize: Int = 25,
                           scope: AttributionScope = .attributed,
                           confidence: AttributionConfidence? = nil,
                           category: String? = nil) async throws -> AttributionPage {
        var items = query.queryItems + [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize)),
            URLQueryItem(name: "scope", value: scope.rawValue)
        ]
        if let confidence { items.append(URLQueryItem(name: "confidence", value: confidence.rawValue)) }
        if let category, !category.isEmpty { items.append(URLQueryItem(name: "category", value: category)) }
        return try await decodedGET("/api/analytics/attributions", queryItems: items)
    }

    /// Authenticated Server-Sent Events used only as an invalidation signal.
    /// The stream never carries or computes dashboard values; a matching event
    /// asks the model to refetch a server-calculated snapshot after a debounce.
    func analyticsEvents() throws -> AsyncThrowingStream<AnalyticsEvent, Error> {
        var preparedRequest = URLRequest(url: try url("/api/sse"),
                                         cachePolicy: .reloadIgnoringLocalCacheData,
                                         timeoutInterval: 60)
        preparedRequest.httpMethod = "GET"
        preparedRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let request = preparedRequest
        let streamingSession = session

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await streamingSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw APIError.decoding }
                    guard http.statusCode == 200 else {
                        if http.statusCode == 401 { throw APIError.unauthorised }
                        throw APIError.badResponse(http.statusCode)
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data:") else { continue }
                        let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        guard let data = payload.data(using: .utf8),
                              let event = try? JSONDecoder().decode(AnalyticsEvent.self, from: data)
                        else { continue }
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Call history

    func fetchCallLogs(page: Int = 1) async throws -> [CallLogRecord] {
        try await decodedGET("/api/voice/logs", queryItems: [URLQueryItem(name: "page", value: String(page))])
    }

    /// Clears the missed-call badge for everyone signed in. Deliberately
    /// non-throwing: the device has already recorded what it has shown, so a
    /// failure here must not surface an error over call history.
    func markMissedCallsSeen() async {
        _ = try? await post("/api/voice/logs/seen", body: [:])
    }

    // MARK: - Voice

    /// Fetches the current iOS-only SIP credentials. Normal launches may fall
    /// back to Keychain when offline; callers that are checking for a server-
    /// side credential rotation can require a fresh response instead.
    func fetchSIPCredentials(allowCachedFallback: Bool = true) async throws -> SIPCredentials {
        guard await restoreSessionIfNeeded() else {
            if allowCachedFallback, let cached = CredentialStore.cachedSIPCredentials { return cached }
            throw APIError.unauthorised
        }

        var request = URLRequest(url: try url("/api/voice/token"),
                                 cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 20)
        request.httpMethod = "GET"
        request.setValue("ios", forHTTPHeaderField: "X-Vici-Client")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await perform(request)
        } catch {
            if allowCachedFallback, let cached = CredentialStore.cachedSIPCredentials { return cached }
            throw error
        }
        guard response.statusCode == 200 else {
            if allowCachedFallback, let cached = CredentialStore.cachedSIPCredentials { return cached }
            throw APIError.badResponse(response.statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let login = json["login"] as? String,
              let password = json["password"] as? String
        else { throw APIError.decoding }

        let creds = SIPCredentials(login: login,
                                   password: password,
                                   callerNumber: json["callerNumber"] as? String ?? "")
        CredentialStore.store(creds)
        return creds
    }

    /// Best-effort log of a call from the device. The backend already exposes
    /// Download a call recording to a temporary file for playback.
    ///
    /// The audio is fetched rather than streamed straight into AVPlayer because
    /// the endpoint is cookie-authenticated and answers with a 302 to a
    /// short-lived signed URL. URLSession here already carries the session
    /// cookie and follows the redirect; AVPlayer does neither reliably. A local
    /// file also makes scrubbing instant instead of re-buffering.
    ///
    /// The first request for a given call is slower — the server copies the
    /// recording out of the provider into private storage before serving it.
    func downloadRecording(callLogID: String) async throws -> URL {
        let (data, response) = try await get("/api/voice/recordings/\(callLogID)")
        guard response.statusCode == 200 else {
            if response.statusCode == 401 { throw APIError.unauthorised }
            if response.statusCode == 404 { throw APIError.server("This recording is no longer available.") }
            throw APIError.badResponse(response.statusCode)
        }
        guard !data.isEmpty else { throw APIError.server("The recording came back empty.") }

        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("recording-\(callLogID).mp3")
        try data.write(to: destination, options: .atomic)
        return destination
    }

    /// POST /api/voice/logs as a client-side fallback logger.
    func logCall(direction: String, phone: String, status: String,
                 durationSeconds: Int?, startedAt: Date? = nil, endedAt: Date? = nil) async {
        var body: [String: Any] = [
            "direction": direction,
            "contact_phone": phone,
            "status": status,
            "source": "ios"
        ]
        if let durationSeconds { body["duration_seconds"] = durationSeconds }
        let formatter = ISO8601DateFormatter()
        if let startedAt { body["started_at"] = formatter.string(from: startedAt) }
        if let endedAt { body["ended_at"] = formatter.string(from: endedAt) }
        _ = try? await post("/api/voice/logs", body: body)
    }

    // MARK: - Audit trail

    /// `GET /api/audit`. `nextCursor` is opaque paging state; the caller keeps
    /// it and hands it back rather than computing page numbers.
    func fetchAudit(category: AuditCategory = .all,
                    actorID: String? = nil,
                    from: Date? = nil,
                    to: Date? = nil,
                    cursor: Int? = nil,
                    limit: Int = 50) async throws -> AuditPage {
        // `all` is a client-side idea, not a server one: routes/audit.js validates
        // `category` against the real category list and answers 400 for anything
        // else. Sending it unconditionally 400s the default, unfiltered feed —
        // the very first request the Activity screen makes. Omit it instead.
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if category != .all {
            items.append(URLQueryItem(name: "category", value: category.rawValue))
        }
        if let actorID, !actorID.isEmpty { items.append(URLQueryItem(name: "actor", value: actorID)) }
        let formatter = ISO8601DateFormatter()
        if let from { items.append(URLQueryItem(name: "from", value: formatter.string(from: from))) }
        if let to { items.append(URLQueryItem(name: "to", value: formatter.string(from: to))) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: String(cursor))) }
        return try await decodedGET("/api/audit", queryItems: items)
    }

    /// `GET /api/audit/entity/:entityType/:entityId`. The contract says "same
    /// item shape" without stating whether it is wrapped, so both a paged
    /// envelope and a bare array decode.
    func fetchEntityHistory(entityType: String, entityID: String) async throws -> [AuditItem] {
        let path = "/api/audit/entity/\(encodedPathSegment(entityType))/\(encodedPathSegment(entityID))"
        let (data, response) = try await get(path)
        try validate(data: data, response: response)
        if let page = try? decoder.decode(AuditPage.self, from: data) { return page.items }
        if let list = try? decoder.decode([AuditItem].self, from: data) { return list }
        throw APIError.decoding
    }

    func fetchAuditActors() async throws -> [AuditActor] {
        let (data, response) = try await get("/api/audit/actors")
        try validate(data: data, response: response)
        if let list = try? decoder.decode([AuditActor].self, from: data) { return list }
        // The server names each list after its resource — `{ actors: [...] }` —
        // rather than using a generic `items` envelope. Decoding only the
        // generic shape throws, and the screen renders empty with no error
        // that points at the cause.
        struct Named: Decodable { let actors: [AuditActor] }
        if let named = try? decoder.decode(Named.self, from: data) { return named.actors }
        struct Wrapped: Decodable { let items: [AuditActor] }
        if let wrapped = try? decoder.decode(Wrapped.self, from: data) { return wrapped.items }
        throw APIError.decoding
    }

    // MARK: - Team

    func fetchTeam() async throws -> [TeamMember] {
        let (data, response) = try await get("/api/users")
        try validate(data: data, response: response)
        if let list = try? decoder.decode([TeamMember].self, from: data) { return list }
        // The server names each list after its resource — `{ users: [...] }` —
        // rather than using a generic `items` envelope. Decoding only the
        // generic shape throws, and the screen renders empty with no error
        // that points at the cause.
        struct Named: Decodable { let users: [TeamMember] }
        if let named = try? decoder.decode(Named.self, from: data) { return named.users }
        struct Wrapped: Decodable { let items: [TeamMember] }
        if let wrapped = try? decoder.decode(Wrapped.self, from: data) { return wrapped.items }
        throw APIError.decoding
    }

    func updateUserRole(id: String, role: String) async throws {
        let (data, response) = try await patch("/api/users/\(encodedPathSegment(id))",
                                               body: ["role": role])
        try validate(data: data, response: response)
    }

    /// The server refuses to remove the last active admin with a 409
    /// `CANNOT_DEACTIVATE_LAST_OWNER`, which `validate` turns into a sentence
    /// the operator can act on.
    func deactivateUser(id: String) async throws {
        let (data, response) = try await post("/api/users/\(encodedPathSegment(id))/deactivate",
                                              body: [:])
        try validate(data: data, response: response)
    }

    func fetchInvitations() async throws -> [Invitation] {
        let (data, response) = try await get("/api/invitations")
        try validate(data: data, response: response)
        if let list = try? decoder.decode([Invitation].self, from: data) { return list }
        // The server names each list after its resource — `{ invitations: [...] }` —
        // rather than using a generic `items` envelope. Decoding only the
        // generic shape throws, and the screen renders empty with no error
        // that points at the cause.
        struct Named: Decodable { let invitations: [Invitation] }
        if let named = try? decoder.decode(Named.self, from: data) { return named.invitations }
        struct Wrapped: Decodable { let items: [Invitation] }
        if let wrapped = try? decoder.decode(Wrapped.self, from: data) { return wrapped.items }
        throw APIError.decoding
    }

    /// Creation is the only time `inviteToken` / `inviteUrl` are returned.
    /// There is no email sender configured, so the caller must show the link
    /// once and let the admin copy it.
    func createInvitation(email: String, role: String) async throws -> Invitation {
        let (data, response) = try await post("/api/invitations",
                                              body: ["email": email, "role": role])
        try validate(data: data, response: response)
        if let invitation = try? decoder.decode(Invitation.self, from: data) { return invitation }
        struct Wrapped: Decodable { let invitation: Invitation }
        if let wrapped = try? decoder.decode(Wrapped.self, from: data) { return wrapped.invitation }
        throw APIError.decoding
    }

    // MARK: - Plumbing

    private let decoder = JSONDecoder()

    private func encodedPathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private func url(_ path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        var components = URLComponents(url: AppConfig.serverURL, resolvingAgainstBaseURL: false)
        components?.percentEncodedPath = path.hasPrefix("/") ? path : "/\(path)"
        if !queryItems.isEmpty { components?.queryItems = queryItems }
        guard let url = components?.url else { throw APIError.decoding }
        return url
    }

    private func get(_ path: String,
                     queryItems: [URLQueryItem] = [],
                     retryOn401: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path, queryItems: queryItems))
        request.httpMethod = "GET"
        return try await perform(request, retryOn401: retryOn401)
    }

    @discardableResult
    private func post(_ path: String,
                      body: [String: Any],
                      retryOn401: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(request, retryOn401: retryOn401)
    }

    private func patch(_ path: String, body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(request)
    }

    private func delete(_ path: String) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "DELETE"
        return try await perform(request)
    }

    private func decodedGET<T: Decodable>(_ path: String,
                                          queryItems: [URLQueryItem] = []) async throws -> T {
        let (data, response) = try await get(path, queryItems: queryItems)
        try validate(data: data, response: response)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// Maps a non-2xx response onto an `APIError`.
    ///
    /// Only 401 becomes `.unauthorised`. A 403 `FORBIDDEN_PERMISSION` is a
    /// role decision about one action, not a broken session, so it surfaces as
    /// an ordinary message and must never be mistaken for a sign-out.
    private func validate(data: Data, response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw APIError.unauthorised }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let message = Self.readableMessage(from: json, statusCode: response.statusCode) {
                throw APIError.server(message)
            }
            throw APIError.badResponse(response.statusCode)
        }
    }

    /// Server error bodies carry either a plain `error`/`message` string or a
    /// machine `code`. The two codes with real consequences for the operator
    /// get sentences rather than an opaque identifier.
    private static func readableMessage(from json: [String: Any]?, statusCode: Int) -> String? {
        guard let json else { return nil }
        let code = json["code"] as? String
        switch code {
        case "FORBIDDEN_PERMISSION":
            let permission = json["permission"] as? String
            let role = RoleCatalog.label(json["role"] as? String)
            if let permission {
                return "\(role) accounts cannot do this. It needs the \(permission) permission."
            }
            return "\(role) accounts cannot do this."
        case "CANNOT_DEACTIVATE_LAST_OWNER":
            return "This is the last active admin. Add or promote another admin first, then try again."
        default:
            break
        }
        if let message = json["error"] as? String, !message.isEmpty { return message }
        if let message = json["message"] as? String, !message.isEmpty { return message }
        if let code, !code.isEmpty { return code }
        return nil
    }

    /// Performs a request and, on a 401, re-authenticates once from the
    /// Keychain and replays it exactly once.
    ///
    /// This is the global recovery the client previously lacked: without it a
    /// single 401 left every tab showing "the session expired" until the app
    /// happened to be backgrounded and reopened. It also implements the
    /// `SESSION_STALE` contract, where a permissions change invalidates the
    /// cookie and the correct response is a silent re-login.
    ///
    /// Three things it deliberately does not do, because the VoIP answer path
    /// reads SIP credentials straight from the Keychain and only a wipe can
    /// stop the phone ringing:
    ///   1. It never calls `SessionModel.signOut()`.
    ///   2. It never calls `CredentialStore.clearAll()`.
    ///   3. It never unregisters push.
    /// A total failure posts `viciAuthenticationLost` and nothing else.
    ///
    /// The replay calls `send` directly rather than recursing, so there is
    /// exactly one retry per request and no possibility of a loop.
    private func perform(_ request: URLRequest,
                         retryOn401: Bool = true) async throws -> (Data, HTTPURLResponse) {
        let (data, http) = try await send(request)
        guard http.statusCode == 401, retryOn401 else { return (data, http) }

        guard await reauthenticateSilently() else {
            NotificationCenter.default.post(name: .viciAuthenticationLost, object: nil)
            return (data, http)
        }

        let replayed = try await send(request)
        if replayed.1.statusCode == 401 {
            NotificationCenter.default.post(name: .viciAuthenticationLost, object: nil)
        }
        return replayed
    }

    /// One login attempt at a time. Concurrent 401s wait for the in-flight
    /// attempt instead of stampeding the login endpoint.
    private func reauthenticateSilently() async -> Bool {
        guard !isReauthenticating else { return false }
        isReauthenticating = true
        defer { isReauthenticating = false }

        guard await loginFromStoredCredentials() else { return false }
        Log.push("session re-authenticated silently after a 401")
        NotificationCenter.default.post(name: .viciAuthenticationRecovered, object: nil)
        return true
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.decoding }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error)
        }
    }
}
