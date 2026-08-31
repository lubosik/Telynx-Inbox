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
    case server(String, statusCode: Int? = nil, code: String? = nil)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badResponse(let code): return "Server returned \(code)."
        case .unauthorised:          return "Wrong password, or the session expired."
        case .decoding:              return "Unexpected response from the server."
        case .server(let message, _, _): return message
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

    /// A fail-closed identity read for Assistant evidence navigation.
    ///
    /// Unlike `loadCurrentUser()`, this never falls back to a cached identity.
    /// A citation may open private records only when the server has just
    /// confirmed the same named account, role and permissions that initiated
    /// the tap.
    func fetchCurrentUserStrict() async throws -> AuthUser {
        let (data, response) = try await get("/api/users/me")
        try validate(data: data, response: response)
        if let user = try? decoder.decode(AuthUser.self, from: data) {
            lastKnownUser = user
            return user
        }
        if let wrapped = try? decoder.decode(AuthResponse.self, from: data),
           let user = wrapped.identity {
            lastKnownUser = user
            return user
        }
        throw APIError.decoding
    }

    /// Persists a first-run tour decision on the authenticated account.
    ///
    /// The account response owns eligibility. This client never infers a new
    /// account when the optional onboarding envelope is absent, so deploying
    /// the iOS build before the additive backend endpoint is safe.
    func updateOnboarding(status: OnboardingStatus,
                          version: Int,
                          userID: String) async throws {
        let (data, response) = try await post("/api/users/me/onboarding", body: [
            "status": status.rawValue,
            "version": version,
            // Included only as an optimistic-concurrency check. The server
            // must still derive authority from the authenticated actor.
            "userId": userID
        ])
        try validate(data: data, response: response)
    }

    // MARK: - Profile
    //
    // ASSUMED CONTRACT. The backend for name and email editing is being built
    // in parallel; every call below is written against the shape documented on
    // each method and every one of them degrades to a readable error rather
    // than a crash if the endpoint is absent. Nothing here is destructive and
    // nothing here changes authorisation: the server still owns which account
    // is being edited, derived from the session, and `userId` is never sent.

    /// `PATCH /api/users/me` with `{ "displayName": String }`.
    ///
    /// Takes effect immediately — there is nothing to confirm about a display
    /// name. Returns the refreshed account when the server echoes one so the
    /// caller does not have to guess what was stored; a server that answers
    /// `204` is fine and yields nil.
    ///
    /// The 400 `INVALID_DISPLAY_NAME` code already has a sentence in
    /// `readableMessage`, because invitations hit the same validation.
    @discardableResult
    func updateDisplayName(_ displayName: String) async throws -> AuthUser? {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let (data, response) = try await patch("/api/users/me", body: ["displayName": trimmed])
        try validate(data: data, response: response)
        if let user = try? decoder.decode(AuthUser.self, from: data) {
            lastKnownUser = user
            return user
        }
        if let wrapped = try? decoder.decode(AuthResponse.self, from: data), let user = wrapped.identity {
            lastKnownUser = user
            return user
        }
        return nil
    }

    /// `GET /api/users/me/timezones` — every zone this server will accept,
    /// grouped by region, with the offset each is on right now.
    ///
    /// Deliberately not built from `TimeZone.knownTimeZoneIdentifiers` on the
    /// device: this phone's ICU data and the server's can disagree, and the
    /// failure that causes is a picker offering a zone the PATCH then rejects.
    /// The server caches this for fifteen minutes, so re-fetching when the
    /// picker opens is cheap.
    func loadTimeZoneCatalogue() async throws -> TimeZoneCatalogue {
        let (data, response) = try await get("/api/users/me/timezones")
        try validate(data: data, response: response)
        return try decoder.decode(TimeZoneCatalogue.self, from: data)
    }

    /// `PATCH /api/users/me` with `{ "timeZone": String }`, or `null` to clear.
    ///
    /// Clearing is not the same as setting one: it returns the account to the
    /// documented fallback, which is the workspace default when the server has
    /// one and this device's zone otherwise. Passing nil here sends JSON null,
    /// not an absent key, because an absent key would mean "leave it alone".
    ///
    /// The server stores the CANONICAL spelling, so the returned account may
    /// carry a differently-cased identifier than the one sent. Callers should
    /// re-read rather than assume what was stored.
    @discardableResult
    func updateTimeZone(_ identifier: String?) async throws -> AuthUser? {
        let value: Any = identifier.map { $0 as Any } ?? NSNull()
        let (data, response) = try await patch("/api/users/me", body: ["timeZone": value])
        try validate(data: data, response: response)
        if let user = try? decoder.decode(AuthUser.self, from: data) {
            lastKnownUser = user
            return user
        }
        if let wrapped = try? decoder.decode(AuthResponse.self, from: data), let user = wrapped.identity {
            lastKnownUser = user
            return user
        }
        return nil
    }

    /// `POST /api/users/me/email` with `{ "email": String }`.
    ///
    /// Starts a change; it does not perform one. The server mails a
    /// confirmation link to the NEW address, mails a heads-up to the OLD one,
    /// and leaves the account answering to the old address until the link is
    /// opened. That ordering is the whole safety property: an address that has
    /// not been proven never becomes the address that signs in, so a typo
    /// cannot lock anybody out and a borrowed session cannot be made permanent.
    ///
    /// The reply is identical whether the requested address was free or already
    /// belongs to somebody, deliberately, so that this cannot be used to test
    /// whether an account exists. Nothing in this client may add a check that
    /// reintroduces that: do not pre-validate the address against the team
    /// directory, and do not reword `message` into a promise that the link was
    /// definitely sent.
    ///
    /// Calling it again with the same address is also the resend path — the
    /// server cancels the open request and issues a fresh link, because two
    /// live links to two different addresses is the exact state the flow
    /// exists to prevent.
    @discardableResult
    func requestEmailChange(to email: String) async throws -> EmailChangeRequestResult {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let (data, response) = try await post("/api/users/me/email", body: ["email": trimmed])
        try validate(data: data, response: response)
        return (try? decoder.decode(EmailChangeRequestResult.self, from: data))
            ?? EmailChangeRequestResult(message: nil, expiresInHours: nil)
    }

    /// `POST /api/users/me/email/cancel`. Abandons an open request and leaves
    /// the current address exactly as it was.
    ///
    /// Idempotent, and deliberately silent about whether there was anything to
    /// cancel: the same 200 either way, for the same reason the request
    /// endpoint is uniform.
    func cancelEmailChange() async throws {
        let (data, response) = try await post("/api/users/me/email/cancel", body: [:])
        try validate(data: data, response: response)
    }

    // MARK: - Notification preferences
    //
    // THE SERVER IS WHERE SUPPRESSION HAPPENS. There is no client-side filter
    // for an alert push: if the backend sends one, iOS displays it whatever a
    // switch in this app says. These two calls record the person's answer on
    // their ACCOUNT, so it follows them to a new device, and
    // `lib/apns-notify.js` consults it immediately before handing a device list
    // to Apple. Nothing in this client may hide a delivered notification and
    // call that "off".

    /// `GET /api/users/me/notifications`.
    ///
    /// Degrades rather than throwing on an older backend. A 404 means the
    /// endpoint is not deployed yet, which is indistinguishable from an
    /// unapplied migration as far as this screen is concerned: both mean "show
    /// the defaults and say they cannot be saved". Throwing would put an error
    /// page in front of a settings screen that has useful information on it.
    func loadNotificationSettings() async -> NotificationSettings {
        guard let (data, response) = try? await get("/api/users/me/notifications"),
              (200..<300).contains(response.statusCode),
              let settings = try? decoder.decode(NotificationSettings.self, from: data) else {
            return .unavailable
        }
        return settings
    }

    /// `PATCH /api/users/me/notifications` with `{ "preferences": { key: Bool } }`.
    ///
    /// Partial by design: only the switch that moved is sent, so two devices
    /// changing different categories cannot overwrite each other's answer with
    /// a stale full snapshot.
    ///
    /// This one DOES throw. A read may degrade quietly; a write may not,
    /// because a toggle that appears to save and does not is the exact failure
    /// this whole feature exists to avoid. The caller puts the switch back and
    /// says so.
    @discardableResult
    func updateNotificationSetting(_ category: NotificationCategory,
                                   enabled: Bool) async throws -> NotificationSettings {
        let (data, response) = try await patch("/api/users/me/notifications",
                                               body: ["preferences": [category.rawValue: enabled]])
        try validate(data: data, response: response)
        guard let settings = try? decoder.decode(NotificationSettings.self, from: data) else {
            throw APIError.server("That setting could not be saved. Try again.")
        }
        return settings
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

    // MARK: - Campaigns

    func fetchCampaigns(page: Int = 1, pageSize: Int = 25) async throws -> CampaignPage {
        try await fetchCampaigns(page: page, pageSize: pageSize, includeArchived: false).page
    }

    /// The campaign list, plus which of its items are archived.
    ///
    /// The archive flags are decoded as a second, fully optional pass over the
    /// same response rather than as a field on `CampaignRecord`, because the
    /// column is being added by another agent and this build must work before
    /// and after it lands. A backend with no archiving returns flags that are
    /// all nil and the list behaves exactly as it did.
    ///
    /// `includeArchived` is only sent when true, so an older backend never
    /// receives a query parameter it does not understand.
    func fetchCampaigns(page: Int,
                        pageSize: Int,
                        includeArchived: Bool) async throws -> CampaignListResult {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if includeArchived {
            items.append(URLQueryItem(name: "includeArchived", value: "true"))
        }
        let (data, response) = try await get("/api/campaigns", queryItems: items)
        try validate(data: data, response: response)
        guard let page = try? decoder.decode(CampaignPage.self, from: data) else {
            throw APIError.decoding
        }
        var archived: [String: String] = [:]
        if let flags = try? decoder.decode(CampaignArchiveStatePage.self, from: data) {
            for flag in flags.items where flag.archivedAt != nil && !flag.id.isEmpty {
                archived[flag.id] = flag.archivedAt
            }
        }
        return CampaignListResult(page: page, archivedAt: archived)
    }

    func fetchCampaignReviewCount() async throws -> Int {
        let result: CampaignReviewCount = try await decodedGET("/api/campaigns/review-count")
        return result.count
    }

    /// Reads only the unapproved proposal review queue. The status is fixed in
    /// app code so this screen cannot be repurposed to expose accepted or
    /// dismissed proposal history. Server policy independently requires
    /// `campaigns.manage` for this GET.
    func fetchProposedCampaignProposals(page: Int = 1,
                                        pageSize: Int = 50) async throws -> CampaignProposalPage {
        try await decodedGET("/api/campaign-proposals", queryItems: [
            URLQueryItem(name: "status", value: "proposed"),
            URLQueryItem(name: "page", value: String(max(1, page))),
            URLQueryItem(name: "pageSize", value: String(min(50, max(1, pageSize))))
        ])
    }

    /// `POST /api/campaign-proposals/:id/accept`, `campaigns.manage`.
    ///
    /// ACCEPTING IS NOT SENDING. It turns a draft into a campaign in `draft`
    /// status, which is still reviewable, still editable, and still behind
    /// approval and scheduling, both of which ask for a face. This client
    /// deliberately still has no approve, schedule or send method for
    /// proposals: those live on the campaign, where the Face ID prompt is.
    ///
    /// Without this the drafts were a dead end. The assistant could write four
    /// of them and nothing on the phone could act on any of them.
    func acceptCampaignProposal(id: String) async throws -> CampaignProposalAcceptance {
        let (data, response) = try await post(
            "/api/campaign-proposals/\(encodedPathSegment(id))/accept", body: [:]
        )
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignProposalAcceptance.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `POST /api/campaign-proposals/:id/dismiss`, `campaigns.manage`.
    /// Rejects a draft. Reaches no customer either way.
    func dismissCampaignProposal(id: String, reason: String?) async throws {
        var body: [String: Any] = [:]
        if let reason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["reason"] = String(reason.prefix(500))
        }
        let (data, response) = try await post(
            "/api/campaign-proposals/\(encodedPathSegment(id))/dismiss", body: body
        )
        try validate(data: data, response: response)
    }

    /// `POST /api/campaigns/check-copy`, `campaigns.manage`.
    ///
    /// Runs the compliance rules over a message and says what is wrong with it.
    /// It REPORTS, it does not refuse: the edit screen shows what a change
    /// breaks and lets the operator decide. Before this existed nothing checked
    /// an edited message at all.
    func checkCampaignCopy(message: String) async throws -> CampaignCopyVerdict {
        let (data, response) = try await post("/api/campaigns/check-copy",
                                              body: ["message": message])
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignCopyVerdict.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// The aggregate-only opportunity portfolio. `refresh=false` is explicit:
    /// an Assistant read may consume the server's labelled cached snapshot but
    /// must never force a WooCommerce and database recomputation.
    func fetchAssistantOpportunityPortfolio() async throws -> AssistantOpportunityPortfolioWire {
        try await decodedGET("/api/campaigns/opportunities", queryItems: [
            URLQueryItem(name: "refresh", value: "false")
        ])
    }

    func fetchCampaign(id: String) async throws -> CampaignDetailResponse {
        try await decodedGET("/api/campaigns/\(encodedPathSegment(id))")
    }

    func fetchCampaignRecipients(id: String,
                                 page: Int = 1,
                                 pageSize: Int = 100) async throws -> CampaignRecipientPage {
        try await decodedGET("/api/campaigns/\(encodedPathSegment(id))/recipients", queryItems: [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ])
    }

    func fetchCampaignPerformance(id: String) async throws -> CampaignPerformance {
        try await decodedGET("/api/campaigns/\(encodedPathSegment(id))/performance")
    }

    func fetchCampaignFinancialOverview(id: String) async throws -> CampaignFinancialOverview {
        try await decodedGET("/api/analytics/campaigns/\(encodedPathSegment(id))")
    }

    func fetchCampaignAttributions(id: String,
                                   page: Int = 1,
                                   pageSize: Int = 25,
                                   scope: AttributionScope) async throws -> CampaignAttributionPage {
        try await decodedGET(
            "/api/analytics/campaigns/\(encodedPathSegment(id))/attributions",
            queryItems: [
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "pageSize", value: String(pageSize)),
                URLQueryItem(name: "scope", value: scope.rawValue)
            ]
        )
    }

    func createCampaign(title: String,
                        message: String,
                        recipients: [CampaignRecipientInput]) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns", body: [
            "title": title,
            "message": message,
            "workflowCategory": "manual",
            "recipients": recipients.map(\.requestBody)
        ])
    }

    func editCampaign(id: String,
                      title: String,
                      message: String,
                      recipients: [CampaignRecipientInput]) async throws -> CampaignActionResponse {
        let (data, response) = try await patch("/api/campaigns/\(encodedPathSegment(id))", body: [
            "title": title,
            "message": message,
            "recipients": recipients.map(\.requestBody)
        ])
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignActionResponse.self, from: data) }
        catch { throw APIError.decoding }
    }

    func submitCampaignForReview(id: String) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/submit-review")
    }

    func approveCampaign(id: String) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/approve")
    }

    func rejectCampaign(id: String, reason: String) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/reject",
                                   body: ["reason": reason])
    }

    func scheduleCampaign(id: String, scheduledFor: Date) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/schedule", body: [
            "scheduledFor": ISO8601DateFormatter().string(from: scheduledFor)
        ])
    }

    func cancelCampaign(id: String, reason: String?) async throws -> CampaignActionResponse {
        var body: [String: Any] = [:]
        if let reason, !reason.isEmpty { body["reason"] = reason }
        return try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/cancel", body: body)
    }

    /// `POST /api/campaigns/plan`, `campaigns.read`.
    ///
    /// Writes nothing. Describe the campaign and it works out who, chooses the
    /// offer, drafts the copy and says whether it may be sent.
    func planCampaign(brief: String) async throws -> CampaignPlan {
        let (data, response) = try await post("/api/campaigns/plan", body: ["brief": brief])
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignPlan.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `POST /api/campaigns/plan/accept`, `campaigns.manage`.
    ///
    /// Sends the reviewed rules and copy back rather than re-planning, so what
    /// is created is what was read. Re-planning could return different copy and
    /// the operator would have approved words they never saw.
    func acceptCampaignPlan(
        title: String,
        audienceDescription: String,
        ruleSet: JSONValue,
        message: String,
        discountPercent: Int?,
        workflowCategory: String
    ) async throws -> CampaignBuildResult {
        var body: [String: Any] = [
            "title": title,
            "audienceDescription": audienceDescription,
            "ruleSet": ruleSet.rawValue,
            "message": message,
            "workflowCategory": workflowCategory
        ]
        if let discountPercent { body["discountPercent"] = discountPercent }
        let (data, response) = try await post("/api/campaigns/plan/accept", body: body)
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignBuildResult.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `GET /api/campaigns/opportunities`, `campaigns.read`.
    ///
    /// The full human-readable portfolio, including the `reasoning` trail.
    /// Distinct from `fetchAssistantOpportunityPortfolio`, which returns the
    /// stripped, model-visible shape and must never carry prose.
    func fetchCampaignOpportunities() async throws -> CampaignOpportunityPortfolio {
        try await decodedGET("/api/campaigns/opportunities")
    }

    /// `GET /api/campaigns/automations/check-in`, `campaigns.read`.
    func fetchCheckInAutomation() async throws -> CheckInAutomation {
        try await decodedGET("/api/campaigns/automations/check-in")
    }

    /// `PUT /api/campaigns/automations/check-in`, `campaigns.approve`.
    ///
    /// Approve rather than manage: switching this on authorises every future
    /// check-in to be approved and sent with nobody reading it.
    @discardableResult
    func setCheckInAutomation(enabled: Bool) async throws -> CheckInAutomationChange {
        let (data, response) = try await put("/api/campaigns/automations/check-in",
                                             body: ["enabled": enabled])
        try validate(data: data, response: response)
        do { return try decoder.decode(CheckInAutomationChange.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `GET /api/campaigns/recipes`, `campaigns.read`.
    func fetchCampaignRecipeCatalogue() async throws -> CampaignRecipeCatalogue {
        try await decodedGET("/api/campaigns/recipes")
    }

    func fetchCampaignRecipes() async throws -> [CampaignRecipeSummary] {
        try await fetchCampaignRecipeCatalogue().recipes
    }

    /// `POST /api/campaigns/copy-suggestions`, `campaigns.manage`.
    ///
    /// The brief is campaign shape only: no recipient, no phone, no contact,
    /// no order. The server re-checks it for identifier shapes before anything
    /// reaches a model, and refuses the whole request rather than stripping.
    /// `currentMessage` is the copy being edited. Sending it turns a request
    /// for three new messages into a request to REVISE this one, which is what
    /// an instruction like "make it warmer" needs in order to mean anything.
    /// Still campaign shape, not customer evidence: it is a template, so a
    /// customer's name appears in it as `{{first_name}}`.
    func suggestCampaignCopy(
        brief: String, count: Int = 3, currentMessage: String? = nil
    ) async throws -> CampaignCopySuggestions {
        var body: [String: Any] = [
            "workflowType": "manual",
            "brief": brief,
            "candidateCount": count
        ]
        if let currentMessage, !currentMessage.isEmpty { body["currentMessage"] = currentMessage }
        let (data, response) = try await post("/api/campaigns/copy-suggestions", body: body)
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignCopySuggestions.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `POST /api/campaigns/build`, `campaigns.manage`.
    ///
    /// Creates draft campaigns and nothing else: it cannot approve, schedule,
    /// mint a coupon or send. `dryRun` reports the numbers and writes nothing,
    /// which is what the screen calls first so the owner sees how many people
    /// are left after the duplicate check before committing to a build.
    func buildCampaign(recipe: String, dryRun: Bool) async throws -> CampaignBuildResult {
        let (data, response) = try await post("/api/campaigns/build",
                                              body: ["recipe": recipe, "dryRun": dryRun])
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignBuildResult.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `POST /api/campaigns/:id/preview`, `campaigns.read`.
    ///
    /// Mints nothing. The server substitutes a placeholder code of the same
    /// shape as a real one, so lengths and validation behave exactly as they
    /// will at approval and WooCommerce is never touched.
    /// `message` previews copy that has NOT been saved, so wording can be
    /// checked without bumping the revision and dropping an approval.
    func previewCampaign(id: String, limit: Int = 20, message: String? = nil) async throws -> CampaignPreview {
        var body: [String: Any] = ["limit": limit]
        if let message, !message.isEmpty { body["message"] = message }
        let (data, response) = try await post("/api/campaigns/\(encodedPathSegment(id))/preview",
                                              body: body)
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignPreview.self, from: data) }
        catch { throw APIError.decoding }
    }

    func dryRunCampaign(id: String) async throws -> CampaignDryRun {
        let (data, response) = try await post("/api/campaigns/\(encodedPathSegment(id))/dry-run", body: [:])
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignDryRun.self, from: data) }
        catch { throw APIError.decoding }
    }

    /// `POST /api/campaigns/:id/archive`.
    ///
    /// ASSUMED CONTRACT. Archiving is reversible and removes nothing: the
    /// campaign, its revisions and its audit rows all stay. It exists so a
    /// finished or abandoned draft can leave the working list without anybody
    /// having to destroy a record that an approval decision may point at.
    func archiveCampaign(id: String) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/archive")
    }

    /// `POST /api/campaigns/:id/unarchive`. The exact inverse.
    func unarchiveCampaign(id: String) async throws -> CampaignActionResponse {
        try await campaignMutation("/api/campaigns/\(encodedPathSegment(id))/unarchive")
    }

    /// `DELETE /api/campaigns/:id`.
    ///
    /// ASSUMED CONTRACT, and the only destructive campaign call in this client.
    /// It is expected to be refused by the server for anything that has been
    /// approved, scheduled, sent or is sending — a campaign that reached a
    /// customer is evidence, and the audit trail is append-only for the same
    /// reason. The client offers it only for drafts, but the client is not the
    /// control: a 409 here is a correct answer and surfaces as its message.
    ///
    /// Returns nothing. A `204` with an empty body is the expected success.
    func deleteCampaign(id: String) async throws {
        let (data, response) = try await delete("/api/campaigns/\(encodedPathSegment(id))")
        try validate(data: data, response: response)
    }

    private func campaignMutation(_ path: String,
                                  body: [String: Any] = [:]) async throws -> CampaignActionResponse {
        let (data, response) = try await post(path, body: body)
        try validate(data: data, response: response)
        do { return try decoder.decode(CampaignActionResponse.self, from: data) }
        catch { throw APIError.decoding }
    }

    // MARK: - Campaign segments

    /// `GET /api/segments`, `campaigns.read`.
    ///
    /// The response carries `available`, the catalogue entries this workspace
    /// has not saved yet, so the empty state can offer them without a second
    /// request to `/api/segments/catalogue`.
    ///
    /// `archived` is only sent when true. The server hides archived segments by
    /// default and reads the parameter as a string comparison against "true",
    /// so sending `archived=false` would be indistinguishable from not sending
    /// it and is simply left off.
    func fetchSegments(page: Int = 1,
                       pageSize: Int = 50,
                       includeArchived: Bool = false) async throws -> SegmentListPage {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if includeArchived { items.append(URLQueryItem(name: "archived", value: "true")) }
        return try await decodedGET("/api/segments", queryItems: items)
    }

    /// `GET /api/segments/:id`, `campaigns.read`. Members are paged; the
    /// override history is not, because it is bounded by how many times a
    /// person has intervened.
    func fetchSegment(id: String,
                      page: Int = 1,
                      pageSize: Int = 50) async throws -> SegmentDetailResponse {
        try await decodedGET("/api/segments/\(encodedPathSegment(id))", queryItems: [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ])
    }

    /// `GET /api/segments/:id/members/:phone`, `campaigns.read`.
    ///
    /// The "why is this person here" call. `member` comes back null when the
    /// person has an active exclude override and no member row, which is the
    /// answer to the opposite question and is a success, not an error.
    func fetchSegmentMember(id: String, phone: String) async throws -> SegmentMemberDetail {
        try await decodedGET(
            "/api/segments/\(encodedPathSegment(id))/members/\(encodedPathSegment(phone))"
        )
    }

    /// `GET /api/segments/members/:phone`, `campaigns.read`.
    ///
    /// Every segment this person is in, each with its own reason. The
    /// per-segment call above answers a narrower question and stays; this one
    /// exists because the segments overlap heavily, so one answer at a time was
    /// correct and incomplete at the same time.
    func fetchSegmentMemberships(phone: String) async throws -> SegmentMembershipSummary {
        try await decodedGET("/api/segments/members/\(encodedPathSegment(phone))")
    }

    /// `POST /api/segments` with `kind: "automatic"`, `campaigns.manage`.
    ///
    /// Idempotent by definition key: asking twice returns the existing segment
    /// with `created: false` and HTTP 200 rather than a duplicate. Membership
    /// is NOT computed here; the segment is saved empty and a recompute fills
    /// it, which is why `SegmentListModel.startTracking` does both.
    func createAutomaticSegment(definitionKey: String) async throws -> SegmentCreationResponse {
        try await segmentDecoded(post("/api/segments", body: [
            "kind": "automatic",
            "definitionKey": definitionKey
        ]))
    }

    /// `POST /api/segments` with `kind: "manual"`, `campaigns.manage`.
    ///
    /// `purpose` is REQUIRED and the server answers 400
    /// `SEGMENT_PURPOSE_REQUIRED` without it. It is the segment's one reason,
    /// written once and shown as the explanation for everybody in it. It is not
    /// the per-person note, which travels on each `SegmentMemberInput` and says
    /// something different about one named human.
    func createManualSegment(name: String,
                             purpose: String,
                             members: [SegmentMemberInput]) async throws -> SegmentCreationResponse {
        let body: [String: Any] = [
            "kind": "manual",
            "name": name,
            "purpose": purpose,
            "members": members.map(\.requestBody)
        ]
        return try await segmentDecoded(post("/api/segments", body: body))
    }

    /// `POST /api/segments/:id/members`, `campaigns.manage`. Manual segments
    /// only; an automatic one answers 409 and says to use an override instead.
    func addSegmentMember(id: String, member: SegmentMemberInput) async throws -> SegmentMemberResponse {
        try await segmentDecoded(
            post("/api/segments/\(encodedPathSegment(id))/members", body: member.requestBody)
        )
    }

    /// `DELETE /api/segments/:id/members/:phone`, `campaigns.manage`.
    @discardableResult
    func removeSegmentMember(id: String, phone: String) async throws -> SegmentMemberRemoval {
        try await segmentDecoded(
            delete("/api/segments/\(encodedPathSegment(id))/members/\(encodedPathSegment(phone))")
        )
    }

    /// `POST /api/segments/:id/overrides`, `campaigns.manage`.
    ///
    /// NOT a membership edit. An exclude survives every recompute until it is
    /// revoked, and an include keeps somebody in whether or not the engine
    /// still matches them. The screens that call this must say so.
    func setSegmentOverride(id: String,
                            phone: String,
                            overrideType: SegmentOverrideType,
                            reason: String?,
                            name: String? = nil,
                            contactID: String? = nil) async throws -> SegmentOverrideResponse {
        var body: [String: Any] = [
            "phone": phone,
            "overrideType": overrideType.rawValue
        ]
        if let reason, !reason.isEmpty { body["reason"] = reason }
        if let name, !name.isEmpty { body["name"] = name }
        if let contactID, let numeric = Int(contactID), numeric > 0 { body["contactId"] = numeric }
        return try await segmentDecoded(
            post("/api/segments/\(encodedPathSegment(id))/overrides", body: body)
        )
    }

    /// `DELETE /api/segments/:id/overrides/:phone`, `campaigns.manage`.
    ///
    /// The reason travels in the body of a DELETE, which is unusual but is what
    /// the route reads. `express.json()` is mounted globally in server.js ahead
    /// of every router, so the body is parsed for this method too. The row is
    /// never deleted: revoking stamps `revoked_at`, `revoked_by` and
    /// `revoke_reason` so both decisions stay readable.
    func revokeSegmentOverride(id: String,
                               phone: String,
                               reason: String?) async throws -> SegmentOverrideResponse {
        var body: [String: Any] = [:]
        if let reason, !reason.isEmpty { body["reason"] = reason }
        return try await segmentDecoded(
            delete("/api/segments/\(encodedPathSegment(id))/overrides/\(encodedPathSegment(phone))",
                   body: body)
        )
    }

    /// `POST /api/segments/:id/recompute`, `campaigns.manage`.
    ///
    /// Automatic segments only. Given a longer timeout than the default 20
    /// seconds because this reads the same authoritative order history the
    /// draft generator does, over the whole workspace, before it decides
    /// anything. It is idempotent twice over, so a client-side timeout followed
    /// by a retry cannot double-apply it.
    func recomputeSegment(id: String) async throws -> SegmentRecomputeResponse {
        try await segmentDecoded(
            post("/api/segments/\(encodedPathSegment(id))/recompute", body: [:], timeout: 90)
        )
    }

    /// `GET /api/segments/:id/candidates`, `campaigns.manage`.
    ///
    /// People already in the segment are removed by the SERVER, before paging.
    /// Do not re-filter here: the client holds one page and the membership it
    /// would be subtracting can run to ten thousand rows, so a client-side
    /// filter would hide the members on screen and leave every other one a
    /// scroll away. That was the bug.
    ///
    /// `held` is separate on purpose. Somebody with an active exclude override
    /// is not a member, but they are not simply absent either, and re-adding
    /// them is a real thing to want to do.
    func fetchSegmentCandidates(id: String,
                                search: String = "",
                                page: Int = 1,
                                pageSize: Int = 50) async throws -> SegmentCandidateResponse {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if !search.isEmpty { items.append(URLQueryItem(name: "search", value: search)) }
        return try await decodedGET("/api/segments/\(encodedPathSegment(id))/candidates",
                                    queryItems: items)
    }

    /// `DELETE /api/segments/:id`, `campaigns.manage`.
    ///
    /// The body may carry `mode: "archive"` and a reason. It may NOT ask for a
    /// deletion: `delete_sms_campaign_segment` has no force path. Whether the
    /// row was destroyed or archived is in the RESPONSE, and the interface must
    /// read it from there rather than assuming the request got what it asked
    /// for. A segment that gains an override between the tap and the statement
    /// is archived, and that is a correct answer rather than a failure.
    func removeSegment(id: String,
                       archiveOnly: Bool = false,
                       reason: String? = nil) async throws -> SegmentRemovalResponse {
        var body: [String: Any] = [:]
        if archiveOnly { body["mode"] = "archive" }
        if let reason, !reason.isEmpty { body["reason"] = reason }
        return try await segmentDecoded(
            delete("/api/segments/\(encodedPathSegment(id))", body: body)
        )
    }

    /// `POST /api/segments/:id/restore`, `campaigns.manage`. The inverse of an
    /// archive. Nothing was removed by the archive, so nothing is rebuilt here.
    @discardableResult
    func restoreSegment(id: String) async throws -> SegmentRestoreResponse {
        try await segmentDecoded(
            post("/api/segments/\(encodedPathSegment(id))/restore", body: [:])
        )
    }

    // MARK: - Describing a segment in words

    /// `POST /api/segments/rules/draft`, `campaigns.manage`.
    ///
    /// A sentence in, DRAFT RULES out. Nothing is saved and nobody is returned:
    /// the model drafts rules for a person to read, and a separate call runs
    /// them. Four outcomes come back with HTTP 200, and three of them are not
    /// rules; see `SegmentRuleDraftResponse.outcome`. An ambiguous sentence is
    /// answered with questions, and that is a success, not a failure.
    ///
    /// Given a longer timeout than the default 20 seconds because it waits on a
    /// model. It writes nothing, so a client-side timeout costs only the wait.
    func draftSegmentRules(description: String) async throws -> SegmentRuleDraftResponse {
        try await segmentDecoded(
            post("/api/segments/rules/draft", body: ["description": description], timeout: 45)
        )
    }

    /// `POST /api/segments/rules/preview`, `campaigns.manage`. THE DRY RUN.
    ///
    /// Runs the rules over the real data and answers with a count, a small
    /// sample and the warnings. It saves nothing, which is the whole point: the
    /// operator sees "this matches 41 people" before committing to anything.
    ///
    /// Reads the same authoritative order history the draft generator does, over
    /// the whole workspace, so it gets the same 90-second timeout a recompute
    /// gets.
    func previewSegmentRules(_ rules: SegmentRuleSet,
                             selfSegmentKey: String? = nil) async throws -> SegmentRulePreviewResponse {
        var body: [String: Any] = ["rules": rules.requestBody()]
        if let selfSegmentKey, !selfSegmentKey.isEmpty { body["selfSegmentKey"] = selfSegmentKey }
        return try await segmentDecoded(post("/api/segments/rules/preview", body: body, timeout: 90))
    }

    /// `POST /api/segments/rules`, `campaigns.manage`. The only one that writes.
    ///
    /// Membership is NOT computed here. The segment is saved empty and a
    /// recompute fills it, exactly like a catalogue segment, which is why
    /// `SegmentRuleBuilderModel` calls `recomputeSegment` straight afterwards.
    ///
    /// `description` is the operator's own sentence, kept as a record of what
    /// they asked for. The description shown under the segment's name is the
    /// server's rendering of the rules, never this.
    func createSegmentFromRules(name: String,
                                description: String?,
                                rules: SegmentRuleSet) async throws -> SegmentRuleCreationResponse {
        var body: [String: Any] = ["name": name, "rules": rules.requestBody()]
        if let description, !description.isEmpty { body["description"] = description }
        return try await segmentDecoded(post("/api/segments/rules", body: body, timeout: 45))
    }

    /// Validates and decodes one segment response.
    ///
    /// Written to take the already-performed request rather than a path,
    /// because the segment routes use every verb and several of them carry a
    /// body a generic helper could not build.
    private func segmentDecoded<T: Decodable>(_ result: (Data, HTTPURLResponse)) throws -> T {
        try validate(data: result.0, response: result.1)
        do { return try decoder.decode(T.self, from: result.0) }
        catch { throw APIError.decoding }
    }

    // MARK: - Assistant capability

    /// The only assistant-specific backend call in Phase 4. It is a
    /// permission-gated capability document, not a prompt or model endpoint.
    func fetchAssistantStatus() async throws -> AssistantCapabilityStatus {
        try await decodedGET("/api/assistant/status")
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

    /// Aggregate Activity Center counts only. Unlike the feed response, this
    /// endpoint transfers no state snapshots, metadata, contact identity,
    /// device information or human-written summary.
    func fetchAssistantAuditSummary(from: Date? = nil,
                                    to: Date? = nil) async throws -> AssistantAuditSummary {
        var items: [URLQueryItem] = []
        let formatter = ISO8601DateFormatter()
        if let from { items.append(URLQueryItem(name: "from", value: formatter.string(from: from))) }
        if let to { items.append(URLQueryItem(name: "to", value: formatter.string(from: to))) }
        return try await decodedGET("/api/audit/summary", queryItems: items)
    }

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

    // MARK: - Conversation referrals

    func fetchReferralRecipients() async throws -> ReferralRecipientsResponse {
        try await decodedGET("/api/referrals/recipients")
    }

    func fetchReferrals(box: ReferralBox,
                        includeResolved: Bool = true) async throws -> [ReferralRecord] {
        let response: ReferralListResponse = try await decodedGET(
            "/api/referrals",
            queryItems: [
                URLQueryItem(name: "box", value: box.rawValue),
                URLQueryItem(name: "includeResolved", value: includeResolved ? "true" : "false")
            ]
        )
        return response.items
    }

    func fetchReferral(id: String) async throws -> ReferralDetailResponse {
        try await decodedGET("/api/referrals/\(encodedPathSegment(id))")
    }

    func createReferral(contactPhone: String,
                        recipient: ReferralComposerDraft.Recipient,
                        note: String) async throws -> ReferralRecord {
        var body: [String: Any] = [
            "contactPhone": contactPhone,
            "note": note
        ]
        switch recipient {
        case .teammate(let id):
            body["targetKind"] = ReferralTargetKind.directed.rawValue
            body["targetUserId"] = id
        case .anyAdmin:
            body["targetKind"] = ReferralTargetKind.anyAdmin.rawValue
        }
        return try await referralMutation(path: "/api/referrals", body: body)
    }

    func claimReferral(id: String) async throws -> ReferralRecord {
        try await referralMutation(path: "/api/referrals/\(encodedPathSegment(id))/claim", body: [:])
    }

    func reassignReferral(id: String,
                          targetUserID: String,
                          note: String) async throws -> ReferralRecord {
        try await referralMutation(
            path: "/api/referrals/\(encodedPathSegment(id))/reassign",
            body: ["targetUserId": targetUserID, "note": note]
        )
    }

    func handBackReferral(id: String, note: String) async throws -> ReferralRecord {
        try await referralMutation(
            path: "/api/referrals/\(encodedPathSegment(id))/hand-back",
            body: ["note": note]
        )
    }

    func resolveReferral(id: String) async throws -> ReferralRecord {
        try await referralMutation(path: "/api/referrals/\(encodedPathSegment(id))/resolve", body: [:])
    }

    private func referralMutation(path: String, body: [String: Any]) async throws -> ReferralRecord {
        let (data, response) = try await post(path, body: body)
        try validate(data: data, response: response)
        guard let result = try? decoder.decode(ReferralMutationResponse.self, from: data) else {
            throw APIError.decoding
        }
        return result.referral
    }

    // MARK: - Team

    /// `GET /api/users` -> `{ users: [...], roles: [...] }`.
    ///
    /// The role catalogue rides along with the member list rather than being a
    /// second request, so the Team screen can never end up in the state where
    /// it knows who is on the account but has to print `agent` because a
    /// separate lookup failed.
    func fetchTeam() async throws -> TeamDirectory {
        let (data, response) = try await get("/api/users")
        try validate(data: data, response: response)
        // The server names each list after its resource — `{ users: [...] }` —
        // rather than using a generic `items` envelope. Decoding only the
        // generic shape throws, and the screen renders empty with no error
        // that points at the cause.
        //
        // `roles` is optional here on purpose: a backend that predates the
        // catalogue must still return a usable member list.
        struct Named: Decodable { let users: [TeamMember]; let roles: [TeamRole]? }
        if let named = try? decoder.decode(Named.self, from: data) {
            return TeamDirectory(members: named.users, roles: named.roles ?? [])
        }
        if let list = try? decoder.decode([TeamMember].self, from: data) {
            return TeamDirectory(members: list, roles: [])
        }
        struct Wrapped: Decodable { let items: [TeamMember] }
        if let wrapped = try? decoder.decode(Wrapped.self, from: data) {
            return TeamDirectory(members: wrapped.items, roles: [])
        }
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

    /// `POST /api/invitations` requires `displayName` and answers 400
    /// `INVALID_DISPLAY_NAME` without it. The client used to send only `email`
    /// and `role`, so every invitation failed with a validation error the admin
    /// had no field to fix.
    ///
    /// Creation is the only time the raw token and acceptance link exist. They
    /// are returned as siblings of the invitation, not inside it, and are never
    /// recoverable afterwards, so the caller must show them once.
    func createInvitation(displayName: String, email: String, role: String) async throws -> InvitationCreation {
        let (data, response) = try await post("/api/invitations",
                                              body: ["displayName": displayName,
                                                     "email": email,
                                                     "role": role])
        try validate(data: data, response: response)
        if let created = try? decoder.decode(InvitationCreation.self, from: data) { return created }
        throw APIError.decoding
    }

    /// `POST /auth/invitation/accept`. The one authenticated-looking call in
    /// this client that has no session behind it. The invitee has never signed
    /// in; the token from the invitation link is the only credential accepted,
    /// and the server compares it by hash.
    ///
    /// `retryOn401` is off deliberately. The generic 401 interceptor
    /// re-authenticates from the Keychain, and on this endpoint that would be
    /// actively wrong: the inviting Admin frequently opens the invitation link
    /// on their own phone, so a silent re-login would attach the Admin's
    /// session to a request meant to create somebody else's account. The
    /// endpoint does not answer 401 in any case.
    ///
    /// This throws `InvitationAcceptError`, not `APIError`, so the caller can
    /// offer the right next action for each cause. The token is never logged.
    func acceptInvitation(token: String, password: String) async throws -> InvitationAcceptance {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await post("/auth/invitation/accept",
                                              body: ["token": token, "password": password],
                                              retryOn401: false)
        } catch {
            throw InvitationAcceptError.network
        }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let code = json?["code"] as? String
        let serverMessage = (json?["error"] as? String) ?? (json?["message"] as? String)

        guard (200..<300).contains(response.statusCode) else {
            // 400 PASSWORD_TOO_WEAK carries the server's own sentence, which is
            // more specific than anything the client could reconstruct.
            if code == "PASSWORD_TOO_WEAK" {
                throw InvitationAcceptError.passwordTooWeak(serverMessage)
            }
            if let mapped = InvitationAcceptError.from(code: code) {
                // INVITATION_ACCEPT_FAILED carries no useful detail, so its
                // own sentence is kept rather than the server's generic one.
                if case .serverFailure = mapped { throw InvitationAcceptError.serverFailure(nil) }
                throw mapped
            }
            // An unrecognised code still shows the server's sentence. Falling
            // back to a generic failure would throw away the only description
            // of what actually went wrong.
            throw InvitationAcceptError.serverFailure(serverMessage)
        }

        guard let accepted = try? decoder.decode(InvitationAcceptance.self, from: data) else {
            throw InvitationAcceptError.serverFailure(nil)
        }
        return accepted
    }

    // MARK: - Passwords

    /// `POST /auth/password-reset/request`.
    ///
    /// Public, and never retried on 401: there is no session behind this call
    /// and the person making it is by definition unable to produce one.
    ///
    /// RESOLVES FOR ALMOST EVERYTHING. The endpoint answers the same generic
    /// 202 for every address, and the caller must be no more specific than the
    /// server is or the anti-enumeration design is undone from the client side.
    /// Only two server answers throw, and both are provably independent of the
    /// address: the pre-lookup shape check and the per-network throttle. A 5xx
    /// resolves like a success, because on the server a storage failure and a
    /// missing account already answer identically.
    ///
    /// The address is not logged.
    func requestPasswordReset(email: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await post("/auth/password-reset/request",
                                              body: ["email": trimmed],
                                              retryOn401: false)
        } catch {
            throw PasswordResetRequestError.unreachable
        }

        if (200..<300).contains(response.statusCode) { return }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let code = json?["code"] as? String
        let serverMessage = (json?["error"] as? String) ?? (json?["message"] as? String)

        switch code {
        case "INVALID_EMAIL":     throw PasswordResetRequestError.invalidEmail(serverMessage)
        case "TOO_MANY_ATTEMPTS": throw PasswordResetRequestError.throttled(serverMessage)
        default:                  return
        }
    }

    /// `POST /auth/password-reset/confirm`.
    ///
    /// The token is the only credential accepted and the server compares it by
    /// hash. It is passed in, used once, and never logged, never rendered and
    /// never stored.
    ///
    /// Not retried on 401 for the same reason `acceptInvitation` is not: there
    /// is no session here, and a silent re-login from the Keychain would attach
    /// somebody else's session to a request that must not have one.
    ///
    /// THIS DOES NOT SIGN ANYBODY IN, because the server deliberately does not.
    /// A reset link forwarded to the wrong person must be a dead end rather
    /// than a session, so the caller sends them to the sign-in form instead.
    /// Nothing is written to the Keychain here.
    func confirmPasswordReset(token: String, password: String) async throws {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await post("/auth/password-reset/confirm",
                                              body: ["token": token, "password": password],
                                              retryOn401: false)
        } catch {
            throw PasswordResetConfirmError.network
        }

        if (200..<300).contains(response.statusCode) { return }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        throw PasswordResetConfirmError.from(code: json?["code"] as? String,
                                             serverMessage: (json?["error"] as? String)
                                                ?? (json?["message"] as? String))
    }

    /// `POST /api/users/me/password`, the change-with-current-password path.
    ///
    /// NOT retried on 401, deliberately, and this is the interesting one. A
    /// wrong current password IS a 401 here (`CURRENT_PASSWORD_INCORRECT`). Let
    /// the generic interceptor see it and a simple typo would silently
    /// re-authenticate from the Keychain, replay the request, collect the same
    /// 401, and then post `viciAuthenticationLost` — putting a "signed out"
    /// banner in front of somebody who is perfectly signed in and merely
    /// mistyped. Reading the code here is the only way to tell the two 401s
    /// apart.
    ///
    /// The server bumps the session epoch, which ends every OTHER session, and
    /// re-stamps this request's cookie so this device stays signed in. Nothing
    /// in this client clears a credential as a result, so the phone keeps its
    /// SIP login and keeps ringing.
    func changePassword(currentPassword: String, newPassword: String) async throws {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await post("/api/users/me/password",
                                              body: ["currentPassword": currentPassword,
                                                     "newPassword": newPassword],
                                              retryOn401: false)
        } catch {
            throw PasswordChangeError.network
        }

        if (200..<300).contains(response.statusCode) {
            // The stored password is what a cold launch from a VoIP push
            // re-authenticates with. Leaving the old one there would mean the
            // next push-woken launch fails to sign in and the phone stops
            // ringing, which is the one failure this app cannot have.
            //
            // Guarded because `CredentialStore.set` treats an empty value as a
            // removal, and removing this key is exactly the thing that must
            // only ever happen behind Sign Out. The server has already refused
            // anything shorter than the policy minimum by this point, so the
            // guard can never fire; it exists so that no future caller can make
            // it fire either.
            if !newPassword.isEmpty {
                CredentialStore.set(newPassword, for: .inboxPassword)
            }
            return
        }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        throw PasswordChangeError.from(code: json?["code"] as? String,
                                       serverMessage: (json?["error"] as? String)
                                          ?? (json?["message"] as? String))
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

    /// `timeout` overrides the session's 20 second default for the few calls
    /// that legitimately take longer. A segment recompute reads the whole
    /// workspace's order history before it answers.
    @discardableResult
    private func post(_ path: String,
                      body: [String: Any],
                      retryOn401: Bool = true,
                      timeout: TimeInterval? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        if let timeout { request.timeoutInterval = timeout }
        return try await perform(request, retryOn401: retryOn401)
    }

    private func put(_ path: String, body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "PUT"
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

    /// A DELETE body is only sent when there is something in it, so no existing
    /// caller starts sending `{}` and a Content-Type it never had.
    private func delete(_ path: String,
                        body: [String: Any] = [:]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "DELETE"
        if !body.isEmpty {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
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
                throw APIError.server(message,
                                      statusCode: response.statusCode,
                                      code: json?["code"] as? String)
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
            return "This is the last active Owner or Admin. Promote somebody else first, then try again."
        case "CANNOT_MODIFY_PEER_OWNER":
            // The peer-Owner guard. The client disables these controls already,
            // so reaching this means two admins were acting at once, or a role
            // changed underneath the screen. Prefer the server's own sentence
            // if it sent one — it knows which of the two rules it applied.
            if let message = json["error"] as? String, !message.isEmpty { return message }
            return "An Owner cannot change another Owner's role or deactivate them. Ask them to make this change from their own account."
        case "SEGMENT_AI_BUILDER_DISABLED":
            // The server's own sentence names an environment variable, which
            // is the right thing to say to whoever runs the deployment and the
            // wrong thing to put in front of an operator.
            return SegmentRuleCopy.disabled
        case "SEGMENT_RULES_INVALID":
            // The reasons are the useful part. They are the validator's own
            // sentences, built from dimension names and limits, and they say
            // which rule was refused and why.
            if let problems = json["errors"] as? [[String: Any]] {
                let reasons = problems.compactMap { $0["reason"] as? String }
                if !reasons.isEmpty { return reasons.joined(separator: " ") }
            }
            if let message = json["error"] as? String, !message.isEmpty { return message }
            return "Those rules were not accepted."
        case "OWNER_ROLE_REQUIRES_OWNER":
            if let message = json["error"] as? String, !message.isEmpty { return message }
            return "Only an Owner can grant or remove the Owner role."
        case "INVALID_DISPLAY_NAME":
            return "Enter a name between 1 and 120 characters."
        default:
            // An unrecognised code is not an excuse for a generic failure. The
            // server writes these messages for a person to read, so show it.
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

    // MARK: - Assistant

    /// `POST /api/assistant/converse`, `assistant.use`.
    ///
    /// History travels with every question because the server holds no session
    /// state for a conversation. Keeping it client side means a dropped
    /// connection or a restarted backend loses nothing, and there is no
    /// per-user transcript sitting on a server waiting to be a liability.
    /// With a `threadID` the server reads the transcript it recorded and
    /// ignores `history` entirely, so a saved conversation cannot be reasoned
    /// over from a version of events the client made up. `history` is still
    /// sent for the unsaved path, which has nothing on the server to read.
    func assistantConverse(question: String,
                           history: [AssistantConversationTurn],
                           threadID: String? = nil,
                           thorough: Bool = true) async throws -> AssistantConverseResponse {
        var body: [String: Any] = [
            "question": question,
            "thorough": thorough,
            "history": history.map { ["role": $0.role, "content": $0.content] }
        ]
        if let threadID, !threadID.isEmpty { body["threadId"] = threadID }
        let (data, response) = try await post("/api/assistant/converse", body: body, timeout: 30)
        try validate(data: data, response: response)
        return try decoder.decode(AssistantConverseResponse.self, from: data)
    }

    // MARK: - Assistant threads

    /// `GET /api/assistant/threads`, `assistant.use`. One account's own
    /// conversations. The server never returns anybody else's.
    func assistantThreads() async throws -> [AssistantThreadSummary] {
        let response: AssistantThreadListResponse = try await decodedGET("/api/assistant/threads")
        return response.threads
    }

    /// `POST /api/assistant/threads`, `assistant.use`.
    func createAssistantThread(title: String? = nil) async throws -> AssistantThreadSummary {
        var body: [String: Any] = [:]
        if let title, !title.isEmpty { body["title"] = title }
        let (data, response) = try await post("/api/assistant/threads", body: body)
        try validate(data: data, response: response)
        return try decoder.decode(AssistantThreadResponse.self, from: data).thread
    }

    /// `GET /api/assistant/threads/:id`, `assistant.use`. The thread and every
    /// message in it, so the operator can see the context the assistant has.
    func assistantThread(id: String) async throws -> AssistantThreadDetail {
        try await decodedGET("/api/assistant/threads/\(pathEscaped(id))")
    }

    /// `PATCH /api/assistant/threads/:id`, `assistant.use`.
    func renameAssistantThread(id: String, title: String) async throws -> AssistantThreadSummary {
        let (data, response) = try await patch("/api/assistant/threads/\(pathEscaped(id))",
                                               body: ["title": title])
        try validate(data: data, response: response)
        return try decoder.decode(AssistantThreadResponse.self, from: data).thread
    }

    /// `DELETE /api/assistant/threads/:id`, `assistant.use`. A real delete. The
    /// messages go with it.
    func deleteAssistantThread(id: String) async throws {
        let (data, response) = try await delete("/api/assistant/threads/\(pathEscaped(id))")
        try validate(data: data, response: response)
    }

    /// A thread id is a server generated uuid, so this should never change it.
    /// It is here because the id is still interpolated into a path, and an id
    /// that is one day not a uuid should produce a 404 rather than a request to
    /// a path nobody meant to build.
    private func pathEscaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    /// `POST /api/assistant/speak`, `assistant.use`. Returns MP3 bytes.
    ///
    /// The ElevenLabs key lives on the server and never in this binary, because
    /// anything shipped in an app can be extracted, TestFlight included.
    func assistantSpeak(text: String, voiceID: String?) async throws -> Data {
        var body: [String: Any] = ["text": text]
        if let voiceID, !voiceID.isEmpty { body["voiceId"] = voiceID }
        let (data, response) = try await post("/api/assistant/speak", body: body, timeout: 30)
        try validate(data: data, response: response)
        return data
    }

    // MARK: - Do not contact

    /// `GET /api/do-not-contact`, `campaigns.read`.
    func fetchDoNotContact() async throws -> DoNotContactList {
        try await decodedGET("/api/do-not-contact")
    }

    /// `POST /api/do-not-contact`, `campaigns.manage`.
    ///
    /// Adding somebody already on the list succeeds rather than erroring:
    /// blocking a person twice means the same thing it meant the first time.
    @discardableResult
    func addToDoNotContact(phone: String, note: String?) async throws -> Bool {
        var body: [String: Any] = ["phone": phone, "reasonCode": "manual_block"]
        if let note, !note.isEmpty { body["note"] = note }
        let (data, response) = try await post("/api/do-not-contact", body: body)
        try validate(data: data, response: response)
        return true
    }

    /// `DELETE /api/do-not-contact/:phone`, `campaigns.manage`.
    @discardableResult
    func removeFromDoNotContact(phone: String) async throws -> Bool {
        let (data, response) = try await delete("/api/do-not-contact/\(encodedPathSegment(phone))")
        try validate(data: data, response: response)
        return true
    }

    /// `GET /api/assistant/voices`, `assistant.use`.
    func assistantVoices(query: String?, gender: String?, accent: String?) async throws -> AssistantVoiceSearchResponse {
        var items: [URLQueryItem] = []
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let gender, !gender.isEmpty { items.append(URLQueryItem(name: "gender", value: gender)) }
        if let accent, !accent.isEmpty { items.append(URLQueryItem(name: "accent", value: accent)) }
        let (data, response) = try await get("/api/assistant/voices", queryItems: items)
        try validate(data: data, response: response)
        return try decoder.decode(AssistantVoiceSearchResponse.self, from: data)
    }

}