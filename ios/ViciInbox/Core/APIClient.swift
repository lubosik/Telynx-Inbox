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
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badResponse(let code): return "Server returned \(code)."
        case .unauthorised:          return "Wrong password, or the session expired."
        case .decoding:              return "Unexpected response from the server."
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

    private func get(_ path: String) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: AppConfig.serverURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        return try await perform(request)
    }

    @discardableResult
    private func post(_ path: String, body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: AppConfig.serverURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(request)
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
