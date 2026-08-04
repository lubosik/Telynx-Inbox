import Foundation

/// Thin client for the existing Vici inbox backend.
///
/// Reuses the exact endpoints the web app already uses:
///   POST /auth/login        { password }        -> sets `vici_sess` cookie
///   GET  /auth/check                            -> { authenticated: Bool }
///   GET  /api/voice/token                       -> { login, password, callerNumber }
///
/// Session is a cookie, so we let URLSession's shared cookie storage handle
/// it — same 30-day cookie the browser gets.
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

    @discardableResult
    func login(password: String) async throws -> Bool {
        let body = ["password": password]
        let (_, response) = try await post("/auth/login", body: body)
        guard response.statusCode == 200 else {
            if response.statusCode == 401 { throw APIError.unauthorised }
            throw APIError.badResponse(response.statusCode)
        }
        // Cache so a cold launch from a VoIP push can re-authenticate silently.
        CredentialStore.set(password, for: .inboxPassword)
        return true
    }

    func isAuthenticated() async -> Bool {
        guard let (data, response) = try? await get("/auth/check"),
              response.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return json["authenticated"] as? Bool ?? false
    }

    /// Re-login using the stored password. Called on cold launch before
    /// fetching SIP credentials.
    func restoreSessionIfNeeded() async -> Bool {
        if await isAuthenticated() { return true }
        guard let password = CredentialStore.get(.inboxPassword) else { return false }
        return (try? await login(password: password)) ?? false
    }

    func logout() async {
        _ = try? await post("/auth/logout", body: [:])
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

    func fetchContacts(search: String = "", page: Int = 1) async throws -> ContactPage {
        var query = [URLQueryItem(name: "page", value: String(page))]
        if !search.isEmpty { query.append(URLQueryItem(name: "search", value: search)) }
        return try await decodedGET("/api/contacts", queryItems: query)
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

    // MARK: - Call history

    func fetchCallLogs(page: Int = 1) async throws -> [CallLogRecord] {
        try await decodedGET("/api/voice/logs", queryItems: [URLQueryItem(name: "page", value: String(page))])
    }

    // MARK: - Voice

    /// Fetches SIP credentials. Falls back to the Keychain cache when the
    /// network or session is unavailable, so a push-woken app can still
    /// register with Telnyx.
    func fetchSIPCredentials() async throws -> SIPCredentials {
        guard await restoreSessionIfNeeded() else {
            if let cached = CredentialStore.cachedSIPCredentials { return cached }
            throw APIError.unauthorised
        }

        let (data, response) = try await get("/api/voice/token")
        guard response.statusCode == 200 else {
            if let cached = CredentialStore.cachedSIPCredentials { return cached }
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
    /// POST /api/voice/logs as a client-side fallback logger.
    func logCall(direction: String, phone: String, status: String, durationSeconds: Int?) async {
        var body: [String: Any] = [
            "direction": direction,
            "contact_phone": phone,
            "status": status,
            "source": "ios"
        ]
        if let durationSeconds { body["duration_seconds"] = durationSeconds }
        _ = try? await post("/api/voice/logs", body: body)
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

    private func get(_ path: String, queryItems: [URLQueryItem] = []) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path, queryItems: queryItems))
        request.httpMethod = "GET"
        return try await perform(request)
    }

    @discardableResult
    private func post(_ path: String, body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(request)
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

    private func validate(data: Data, response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw APIError.unauthorised }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let message = json["error"] as? String { throw APIError.server(message) }
            throw APIError.badResponse(response.statusCode)
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
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
